// The indexer: reads our platform's LaunchLab pools and their trades from RPC, keeps the coins table current,
// and seals the Assay readings (launch, 1 minute, 5 minutes). Runs from a cron route or a script; it is re-entrant
// and keeps its own small state (history, tier window) in the kv table so a serverless run can pick up where the last left off.
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getPdaCreatorVault, getPdaCreatorFeeVaultAuth, getPdaLaunchpadAuth, getPdaPlatformVault, getPdaPlatformFeeVaultAuth } from "@raydium-io/raydium-sdk-v2";
import type { Db } from "./db";
import { kv } from "./db";
import { readPlatformPools, readPool, poolStatus, curveComplete, curvePriceSol, bondingProgress, marketCapSol, type PoolState, ids } from "./raydium";
import { NETWORK, WSOL, type Network } from "./chain";
import { readOnchainMeta, readOffchainMeta, safeImage } from "./metadata";
import { History, type HistoryJson } from "./grade/history";
import { TierWindow, type TierWindowJson, score, tierOf, signals, CHECKPOINTS, MODEL_VERSION, type Checkpoint } from "./grade/assay";
import { liveFeatures, suffix, type LiveTrade } from "./grade/features";
import { nameFeatures } from "./grade/text";
import { seal } from "./ledger";

const LAMPORTS = 1e9;
const CHECK_AT: Record<Exclude<Checkpoint, "launch">, number> = { m1: 60, m5: 300 };
/** A reading that could not be made within this many seconds of its time is not made at all. */
const CHECK_GRACE: Record<Exclude<Checkpoint, "launch">, number> = { m1: 180, m5: 300 };
/** A launch reading older than this is not sealed: the coin could already have filled its curve. */
const LAUNCH_GRACE = 180;

export interface CoinRow {
  mint: string; pool_id: string; name: string; symbol: string; uri: string; image: string | null; creator: string;
  created_at: string; create_sig: string | null; decimals: number; supply: string; status: string; graduated_at: string | null;
  token_2022: boolean; transfer_fee_bps: number; dev_buy_pct: number; initial_buy_sol: number; last_sig?: string | null;
}

export interface IndexStats { pools: number; newCoins: number; trades: number; readings: number; graduations: number; errors: string[] }

const log = (...a: unknown[]) => { if (process.env.INDEXER_LOG !== "0") console.log("[indexer]", ...a); };

/** One pass. Safe to call every minute. */
export async function indexOnce(db: Db, connection: Connection, network: Network = NETWORK, opts: { maxCoins?: number; now?: number } = {}): Promise<IndexStats> {
  const now = opts.now ?? Date.now();
  const stats: IndexStats = { pools: 0, newCoins: 0, trades: 0, readings: 0, graduations: 0, errors: [] };
  if (!(await lock(db, now))) { stats.errors.push("locked"); return stats; }
  try {
    const history = History.from((await kv.get<HistoryJson>(db, "history")) ?? new History().toJSON());
    const tiers = TierWindow.from((await kv.get<TierWindowJson>(db, "tiers")) ?? new TierWindow().toJSON());

    const pools = await readPlatformPools(connection, network);
    stats.pools = pools.length;
    const known = new Set((await db.query<{ mint: string }>("select mint from coins")).map((r) => r.mint));

    // 1. new coins
    for (const { poolId, state } of pools) {
      const mint = state.mintA.toBase58();
      if (known.has(mint)) continue;
      try {
        await insertCoin(db, connection, poolId, state, network, now);
        known.add(mint); stats.newCoins++;
      } catch (e) { stats.errors.push(`insert ${mint}: ${(e as Error).message}`); }
    }

    // 2. trades + stats for coins that can still move: live ones, and graduated ones for 24 h after graduation
    const active = await db.query<CoinRow & { last_sig: string | null }>(
      `select c.*, (select v->>'sig' from kv where k = 'last_sig:' || c.mint) as last_sig from coins c
        where c.network = $1 and (c.graduated_at is null or c.graduated_at > now() - interval '24 hours')
        order by c.created_at desc limit $2`,
      [network, opts.maxCoins ?? 200],
    );
    const byMint = new Map(pools.map((p) => [p.state.mintA.toBase58(), p]));
    for (const coin of active) {
      try {
        const pool = byMint.get(coin.mint);
        const state = pool?.state ?? (await readPool(connection, new PublicKey(coin.pool_id)));
        if (!state) continue;
        const n = await syncTrades(db, connection, coin, state, network);
        stats.trades += n;
        await updateStats(db, coin, state, now);
        const st = poolStatus(state.status);
        if (curveComplete(state.status) && !coin.graduated_at) {
          // A coin first seen already full graduated at its last curve trade, not when we happened to look.
          await db.query(
            `update coins set status = $2, updated_at = now(),
                    graduated_at = coalesce((select max(ts) from trades where mint = $1), now())
              where mint = $1 and graduated_at is null`, [coin.mint, st]);
          history.recordGraduation(coin.name, coin.symbol, coin.creator, now);
          stats.graduations++;
          log("graduated", coin.symbol, coin.mint);
        } else if (st !== coin.status && st !== "unknown") {
          await db.query("update coins set status = $2, updated_at = now() where mint = $1", [coin.mint, st]);
        }
        stats.readings += await gradeCoin(db, coin, history, tiers, now);
      } catch (e) { stats.errors.push(`sync ${coin.mint}: ${(e as Error).message}`); }
    }

    history.prune(now);
    await kv.set(db, "history", history.toJSON());
    await kv.set(db, "tiers", tiers.toJSON());
    await kv.set(db, "indexer_last", { at: now, ...stats });
    return stats;
  } finally {
    await unlock(db);
  }
}

