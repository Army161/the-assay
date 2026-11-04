import { describe, it, expect } from "vitest";
import { freshDb } from "@/lib/db";
import { seal, verifyChain, record, GENESIS, hashRow } from "@/lib/ledger";

async function coin(db: Awaited<ReturnType<typeof freshDb>>, mint: string, graduatedAt: string | null = null) {
  await db.query(
    `insert into coins (mint, pool_id, network, name, symbol, creator, created_at, supply, total_sell, fund_target_lamports, graduated_at)
     values ($1, $1 || 'pool', 'devnet', 'X', 'X', 'c', now() - interval '2 hours', 1, 1, 1, $2)`, [mint, graduatedAt]);
}

describe("sealed ledger", () => {
  it("chains readings and verifies", async () => {
    const db = await freshDb();
    await coin(db, "m1"); await coin(db, "m2", new Date().toISOString());
    const a = await seal(db, { t: Date.now() - 3600e3, mint: "m1", checkpoint: "launch", score: 0.123456789, pct: 0.9, tier: "top10", model: "test", poolN: 3, features: { a: 1 }, signals: [] });
    const b = await seal(db, { t: Date.now() - 3500e3, mint: "m2", checkpoint: "launch", score: 0.5, pct: 0.4, tier: "bottom_half", model: "test", poolN: 4, features: {}, signals: [] });
    expect(a.seq).toBe(0); expect(a.prev).toBe(GENESIS); expect(b.prev).toBe(a.hash);
    expect(a.score).toBe(0.123457); // rounded before hashing so re-verification is exact
    const v = await verifyChain(db);
    expect(v).toMatchObject({ ok: true, sealed: 2, head: b.hash, brokenAt: null });
    expect(hashRow(a.prev, { seq: 0, t: a.t, mint: "m1", checkpoint: "launch", score: a.score, pct: a.pct, tier: "top10", model: "test" })).toBe(a.hash);
    await db.close();
  });
  it("detects a tampered reading", async () => {
    const db = await freshDb();
    await coin(db, "m1");
    await seal(db, { t: Date.now(), mint: "m1", checkpoint: "launch", score: 0.2, pct: 0.2, tier: "bottom_half", model: "t", poolN: 1, features: {}, signals: [] });
    await seal(db, { t: Date.now(), mint: "m1", checkpoint: "m1", score: 0.2, pct: 0.2, tier: "bottom_half", model: "t", poolN: 1, features: {}, signals: [] });
    await db.query("update readings set tier = 'top1' where seq = 0");
    const v = await verifyChain(db);
    expect(v.ok).toBe(false); expect(v.brokenAt).toBe(0);
    await db.close();
  });
  it("counts graduations only after the reading", async () => {
    const db = await freshDb();
    await coin(db, "m1", new Date(Date.now() - 3000e3).toISOString()); // graduated 50 min ago
    await coin(db, "m2", new Date(Date.now() - 7000e3).toISOString()); // graduated before any reading
    await seal(db, { t: Date.now() - 3600e3, mint: "m1", checkpoint: "launch", score: 0.9, pct: 0.95, tier: "top10", model: "t", poolN: 2, features: {}, signals: [] });
    await seal(db, { t: Date.now() - 3600e3, mint: "m2", checkpoint: "launch", score: 0.1, pct: 0.1, tier: "bottom_half", model: "t", poolN: 2, features: {}, signals: [] });
    const r = await record(db, 30 * 60e3);
    expect(r.sealed).toBe(2);
    expect(r.checkpoints.launch.grads).toBe(1);
    expect(r.checkpoints.launch.tiers.top10).toMatchObject({ n: 1, grads: 1, rel: 2 });
    expect(r.checkpoints.launch.tiers.bottom_half).toMatchObject({ n: 1, grads: 0, rel: 0 });
    await db.close();
  });
});
