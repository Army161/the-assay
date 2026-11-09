// The kv lease: one holder at a time, and a holder that outlived its lease cannot renew or release its successor's.
import { describe, it, expect } from "vitest";
import { freshDb, kv, LeaseLost } from "../src/lib/db";
import { seal } from "../src/lib/ledger";
import { showLatestReading, gradeCoin, type CoinRow } from "../src/lib/indexer";
import { History } from "../src/lib/grade/history";
import { TierWindow } from "../src/lib/grade/assay";

describe("kv lease", () => {
  it("lets one holder in, and only that holder renew or release", async () => {
    const db = await freshDb();
    const a = await kv.lease(db, "lock:x", 60_000);
    expect(a).not.toBeNull();
    expect(await kv.lease(db, "lock:x", 60_000)).toBeNull();
    expect(await kv.renew(db, "lock:x", a!)).toBe(true);

    // A's lease runs out while A is still working; B takes over.
    await db.query("update kv set updated_at = now() - interval '2 minutes' where k = 'lock:x'");
    const b = await kv.lease(db, "lock:x", 60_000);
    expect(b).not.toBeNull();
    expect(b).not.toBe(a);

    // A finishes late: it learns it lost the lease, and its release does not free B's.
    expect(await kv.renew(db, "lock:x", a!)).toBe(false);
    await kv.release(db, "lock:x", a!);
    expect(await kv.lease(db, "lock:x", 60_000)).toBeNull();

    await kv.release(db, "lock:x", b!);
    expect(await kv.lease(db, "lock:x", 60_000)).not.toBeNull();
    await db.close();
  });

  it("refuses a fenced write from a holder that was taken over after it last renewed", async () => {
    const db = await freshDb();
    const a = (await kv.lease(db, "lock:x", 60_000))!;
    expect(await kv.renew(db, "lock:x", a)).toBe(true);
    expect(await kv.setFenced(db, "history", { by: "a" }, "lock:x", a)).toBe(true);
    // A pauses after renewing; its lease runs out and B takes over and writes.
    await db.query("update kv set updated_at = now() - interval '2 minutes' where k = 'lock:x'");
    const b = (await kv.lease(db, "lock:x", 60_000))!;
    expect(await kv.setFenced(db, "history", { by: "b" }, "lock:x", b)).toBe(true);
    // A wakes up and tries to write: refused, and B's value stays.
    expect(await kv.setFenced(db, "history", { by: "a-late" }, "lock:x", a)).toBe(false);
    expect(await kv.get(db, "history")).toEqual({ by: "b" });
    await db.close();
  });

  it("refuses a fenced delete and a fenced seal from a holder that was taken over", async () => {
    const db = await freshDb();
    await db.query(`insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports)
                    values ('M','P','devnet','C','C','X',now(),6,1,1,1)`);
    const a = (await kv.lease(db, "lock:x", 60_000))!;
    await kv.set(db, "sig_scan:M", { before: "s" });
    const reading = { t: Date.now(), mint: "M", checkpoint: "launch" as const, score: 0.5, pct: 50, tier: "mid", model: "t", poolN: 1, features: {}, signals: [] };
    await seal(db, reading, { lease: "lock:x", token: a });
    await db.query("update kv set updated_at = now() - interval '2 minutes' where k = 'lock:x'");
    const b = (await kv.lease(db, "lock:x", 60_000))!;
    expect(await kv.delFenced(db, "sig_scan:M", "lock:x", a)).toBe(false);
    expect(await kv.get(db, "sig_scan:M")).toEqual({ before: "s" });
    await expect(seal(db, reading, { lease: "lock:x", token: a })).rejects.toBeInstanceOf(LeaseLost);
    expect((await db.query("select seq from readings")).length).toBe(1);
    expect(await kv.delFenced(db, "sig_scan:M", "lock:x", b)).toBe(true);
    expect(await kv.get(db, "sig_scan:M")).toBeNull();
    await db.close();
  });

  it("keeps the newest reading on the coin when a pass taken over between seal and update writes late", async () => {
    const db = await freshDb();
    await db.query(`insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports)
                    values ('M','P','devnet','C','C','X',now(),6,1,1,1)`);
    const r = (checkpoint: "m1" | "m5", tier: string) => ({ t: Date.now(), mint: "M", checkpoint, score: 0.5, pct: 50, tier, model: "t", poolN: 1, features: {}, signals: [] });
    // A seals m1, then pauses before updating the coin.
    const a = (await kv.lease(db, "lock:x", 60_000))!;
    await seal(db, r("m1", "mid"), { lease: "lock:x", token: a });
    // A's lease runs out; B takes over, seals m5 and updates the coin.
    await db.query("update kv set updated_at = now() - interval '2 minutes' where k = 'lock:x'");
    const b = (await kv.lease(db, "lock:x", 60_000))!;
    await seal(db, r("m5", "top10"), { lease: "lock:x", token: b });
    await showLatestReading(db, "M", { lease: "lock:x", token: b });
    // A resumes: its update is refused, and even unfenced it would write the newest reading, not its own.
    await showLatestReading(db, "M", { lease: "lock:x", token: a });
    expect(await db.one("select latest_checkpoint, latest_tier from coins where mint = 'M'")).toEqual({ latest_checkpoint: "m5", latest_tier: "top10" });
    await showLatestReading(db, "M");
    expect(await db.one("select latest_checkpoint, latest_tier from coins where mint = 'M'")).toEqual({ latest_checkpoint: "m5", latest_tier: "top10" });
    await db.close();
  });

  it("repairs the coin on the next pass when a pass sealed a reading and lost its lease before updating the coin", async () => {
    const db = await freshDb();
    await db.query(`insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports)
                    values ('M','P','devnet','C','C','X',now() - interval '10 minutes',6,1,1,1)`);
    const r = (checkpoint: "launch" | "m1" | "m5", tier: string) => ({ t: Date.now(), mint: "M", checkpoint, score: 0.5, pct: 50, tier, model: "t", poolN: 1, features: {}, signals: [] });
    const a = (await kv.lease(db, "lock:x", 60_000))!;
    await seal(db, r("launch", "mid"), { lease: "lock:x", token: a });
    await seal(db, r("m1", "mid"), { lease: "lock:x", token: a });
    await showLatestReading(db, "M", { lease: "lock:x", token: a });
    // A seals m5, then pauses; B takes over and A's coin update is refused.
    await seal(db, r("m5", "top10"), { lease: "lock:x", token: a });
    await db.query("update kv set updated_at = now() - interval '2 minutes' where k = 'lock:x'");
    const b = (await kv.lease(db, "lock:x", 60_000))!;
    await showLatestReading(db, "M", { lease: "lock:x", token: a });
    expect(await db.one("select latest_checkpoint from coins where mint = 'M'")).toEqual({ latest_checkpoint: "m1" });
    // B's pass finds every checkpoint sealed, seals nothing, and still brings the coin up to m5.
    const coin = (await db.one<CoinRow>("select * from coins where mint = 'M'"))!;
    expect(await gradeCoin(db, coin, new History(), new TierWindow(), Date.now(), { lease: "lock:x", token: b })).toBe(0);
    expect(await db.one("select latest_checkpoint, latest_tier, flagged_at is not null as flagged from coins where mint = 'M'"))
      .toEqual({ latest_checkpoint: "m5", latest_tier: "top10", flagged: true });
    expect((await db.query("select seq from readings")).length).toBe(3);
    await db.close();
  });
});
