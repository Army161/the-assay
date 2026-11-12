// The indexer: reads our platform's LaunchLab pools and their trades from RPC, keeps the coins table current,
// and seals the Assay readings (launch, 1 minute, 5 minutes). Runs from a cron route or a script; it is re-entrant
// and keeps its own small state (history, tier window) in the kv table so a serverless run can pick up where the last left off.
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { anchorDataBuf, getPdaCpiEvent, getPdaCreatorVault, getPdaCreatorFeeVaultAuth, getPdaLaunchpadAuth, getPdaPlatformVault, getPdaPlatformFeeVaultAuth } from "@raydium-io/raydium-sdk-v2";
import bs58 from "bs58";
import type { Db } from "./db";
import { kv, kvWriter, fenced, LeaseLost, type Fence, type KvWriter } from "./db";
import { readPlatformPools, readPool, poolStatus, curveComplete, curvePriceSol, bondingProgress, marketCapSol, type PoolState, ids } from "./raydium";
import { NETWORK, WSOL, MAX_TX_VERSION, LAUNCH, FEES, LAUNCHLAB, type Network } from "./chain";
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

export { LeaseLost };

/** One pass. Safe to call every minute. */
/**
 * How long one pass may spend before it stops taking new coins and saves (routes run for at most 300 s). A pass that
 * stops early leaves the remaining coins for the next pass; nothing is half-written.
 */
const PASS_BUDGET_MS = 180_000;
/** A pool that has not moved is still re-scanned this often, in case a signature listing lagged the pool state. */
export const FP_RESCAN_MS = 5 * 60_000;

export async function indexOnce(db: Db, connection: Connection, network: Network = NETWORK, opts: { maxCoins?: number; now?: number; budgetMs?: number } = {}): Promise<IndexStats> {
  const now = opts.now ?? Date.now();
  const stopAt = Date.now() + (opts.budgetMs ?? PASS_BUDGET_MS);
  const stats: IndexStats = { pools: 0, newCoins: 0, trades: 0, readings: 0, graduations: 0, errors: [] };
  // The daily cron and the traffic tick can start a pass at the same moment; the lease lets only one run.
  const token = await kv.lease(db, INDEXER_LEASE, INDEXER_LEASE_MS);
  if (!token) { stats.errors.push("locked"); return stats; }
  const alive = async () => { if (!(await kv.renew(db, INDEXER_LEASE, token))) throw new LeaseLost(INDEXER_LEASE); };
  // Every cursor, queue and history write and every sealed reading is fenced: refused once another pass holds the lease.
  const fence: Fence = { lease: INDEXER_LEASE, token };
  const w = kvWriter(db, fence);
  try {
    const history = History.from((await kv.get<HistoryJson>(db, "history")) ?? new History().toJSON());
    const tiers = TierWindow.from((await kv.get<TierWindowJson>(db, "tiers")) ?? new TierWindow().toJSON());

    const pools = await readPlatformPools(connection, network);
    stats.pools = pools.length;
    const known = new Set((await db.query<{ mint: string }>("select mint from coins")).map((r) => r.mint));
    for (const r of await db.query<{ k: string }>("select k from kv where k like 'unlisted:%'")) known.add(r.k.slice("unlisted:".length));

    // 1. new coins. Anyone can create a pool under our platform id with their own settings (another curve, a team
    // allocation, another quote token); only pools made the way our launch form makes them are listed and graded.
    for (const { poolId, state } of pools) {
      if (Date.now() > stopAt) break;
      const mint = state.mintA.toBase58();
      if (known.has(mint)) continue;
      const why = nonStandardPool(state, network);
      if (why) { await w.set(`unlisted:${mint}`, { pool: poolId.toBase58(), why }); known.add(mint); log("unlisted", mint, why); continue; }
      try {
        await insertCoin(db, connection, poolId, state, network, now);
        known.add(mint); stats.newCoins++;
      } catch (e) { stats.errors.push(`insert ${mint}: ${(e as Error).message}`); }
    }

    // 2. trades + stats for coins that can still move, and for any coin whose trades are not all in yet
    const active = await activeCoins(db, network, opts.maxCoins ?? 200);
    const byMint = new Map(pools.map((p) => [p.state.mintA.toBase58(), p]));
    for (const coin of active) {
      if (Date.now() > stopAt) { stats.errors.push("pass time budget reached; the rest wait for the next pass"); break; }
      await alive();
      await markVisited(db, coin.mint, fence);
      try {
        const pool = byMint.get(coin.mint);
        const state = pool?.state ?? (await readPool(connection, new PublicKey(coin.pool_id)));
        if (!state) continue;
        // A pool that has not moved since the last complete sync has no new trades: skip the signature scan, which is
        // the bulk of the RPC cost (every live coin would otherwise be scanned every pass, forever).
        const fp = poolFingerprint(state);
        // The pool read and the signature listing are not pinned to one slot, so a listing can lag the pool state it was
        // meant to cover. A skipped pool is therefore still re-scanned every few minutes to pick up anything it missed.
        const saved = await kv.get<{ fp: string; at?: number }>(db, `pool_fp:${coin.mint}`);
        const unchanged = saved?.fp === fp && now - (saved.at ?? 0) < FP_RESCAN_MS && (await tradesCaughtUp(db, coin.mint));
        if (!unchanged) {
          const n = await syncTrades(db, connection, coin, state, network, alive, w);
          stats.trades += n;
        }
        // Stats and readings wait until every trade up to now is stored, so no checkpoint is sealed on a partial record.
        const caughtUp = unchanged || (await tradesCaughtUp(db, coin.mint));
        if (caughtUp) await updateStats(db, coin, state, now, fence); // also ages the 24 h volume of quiet coins
        if (caughtUp && !unchanged) await w.set(`pool_fp:${coin.mint}`, { fp, at: now });
        const st = poolStatus(state.status);
        // Graduation is dated from the last stored trade, so it waits until every trade is in.
        if (curveComplete(state.status) && !coin.graduated_at && caughtUp) {
          // A coin first seen already full graduated at its last curve trade, not when we happened to look.
          const f = fenced(fence, 3);
          const grad = await db.query(
            `update coins set status = $2, updated_at = now(),
                    graduated_at = coalesce((select max(ts) from trades where mint = $1), now())
              where mint = $1 and graduated_at is null and ${f.sql} returning mint`, [coin.mint, st, ...f.params]);
          if (!grad.length) await alive(); // refused: stop here if the lease is gone
          history.recordGraduation(coin.name, coin.symbol, coin.creator, now);
          stats.graduations++;
          log("graduated", coin.symbol, coin.mint);
        } else if (st !== coin.status && st !== "unknown") {
          const f = fenced(fence, 3);
          await db.query(`update coins set status = $2, updated_at = now() where mint = $1 and ${f.sql}`, [coin.mint, st, ...f.params]);
        }
        // Before a reading is sealed, the stored trades must account for the pool exactly; the signature listing can lag
        // the pool, and a sealed reading can never be redone. On the curve they must add up to the pool's own sold count,
        // read fresh after the sync (see tradesCoverRealA); not the vault balance, which anyone can raise by sending
        // tokens to it. Once the curve is full it sold exactly its total, so the stored trades must add up to that.
        const covered = curveComplete(state.status)
          ? async () => tradesCoverSold(db, coin.mint)
          : async () => {
            const p = await readPool(connection, new PublicKey(coin.pool_id));
            return !!p && (await tradesCoverRealA(db, coin.mint, BigInt(p.realA.toString())));
          };
        if (caughtUp) stats.readings += await gradeCoin(db, coin, history, tiers, now, fence, covered);
      } catch (e) {
        if (e instanceof LeaseLost) throw e;
        stats.errors.push(`sync ${coin.mint}: ${(e as Error).message}`);
      }
    }

    history.prune(now);
    await w.set("history", history.toJSON());
    await w.set("tiers", tiers.toJSON());
    await w.set("indexer_last", { at: now, ...stats });
    return stats;
  } finally {
    await kv.release(db, INDEXER_LEASE, token);
  }
}

