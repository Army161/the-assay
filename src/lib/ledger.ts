// Every reading is sealed into a hash chain before its outcome is known, so the record can be checked by anyone.
import { createHash } from "node:crypto";
import { LeaseLost, type Db, type Fence } from "./db";
import type { Checkpoint } from "./grade/assay";

export interface SealInput {
  t: number; mint: string; checkpoint: Checkpoint; score: number; pct: number; tier: string; model: string;
  poolN: number; features: Record<string, unknown>; signals: unknown[];
}
export interface Reading extends SealInput { seq: number; prev: string; hash: string }

export const GENESIS = "0".repeat(64);

export function hashRow(prev: string, body: { seq: number; t: number; mint: string; checkpoint: string; score: number; pct: number; tier: string; model: string }) {
  return createHash("sha256").update(prev + JSON.stringify(body)).digest("hex");
}

/**
 * Appends a reading to the chain. With a fence, the insert happens only while that lease is still held (checked in
 * the same statement), so a run that lost its lease cannot seal a reading after the run that took over.
 */
export async function seal(db: Db, e: SealInput, fence?: Fence): Promise<Reading> {
  const head = await db.one<{ seq: number; hash: string }>("select seq, hash from readings order by seq desc limit 1");
  const seq = head ? Number(head.seq) + 1 : 0;
  const prev = head ? head.hash : GENESIS;
  const body = { seq, t: e.t, mint: e.mint, checkpoint: e.checkpoint, score: +e.score.toFixed(6), pct: +e.pct.toFixed(4), tier: e.tier, model: e.model };
  const hash = hashRow(prev, body);
  const rows = await db.query(
    `insert into readings (seq, t, mint, checkpoint, score, pct, tier, model, pool_n, features, signals, prev, hash)
     select $1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13
      where $14::text is null or exists (select 1 from kv where k = $14 and v->>'owner' = $15 for share)
     returning seq`,
    [seq, e.t, e.mint, e.checkpoint, body.score, body.pct, e.tier, e.model, e.poolN, JSON.stringify(e.features), JSON.stringify(e.signals), prev, hash,
      fence?.lease ?? null, fence?.token ?? null],
  );
  if (!rows.length) throw new LeaseLost(fence!.lease);
  return { ...e, score: body.score, pct: body.pct, seq, prev, hash };
}

/** Re-hash the whole chain. Returns the first broken seq, or null if intact. */
export async function verifyChain(db: Db): Promise<{ ok: boolean; sealed: number; head: string; brokenAt: number | null }> {
  const rows = await db.query<{ seq: number; t: string; mint: string; checkpoint: string; score: number; pct: number; tier: string; model: string; prev: string; hash: string }>(
    "select seq, extract(epoch from t) * 1000 as t, mint, checkpoint, score, pct, tier, model, prev, hash from readings order by seq",
  );
  let prev = GENESIS;
  for (const r of rows) {
    const body = { seq: Number(r.seq), t: Math.round(Number(r.t)), mint: r.mint, checkpoint: r.checkpoint, score: Number(r.score), pct: Number(r.pct), tier: r.tier, model: r.model };
    if (r.prev !== prev || hashRow(prev, body) !== r.hash) return { ok: false, sealed: rows.length, head: prev, brokenAt: Number(r.seq) };
    prev = r.hash;
  }
  return { ok: true, sealed: rows.length, head: prev, brokenAt: null };
}

/** Live record: readings at least `minAge` old, graduation counted only if it came after the reading. */
export async function record(db: Db, minAgeMs = 30 * 60e3) {
  const rows = await db.query<{ checkpoint: string; tier: string; n: number; grads: number }>(
    `select r.checkpoint, r.tier, count(*)::int as n,
            count(*) filter (where c.graduated_at is not null and c.graduated_at >= r.t)::int as grads
       from readings r join coins c on c.mint = r.mint
      where r.t <= now() - ($1 || ' milliseconds')::interval
      group by r.checkpoint, r.tier`,
    [String(minAgeMs)],
  );
  const out: Record<string, { n: number; grads: number; tiers: Record<string, { n: number; grads: number; rel: number | null }> }> = {};
  for (const r of rows) {
    const c = (out[r.checkpoint] ??= { n: 0, grads: 0, tiers: {} });
    c.n += r.n; c.grads += r.grads;
    c.tiers[r.tier] = { n: r.n, grads: r.grads, rel: null };
  }
  for (const c of Object.values(out)) for (const t of Object.values(c.tiers)) t.rel = c.grads ? t.grads / t.n / (c.grads / c.n) : null;
  const head = await db.one<{ seq: number; hash: string; since: string }>("select max(seq) as seq, (select hash from readings order by seq desc limit 1) as hash, min(t) as since from readings");
  return { since: head?.since ?? null, sealed: head?.seq != null ? Number(head.seq) + 1 : 0, head: head?.hash ?? GENESIS, minAgeMin: minAgeMs / 60e3, checkpoints: out };
}
