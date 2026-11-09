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

const INDEXER_LEASE = "lock:indexer";
/**
 * How long the lease lasts without renewal. A pass renews it before every coin and every stored chunk, so this only
 * needs to cover one step; it is also longer than the 60 s the index routes may run, so a pass Vercel cuts off
 * frees it within two minutes.
 */
const INDEXER_LEASE_MS = 120_000;

/** Thrown when a pass finds its lease has passed to another pass; the pass stops before writing anything more. */
export class LeaseLost extends Error { constructor(k: string) { super(`lease ${k} lost`); } }

/** One pass. Safe to call every minute. */
export async function indexOnce(db: Db, connection: Connection, network: Network = NETWORK, opts: { maxCoins?: number; now?: number } = {}): Promise<IndexStats> {
  const now = opts.now ?? Date.now();
  const stats: IndexStats = { pools: 0, newCoins: 0, trades: 0, readings: 0, graduations: 0, errors: [] };
  // The daily cron and the traffic tick can start a pass at the same moment; the lease lets only one run.
  const token = await kv.lease(db, INDEXER_LEASE, INDEXER_LEASE_MS);
  if (!token) { stats.errors.push("locked"); return stats; }
  const alive = async () => { if (!(await kv.renew(db, INDEXER_LEASE, token))) throw new LeaseLost(INDEXER_LEASE); };
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
      await alive();
      try {
        const pool = byMint.get(coin.mint);
        const state = pool?.state ?? (await readPool(connection, new PublicKey(coin.pool_id)));
        if (!state) continue;
        const n = await syncTrades(db, connection, coin, state, network, alive);
        stats.trades += n;
        // Stats and readings wait until every trade up to now is stored, so no checkpoint is sealed on a partial record.
        const caughtUp = await tradesCaughtUp(db, coin.mint);
        if (caughtUp) await updateStats(db, coin, state, now);
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
        if (caughtUp) stats.readings += await gradeCoin(db, coin, history, tiers, now);
      } catch (e) {
        if (e instanceof LeaseLost) throw e;
        stats.errors.push(`sync ${coin.mint}: ${(e as Error).message}`);
      }
    }

    history.prune(now);
    // Fenced: a pass that lost its lease writes none of these over the pass that took over.
    const fenced = async (k: string, v: unknown) => { if (!(await kv.setFenced(db, k, v, INDEXER_LEASE, token))) throw new LeaseLost(INDEXER_LEASE); };
    await fenced("history", history.toJSON());
    await fenced("tiers", tiers.toJSON());
    await fenced("indexer_last", { at: now, ...stats });
    return stats;
  } finally {
    await kv.release(db, INDEXER_LEASE, token);
  }
}

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

/** Signatures per getSignaturesForAddress page (the RPC maximum) and how many pages one pass may read back. */
const SIG_PAGE = 1000;
const MAX_SIG_PAGES = 10;
/** Transactions fetched and stored per step; the cursor moves after each step, so a pass cut off midway keeps its progress. */
const TX_CHUNK = 100;
/** Passes that may find a landed transaction missing from the RPC before the cursor moves past it into the retry queue. */
const MISSING_TX_TRIES = 5;
/**
 * Later passes that ask again for a queued transaction, and the most queued per coin. Past either, the signature
 * moves to `sig_dead:<mint>` (logged), which keeps it for a manual backfill: `npm run trades:backfill [mint]`.
 */
const RETRY_TX_TRIES = 50;
const RETRY_TX_MAX = 200;
const DEAD_TX_MAX = 5_000;

/** Backfill: puts every dead-lettered signature of `mint` back in its retry queue; returns how many. */
export async function requeueDead(db: Db, mint: string): Promise<number> {
  const dead = (await kv.get<string[]>(db, `sig_dead:${mint}`)) ?? [];
  if (!dead.length) return 0;
  const retry = (await kv.get<{ sig: string; tries: number }[]>(db, `sig_retry:${mint}`)) ?? [];
  const have = new Set(retry.map((r) => r.sig));
  await kv.set(db, `sig_retry:${mint}`, [...retry, ...dead.filter((d) => !have.has(d)).map((sig) => ({ sig, tries: 0 }))]);
  await kv.del(db, `sig_dead:${mint}`);
  return dead.length;
}