/** Why a pool is not one our launch form would make (null when it is). Pure: reads only the pool state. */
export function nonStandardPool(state: PoolState, network: Network): string | null {
  const base = (n: number) => BigInt(Math.round(n * 10 ** LAUNCH.decimals)).toString();
  if (!state.configId.equals(ids(network).globalConfig)) return "another curve config";
  if (!state.mintB.equals(WSOL)) return "not quoted in SOL";
  if (state.mintDecimalsA !== LAUNCH.decimals) return "other decimals";
  if (state.supply.toString() !== base(LAUNCH.supply)) return "other supply";
  if (state.totalSellA.toString() !== base(LAUNCH.totalSellA)) return "other curve size";
  const target = network === "mainnet" ? 85 : 1.5;
  if (state.totalFundRaisingB.toString() !== BigInt(Math.round(target * 1e9)).toString()) return "other graduation target";
  if (!state.vestingSchedule.totalLockedAmount.isZero()) return "team allocation locked in vesting";
  if (state.migrateType !== 1) return "does not migrate to the CPMM pool";
  return null;
}

/** What changes on every curve trade and at graduation. Equal fingerprints mean no trade happened in between. */
export function poolFingerprint(state: PoolState): string {
  return [state.status, state.realA.toString(), state.realB.toString(), state.supply.toString()].join(":");
}

/**
 * Coins a pass works on: live ones, graduated ones for 24 h after graduation, and any coin whose trades are not all
 * stored yet (a backlog, a held cursor or queued retries), however old, so a long backlog always finishes. When more
 * coins qualify than `limit`, coins under 10 minutes old (their launch, 1 and 5 minute readings are due) take up to
 * three quarters of the pass and older coins at least a quarter; each group goes by the pass that last visited it,
 * oldest visit first, so every coin gets its turn however many launches arrive. `limit` must be at least 2.
 */
export async function activeCoins(db: Db, network: Network, limit: number) {
  // Below 2 one group would hold the only place on every pass, so it is refused rather than starving the other.
  if (!Number.isInteger(limit) || limit < 2) throw new RangeError(`activeCoins: limit must be an integer of at least 2, got ${limit}`);
  const pick = (young: boolean) => db.query<CoinRow & { last_sig: string | null }>(
    `select c.*, (select v->>'sig' from kv where k = 'last_sig:' || c.mint) as last_sig from coins c
      where c.network = $1 and (c.graduated_at is null or c.graduated_at > now() - interval '24 hours'
            or exists (select 1 from kv where k in ('sig_scan:' || c.mint, 'sig_behind:' || c.mint, 'sig_missing:' || c.mint, 'sig_retry:' || c.mint)))
        and (c.created_at > now() - interval '10 minutes') = $3
      order by c.indexed_at asc, c.created_at desc limit $2`,
    [network, limit, young],
  );
  const [young, older] = await Promise.all([pick(true), pick(false)]);
  const reserve = Math.min(older.length, Math.max(1, Math.floor(limit / 4)));
  const y = young.slice(0, limit - reserve);
  return [...y, ...older.slice(0, limit - y.length)];
}