async function lock(db: Db, now: number) {
  const cur = await kv.get<{ at: number }>(db, "indexer_lock");
  if (cur && now - cur.at < 55_000) return false;
  await kv.set(db, "indexer_lock", { at: now });
  return true;
}
const unlock = (db: Db) => kv.set(db, "indexer_lock", { at: 0 });

async function insertCoin(db: Db, connection: Connection, poolId: PublicKey, state: PoolState, network: Network, now: number) {
  const mint = state.mintA;
  const token2022 = state.mintProgramFlag === 1;
  const meta = (await readOnchainMeta(connection, mint, token2022)) ?? { name: "", symbol: "", uri: "" };
  const off = meta.uri ? await readOffchainMeta(meta.uri) : null;
  // creation time and signature: the oldest signature on the pool account
  const sigs = await connection.getSignaturesForAddress(poolId, { limit: 1000 }, "confirmed");
  const first = sigs.at(-1);
  const createdAt = first?.blockTime ? first.blockTime * 1000 : now;
  let transferFeeBps = 0;
  if (token2022) {
    try {
      const { getMint, getTransferFeeConfig } = await import("@solana/spl-token");
      const m = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
      const tf = getTransferFeeConfig(m);
      if (tf) transferFeeBps = tf.newerTransferFee.transferFeeBasisPoints;
    } catch { /* no extension */ }
  }
  await db.query(
    `insert into coins (mint, pool_id, network, name, symbol, uri, image, description, socials, creator, created_at, create_sig, decimals, supply, total_sell,
       fund_target_lamports, token_2022, transfer_fee_bps, status, price_sol, mcap_sol, real_b_lamports, progress)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,to_timestamp($11/1000.0),$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     on conflict (mint) do nothing`,
    [
      mint.toBase58(), poolId.toBase58(), network, meta.name.slice(0, 64), meta.symbol.slice(0, 16), meta.uri.slice(0, 500), safeImage(off?.image),
      off?.description?.slice(0, 1000) ?? null, JSON.stringify({ website: off?.website ?? null, twitter: off?.twitter ?? null, telegram: off?.telegram ?? null, discord: off?.discord ?? null }),
      state.creator.toBase58(), createdAt, first?.signature ?? null, state.mintDecimalsA, state.supply.toString(), state.totalSellA.toString(),
      state.totalFundRaisingB.toString(), token2022, transferFeeBps, poolStatus(state.status), curvePriceSol(state), marketCapSol(state), state.realB.toString(), bondingProgress(state),
    ],
  );
  log("new coin", meta.symbol, mint.toBase58());
}

interface ParsedTrade { sig: string; slot: number; ts: number; side: "buy" | "sell"; wallet: string; solLamports: bigint; tokenBase: bigint; referrer: string | null }

