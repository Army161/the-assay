// The kv lease: one holder at a time, and a holder that outlived its lease cannot renew or release its successor's.
import { describe, it, expect } from "vitest";
import { freshDb, kv } from "../src/lib/db";

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
});