/** Notes that a pass reached this coin, so the next pass with more coins than it can take starts with the others. */
export async function markVisited(db: Db, mint: string, fence?: Fence) {
  const f = fenced(fence, 2);
  await db.query(`update coins set indexed_at = now() where mint = $1 and ${f.sql}`, [mint, ...f.params]);
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
    // A failed read is not a zero fee: let it throw, so the coin is not inserted and the next pass tries again.
    const { getMint, getTransferFeeConfig } = await import("@solana/spl-token");
    const m = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    const tf = getTransferFeeConfig(m); // null only when the mint really has no transfer-fee extension
    if (tf) transferFeeBps = tf.newerTransferFee.transferFeeBasisPoints;
    if (!FEES.holderRewardBps.includes(transferFeeBps as never)) {
      await kv.set(db, `unlisted:${mint.toBase58()}`, { pool: poolId.toBase58(), why: `transfer fee ${transferFeeBps} bps` });
      log("unlisted", mint.toBase58(), "transfer fee", transferFeeBps);
      return;
    }
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

/** One trade on one pool. `ix` is its place among the transaction's trades on that pool (0 for the first, or the only one). */
interface ParsedTrade { sig: string; ix: number; slot: number; ts: number; side: "buy" | "sell"; wallet: string; solLamports: bigint; tokenBase: bigint; referrer: string | null }

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

/**
 * The transactions a getParsedTransactions call returned, by their own signature. It is one JSON-RPC batch, and the
 * RPC may answer a batch in any order (devnet reordered most batches on 2026-11-12) while web3.js hands the answers on
 * as they came, so going by position would store one transaction under another's signature and lose the other.
 */
const bySignature = (txs: (ParsedTransactionWithMeta | null)[]) =>
  new Map(txs.flatMap((t) => (t ? [[t.transaction.signatures[0], t] as const] : [])));

/**
 * Backfill: puts every dead-lettered signature of `mint` back in its retry queue; returns how many. Takes the indexer
 * lease for the move, so it never interleaves with a pass; returns null when a pass holds it (try again shortly).
 */
export async function requeueDead(db: Db, mint: string): Promise<number | null> {
  const token = await kv.lease(db, INDEXER_LEASE, INDEXER_LEASE_MS);
  if (!token) return null;
  try {
    const w = kvWriter(db, { lease: INDEXER_LEASE, token });
    const dead = (await kv.get<string[]>(db, `sig_dead:${mint}`)) ?? [];
    if (!dead.length) return 0;
    const retry = (await kv.get<{ sig: string; tries: number }[]>(db, `sig_retry:${mint}`)) ?? [];
    const have = new Set(retry.map((r) => r.sig));
    await w.set(`sig_retry:${mint}`, [...retry, ...dead.filter((d) => !have.has(d)).map((sig) => ({ sig, tries: 0 }))]);
    await w.del(`sig_dead:${mint}`);
    return dead.length;
  } finally {
    await kv.release(db, INDEXER_LEASE, token);
  }
}

async function deadLetter(db: Db, w: KvWriter, mint: string, sigs: string[]) {
  if (!sigs.length) return;
  const key = `sig_dead:${mint}`;
  const dead = (await kv.get<string[]>(db, key)) ?? [];
  await w.set(key, [...new Set([...dead, ...sigs])]); // never trimmed: only a backfill takes signatures off
  log("trades:", sigs.length, "signature(s) for", mint, "still missing after retries; kept in", key, "for backfill:", sigs.join(", "));
}

/**
 * True when every landed trade up to the newest signature on the pool is stored. False while a long backlog is
 * still being read (`sig_scan:<mint>`), after a pass that finished such a backlog but has not yet read the newer
 * signatures past it (`sig_behind:<mint>`), while the cursor is held before a transaction the RPC has not served
 * (`sig_missing:<mint>`), and while a transaction the cursor moved past is still queued for retry (`sig_retry:<mint>`).
 * Only a dead-lettered transaction (`sig_dead:<mint>`, after 50 retries) no longer holds the coin back.
 */
export async function tradesCaughtUp(db: Db, mint: string): Promise<boolean> {
  const rows = await db.query("select 1 from kv where k = any($1::text[])", [["sig_scan", "sig_behind", "sig_missing", "sig_retry"].map((p) => `${p}:${mint}`)]);
  return rows.length === 0;
}

type SigInfo = Awaited<ReturnType<Connection["getSignaturesForAddress"]>>[number];

/**
 * Pull every signature on the pool since the last one seen and turn them into trades (see parseTrades). Pages back
 * until it reaches the last signature seen (a quiet site can go hours between passes, and a busy coin can see more
 * than one page between two), then stores oldest first, moving the cursor as it goes.
 *
 * The cursor (`last_sig:<mint>`) only ever moves past signatures that were stored or are known not to be trades, so
 * nothing is skipped: when more than MAX_SIG_PAGES pages are waiting, the pass saves where it stopped reading
 * (`sig_scan:<mint>`) and the next pass reads on from there until it reaches the cursor; when the RPC has not got a
 * landed transaction yet, or served it without all of its trade data (see parseTrades), the cursor stops just before
 * it and a later pass asks again. One still missing after MISSING_TX_TRIES passes goes into a retry queue
 * (`sig_retry:<mint>`) before the cursor moves past it, so the coin is not held up and the trade is still stored if the
 * RPC serves it later; one that outlasts the retries is dead-lettered (`sig_dead:<mint>`) for `npm run trades:backfill`.
 */
export async function syncTrades(
  db: Db, connection: Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">, coin: CoinRow & { last_sig: string | null },
  state: PoolState, network: Network, alive: () => Promise<void> = async () => {}, w: KvWriter = kvWriter(db),
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
    mint: coin.mint, supply: coin.supply, pool: coin.pool_id,
  };
  // Stores every trade the transaction made on this pool, one row each; returns how many, or null when the answer cannot
  // be read for certain (see parseTrades): nothing is stored, and it is handled as a transaction the RPC has not served
  // yet, so it is asked for again and ends up dead-lettered for backfill rather than skipped. A pass cut off between two
  // rows has not moved the cursor past the transaction, so the next pass stores the rest (the key skips the stored ones).
  const store = async (tx: ParsedTransactionWithMeta | null): Promise<number | null> => {
    if (!tx) return null;
    if (tx.meta?.err) return 0;
    const trades = parseTrades(tx, keys);
    if (!trades) return null;
    // A row stored before trades were kept one by one (ix -1, see the schema) holds all of them in one: it is replaced,
    // not added to. A pass cut off after this has not moved the cursor past the transaction, so the next one stores it.
    await db.query("delete from trades where sig = $1 and mint = $2 and ix = -1", [tx.transaction.signatures[0], coin.mint]);
    for (const t of trades) {
      const price = t.tokenBase > 0n ? (Number(t.solLamports) / LAMPORTS) / (Number(t.tokenBase) / 10 ** coin.decimals) : 0;
      await db.query(
        `insert into trades (sig, mint, ix, slot, ts, side, wallet, sol_lamports, token_base, price_sol, referrer)
         values ($1,$2,$3,$4,to_timestamp($5/1000.0),$6,$7,$8,$9,$10,$11) on conflict (sig, mint, ix) do nothing`,
        [t.sig, coin.mint, t.ix, t.slot, t.ts, t.side, t.wallet, t.solLamports.toString(), t.tokenBase.toString(), price, t.referrer],
      );
    }
    return trades.length;
  };

  // Transactions the cursor already moved past while the RPC still lacked them: ask for them again.
  const retryKey = `sig_retry:${coin.mint}`;
  let retry = (await kv.get<{ sig: string; tries: number }[]>(db, retryKey)) ?? [];
  let stored = 0;
  if (retry.length) {
    // A backfill can requeue thousands at once: each pass asks for at most RETRY_TX_MAX of them, TX_CHUNK per RPC call,
    // and moves the ones it did not reach to the front so the next pass takes them.
    const batch = retry.slice(0, RETRY_TX_MAX), rest = retry.slice(RETRY_TX_MAX);
    const fetched: (ParsedTransactionWithMeta | null)[] = [];
    for (let i = 0; i < batch.length; i += TX_CHUNK) {
      fetched.push(...(await connection.getParsedTransactions(batch.slice(i, i + TX_CHUNK).map((r) => r.sig), { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: "confirmed" })));
      await alive();
    }
    const got = bySignature(fetched);
    const left: typeof retry = [], dead: string[] = [];
    for (const r of batch) {
      const n = await store(got.get(r.sig) ?? null);
      if (n !== null) { stored += n; continue; }
      if (r.tries + 1 >= RETRY_TX_TRIES) dead.push(r.sig);
      else left.push({ sig: r.sig, tries: r.tries + 1 });
    }
    await deadLetter(db, w, coin.mint, dead);
    retry = [...rest, ...left];
    if (retry.length) await w.set(retryKey, retry); else await w.del(retryKey);
  }
  const scanKey = `sig_scan:${coin.mint}`;
  const scan = await kv.get<{ before: string; until: string | null }>(db, scanKey);
  // A saved scan only holds while the cursor it was reading towards is unchanged.
  let before: string | undefined = scan && scan.until === until ? scan.before : undefined;
  // A pass that resumes a backlog reads only below where the last one stopped: newer signatures wait for the next.
  const fromNewest = before === undefined;
  const behindKey = `sig_behind:${coin.mint}`;
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
    await w.set(scanKey, { before, until });
    log("trades:", coin.mint, "has more than", sigs.length, "new signatures; reading on next pass");
    return stored;
  }
  if (scan) await w.del(scanKey);
  if (fromNewest) await w.del(behindKey); else await w.set(behindKey, true);
  if (!sigs.length) return stored;
  sigs.reverse(); // oldest first
  const missingKey = `sig_missing:${coin.mint}`;
  for (let i = 0; i < sigs.length; i += TX_CHUNK) {
    const chunk = sigs.slice(i, i + TX_CHUNK);
    const ok = chunk.filter((s) => !s.err);
    const fetched = ok.length ? await connection.getParsedTransactions(ok.map((s) => s.signature), { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: "confirmed" }) : [];
    const txBySig = bySignature(fetched);
    await alive();
    let cursor: string | null = null; // the newest signature of this chunk that is fully handled
    let stalled = false;
    for (const s of chunk) {
      if (!s.err) {
        const n = await store(txBySig.get(s.signature) ?? null);
        if (n === null) {
          // Landed but not served yet (lagging RPC node), or served without all of its trade data. Stop before it so a
          // later pass retries; give up after a few.
          const miss = await kv.get<{ sig: string; tries: number }>(db, missingKey);
          const tries = miss?.sig === s.signature ? miss.tries + 1 : 1;
          if (tries < MISSING_TX_TRIES) {
            await w.set(missingKey, { sig: s.signature, tries });
            stalled = true;
            break;
          }
          // Queue it before the cursor passes it, so a later pass still stores it once the RPC has it.
          log("trades:", s.signature, "for", coin.mint, "still missing or unreadable after", tries, "passes; moving on and retrying it later");
          if (!retry.some((r) => r.sig === s.signature)) {
            retry = [...retry, { sig: s.signature, tries: 0 }];
            if (retry.length > RETRY_TX_MAX) await deadLetter(db, w, coin.mint, retry.splice(0, retry.length - RETRY_TX_MAX).map((r) => r.sig));
          }
          await w.set(retryKey, retry);
          await w.del(missingKey);
        } else stored += n;
      }
      cursor = s.signature;
    }
    if (cursor) await w.set(`last_sig:${coin.mint}`, { sig: cursor });
    if (stalled) return stored;
  }
  await w.del(missingKey); // nothing is held back any more
  return stored;
}

