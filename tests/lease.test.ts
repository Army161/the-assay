// The kv lease: one holder at a time, and a holder that outlived its lease cannot renew or release its successor's.
import { describe, it, expect } from "vitest";
import { freshDb, kv, LeaseLost } from "../src/lib/db";
import { seal } from "../src/lib/ledger";

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
});
