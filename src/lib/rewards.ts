// Holder rewards. Coins launched with a transfer fee (Token-2022) withhold 1-2% of every transfer inside the
// receiving token accounts. This worker harvests those withheld tokens to the mint, withdraws them to the rewards
// wallet (the mint's withdraw-withheld authority), sells them for SOL on the coin's own market (the curve while live,
// the Raydium CPMM pool after graduation) and pays the SOL to holders pro rata. Everything is recorded in `rewards`.
//
// The rewards wallet is a hot wallet on the server. By design it only ever holds the withheld tokens for the seconds
// between withdraw and payout, plus SOL for fees. It can never touch pool funds, platform fees or creator fees.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { tokenAccountsForMint } from "./token-accounts";
import {
  TOKEN_2022_PROGRAM_ID, getTransferFeeAmount, harvestWithheldTokensToMint, withdrawWithheldTokensFromMint,
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getMint, getTransferFeeConfig, getAccount,
} from "@solana/spl-token";
import { getCpmmPdaPoolId, getPdaLaunchpadVaultId, getPdaVault } from "@raydium-io/raydium-sdk-v2";
import type { Db } from "./db";
import { kv } from "./db";
import { loadRaydium, ids, BN, sdkTxVersion, readPool, curveComplete } from "./raydium";
import { WSOL, assertNetworkAllowed, type Network } from "./chain";

export interface RewardsRunStats { coins: number; paid: { mint: string; holders: number; sol: number; sigs: string[] }[]; skipped: { mint: string; reason: string }[]; errors: string[] }

const MIN_PAYOUT_LAMPORTS = 500_000; // 0.0005 SOL: below this a holder's share is carried to the next round
const MAX_HOLDERS = 120;
const BATCH = 18;
const MIN_WITHHELD_SHARE = 0.00005; // skip a coin until at least 0.005% of supply has accumulated

export function loadRewardsKeypair() {
  const raw = process.env.REWARDS_KEYPAIR;
  if (!raw) throw new Error("REWARDS_KEYPAIR not set");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
}

const log = (...a: unknown[]) => { if (process.env.INDEXER_LOG !== "0") console.log("[rewards]", ...a); };

/** One rewards run at a time: the wallet is shared by every coin and each sale is measured by its balance change. */
const REWARDS_LEASE = "lock:rewards";
const REWARDS_LEASE_MS = 15 * 60_000; // longer than any function may run, so a run that was cut off frees it

export async function runRewards(db: Db, conn: Connection, network: Network, opts: { maxCoins?: number; keypair?: Keypair } = {}): Promise<RewardsRunStats> {
  assertNetworkAllowed(network);
  const out: RewardsRunStats = { coins: 0, paid: [], skipped: [], errors: [] };
  // The daily cron and the traffic tick can both start a run; two at once would each count the other's sale as theirs.
  if (!(await kv.claim(db, REWARDS_LEASE, REWARDS_LEASE_MS))) { out.errors.push("another rewards run is in progress"); return out; }
  try {
    return await runRewardsLocked(db, conn, network, opts, out);
  } finally {
    await kv.release(db, REWARDS_LEASE);
  }
}