/** `pool` is the pool account: with it, trades are read from LaunchLab's own trade events (syncTrades always sets it). */
export interface TradeKeys { vaultA: string; vaultB: string; auth: string; creatorVault: string; creatorVaultAuth: string; platformVault: string; platformVaultAuth: string; mint: string; supply?: string; pool?: string }

/**
 * The trades a transaction made on the pool, in the order they ran. Each TradeEvent LaunchLab emitted for the pool is
 * one trade (see tradeEvents), so a bot's buy and sell of the same amount in one transaction are two trades, not none.
 * The token amount is the event's change to the pool's sold count (realA), up for a buy and down for a sell, so tokens
 * sent straight to vault A in the same transaction are not counted. SOL comes from the event too, not from vault B's
 * balance: anyone can send wrapped SOL to the vault in the same transaction, and a deposit the size of a sale's
 * proceeds would make that sale read as free. Amounts are what reached or left the curve, net of fees.
 *
 * With the pool known (syncTrades always gives it), the events are the only source. A transaction with no LaunchLab
 * buy or sell on the pool and no event for it holds no trade, whatever the vaults did (the migration, a fee claim, a
 * deposit). One whose events cannot be read for certain returns null, so it is not stored and is asked for again (see
 * syncTrades): every buy/sell on the pool emits exactly one event, so an instruction without its event (an answer
 * missing inner instructions), an event no instruction can be tied to, or an event laid out otherwise than read here
 * means the answer is incomplete or the layout changed. Read from the vaults instead, a deposit in the same
 * transaction would change the amounts, and a stored row is never rewritten: the coin's coverage check would then fail
 * for good and its readings expire.
 *
 * Without the pool, the vaults alone are read, as one trade at most: they must move in opposite directions, SOL in and
 * tokens out for a buy; the creation transaction (supply in, then the dev buy) and the migration (both vaults drained)
 * follow the same rule.
 */