/** Pull new signatures on the pool and turn them into trades from token-balance deltas on the pool vaults. */
async function syncTrades(db: Db, connection: Connection, coin: CoinRow & { last_sig: string | null }, state: PoolState, network: Network) {
  const poolId = new PublicKey(coin.pool_id);
  const sigs = await connection.getSignaturesForAddress(poolId, { limit: 200, until: coin.last_sig ?? undefined }, "confirmed");
  if (!sigs.length) return 0;
  const ok = sigs.filter((s) => !s.err);
  const txs = await connection.getParsedTransactions(ok.map((s) => s.signature), { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const vaultA = state.vaultA.toBase58(), vaultB = state.vaultB.toBase58();
  const auth = getPdaLaunchpadAuth(ids(network).program).publicKey.toBase58();
  const creatorVaultAuth = getPdaCreatorFeeVaultAuth(ids(network).program).publicKey.toBase58();
  const creatorVault = getPdaCreatorVault(ids(network).program, state.creator, WSOL).publicKey.toBase58();
  const platformVault = getPdaPlatformVault(ids(network).program, state.platformId, WSOL).publicKey.toBase58();
  const platformVaultAuth = getPdaPlatformFeeVaultAuth(ids(network).program).publicKey.toBase58();
  const trades: ParsedTrade[] = [];
  for (const tx of txs) {
    if (!tx || tx.meta?.err) continue;
    const t = parseTrade(tx, { vaultA, vaultB, auth, creatorVault, creatorVaultAuth, platformVault, platformVaultAuth, mint: coin.mint, supply: coin.supply });
    if (t) trades.push(t);
  }
  // oldest first
  trades.reverse();
  for (const t of trades) {
    const price = t.tokenBase > 0n ? (Number(t.solLamports) / LAMPORTS) / (Number(t.tokenBase) / 10 ** coin.decimals) : 0;
    await db.query(
      `insert into trades (sig, mint, slot, ts, side, wallet, sol_lamports, token_base, price_sol, referrer)
       values ($1,$2,$3,to_timestamp($4/1000.0),$5,$6,$7,$8,$9,$10) on conflict (sig) do nothing`,
      [t.sig, coin.mint, t.slot, t.ts, t.side, t.wallet, t.solLamports.toString(), t.tokenBase.toString(), price, t.referrer],
    );
  }
  await kv.set(db, `last_sig:${coin.mint}`, { sig: sigs[0].signature });
  return trades.length;
}

export interface TradeKeys { vaultA: string; vaultB: string; auth: string; creatorVault: string; creatorVaultAuth: string; platformVault: string; platformVaultAuth: string; mint: string; supply?: string }

/**
 * A trade is a transaction where the pool's two vaults move in opposite directions: SOL in and tokens out is a buy,
 * tokens in and SOL out is a sell. The creation transaction (supply in, then the dev buy) and the migration
 * (both vaults drained) are handled by the same rule. Amounts are what reached or left the curve, net of fees.
 */
export function parseTrade(tx: ParsedTransactionWithMeta, k: TradeKeys): ParsedTrade | null {
  const sig = tx.transaction.signatures[0];
  const keys = tx.transaction.message.accountKeys.map((a) => a.pubkey.toBase58());
  const pre = tx.meta?.preTokenBalances ?? [], post = tx.meta?.postTokenBalances ?? [];
  const bal = (list: typeof pre, idx: number) => list.find((b) => b.accountIndex === idx);
  const delta = (idx: number) => {
    const a = bal(pre, idx), b = bal(post, idx);
    return BigInt(b?.uiTokenAmount.amount ?? "0") - BigInt(a?.uiTokenAmount.amount ?? "0");
  };
  const iA = keys.indexOf(k.vaultA), iB = keys.indexOf(k.vaultB);
  if (iA < 0 || iB < 0) return null;
  const dA = delta(iA), dB = delta(iB);
  // creation tx: vault A is created and filled with the supply in the same tx, so the dev buy is supply - what stayed
  const createdVaultA = !bal(pre, iA);
  if (createdVaultA) {
    if (dB <= 0n || !k.supply) return null; // created without a dev buy: nothing traded
  } else {
    if (dA === 0n || dB === 0n) return null;
    if ((dA < 0n) === (dB < 0n)) return null; // same direction: migration or something that is not a trade
  }
  const side: "buy" | "sell" = dB > 0n ? "buy" : "sell";
  const wallet = keys[0];
  // the caller's share lands in a WSOL account owned by the caller: the only other WSOL account that gains in the tx
  let referrer: string | null = null;
  for (const b of post) {
    if (b.mint !== "So11111111111111111111111111111111111111112") continue;
    const owner = b.owner ?? ""; const idx = b.accountIndex; const acct = keys[idx];
    if (!owner || owner === wallet || owner === k.auth || owner === k.creatorVaultAuth || owner === k.platformVaultAuth) continue;
    if (acct === k.vaultB || acct === k.creatorVault || acct === k.platformVault) continue;
    if (delta(idx) > 0n) { referrer = owner; break; }
  }
  const solLamports = dB < 0n ? -dB : dB;
  const tokenBase = createdVaultA && k.supply ? BigInt(k.supply) - BigInt(bal(post, iA)?.uiTokenAmount.amount ?? "0") : dA < 0n ? -dA : dA;
  if (tokenBase <= 0n) return null;
  return { sig, slot: tx.slot, ts: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000, side, wallet, solLamports, tokenBase, referrer };
}

async function updateStats(db: Db, coin: CoinRow, state: PoolState, now: number) {
  const agg = await db.one<{ n: number; vol: number; vol24: number; last: string | null }>(
    `select count(*)::int as n, coalesce(sum(sol_lamports),0)/1e9 as vol,
            coalesce(sum(sol_lamports) filter (where ts > now() - interval '24 hours'),0)/1e9 as vol24, max(ts) as last
       from trades where mint = $1`,
    [coin.mint],
  );
  // dev buy = the trade in the creation transaction (or the first trade by the creator within 5 s of creation)
  const dev = await db.one<{ sol: number; tokens: number }>(
    `select coalesce(sum(sol_lamports),0)/1e9 as sol, coalesce(sum(token_base),0) as tokens from trades
      where mint = $1 and side = 'buy' and wallet = $2 and (sig = $3 or ts <= $4::timestamptz + interval '5 seconds')`,
    [coin.mint, coin.creator, coin.create_sig ?? "", coin.created_at],
  );
  const supply = Number(coin.supply);
  const devPct = supply > 0 ? (Number(dev?.tokens ?? 0) / supply) * 100 : 0;
  await db.query(
    `update coins set price_sol=$2, mcap_sol=$3, real_b_lamports=$4, progress=$5, vol_sol=$6, vol_24h_sol=$7, trades=$8, last_trade_at=$9,
        dev_buy_pct=$10, initial_buy_sol=$11, updated_at=now() where mint=$1`,
    [coin.mint, curvePriceSol(state), marketCapSol(state), state.realB.toString(), bondingProgress(state), Number(agg?.vol ?? 0), Number(agg?.vol24 ?? 0), agg?.n ?? 0, agg?.last ?? null, devPct, Number(dev?.sol ?? 0)],
  );
  void now;
}

/** Seal whichever readings are due for this coin. Returns how many were sealed. */
async function gradeCoin(db: Db, coin: CoinRow, history: History, tiers: TierWindow, now: number) {
  const have = new Set((await db.query<{ checkpoint: string }>("select checkpoint from readings where mint = $1", [coin.mint])).map((r) => r.checkpoint));
  const createdAt = new Date(coin.created_at).getTime();
  const ageS = (now - createdAt) / 1000;
  let sealed = 0;
  // features that do not depend on trades
  const base = await baseFeatures(db, coin, history, createdAt);
  if (!have.has("launch")) {
    history.recordLaunch(coin.name, coin.symbol, coin.creator, createdAt);
    if (ageS > LAUNCH_GRACE) {
      // Seen too late (indexer down, backfill): the outcome may already be known, so no launch reading is sealed.
      tiers.add("launch", now);
      await db.query("insert into readings_skipped (mint, checkpoint, reason) values ($1,'launch','late') on conflict do nothing", [coin.mint]).catch(() => {});
    } else {
      sealed += await place(db, coin, "launch", base.features, base.word, tiers, now, null);
    }
    have.add("launch");
  }
  for (const cp of ["m1", "m5"] as const) {
    if (have.has(cp)) continue;
    const due = CHECK_AT[cp] + 8;
    if (ageS < due) continue;
    if (ageS > due + CHECK_GRACE[cp]) {
      // too late for an honest reading: the coin still counts in the hour's pool, ranked below every coin that was read
      tiers.add(cp, now);
      await db.query("insert into readings_skipped (mint, checkpoint, reason) values ($1,$2,'late') on conflict do nothing", [coin.mint, cp]).catch(() => {});
      continue;
    }
    const trades = await liveTrades(db, coin, createdAt);
    const m1 = liveFeatures(trades, 60);
    const f: Record<string, number | null> = { ...base.features, ...suffix(m1, "m1") };
    let live = m1;
    if (cp === "m5") { live = liveFeatures(trades, 300); Object.assign(f, suffix(live, "m5")); }
    sealed += await place(db, coin, cp, f, base.word, tiers, now, live);
  }
  return sealed;
}

async function baseFeatures(db: Db, coin: CoinRow, history: History, createdAt: number) {
  const n = history.narrative(coin.name, coin.symbol, createdAt);
  const word = history.pickWord(n._words, createdAt);
  const narrative = Object.fromEntries(Object.entries(n).filter(([k]) => !k.startsWith("_"))) as Record<string, number>;
  const creator = history.creatorFeatures(coin.creator, createdAt);
  // our own table is the creator's record on this launchpad
  const mine = await db.one<{ n24: number; grads: number; last: string | null }>(
    `select count(*) filter (where created_at >= $2::timestamptz - interval '24 hours' and created_at < $2::timestamptz)::int as n24,
            count(*) filter (where graduated_at is not null and created_at < $2::timestamptz)::int as grads,
            max(created_at) filter (where created_at < $2::timestamptz) as last
       from coins where creator = $1 and mint <> $3`,
    [coin.creator, coin.created_at, coin.mint],
  );
  const features: Record<string, number | null> = {
    is_mayhem: 0, is_cashback: coin.transfer_fee_bps > 0 ? 1 : 0,
    initial_buy_sol: Number(coin.initial_buy_sol ?? 0), dev_buy_pct: Number(coin.dev_buy_pct ?? 0),
    creator_launches_24h: Math.max(creator.creator_launches_24h, mine?.n24 ?? 0),
    secs_since_creator_last: mine?.last ? (createdAt - new Date(mine.last).getTime()) / 1000 : creator.secs_since_creator_last,
    creator_prior_grads: Math.max(creator.creator_prior_grads, mine?.grads ?? 0),
    ...narrative,
    ...nameFeatures(coin.name, coin.symbol, coin.uri, new Date(createdAt)),
  };
  return { features, word };
}

async function liveTrades(db: Db, coin: CoinRow, createdAt: number): Promise<LiveTrade[]> {
  const rows = await db.query<{ sig: string; ts: string; side: string; wallet: string; sol_lamports: string; token_base: string; price_sol: number }>(
    "select sig, ts, side, wallet, sol_lamports, token_base, price_sol from trades where mint = $1 order by ts, slot",
    [coin.mint],
  );
  const supply = Number(coin.supply);
  const first = rows.find((r) => r.sig !== coin.create_sig);
  const price0 = first ? Number(first.price_sol) : 0;
  return rows
    .filter((r) => r.sig !== coin.create_sig)
    .map((r) => ({
      s: (new Date(r.ts).getTime() - createdAt) / 1000,
      isBuy: r.side === "buy",
      wallet: r.wallet,
      share: supply > 0 ? Number(r.token_base) / supply : 0,
      sol: Number(r.sol_lamports) / LAMPORTS,
      priceRatio: price0 > 0 ? Number(r.price_sol) / price0 : null,
      byCreator: r.wallet === coin.creator,
    }));
}

async function place(db: Db, coin: CoinRow, cp: Checkpoint, f: Record<string, number | null>, word: string | null, tiers: TierWindow, now: number, live: Record<string, number> | null) {
  const s = score(cp, f);
  const { pct, n } = tiers.place(cp, s, now);
  const tier = tierOf(pct);
  const sig = signals({ features: f, live, word, transferFeeBps: coin.transfer_fee_bps });
  await seal(db, { t: now, mint: coin.mint, checkpoint: cp, score: s, pct, tier: tier.key, model: MODEL_VERSION, poolN: n, features: f, signals: sig });
  await db.query(
    `update coins set latest_tier = $2, latest_checkpoint = $3, flagged_at = case when $4 and flagged_at is null then now() else flagged_at end, updated_at = now() where mint = $1`,
    [coin.mint, tier.key, cp, tier.key === "top1" || tier.key === "top10"],
  );
  log("sealed", cp, coin.symbol, tier.key, `pool ${n}`);
  return 1;
}

export { CHECKPOINTS, TOKEN_PROGRAM_ID };