async function runRewardsLocked(db: Db, conn: Connection, network: Network, opts: { maxCoins?: number; keypair?: Keypair }, out: RewardsRunStats): Promise<RewardsRunStats> {
  const auth = opts.keypair ?? loadRewardsKeypair();
  const coins = await db.query<{ mint: string; pool_id: string; supply: string; decimals: number; creator: string; status: string; transfer_fee_bps: number; last: string | null }>(
    `select c.mint, c.pool_id, c.supply, c.decimals, c.creator, c.status, c.transfer_fee_bps, (select max(run_at) from rewards r where r.mint = c.mint) as last
       from coins c where c.network = $1 and c.transfer_fee_bps > 0 order by last nulls first, c.created_at limit $2`, [network, opts.maxCoins ?? 5]);
  for (const coin of coins) {
    out.coins++;
    try {
      const r = await rewardCoin(db, conn, network, auth, coin);
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

async function rewardCoin(db: Db, conn: Connection, network: Network, auth: Keypair, coin: CoinRow): Promise<{ holders: number; sol: number; sigs: string[] } | { skipped: string }> {
  const mint = new PublicKey(coin.mint);
  const mintInfo = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const tf = getTransferFeeConfig(mintInfo);
  if (!tf) return { skipped: "no transfer fee extension" };
  if (!tf.withdrawWithheldAuthority.equals(auth.publicKey)) return { skipped: "rewards wallet is not the withdraw authority" };

  // every token account of the mint we can see: holders, withheld balances, and what to exclude
  const pool = await readPool(conn, new PublicKey(coin.pool_id));
  const vaultAKey = getPdaLaunchpadVaultId(ids(network).program, new PublicKey(coin.pool_id), mint).publicKey;
  const vaultA = vaultAKey.toBase58();
  const cpmm = cpmmPoolId(network, mint);
  const ourAta = getAssociatedTokenAddressSync(mint, auth.publicKey, false, TOKEN_2022_PROGRAM_ID).toBase58();
  const cpmmVaults = cpmm.map((p) => getPdaVault(ids(network).cpmmProgram, p, mint).publicKey);
  const { accounts: parsed } = await tokenAccountsForMint(conn, db, mint, true, [vaultAKey, ...cpmmVaults]);
  const withheldAccounts = parsed.filter((p) => (getTransferFeeAmount(p.acc)?.withheldAmount ?? 0n) > 0n);
  const sigs: string[] = [];

  // 1. harvest withheld tokens into the mint (permissionless), 20 accounts per tx
  for (let i = 0; i < withheldAccounts.length; i += 20) {
    const sig = await harvestWithheldTokensToMint(conn, auth, mint, withheldAccounts.slice(i, i + 20).map((p) => p.pubkey), { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    sigs.push(sig);
  }
  const mintAfter = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const withheld = getTransferFeeConfig(mintAfter)?.withheldAmount ?? 0n;
  // tokens already in our account were withdrawn by an earlier run that was cut off before it sold them
  const ataKey = new PublicKey(ourAta);
  const leftover = await tokenBalance(conn, ataKey);
  const supply = BigInt(coin.supply);
  if (Number(withheld + leftover) / Number(supply) < MIN_WITHHELD_SHARE) return { skipped: `withheld ${withheld} below threshold` };

  // 2. withdraw to the rewards wallet
  if (withheld > 0n) {
    const dest = await getOrCreateAssociatedTokenAccount(conn, auth, mint, auth.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
    sigs.push(await withdrawWithheldTokensFromMint(conn, auth, mint, dest.address, auth, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID));
  }
  // The account only ever receives withheld fees, so all of it is sold: this run's withdrawal plus anything a cut-off run left.
  const have = await tokenBalance(conn, ataKey);
  if (have <= 0n) return { skipped: "nothing withdrawn" };

  // 3. sell for SOL on the coin's market
  const before = await conn.getBalance(auth.publicKey, "confirmed");
  const sdk = await loadRaydium(conn, auth, network);
  await sdk.account.fetchWalletTokenAccounts({ forceUpdate: true });
  if (pool && !curveComplete(pool.status)) {
    const { execute } = await sdk.launchpad.sellToken({ programId: ids(network).program, mintA: mint, mintAProgram: TOKEN_2022_PROGRAM_ID, sellAmount: new BN(have.toString()), slippage: new BN(1000), txVersion: sdkTxVersion });
    sigs.push((await execute({ sendAndConfirm: true })).txId);
  } else {
    const poolId = (await firstExisting(conn, cpmm))?.toBase58();
    if (!poolId) return { skipped: "graduated but CPMM pool not found yet" };
    const { poolInfo, poolKeys, computePoolInfo } = await sdk.cpmm.getPoolInfoFromRpc(poolId);
    const baseIn = poolInfo.mintA.address === mint.toBase58();
    const amountIn = new BN(have.toString());
    const q = sdk.cpmm.computeSwapAmount({ pool: computePoolInfo, amountIn, outputMint: WSOL, slippage: 0.1, swapBaseIn: true });
    const { execute } = await sdk.cpmm.swap({ poolInfo, poolKeys, inputAmount: amountIn, swapResult: q.swapResult, baseIn, slippage: 0.1, txVersion: sdkTxVersion });
    sigs.push((await execute({ sendAndConfirm: true })).txId);
  }
  await new Promise((r) => setTimeout(r, 1500));
  const after = await conn.getBalance(auth.publicKey, "confirmed");
  const carryKey = `reward_carry:${coin.mint}`;
  const carry = (await kv.get<{ lamports: number }>(db, carryKey))?.lamports ?? 0;
  const proceeds = Math.max(0, after - before) + carry;
  // Owed to holders from here on. Saved before any payout, so a run cut off now pays it on the next run.
  await kv.set(db, carryKey, { lamports: proceeds });
  if (proceeds < MIN_PAYOUT_LAMPORTS) return { skipped: `proceeds ${proceeds} lamports carried` };

  // 4. pay holders pro rata (token accounts of real wallets; pool and AMM vaults and our own account excluded)
  const exclude = new Set([vaultA, ourAta, ...cpmm.map((p) => p.toBase58()), ...cpmmVaults.map((p) => p.toBase58())]);
  const holders = parsed
    .filter((p) => !exclude.has(p.pubkey.toBase58()) && p.acc.amount > 0n && !p.acc.owner.toBase58().startsWith("DRay"))
    .sort((a, b) => (a.acc.amount > b.acc.amount ? -1 : 1))
    .slice(0, MAX_HOLDERS);
  const total = holders.reduce((s, h) => s + h.acc.amount, 0n);
  if (total === 0n) return { skipped: "no holders" };
  const payouts = holders
    .map((h) => ({ to: h.acc.owner, lamports: Number((BigInt(proceeds) * h.acc.amount) / total) }))
    .filter((p) => p.lamports >= MIN_PAYOUT_LAMPORTS);
  let paid = 0;
  let sent = 0;
  try {
    for (let i = 0; i < payouts.length; i += BATCH) {
      const batch = payouts.slice(i, i + BATCH);
      const tx = new Transaction();
      for (const p of batch) tx.add(SystemProgram.transfer({ fromPubkey: auth.publicKey, toPubkey: p.to, lamports: p.lamports }));
      const amount = batch.reduce((s, p) => s + p.lamports, 0);
      // Taken off what is owed before sending: if the send fails without saying whether it landed, holders are
      // short this batch until it is looked into, but a later run can never pay it a second time.
      await kv.set(db, carryKey, { lamports: proceeds - paid - amount });
      sigs.push(await sendAndConfirmTransaction(conn, tx, [auth], { commitment: "confirmed" }));
      paid += amount; sent += batch.length;
    }
  } catch (e) {
    await db.query("insert into rewards (mint, withheld_base, sol_lamports, holders, sigs, status) values ($1,$2,$3,$4,$5::jsonb,'partial')", [coin.mint, have.toString(), paid, sent, JSON.stringify(sigs)]);
    throw e;
  }
  await db.query("insert into rewards (mint, withheld_base, sol_lamports, holders, sigs) values ($1,$2,$3,$4,$5::jsonb)", [coin.mint, have.toString(), paid, payouts.length, JSON.stringify(sigs)]);
  log("paid", coin.mint, payouts.length, "holders", paid / LAMPORTS_PER_SOL, "SOL");
  return { holders: payouts.length, sol: paid / LAMPORTS_PER_SOL, sigs };
}

/** Token balance of an account, 0 when it does not exist yet. */
async function tokenBalance(conn: Connection, account: PublicKey): Promise<bigint> {
  try { return (await getAccount(conn, account, "confirmed", TOKEN_2022_PROGRAM_ID)).amount; } catch { return 0n; }
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
  let where = "";
  if (mint) { params.push(mint); where = " where r.mint = $2"; }
  return db.query<{ id: number; mint: string; symbol: string; run_at: string; withheld_base: string; sol_lamports: string; holders: number; sigs: string[] }>(
    `select r.id, r.mint, c.symbol, r.run_at, r.withheld_base, r.sol_lamports, r.holders, r.sigs from rewards r join coins c on c.mint = r.mint${where} order by r.run_at desc limit $1`, params);
}