export function parseTrades(tx: ParsedTransactionWithMeta, k: TradeKeys): ParsedTrade[] | null {
  const sig = tx.transaction.signatures[0];
  const keys = tx.transaction.message.accountKeys.map((a) => a.pubkey.toBase58());
  const pre = tx.meta?.preTokenBalances ?? [], post = tx.meta?.postTokenBalances ?? [];
  const bal = (list: typeof pre, idx: number) => list.find((b) => b.accountIndex === idx);
  const delta = (idx: number) => {
    const a = bal(pre, idx), b = bal(post, idx);
    return BigInt(b?.uiTokenAmount.amount ?? "0") - BigInt(a?.uiTokenAmount.amount ?? "0");
  };
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const iA = keys.indexOf(k.vaultA), iB = keys.indexOf(k.vaultB);
  if (iA < 0 || iB < 0) return [];
  const at = { sig, slot: tx.slot, ts: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000 };
  // The trader and the caller come from the LaunchLab buy/sell instruction itself (top level, or inside an aggregator's
  // route): account 0 is the trader, and when a share fee is paid the receiver's token account is account 15 (the
  // instruction then has 19 accounts; 18 without). The fee payer of a routed trade is often a bot or relayer.
  const byIx = (ix: string[]) => {
    let referrer: string | null = null;
    if (ix.length >= 19) {
      const idx = keys.indexOf(ix[15]);
      const owner = (bal(post, idx) ?? bal(pre, idx))?.owner ?? null;
      if (owner && owner !== ix[0]) referrer = owner;
    }
    return { wallet: ix[0], referrer };
  };
  // The trade read from the vaults: the pool's buy/sell instruction wherever it is, or for older transactions without a
  // parsed instruction list the fee payer, and as caller the owner of the only other WSOL account that gains in the
  // transaction (the caller's share lands in a WSOL account the caller owns).
  const only = () => {
    const ix = launchLabTradeIx(tx, k.vaultA, k.vaultB);
    if (ix) return byIx(ix);
    const wallet = keys[0];
    for (const b of post) {
      if (b.mint !== "So11111111111111111111111111111111111111112") continue;
      const owner = b.owner ?? ""; const idx = b.accountIndex; const acct = keys[idx];
      if (!owner || owner === wallet || owner === k.auth || owner === k.creatorVaultAuth || owner === k.platformVaultAuth) continue;
      if (acct === k.vaultB || acct === k.creatorVault || acct === k.platformVault) continue;
      if (delta(idx) > 0n) return { wallet, referrer: owner };
    }
    return { wallet, referrer: null };
  };

  if (k.pool) {
    // Every event is an inner instruction, and so is a routed trade's buy or sell: an answer without the inner list (a
    // node that did not record it) shows neither, so what the transaction did on the pool is unknown, not nothing.
    if (tx.meta?.innerInstructions == null) { log("trades:", sig, "came without its inner instructions; not read for now"); return null; }
    const events = tradeEvents(tx, k.pool, k.vaultA, k.vaultB);
    const instructions = launchLabTradeIxs(tx, k.vaultA, k.vaultB).length;
    if (!events.length && !instructions) return [];
    // The side is the sold count's direction, which the coverage check adds up; the event's own trade direction agreed
    // with it on every devnet trade, so one that disagrees is not laid out as read here.
    const unreadable = events.length !== instructions ? `${instructions} LaunchLab trades and ${events.length} TradeEvents on the pool`
      : events.some((e) => !e.accounts) ? "a TradeEvent no LaunchLab trade can be tied to"
      : events.some((e) => e.sold !== 0n && e.sell !== (e.sold < 0n)) ? "a TradeEvent whose direction disagrees with its sold count"
      : null;
    if (unreadable) { log("trades:", sig, "carries", unreadable, "; not read for now"); return null; }
    // Vault B is not checked: a SOL deposit in the same transaction could cancel its change.
    return events.flatMap((e, ix) => (e.sold === 0n ? [] : [{ ...at, ix, side: e.sold > 0n ? "buy" as const : "sell" as const, ...byIx(e.accounts!), solLamports: abs(e.sol), tokenBase: abs(e.sold) }]));
  }
  const dA = delta(iA), dB = delta(iB);
  // creation tx: vault A is created and filled with the supply in the same tx, so the dev buy is supply - what stayed
  const createdVaultA = !bal(pre, iA);
  if (createdVaultA) {
    if (dB <= 0n || !k.supply) return []; // created without a dev buy: nothing traded
  } else {
    if (dA === 0n || dB === 0n) return [];
    if ((dA < 0n) === (dB < 0n)) return []; // same direction: migration or something that is not a trade
  }
  const tokenBase = createdVaultA ? BigInt(k.supply ?? 0) - BigInt(bal(post, iA)?.uiTokenAmount.amount ?? "0") : abs(dA);
  if (tokenBase <= 0n) return [];
  return [{ ...at, ix: 0, side: dB > 0n ? "buy" : "sell", ...only(), solLamports: abs(dB), tokenBase }];
}