async function deadLetter(db: Db, mint: string, sigs: string[]) {
  if (!sigs.length) return;
  const key = `sig_dead:${mint}`;
  const dead = (await kv.get<string[]>(db, key)) ?? [];
  await kv.set(db, key, [...new Set([...dead, ...sigs])].slice(-DEAD_TX_MAX));
  log("trades:", sigs.length, "signature(s) for", mint, "still missing after retries; kept in", key, "for backfill:", sigs.join(", "));
}

/**
 * True when every landed trade up to the newest signature seen is stored: no long backlog is still being read
 * (`sig_scan:<mint>`) and the cursor is not held before a transaction the RPC has not served (`sig_missing:<mint>`).
 */
export async function tradesCaughtUp(db: Db, mint: string): Promise<boolean> {
  const rows = await db.query("select 1 from kv where k = any($1::text[])", [[`sig_scan:${mint}`, `sig_missing:${mint}`]]);
  return rows.length === 0;
}

type SigInfo = Awaited<ReturnType<Connection["getSignaturesForAddress"]>>[number];

/**
 * Pull every signature on the pool since the last one seen and turn them into trades from token-balance deltas on
 * the pool vaults. Pages back until it reaches the last signature seen (a quiet site can go hours between passes,
 * and a busy coin can see more than one page between two), then stores oldest first, moving the cursor as it goes.
 *
 * The cursor (`last_sig:<mint>`) only ever moves past signatures that were stored or are known not to be trades, so
 * nothing is skipped: when more than MAX_SIG_PAGES pages are waiting, the pass saves where it stopped reading
 * (`sig_scan:<mint>`) and the next pass reads on from there until it reaches the cursor; when the RPC has not got a
 * landed transaction yet, the cursor stops just before it and a later pass asks again. One still missing after
 * MISSING_TX_TRIES passes goes into a retry queue (`sig_retry:<mint>`) before the cursor moves past it, so the coin
 * is not held up and the trade is still stored if the RPC serves it later.
 */
