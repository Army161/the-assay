// Holder rewards. Coins launched with a transfer fee (Token-2022) withhold 1-2% of every transfer inside the
// receiving token accounts. This worker harvests those withheld tokens to the mint, withdraws them to the rewards
// wallet (the mint's withdraw-withheld authority), sells them for SOL on the coin's own market (the curve while live,
// the Raydium CPMM pool after graduation) and pays the SOL to holders pro rata. Everything is recorded in `rewards`.
//
// The rewards wallet is a hot wallet on the server. By design it only ever holds the withheld tokens for the seconds
// between withdraw and payout, plus SOL for fees. It can never touch pool funds, platform fees or creator fees.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, LAMPORTS_PER_SOL, ComputeBudgetProgram, type Signer } from "@solana/web3.js";
import { tokenAccountsForMint } from "./token-accounts";
import {
  TOKEN_2022_PROGRAM_ID, getTransferFeeAmount, createHarvestWithheldTokensToMintInstruction, createWithdrawWithheldTokensFromMintInstruction,
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getMint, getTransferFeeConfig, getAccount, TokenAccountNotFoundError,
  createSetAuthorityInstruction, AuthorityType,
} from "@solana/spl-token";
import { getCpmmPdaPoolId, getPdaLaunchpadVaultId, getPdaVault, getPdaPlatformId } from "@raydium-io/raydium-sdk-v2";
import { priorityFee, UNITS } from "./send";
import type { Db } from "./db";
import { kv } from "./db";
import { loadRaydium, ids, BN, sdkTxVersion, readPool, curveComplete } from "./raydium";
import { WSOL, MAX_TX_VERSION, PLATFORM_ID, assertNetworkAllowed, isProgramOwner, type Network } from "./chain";

export interface RewardsRunStats { coins: number; paid: { mint: string; holders: number; sol: number; sigs: string[] }[]; skipped: { mint: string; reason: string }[]; errors: string[] }

const MIN_PAYOUT_LAMPORTS = 500_000; // 0.0005 SOL: below this a holder's share is carried to the next round
const MAX_HOLDERS = 120;
const BATCH = 18;
const MIN_WITHHELD_SHARE = 0.00005; // skip a coin until at least 0.005% of supply has accumulated
const HARVEST_ACCOUNTS_PER_RUN = 100; // the accounts holding the most withheld fees; the rest wait for the next run
const SALE_SLIPPAGE_BPS = 200; // 2%: fee sales run on a schedule, so a loose limit would invite sandwiching
const RESERVE_LAMPORTS = 10_000_000; // 0.01 SOL kept back in the rewards wallet for transaction fees
const RUN_BUDGET_MS = 200_000; // stop starting new coins or transactions after this, well inside a 300 s function

/** Thrown between transactions when the run's time is up. The state is saved after every step, so the next run resumes. */
class OutOfTime extends Error { constructor() { super("time budget reached"); } }
const checkTime = (deadline: number) => { if (Date.now() > deadline) throw new OutOfTime(); };