// Only the program of the network this indexer runs on: the other network's id means nothing here.
const LAUNCHLAB_PROGRAM = LAUNCHLAB[NETWORK].program.toBase58();
const TRADE_DISCRIMINATORS = [anchorDataBuf.buyExactIn, anchorDataBuf.buyExactOut, anchorDataBuf.sellExactIn, anchorDataBuf.sellExactOut].map((b) => Buffer.from(b).toString("hex"));
const EVENT_IX_TAG = "e445a52e51cb9a1d"; // Anchor emit_cpi! prefix
const TRADE_EVENT = "bddb7fd34ee661ee"; // sha256("event:TradeEvent")[0..8]
// The event instruction's one account; only LaunchLab can sign for it, so a landed transaction cannot carry a forged event.
const EVENT_AUTHORITY = getPdaCpiEvent(LAUNCHLAB[NETWORK].program).publicKey.toBase58();

/**
 * One TradeEvent LaunchLab emitted for a pool: its change to the pool's sold count (realA), the SOL it moved in or out
 * of vault B, its own trade direction, and the accounts of the buy/sell instruction that emitted it (null when none can
 * be tied to it).
 */
export interface TradeEvent { sold: bigint; sol: bigint; sell: boolean; accounts: string[] | null }

/**
 * LaunchLab's TradeEvents for `pool`, in the order they ran, each tied to the buy/sell instruction on the pool (vault A
 * at 7, vault B at 8) that emitted it. Instructions are walked as they ran: outer instruction i, then the inner
 * instructions it made (inner group i). An event belongs to the latest buy/sell on the pool before it, which must sit
 * one level above it when the RPC gives levels (stackHeight): emit_cpi is the instruction calling LaunchLab itself, and
 * one LaunchLab trade cannot run inside another. Each buy/sell emits one event.
 * Event data (Anchor emit_cpi, 155 bytes, u64 LE): tag, discriminator, pool at 16, real_base_before 72, real_quote_before
 * 80, real_base_after 88, real_quote_after 96, protocol_fee 120, trade_direction at 152 (0 buy, 1 sell). The SOL is the
 * curve's quote change plus the protocol fee, which stays in vault B: on every devnet trade checked (16, buys and sells)
 * that is exactly vault B's balance change, so a plain trade reads as it did from the vault.
 */
