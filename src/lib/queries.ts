// Read models for the board and the coin page. Plain SQL over the indexer's tables; no RPC on the request path.
import type { Db } from "./db";
import { TIERS, tierLabel, relOdds, CHECKPOINT_LABEL, type Checkpoint } from "./grade/assay";
import { CALLER_PAY_TIERS, NETWORK } from "./chain";

export type Sort = "new" | "trending" | "graduating" | "mcap" | "graduated" | "top";

export interface CoinCard {
  mint: string; poolId: string; name: string; symbol: string; image: string | null; description: string | null; creator: string;
  createdAt: string; status: string; graduatedAt: string | null; priceSol: number; mcapSol: number; progress: number;
  volSol: number; vol24hSol: number; trades: number; holders: number | null; devBuyPct: number; transferFeeBps: number;
  tier: string | null; tierLabel: string; checkpoint: string | null; lastTradeAt: string | null; callerPaid: boolean;
  socials: Record<string, string | null>;
}

const CARD = `mint, pool_id, name, symbol, image, description, creator, created_at, status, graduated_at, price_sol, mcap_sol, progress,
  vol_sol, vol_24h_sol, trades, holders, dev_buy_pct, transfer_fee_bps, latest_tier, latest_checkpoint, last_trade_at, socials`;

type Row = Record<string, unknown>;
export function toCard(r: Row): CoinCard {
  const tier = (r.latest_tier as string | null) ?? null;
  return {
    mint: r.mint as string, poolId: r.pool_id as string, name: r.name as string, symbol: r.symbol as string, image: (r.image as string | null) ?? null,
    description: (r.description as string | null) ?? null, creator: r.creator as string, createdAt: iso(r.created_at), status: r.status as string,
    graduatedAt: r.graduated_at ? iso(r.graduated_at) : null, priceSol: Number(r.price_sol), mcapSol: Number(r.mcap_sol), progress: Number(r.progress),
    volSol: Number(r.vol_sol), vol24hSol: Number(r.vol_24h_sol), trades: Number(r.trades), holders: r.holders == null ? null : Number(r.holders),
    devBuyPct: Number(r.dev_buy_pct), transferFeeBps: Number(r.transfer_fee_bps), tier, tierLabel: tierLabel(tier), checkpoint: (r.latest_checkpoint as string | null) ?? null,
    lastTradeAt: r.last_trade_at ? iso(r.last_trade_at) : null, callerPaid: tier != null && CALLER_PAY_TIERS.has(tier),
    socials: (r.socials as Record<string, string | null>) ?? {},
  };
}
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

const ORDER: Record<Sort, string> = {
  new: "created_at desc",
  trending: "vol_24h_sol desc, trades desc, created_at desc",
  graduating: "progress desc, vol_24h_sol desc",
  mcap: "mcap_sol desc",
  graduated: "graduated_at desc nulls last, created_at desc",
  top: "case latest_tier when 'top1' then 0 when 'top10' then 1 when 'top25' then 2 when 'upper_half' then 3 else 4 end, created_at desc",
};

export async function board(db: Db, opts: { sort?: Sort; q?: string; status?: "live" | "graduated" | "all"; limit?: number; offset?: number; tier?: string } = {}) {
  const sort = opts.sort && ORDER[opts.sort] ? opts.sort : "new";
  const where: string[] = ["network = $1"]; const params: unknown[] = [NETWORK];
  if (opts.q) { params.push(`%${opts.q.replace(/[%_\\]/g, "\\$&").slice(0, 40)}%`); where.push(`(name ilike $${params.length} or symbol ilike $${params.length} or mint ilike $${params.length})`); }
  if (opts.status === "live") where.push("graduated_at is null");
  if (opts.status === "graduated" || sort === "graduated") where.push("graduated_at is not null");
  if (opts.tier) { params.push(opts.tier); where.push(`latest_tier = $${params.length}`); }
  params.push(Math.min(100, Math.max(1, opts.limit ?? 48)), Math.max(0, opts.offset ?? 0));
  const rows = await db.query<Row>(`select ${CARD} from coins where ${where.join(" and ")} order by ${ORDER[sort]} limit $${params.length - 1} offset $${params.length}`, params);
  return rows.map(toCard);
}