export async function syncTrades(
  db: Db, connection: Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">, coin: CoinRow & { last_sig: string | null },
  state: PoolState, network: Network, alive: () => Promise<void> = async () => {},
) {
  const poolId = new PublicKey(coin.pool_id);
  const until = coin.last_sig ?? null;
  const keys: TradeKeys = {
    vaultA: state.vaultA.toBase58(), vaultB: state.vaultB.toBase58(),
    auth: getPdaLaunchpadAuth(ids(network).program).publicKey.toBase58(),
    creatorVault: getPdaCreatorVault(ids(network).program, state.creator, WSOL).publicKey.toBase58(),
    creatorVaultAuth: getPdaCreatorFeeVaultAuth(ids(network).program).publicKey.toBase58(),
    platformVault: getPdaPlatformVault(ids(network).program, state.platformId, WSOL).publicKey.toBase58(),
    platformVaultAuth: getPdaPlatformFeeVaultAuth(ids(network).program).publicKey.toBase58(),
    mint: coin.mint, supply: coin.supply,
  };
  const store = async (tx: ParsedTransactionWithMeta) => {
    if (tx.meta?.err) return false;
    const t = parseTrade(tx, keys);
    if (!t) return false;
    const price = t.tokenBase > 0n ? (Number(t.solLamports) / LAMPORTS) / (Number(t.tokenBase) / 10 ** coin.decimals) : 0;
    await db.query(
      `insert into trades (sig, mint, slot, ts, side, wallet, sol_lamports, token_base, price_sol, referrer)
       values ($1,$2,$3,to_timestamp($4/1000.0),$5,$6,$7,$8,$9,$10) on conflict (sig) do nothing`,
      [t.sig, coin.mint, t.slot, t.ts, t.side, t.wallet, t.solLamports.toString(), t.tokenBase.toString(), price, t.referrer],
    );
    return true;
  };

  // Transactions the cursor already moved past while the RPC still lacked them: ask for them again.
  const retryKey = `sig_retry:${coin.mint}`;
  let retry = (await kv.get<{ sig: string; tries: number }[]>(db, retryKey)) ?? [];
  let stored = 0;
  if (retry.length) {
    const fetched = await connection.getParsedTransactions(retry.map((r) => r.sig), { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    await alive();
    const left: typeof retry = [], dead: string[] = [];
    for (const [j, r] of retry.entries()) {
      const tx = fetched[j] ?? null;
      if (tx) { if (await store(tx)) stored++; continue; }
      if (r.tries + 1 >= RETRY_TX_TRIES) dead.push(r.sig);
      else left.push({ sig: r.sig, tries: r.tries + 1 });
    }
    await deadLetter(db, coin.mint, dead);
    retry = left;
    if (retry.length) await kv.set(db, retryKey, retry); else await kv.del(db, retryKey);
  }
  const scanKey = `sig_scan:${coin.mint}`;
  const scan = await kv.get<{ before: string; until: string | null }>(db, scanKey);
  // A saved scan only holds while the cursor it was reading towards is unchanged.
  let before: string | undefined = scan && scan.until === until ? scan.before : undefined;
  const sigs: SigInfo[] = [];
  let reached = false;
  for (let page = 0; page < MAX_SIG_PAGES; page++) {
    const batch = await connection.getSignaturesForAddress(poolId, { limit: SIG_PAGE, until: until ?? undefined, before }, "confirmed");
    sigs.push(...batch);
    if (batch.length < SIG_PAGE) { reached = true; break; }
    before = batch[batch.length - 1].signature;
  }
  // Ten full pages may end exactly at the cursor: look one signature further before calling it unfinished.
  if (!reached) reached = (await connection.getSignaturesForAddress(poolId, { limit: 1, until: until ?? undefined, before }, "confirmed")).length === 0;
  await alive();
  if (!reached) {
    // Too many to read in one pass. Nothing new is stored until the oldest are in hand: the next pass reads on from here.
    await kv.set(db, scanKey, { before, until });
    log("trades:", coin.mint, "has more than", sigs.length, "new signatures; reading on next pass");
    return stored;
  }
  if (scan) await kv.del(db, scanKey);
  if (!sigs.length) return stored;
  sigs.reverse(); // oldest first
  const missingKey = `sig_missing:${coin.mint}`;
  for (let i = 0; i < sigs.length; i += TX_CHUNK) {
    const chunk = sigs.slice(i, i + TX_CHUNK);
    const ok = chunk.filter((s) => !s.err);
    const fetched = ok.length ? await connection.getParsedTransactions(ok.map((s) => s.signature), { maxSupportedTransactionVersion: 0, commitment: "confirmed" }) : [];
    const txBySig = new Map(ok.map((s, j) => [s.signature, fetched[j] ?? null]));
    await alive();
    let cursor: string | null = null; // the newest signature of this chunk that is fully handled
    let stalled = false;
    for (const s of chunk) {
      if (!s.err) {
        const tx = txBySig.get(s.signature) ?? null;
        if (!tx) {
          // Landed but not served yet (lagging RPC node). Stop before it so a later pass retries; give up after a few.
          const miss = await kv.get<{ sig: string; tries: number }>(db, missingKey);
          const tries = miss?.sig === s.signature ? miss.tries + 1 : 1;
          if (tries < MISSING_TX_TRIES) {
            await kv.set(db, missingKey, { sig: s.signature, tries });
            stalled = true;
            break;
          }
          // Queue it before the cursor passes it, so a later pass still stores it once the RPC has it.
          log("trades:", s.signature, "for", coin.mint, "still missing after", tries, "passes; moving on and retrying it later");
          if (!retry.some((r) => r.sig === s.signature)) {
            retry = [...retry, { sig: s.signature, tries: 0 }];
            if (retry.length > RETRY_TX_MAX) await deadLetter(db, coin.mint, retry.splice(0, retry.length - RETRY_TX_MAX).map((r) => r.sig));
          }
          await kv.set(db, retryKey, retry);
          await kv.del(db, missingKey);
        } else if (await store(tx)) stored++;
      }
      cursor = s.signature;
    }
    if (cursor) await kv.set(db, `last_sig:${coin.mint}`, { sig: cursor });
    if (stalled) return stored;
  }
  await kv.del(db, missingKey); // nothing is held back any more
  return stored;
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