export function tradeEvents(tx: ParsedTransactionWithMeta, pool: string, vaultA: string, vaultB: string): TradeEvent[] {
  type Ins = { programId?: PublicKey | string; accounts?: (PublicKey | string)[]; data?: string; stackHeight?: number | null };
  const str = (x: PublicKey | string) => (typeof x === "string" ? x : x.toBase58());
  const inner = tx.meta?.innerInstructions ?? [];
  const ran = (tx.transaction.message.instructions as Ins[]).flatMap((ins, i) => [
    { ins, level: 1 as number | null },
    ...inner.filter((g) => g.index === i).flatMap((g) => (g.instructions as Ins[]).map((x) => ({ ins: x, level: x.stackHeight ?? null }))),
  ]);
  const out: TradeEvent[] = [];
  let trade: { accounts: string[]; level: number | null } | null = null; // the pool's latest buy/sell so far
  for (const { ins, level } of ran) {
    const { programId, accounts, data } = ins;
    if (!programId || !accounts?.[0] || typeof data !== "string" || str(programId) !== LAUNCHLAB_PROGRAM) continue;
    if (isLaunchLabTrade(ins)) {
      const a = accounts.map(str);
      if (a.length >= 18 && a[7] === vaultA && a[8] === vaultB) trade = { accounts: a, level };
      continue;
    }
    if (str(accounts[0]) !== EVENT_AUTHORITY) continue;
    let d: Buffer;
    try { d = Buffer.from(bs58.decode(data)); } catch { continue; }
    if (d.length < 155 || d.subarray(0, 8).toString("hex") !== EVENT_IX_TAG || d.subarray(8, 16).toString("hex") !== TRADE_EVENT) continue;
    if (bs58.encode(d.subarray(16, 48)) !== pool) continue;
    const u64 = (o: number) => d.readBigUInt64LE(o);
    const emitter = trade && (level === null || trade.level === null || level === trade.level + 1) ? trade.accounts : null;
    out.push({ sold: u64(88) - u64(72), sol: u64(96) - u64(80) + u64(120), sell: d[152] === 1, accounts: emitter });
    trade = null;
  }
  return out;
}

/** True for a LaunchLab buy or sell instruction: the program id and the Anchor discriminator both have to match. */
function isLaunchLabTrade(ins: unknown): boolean {
  const { programId, data } = ins as { programId?: PublicKey | string; data?: string };
  if (!programId || typeof data !== "string") return false;
  if ((typeof programId === "string" ? programId : programId.toBase58()) !== LAUNCHLAB_PROGRAM) return false;
  try { return TRADE_DISCRIMINATORS.includes(Buffer.from(bs58.decode(data).subarray(0, 8)).toString("hex")); } catch { return false; }
}

/** Accounts of each LaunchLab buy/sell instruction on this pool (vault A at 7, vault B at 8), top level or inner. */
export function launchLabTradeIxs(tx: ParsedTransactionWithMeta, vaultA: string, vaultB: string): string[][] {
  const all = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
  ];
  const out: string[][] = [];
  for (const ins of all) {
    const accounts = (ins as { accounts?: PublicKey[] }).accounts;
    if (!accounts || accounts.length < 18 || !isLaunchLabTrade(ins)) continue;
    const a = accounts.map((x) => (typeof x === "string" ? x : x.toBase58()));
    if (a[7] === vaultA && a[8] === vaultB) out.push(a);
  }
  return out;
}

/** The first of them (see launchLabTradeIxs), or null. */
export const launchLabTradeIx = (tx: ParsedTransactionWithMeta, vaultA: string, vaultB: string): string[] | null =>
  launchLabTradeIxs(tx, vaultA, vaultB)[0] ?? null;