export async function coin(db: Db, mint: string) {
  const r = await db.one<Row>(`select ${CARD}, uri, decimals, supply, total_sell, fund_target_lamports, real_b_lamports, token_2022, create_sig, top10_share, flagged_at from coins where mint = $1`, [mint]);
  if (!r) return null;
  const card = toCard(r);
  const readings = await db.query<Row>("select seq, t, checkpoint, score, pct, tier, model, pool_n, signals, hash, prev from readings where mint = $1 order by seq", [mint]);
  const skipped = await db.query<{ checkpoint: string }>("select checkpoint from readings_skipped where mint = $1", [mint]);
  return {
    ...card,
    skipped: skipped.map((x) => x.checkpoint),
    uri: r.uri as string, decimals: Number(r.decimals), supply: String(r.supply), totalSell: String(r.total_sell), fundTargetLamports: String(r.fund_target_lamports),
    realBLamports: String(r.real_b_lamports), token2022: Boolean(r.token_2022), createSig: (r.create_sig as string | null) ?? null, top10Share: r.top10_share == null ? null : Number(r.top10_share),
    flaggedAt: r.flagged_at ? iso(r.flagged_at) : null,
    readings: readings.map((x) => {
      const cp = x.checkpoint as Checkpoint;
      const odds = relOdds(cp, x.tier as string);
      return {
        seq: Number(x.seq), t: iso(x.t), checkpoint: cp, checkpointLabel: CHECKPOINT_LABEL[cp], score: Number(x.score), pct: Number(x.pct), tier: x.tier as string,
        tierLabel: tierLabel(x.tier as string), model: x.model as string, poolN: Number(x.pool_n), signals: x.signals as unknown[], hash: x.hash as string, prev: x.prev as string,
        backtest: { x: odds.x, range: odds.range, text: odds.text },
      };
    }),
  };
}

export async function trades(db: Db, mint: string, limit = 60, before?: string) {
  const params: unknown[] = [mint, limit];
  let extra = "";
  if (before) { params.push(before); extra = ` and ts < $3::timestamptz`; }
  const rows = await db.query<Row>(`select sig, slot, ts, side, wallet, sol_lamports, token_base, price_sol, referrer from trades where mint = $1${extra} order by ts desc, slot desc limit $2`, params);
  return rows.map((r) => ({ sig: r.sig as string, slot: Number(r.slot), ts: iso(r.ts), side: r.side as "buy" | "sell", wallet: r.wallet as string, sol: Number(r.sol_lamports) / 1e9, tokens: String(r.token_base), priceSol: Number(r.price_sol), referrer: (r.referrer as string | null) ?? null }));
}

/** OHLC candles from trades, bucketed by `res` seconds (gaps carry the previous close). */
export async function candles(db: Db, mint: string, res = 60, limit = 300) {
  const rows = await db.query<{ b: string; o: number; h: number; l: number; c: number; v: number }>(
    `select b, (array_agg(price_sol order by ts, slot))[1] as o, max(price_sol) as h, min(price_sol) as l, (array_agg(price_sol order by ts desc, slot desc))[1] as c, sum(sol_lamports)/1e9 as v
       from (select floor(extract(epoch from ts) / $2) * $2 as b, ts, slot, price_sol, sol_lamports from trades where mint = $1 and price_sol > 0) x
      group by b order by b desc limit $3`, [mint, res, limit]);
  const out = rows.reverse().map((r) => ({ time: Number(r.b), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v) }));
  return out;
}

export async function stats(db: Db) {
  const s = await db.one<Row>(
    `select count(*)::int as coins, count(*) filter (where graduated_at is not null)::int as graduated, count(*) filter (where created_at > now() - interval '24 hours')::int as coins_24h,
            coalesce(sum(vol_sol),0) as vol, coalesce(sum(vol_24h_sol),0) as vol_24h, coalesce(sum(trades),0)::int as trades from coins where network = $1`, [NETWORK]);
  const r = await db.one<Row>("select count(*)::int as readings, max(seq) as head from readings");
  const c = await db.one<Row>("select count(*)::int as callers from callers");
  const vol = Number(s?.vol ?? 0);
  return {
    network: NETWORK, coins: Number(s?.coins ?? 0), graduated: Number(s?.graduated ?? 0), coins24h: Number(s?.coins_24h ?? 0), volumeSol: vol, volume24hSol: Number(s?.vol_24h ?? 0),
    trades: Number(s?.trades ?? 0), readings: Number(r?.readings ?? 0), callers: Number(c?.callers ?? 0),
    // fees are a fixed share of gross curve volume (net amounts recorded, so gross = net / 0.98)
    feesSol: { platform: (vol / 0.98) * 0.01, creators: (vol / 0.98) * 0.005 },
    tiers: TIERS.map((t) => ({ key: t.key, label: t.label })),
  };
}
