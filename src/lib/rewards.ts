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
import { WSOL, type Network } from "./chain";

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

export async function runRewards(db: Db, conn: Connection, network: Network, opts: { maxCoins?: number; keypair?: Keypair } = {}): Promise<RewardsRunStats> {
  const auth = opts.keypair ?? loadRewardsKeypair();
  const out: RewardsRunStats = { coins: 0, paid: [], skipped: [], errors: [] };
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
  const supply = BigInt(coin.supply);
  if (Number(withheld) / Number(supply) < MIN_WITHHELD_SHARE) return { skipped: `withheld ${withheld} below threshold` };

  // 2. withdraw to the rewards wallet
  const dest = await getOrCreateAssociatedTokenAccount(conn, auth, mint, auth.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
  const heldBefore = dest.amount;
  sigs.push(await withdrawWithheldTokensFromMint(conn, auth, mint, dest.address, auth, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID));
  // only what was just withdrawn is sold; anything the wallet already held stays untouched
  const have = (await getAccount(conn, dest.address, "confirmed", TOKEN_2022_PROGRAM_ID)).amount - heldBefore;
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
  const carry = (await kv.get<{ lamports: number }>(db, `reward_carry:${coin.mint}`))?.lamports ?? 0;
  const proceeds = Math.max(0, after - before) + carry;
  if (proceeds < MIN_PAYOUT_LAMPORTS) { await kv.set(db, `reward_carry:${coin.mint}`, { lamports: proceeds }); return { skipped: `proceeds ${proceeds} lamports carried` }; }

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
  for (let i = 0; i < payouts.length; i += BATCH) {
    const tx = new Transaction();
    for (const p of payouts.slice(i, i + BATCH)) { tx.add(SystemProgram.transfer({ fromPubkey: auth.publicKey, toPubkey: p.to, lamports: p.lamports })); paid += p.lamports; }
    sigs.push(await sendAndConfirmTransaction(conn, tx, [auth], { commitment: "confirmed" }));
  }
  await kv.set(db, `reward_carry:${coin.mint}`, { lamports: proceeds - paid });
  await db.query("insert into rewards (mint, withheld_base, sol_lamports, holders, sigs) values ($1,$2,$3,$4,$5::jsonb)", [coin.mint, have.toString(), paid, payouts.length, JSON.stringify(sigs)]);
  log("paid", coin.mint, payouts.length, "holders", paid / LAMPORTS_PER_SOL, "SOL");
  return { holders: payouts.length, sol: paid / LAMPORTS_PER_SOL, sigs };
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