async function updateStats(db: Db, coin: CoinRow, state: PoolState, now: number, fence?: Fence) {
  const f = fenced(fence, 12);
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
        dev_buy_pct=$10, initial_buy_sol=$11, updated_at=now() where mint=$1 and ${f.sql}`,
    [coin.mint, curvePriceSol(state), marketCapSol(state), state.realB.toString(), bondingProgress(state), Number(agg?.vol ?? 0), Number(agg?.vol24 ?? 0), agg?.n ?? 0, agg?.last ?? null, devPct, Number(dev?.sol ?? 0), ...f.params],
  );
  void now;
}

/** Seal whichever readings are due for this coin. Returns how many were sealed. */
/**
 * Seals the checkpoints that are due for a coin, then puts its newest reading on its row. That last step also repairs
 * a coin left behind by a pass that sealed a reading and lost its lease before updating the row.
 */
/**
 * True when the stored trades add up to the pool's own sold count (realA) to the base unit: each stored trade is one
 * TradeEvent's change to that count (see tradeEvents), so buys - sells must equal it, however many trades one
 * transaction holds. Only a LaunchLab buy or sell moves realA, so a direct deposit to the vault cannot hold readings
 * back, while a trade the signature listing has not shown yet leaves a gap and the reading waits for the next pass.
 */
export async function tradesCoverRealA(db: Db, mint: string, realA: bigint): Promise<boolean> {
  return (await netSold(db, mint)) === realA;
}

/** For a full curve: the stored trades must add up to exactly the tokens the curve sells, or one is still missing. */
export async function tradesCoverSold(db: Db, mint: string): Promise<boolean> {
  const c = await db.one<{ total_sell: string }>("select total_sell::text as total_sell from coins where mint = $1", [mint]);
  return !!c && (await netSold(db, mint)) === BigInt(c.total_sell.split(".")[0]);
}

async function netSold(db: Db, mint: string): Promise<bigint> {
  const r = await db.one<{ net: string }>(
    "select coalesce(sum(case when side = 'buy' then token_base else -token_base end), 0)::text as net from trades where mint = $1",
    [mint],
  );
  return BigInt((r?.net ?? "0").split(".")[0]);
}

export async function gradeCoin(db: Db, coin: CoinRow, history: History, tiers: TierWindow, now: number, fence?: Fence, covered?: () => Promise<boolean>) {
  // Asked at most once per call, and only when a reading is actually about to be sealed.
  let coverage: Promise<boolean> | null = null;
  const ready = () => (covered ? (coverage ??= covered().catch(() => false)) : Promise.resolve(true));
  const have = new Set((await db.query<{ checkpoint: string }>("select checkpoint from readings where mint = $1", [coin.mint])).map((r) => r.checkpoint));
  const createdAt = new Date(coin.created_at).getTime();
  const ageS = (now - createdAt) / 1000;
  let sealed = 0;
  // features that do not depend on trades
  const base = await baseFeatures(db, coin, history, createdAt);
  if (!have.has("launch")) {
    // A trade is still missing: wait for the next pass (inside the grace window) before anything is recorded or sealed.
    if (ageS <= LAUNCH_GRACE && !(await ready())) return sealed;
    history.recordLaunch(coin.name, coin.symbol, coin.creator, createdAt);
    if (ageS > LAUNCH_GRACE) {
      // Seen too late (indexer down, backfill): the outcome may already be known, so no launch reading is sealed.
      tiers.add("launch", now);
      await skip(db, coin.mint, "launch", fence);
    } else {
      sealed += await place(db, coin, "launch", base.features, base.word, tiers, now, null, fence);
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
      await skip(db, coin.mint, cp, fence);
      continue;
    }
    if (!(await ready())) break;
    const trades = await liveTrades(db, coin, createdAt);
    const m1 = liveFeatures(trades, 60);
    const f: Record<string, number | null> = { ...base.features, ...suffix(m1, "m1") };
    let live = m1;
    if (cp === "m5") { live = liveFeatures(trades, 300); Object.assign(f, suffix(live, "m5")); }
    sealed += await place(db, coin, cp, f, base.word, tiers, now, live, fence);
  }
  await showLatestReading(db, coin.mint, fence);
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

export async function liveTrades(db: Db, coin: CoinRow, createdAt: number): Promise<LiveTrade[]> {
  const rows = await db.query<{ sig: string; ts: string; side: string; wallet: string; sol_lamports: string; token_base: string; price_sol: number }>(
    "select sig, ts, side, wallet, sol_lamports, token_base, price_sol from trades where mint = $1 order by ts, slot, ix",
    [coin.mint],
  );
  const supply = Number(coin.supply);
  // The dev buy (the creator's trade in the creation transaction) is in dev_buy_pct, not here. Another wallet's buy in
  // that transaction, stored as its own trade, is a buy at second 0 like any other: a bundled buy is what the early
  // buy features are there to see. The price ratios stay measured from the first trade after that transaction, as
  // they were before such buys were stored, so a bundled buy does not move every ratio of the coin; and a bundled buy
  // has none, as its own would be measured from a trade that can come after the checkpoint being read.
  const live = rows.filter((r) => !(r.sig === coin.create_sig && r.wallet === coin.creator));
  const first = rows.find((r) => r.sig !== coin.create_sig);
  const price0 = first ? Number(first.price_sol) : 0;
  return live
    .map((r) => ({
      s: (new Date(r.ts).getTime() - createdAt) / 1000,
      isBuy: r.side === "buy",
      wallet: r.wallet,
      share: supply > 0 ? Number(r.token_base) / supply : 0,
      sol: Number(r.sol_lamports) / LAMPORTS,
      priceRatio: price0 > 0 && r.sig !== coin.create_sig ? Number(r.price_sol) / price0 : null,
      byCreator: r.wallet === coin.creator,
    }));
}

/**
 * Puts a coin's newest sealed reading on its row, writing only when the row shows something else. The tier is read back from the chain, not passed in, so whichever
 * pass writes it last the field is right; the write is fenced as well, so a pass that lost its lease writes nothing.
 */
export async function showLatestReading(db: Db, mint: string, fence?: Fence) {
  const f = fenced(fence, 2);
  await db.query(
    `update coins c set latest_tier = r.tier, latest_checkpoint = r.checkpoint,
            flagged_at = case when r.tier in ('top1','top10') and c.flagged_at is null then now() else c.flagged_at end, updated_at = now()
       from (select tier, checkpoint from readings where mint = $1 order by seq desc limit 1) r
      where c.mint = $1 and (c.latest_checkpoint is distinct from r.checkpoint or c.latest_tier is distinct from r.tier)
        and ${f.sql}`,
    [mint, ...f.params],
  );
}

/** Records that a checkpoint was passed without a reading (seen too late), under the pass's lease. */
async function skip(db: Db, mint: string, cp: Checkpoint, fence?: Fence) {
  const f = fenced(fence, 3);
  await db.query(
    `insert into readings_skipped (mint, checkpoint, reason) select $1, $2, 'late' where ${f.sql} on conflict do nothing`,
    [mint, cp, ...f.params],
  ).catch((e) => log("readings_skipped:", (e as Error).message));
}

async function place(db: Db, coin: CoinRow, cp: Checkpoint, f: Record<string, number | null>, word: string | null, tiers: TierWindow, now: number, live: Record<string, number> | null, fence?: Fence) {
  const s = score(cp, f);
  const { pct, n } = tiers.place(cp, s, now);
  const tier = tierOf(pct);
  const sig = signals({ features: f, live, word, transferFeeBps: coin.transfer_fee_bps });
  await seal(db, { t: now, mint: coin.mint, checkpoint: cp, score: s, pct, tier: tier.key, model: MODEL_VERSION, poolN: n, features: f, signals: sig }, fence);
  await showLatestReading(db, coin.mint, fence);
  log("sealed", cp, coin.symbol, tier.key, `pool ${n}`);
  return 1;
}

export { CHECKPOINTS, TOKEN_PROGRAM_ID };
