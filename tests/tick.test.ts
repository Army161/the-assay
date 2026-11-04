import { describe, it, expect } from "vitest";
import { freshDb } from "../src/lib/db";
import { claim } from "../src/lib/tick";

describe("tick claim", () => {
  it("lets exactly one of many concurrent callers run, then opens again after the interval", async () => {
    const db = await freshDb();
    const wins = await Promise.all(Array.from({ length: 8 }, () => claim(db, "index", 20_000)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await claim(db, "index", 20_000)).toBe(false);
    // a different job has its own lock
    expect(await claim(db, "rewards", 600_000)).toBe(true);
    // age the index lock past the interval: it opens again
    await db.query("update kv set updated_at = now() - interval '21 seconds' where k = 'tick:index'");
    expect(await claim(db, "index", 20_000)).toBe(true);
    expect(await claim(db, "index", 20_000)).toBe(false);
    await db.close();
  });
});