/** confirmTransaction resolves (not rejects) when the transaction landed with an error, so the result is checked here. */
async function confirmOk(conn: Connection, sig: string, blockhash: string, lastValidBlockHeight: number) {
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (r.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(r.value.err)}`);
}

/**
 * Accounts a transfer can never pay: executable programs and sysvars are read-only in a transaction, so one of them
 * in a payout batch would fail the whole batch, every run. A holder whose token account names one as its owner gets
 * no share; it goes to the other holders.
 */
const UNPAYABLE = new Set([
  "11111111111111111111111111111111", "Sysvar1111111111111111111111111111111111111", "NativeLoader1111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111", "BPFLoader2111111111111111111111111111111111", "BPFLoaderUpgradeab1e11111111111111111111111",
  "Config1111111111111111111111111111111111111", "Stake11111111111111111111111111111111111111", "Vote111111111111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111", "AddressLookupTab1e1111111111111111111111111", "1nc1nerator11111111111111111111111111111111",
]);
export function unpayableAccount(address: string, info: { executable: boolean; owner: PublicKey } | null): boolean {
  if (UNPAYABLE.has(address)) return true;
  if (!info) return false;
  return !!info.executable || info.owner?.toBase58() === "Sysvar1111111111111111111111111111111111111";
}

export function loadRewardsKeypair(raw = process.env.REWARDS_KEYPAIR, network?: Network) {
  if (!raw) throw new Error("REWARDS_KEYPAIR not set");
  let kp: Keypair;
  try {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw.trim()) as number[]));
  } catch {
    throw new Error("REWARDS_KEYPAIR is not a JSON array of 64 numbers"); // never echo any of the value
  }
  // The platform admin key must never sit on a server: it alone can change the platform's fees and wallets.
  // (Devnet uses one key for both, for testing.)
  if (network && network !== "devnet") {
    const platform = PLATFORM_ID[network];
    if (platform && getPdaPlatformId(ids(network).program, kp.publicKey).publicKey.equals(platform)) {
      throw new Error("REWARDS_KEYPAIR is the platform admin key; use the separate rewards wallet");
    }
  }
  return kp;
}

const log = (...a: unknown[]) => { if (process.env.INDEXER_LOG !== "0") console.log("[rewards]", ...a); };

/** One rewards run at a time: the wallet is shared by every coin, and two runs would both act on the same coin state. */
const REWARDS_LEASE = "lock:rewards";
const REWARDS_LEASE_MS = 15 * 60_000; // longer than any function may run (300 s), so a run that was cut off frees it

export async function runRewards(db: Db, conn: Connection, network: Network, opts: { maxCoins?: number; keypair?: Keypair } = {}): Promise<RewardsRunStats> {
  assertNetworkAllowed(network);
  const out: RewardsRunStats = { coins: 0, paid: [], skipped: [], errors: [] };
  // The daily cron and the traffic tick can both start a run; only the lease holder goes on.
  const token = await kv.lease(db, REWARDS_LEASE, REWARDS_LEASE_MS);
  if (!token) { out.errors.push("another rewards run is in progress"); return out; }
  try {
    return await runRewardsLocked(db, conn, network, opts, out, { lease: REWARDS_LEASE, token });
  } finally {
    await kv.release(db, REWARDS_LEASE, token);
  }
}

async function runRewardsLocked(
  db: Db, conn: Connection, network: Network, opts: { maxCoins?: number; keypair?: Keypair }, out: RewardsRunStats, fence: Fence,
): Promise<RewardsRunStats> {
  const auth = opts.keypair ?? loadRewardsKeypair(undefined, network);
  // Oldest attempt first, whatever its outcome, so coins that are always skipped cannot hold every slot.
  const coins = await db.query<{ mint: string; pool_id: string; supply: string; decimals: number; creator: string; status: string; transfer_fee_bps: number }>(
    `select c.mint, c.pool_id, c.supply, c.decimals, c.creator, c.status, c.transfer_fee_bps
       from coins c where c.network = $1 and c.transfer_fee_bps > 0 order by c.rewards_checked_at nulls first, c.created_at limit $2`, [network, opts.maxCoins ?? 5]);
  const deadline = Date.now() + RUN_BUDGET_MS;
  for (const coin of coins) {
    if (Date.now() > deadline) break;
    if (!(await kv.renew(db, fence.lease, fence.token))) { out.errors.push("rewards lease lost; stopping"); break; }
    await db.query("update coins set rewards_checked_at = now() where mint = $1", [coin.mint]);
    out.coins++;
    try {
      const r = await rewardCoin(db, fence, conn, network, auth, coin, deadline);
      if ("skipped" in r) out.skipped.push({ mint: coin.mint, reason: r.skipped });
      else out.paid.push({ mint: coin.mint, ...r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
      out.errors.push(`${coin.mint}: ${msg}`); log("error", coin.mint, msg, e instanceof Error ? e.stack : "");
    }
  }
  return out;
}

type CoinRow = { mint: string; pool_id: string; supply: string; decimals: number; creator: string; status: string; transfer_fee_bps: number };

/**
 * What the rewards run owes for one coin, kept in kv so a run that stops at any point loses nothing and pays nothing twice.
 * - unsold: withheld fee tokens withdrawn to the rewards wallet and not yet sold. Only these are ever sold, never
 *   anything else the wallet's token account may hold.
 * - carry: SOL from sales that is not yet shared out (shares under the minimum wait here for the next round).
 * - owed: SOL shared out to holders and not yet sent, by wallet. A round is paid off before the next one is shared out.
 * - held: shares of wallets a transfer cannot fund yet (an empty wallet below the rent-exempt minimum), by wallet. They
 *   stay those wallets' own and are offered again on every run, so the rest of the holders are paid meanwhile.
 * - pending: the one transaction that is signed and may be on its way. It is written down before it is sent and settled
 *   from the chain afterwards (or on the next run): a withdrawal adds the tokens it moved to unsold, a sale moves its
 *   tokens out of unsold and its exact proceeds into carry, a payout takes its wallets off owed.
 */
interface Pending { kind: "withdraw" | "sale" | "pay"; sig: string; lastValidBlockHeight: number; to?: string[]; tokens?: string; mint?: string; owner?: string }
export interface RewardState { unsold: string; carry: number; owed: { to: string; lamports: number }[]; held?: Record<string, number>; pending: Pending | null }

const stateKey = (mint: string) => `reward_state:${mint}`;

export async function loadRewardState(db: Db, mint: string): Promise<RewardState> {
  const s = await kv.get<RewardState>(db, stateKey(mint));
  if (s) return { unsold: s.unsold ?? "0", carry: s.carry ?? 0, owed: s.owed ?? [], held: s.held ?? {}, pending: s.pending ?? null };
  const old = await kv.get<{ lamports: number }>(db, `reward_carry:${mint}`); // the single number kept before this state
  return { unsold: "0", carry: old?.lamports ?? 0, owed: [], held: {}, pending: null };
}

/** The rewards lease this run holds. Every state write checks it, so a run that lost its lease stops before it sends. */
interface Fence { lease: string; token: string }

async function saveRewardState(db: Db, fence: Fence, mint: string, st: RewardState) {
  if (!(await kv.setFenced(db, stateKey(mint), st, fence.lease, fence.token))) throw new Error("rewards lease lost; not writing");
}

type SettleConn = Pick<Connection, "getSignatureStatuses" | "getTransaction" | "getBlockHeight">;

/**
 * Settles `st.pending` from the chain. "landed": applied to carry or owed. "failed": it did not and cannot land, so
 * nothing changes. "waiting": it may still land, so the coin is left alone until it is known.
 */
export async function settlePending(conn: SettleConn, st: RewardState): Promise<"landed" | "failed" | "waiting" | "none"> {
  const p = st.pending;
  if (!p) return "none";
  const status = (await conn.getSignatureStatuses([p.sig], { searchTransactionHistory: true })).value[0];
  if (status?.err) { st.pending = null; return "failed"; }
  if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
    if (p.kind === "sale" || p.kind === "withdraw") {
      const tx = await conn.getTransaction(p.sig, { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: "confirmed" });
      if (!tx?.meta) return "waiting";
      if (p.kind === "sale") {
        // The rewards wallet pays the fee, so it is account 0: its change is what the sale brought in, net of the fee.
        st.carry += Math.max(0, tx.meta.postBalances[0] - tx.meta.preBalances[0]);
        st.unsold = (BigInt(st.unsold) - BigInt(p.tokens ?? "0")).toString();
        if (BigInt(st.unsold) < 0n) st.unsold = "0";
      } else {
        // What the withdrawal put in the rewards wallet's token account, read from the transaction itself.
        const bal = (xs: typeof tx.meta.preTokenBalances) => BigInt(xs?.find((b) => b.mint === p.mint && b.owner === p.owner)?.uiTokenAmount.amount ?? "0");
        const moved = bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
        if (moved > 0n) st.unsold = (BigInt(st.unsold) + moved).toString();
      }
    } else {
      const paid = new Set(p.to ?? []);
      st.owed = st.owed.filter((o) => !paid.has(o.to));
    }
    st.pending = null;
    return "landed";
  }
  if (!status && (await conn.getBlockHeight("confirmed")) > p.lastValidBlockHeight) { st.pending = null; return "failed"; }
  return "waiting";
}

/** Signs `tx` on a fresh blockhash, records it as pending, then sends it and waits for confirmation. */
async function sendTracked(
  db: Db, fence: Fence, conn: Connection, mint: string, st: RewardState, tx: Transaction | VersionedTransaction, signers: Signer[], pending: Omit<Pending, "sig" | "lastValidBlockHeight">,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  let sig: string;
  if (!(tx instanceof VersionedTransaction) && !tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))) {
    // A priority fee, so the transaction lands on a busy mainnet (SDK-built ones carry their own).
    const writable = tx.instructions.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey));
    const units = Math.min(400_000, UNITS.payout * Math.max(1, tx.instructions.length));
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await priorityFee(conn, networkOf(conn), writable) }),
    );
  }
  if (tx instanceof VersionedTransaction) {
    tx.message.recentBlockhash = blockhash;
    tx.sign(signers);
    sig = base58(tx.signatures[0]);
  } else {
    tx.recentBlockhash = blockhash;
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    sig = base58(tx.signature!);
  }
  st.pending = { ...pending, sig, lastValidBlockHeight };
  await saveRewardState(db, fence, mint, st); // on record before it can land
  const raw = tx.serialize();
  await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 0 });
  // Re-send the same bytes until it is confirmed or its blockhash expires; settlePending reads the outcome.
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const st0 = (await conn.getSignatureStatuses([sig])).value[0];
    if (st0?.err || st0?.confirmationStatus === "confirmed" || st0?.confirmationStatus === "finalized") break;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) break;
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
  }
  return sig;
}

/** The network a connection points at, for the priority fee bounds. */
const networkOf = (conn: Connection): Network => (/devnet/.test(conn.rpcEndpoint) ? "devnet" : "mainnet");

async function rewardCoin(db: Db, fence: Fence, conn: Connection, network: Network, auth: Keypair, coin: CoinRow, deadline = Infinity): Promise<{ holders: number; sol: number; sigs: string[] } | { skipped: string }> {
  const st = await loadRewardState(db, coin.mint);
  // A transaction a cut-off run left behind is settled before anything else is done for this coin.
  const before = await settlePending(conn, st);
  if (before === "waiting") return { skipped: `waiting for ${st.pending?.sig} to settle` };
  if (before !== "none") await saveRewardState(db, fence, coin.mint, st);

  const mint = new PublicKey(coin.mint);
  const mintInfo = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const tf = getTransferFeeConfig(mintInfo);
  if (!tf) return { skipped: "no transfer fee extension" };
  if (!tf.withdrawWithheldAuthority.equals(auth.publicKey)) return { skipped: "rewards wallet is not the withdraw authority" };
  if (tf.transferFeeConfigAuthority.equals(auth.publicKey)) {
    // At graduation LaunchLab hands the coin's fee-setting authority to this wallet. A server key that could raise a
    // coin's transfer fee is a risk to every holder, so it gives the authority up for good: the fee stays as launched.
    const tx = new Transaction().add(createSetAuthorityInstruction(mint, auth.publicKey, AuthorityType.TransferFeeConfig, null, [], TOKEN_2022_PROGRAM_ID));
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash; tx.feePayer = auth.publicKey; tx.sign(auth);
    const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    await confirmOk(conn, sig, blockhash, lastValidBlockHeight);
    log("fixed the transfer fee for good on", coin.mint, sig);
  }

  // every token account of the mint we can see: holders, withheld balances, and what to exclude
  const pool = await readPool(conn, new PublicKey(coin.pool_id));
  const vaultAKey = getPdaLaunchpadVaultId(ids(network).program, new PublicKey(coin.pool_id), mint).publicKey;
  const vaultA = vaultAKey.toBase58();
  const cpmm = cpmmPoolId(network, mint);
  const ourAta = getAssociatedTokenAddressSync(mint, auth.publicKey, false, TOKEN_2022_PROGRAM_ID).toBase58();
  const cpmmVaults = cpmm.map((p) => getPdaVault(ids(network).cpmmProgram, p, mint).publicKey);
  const { accounts: parsed, complete } = await tokenAccountsForMint(conn, db, mint, true, [vaultAKey, ...cpmmVaults]);
  const sigs: string[] = [];
  let sold = 0n;
  let paid = 0;
  let sent = 0;
  const record = (status: "done" | "partial") => (sold > 0n || paid > 0)
    ? db.query("insert into rewards (mint, withheld_base, sol_lamports, holders, sigs, status) values ($1,$2,$3,$4,$5::jsonb,$6)", [coin.mint, sold.toString(), paid, sent, JSON.stringify(sigs), status])
    : Promise.resolve([]);

  try {
    // 1-3. collect the withheld fees and sell them, once enough has built up
    const sale = await collectAndSell(db, fence, conn, network, auth, coin, st, { mint, pool, parsed, cpmm, ourAta: new PublicKey(ourAta) }, sigs, deadline);
    if (sale.sold) sold = sale.sold;

    // 4. share out what has been carried, once the last round is fully paid
    const exclude = new Set([vaultA, ourAta, ...cpmm.map((p) => p.toBase58()), ...cpmmVaults.map((p) => p.toBase58())]);
    // On mainnet a partial account list (the RPC refused the full scan) would pay only the holders it happened to
    // name, so the SOL waits in carry until a full list is available.
    if (!complete && network === "mainnet" && !st.owed.length && st.carry >= MIN_PAYOUT_LAMPORTS) log("holder list incomplete; payout waits", coin.mint);
    else if (!st.owed.length && st.carry >= MIN_PAYOUT_LAMPORTS) {
      const candidates = parsed
        .filter((p) => !exclude.has(p.pubkey.toBase58()) && p.acc.amount > 0n && !isProgramOwner(p.acc.owner))
        .sort((a, b) => (a.acc.amount > b.acc.amount ? -1 : 1))
        .slice(0, MAX_HOLDERS * 2);
      const infos: ({ executable: boolean; owner: PublicKey } | null)[] = [];
      for (let i = 0; i < candidates.length; i += 100) infos.push(...(await conn.getMultipleAccountsInfo(candidates.slice(i, i + 100).map((p) => p.acc.owner), "confirmed")));
      const holders = candidates.filter((p, i) => !unpayableAccount(p.acc.owner.toBase58(), infos[i])).slice(0, MAX_HOLDERS);
      st.owed = shareOut(st.carry, holders.map((h) => ({ owner: h.acc.owner.toBase58(), amount: h.acc.amount })));
      st.carry -= st.owed.reduce((a, o) => a + o.lamports, 0);
      await saveRewardState(db, fence, coin.mint, st);
    }

    // 5. pay what is owed, one batch at a time; each batch comes off `owed` only once it has landed
    if (releaseHeld(st) + (await deferUnpayable(conn, st))) await saveRewardState(db, fence, coin.mint, st);
    while (st.owed.length) {
      checkTime(deadline);
      const batch = st.owed.slice(0, BATCH);
      const need = batch.reduce((a, p) => a + p.lamports, 0) + RESERVE_LAMPORTS;
      const have = await conn.getBalance(auth.publicKey, "confirmed");
      if (have < need) throw new Error(`rewards wallet underfunded: holds ${have / LAMPORTS_PER_SOL} SOL, this batch needs ${need / LAMPORTS_PER_SOL}; top it up`);
      const tx = new Transaction();
      for (const p of batch) tx.add(SystemProgram.transfer({ fromPubkey: auth.publicKey, toPubkey: new PublicKey(p.to), lamports: p.lamports }));
      const sig = await sendTracked(db, fence, conn, coin.mint, st, tx, [auth], { kind: "pay", to: batch.map((p) => p.to) });
      const r = await settlePending(conn, st);
      await saveRewardState(db, fence, coin.mint, st);
      if (r !== "landed") throw new Error(`payout ${sig} ${r}`);
      sigs.push(sig);
      paid += batch.reduce((a, p) => a + p.lamports, 0);
      sent += batch.length;
    }
  } catch (e) {
    await record("partial");
    if (e instanceof OutOfTime) return { skipped: "time budget reached; the next run carries on from here" };
    throw e;
  }
  const held = Object.values(st.held ?? {}).reduce((a, b) => a + b, 0);
  if (!sold && !paid) return { skipped: st.carry + held > 0 ? `${st.carry} lamports carried, ${held} held for unfunded wallets` : "nothing to pay" };
  await record("done");
  log("paid", coin.mint, sent, "holders", paid / LAMPORTS_PER_SOL, "SOL");
  return { holders: sent, sol: paid / LAMPORTS_PER_SOL, sigs };
}

/** Puts every held share back on `owed` (added to the wallet's share in this round, if it has one); returns the lamports. */
export function releaseHeld(st: RewardState): number {
  const held = Object.entries(st.held ?? {}).filter(([, l]) => l > 0);
  if (!held.length) return 0;
  let back = 0;
  for (const [to, lamports] of held) {
    const o = st.owed.find((x) => x.to === to);
    if (o) o.lamports += lamports;
    else st.owed.push({ to, lamports });
    back += lamports;
  }
  st.held = {};
  return back;
}

/**
 * A transfer that leaves a wallet below the rent-exempt minimum fails, and with it the whole batch: one holder with an
 * empty wallet would block every payout of the coin. Such shares move to `held`, still that wallet's, and are offered
 * again on the next run (paid once the wallet holds SOL or its shares add up to the minimum). Returns the lamports moved.
 */
export async function deferUnpayable(conn: Pick<Connection, "getMultipleAccountsInfo" | "getMinimumBalanceForRentExemption">, st: RewardState): Promise<number> {
  if (!st.owed.length) return 0;
  const rentMin = await conn.getMinimumBalanceForRentExemption(0);
  const balances: number[] = [];
  const dead = new Set<number>();
  for (let i = 0; i < st.owed.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(st.owed.slice(i, i + 100).map((o) => new PublicKey(o.to)), "confirmed");
    infos.forEach((a, j) => { balances.push(a?.lamports ?? 0); if (unpayableAccount(st.owed[i + j].to, a)) dead.add(i + j); });
  }
  let back = 0;
  const held = (st.held ??= {});
  st.owed = st.owed.filter((o, i) => {
    // Never payable: the share goes back to carry, for the other holders in the next round.
    if (dead.has(i)) { st.carry += o.lamports; back += o.lamports; return false; }
    if (balances[i] + o.lamports >= rentMin) return true;
    held[o.to] = (held[o.to] ?? 0) + o.lamports;
    back += o.lamports;
    return false;
  });
  if (back) log("held", back, "lamports for wallets a transfer cannot fund yet (below the rent-exempt minimum)");
  return back;
}

/** Pro-rata shares of `lamports` by token amount, one per wallet; shares under the minimum are left out (carried). */
export function shareOut(lamports: number, holders: { owner: string; amount: bigint }[]): { to: string; lamports: number }[] {
  const byOwner = new Map<string, bigint>();
  for (const h of holders) byOwner.set(h.owner, (byOwner.get(h.owner) ?? 0n) + h.amount);
  const total = [...byOwner.values()].reduce((a, b) => a + b, 0n);
  if (total === 0n) return [];
  return [...byOwner]
    .map(([to, amount]) => ({ to, lamports: Number((BigInt(lamports) * amount) / total) }))
    .filter((p) => p.lamports >= MIN_PAYOUT_LAMPORTS);
}

/** Harvests and withdraws the withheld fees and sells everything in the rewards account; returns the tokens sold. */
async function collectAndSell(
  db: Db, fence: Fence, conn: Connection, network: Network, auth: Keypair, coin: CoinRow, st: RewardState,
  c: { mint: PublicKey; pool: Awaited<ReturnType<typeof readPool>>; parsed: Awaited<ReturnType<typeof tokenAccountsForMint>>["accounts"]; cpmm: PublicKey[]; ourAta: PublicKey },
  sigs: string[],
  deadline = Infinity,
): Promise<{ sold: bigint }> {
  const { mint, pool, parsed, cpmm, ourAta } = c;
  const withheldOf = (p: (typeof parsed)[number]) => getTransferFeeAmount(p.acc)?.withheldAmount ?? 0n;
  const withheldAccounts = parsed.filter((p) => withheldOf(p) > 0n).sort((a, b) => (withheldOf(a) > withheldOf(b) ? -1 : 1));
  const harvestable = withheldAccounts.reduce((a, p) => a + (getTransferFeeAmount(p.acc)?.withheldAmount ?? 0n), 0n);
  const inMint = getTransferFeeConfig(await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n;
  const supply = BigInt(coin.supply);
  if (Number(harvestable + inMint + BigInt(st.unsold)) / Number(supply) < MIN_WITHHELD_SHARE) return { sold: 0n };

  // 1. harvest withheld tokens into the mint (permissionless), 20 accounts per tx, the largest first, a bounded number per run
  const toHarvest = withheldAccounts.slice(0, HARVEST_ACCOUNTS_PER_RUN);
  for (let i = 0; i < toHarvest.length; i += 20) {
    checkTime(deadline);
    const ix = createHarvestWithheldTokensToMintInstruction(mint, toHarvest.slice(i, i + 20).map((p) => p.pubkey), TOKEN_2022_PROGRAM_ID);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await priorityFee(conn, network, [mint]) }),
      ix,
    );
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash; tx.feePayer = auth.publicKey; tx.sign(auth);
    const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    await confirmOk(conn, sig, blockhash, lastValidBlockHeight);
    sigs.push(sig);
  }
  const withheld = getTransferFeeConfig(await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n;

  // 2. withdraw to the rewards wallet, tracked so the tokens it moves are known to be fees
  if (withheld > 0n) {
    checkTime(deadline);
    const dest = await getOrCreateAssociatedTokenAccount(conn, auth, mint, auth.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
    const tx = new Transaction().add(createWithdrawWithheldTokensFromMintInstruction(mint, dest.address, auth.publicKey, [], TOKEN_2022_PROGRAM_ID));
    const sig = await sendTracked(db, fence, conn, coin.mint, st, tx, [auth], { kind: "withdraw", mint: mint.toBase58(), owner: auth.publicKey.toBase58() });
    const r = await settlePending(conn, st);
    await saveRewardState(db, fence, coin.mint, st);
    if (r !== "landed") throw new Error(`withdraw ${sig} ${r}`);
    sigs.push(sig);
  }
  // Sell the fees withdrawn so far (this run's and any a cut-off run left), never more than the account holds.
  const balance = await tokenBalance(conn, ourAta);
  const have = BigInt(st.unsold) < balance ? BigInt(st.unsold) : balance;
  if (have <= 0n) return { sold: 0n };

  // 3. sell for SOL on the coin's market; the proceeds are read from the sale transaction itself
  checkTime(deadline);
  const sdk = await loadRaydium(conn, auth, network);
  await sdk.account.fetchWalletTokenAccounts({ forceUpdate: true });
  let built: { transaction: Transaction | VersionedTransaction; signers: Signer[] };
  if (pool && !curveComplete(pool.status)) {
    built = await sdk.launchpad.sellToken({
      programId: ids(network).program, mintA: mint, mintAProgram: TOKEN_2022_PROGRAM_ID, sellAmount: new BN(have.toString()), slippage: new BN(SALE_SLIPPAGE_BPS),
      computeBudgetConfig: { units: UNITS.rewardSell, microLamports: await priorityFee(conn, network, [new PublicKey(coin.pool_id)]) }, txVersion: sdkTxVersion,
    });
  } else {
    const poolId = (await firstExisting(conn, cpmm))?.toBase58();
    if (!poolId) { log("graduated but CPMM pool not found yet", coin.mint); return { sold: 0n }; }
    const { poolInfo, poolKeys, computePoolInfo } = await sdk.cpmm.getPoolInfoFromRpc(poolId);
    const baseIn = poolInfo.mintA.address === mint.toBase58();
    const amountIn = new BN(have.toString());
    const q = sdk.cpmm.computeSwapAmount({ pool: computePoolInfo, amountIn, outputMint: WSOL, slippage: SALE_SLIPPAGE_BPS / 10_000, swapBaseIn: true });
    built = await sdk.cpmm.swap({
      poolInfo, poolKeys, inputAmount: amountIn, swapResult: q.swapResult, baseIn, slippage: SALE_SLIPPAGE_BPS / 10_000,
      computeBudgetConfig: { units: UNITS.rewardSell, microLamports: await priorityFee(conn, network, [new PublicKey(poolId)]) }, txVersion: sdkTxVersion,
    });
  }
  const signers = [auth, ...built.signers.filter((x) => !x.publicKey.equals(auth.publicKey))];
  const sig = await sendTracked(db, fence, conn, coin.mint, st, built.transaction, signers, { kind: "sale", tokens: have.toString() });
  const r = await settlePending(conn, st);
  await saveRewardState(db, fence, coin.mint, st);
  if (r !== "landed") throw new Error(`sale ${sig} ${r}`);
  sigs.push(sig);
  return { sold: have };
}

/** Token balance of an account, 0 when it does not exist yet; any other failure (RPC down) is thrown. */
async function tokenBalance(conn: Connection, account: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(conn, account, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) return 0n;
    throw e;
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 (the encoding of Solana signatures), so a transaction's signature is known before it is sent. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

/** Both orderings of the CPMM pool pda for our (coin, WSOL) pair on the platform's config. */
export function cpmmPoolId(network: Network, mint: PublicKey) {
  const { cpmmProgram, cpmmConfig } = ids(network);
  return [getCpmmPdaPoolId(cpmmProgram, cpmmConfig, WSOL, mint).publicKey, getCpmmPdaPoolId(cpmmProgram, cpmmConfig, mint, WSOL).publicKey];
}

async function firstExisting(conn: Connection, keys: PublicKey[]) {
  const infos = await conn.getMultipleAccountsInfo(keys, "confirmed");
  const i = infos.findIndex((x) => x != null);
  return i >= 0 ? keys[i] : null;
}

export async function rewardsHistory(db: Db, mint?: string, limit = 50) {
  const params: unknown[] = [limit];
  let where = " where c.hidden_at is null";
  if (mint) { params.push(mint); where += " and r.mint = $2"; }
  return db.query<{ id: number; mint: string; symbol: string; run_at: string; withheld_base: string; sol_lamports: string; holders: number; sigs: string[]; status: string }>(
    `select r.id, r.mint, c.symbol, r.run_at, r.withheld_base, r.sol_lamports, r.holders, r.sigs, r.status from rewards r join coins c on c.mint = r.mint${where} order by r.run_at desc limit $1`, params);
}
