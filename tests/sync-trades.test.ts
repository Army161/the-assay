// syncTrades pages back to the last signature it saw, so trades older than one page are not skipped.
import { describe, it, expect } from "vitest";
import { PublicKey, type ParsedTransactionWithMeta, type Connection } from "@solana/web3.js";
import txs from "./fixtures/devnet-txs.json";
import keys from "./fixtures/devnet-keys.json";
import { freshDb, kv, kvWriter, LeaseLost } from "../src/lib/db";
import { syncTrades, tradesCaughtUp, requeueDead, activeCoins, markVisited, type CoinRow } from "../src/lib/indexer";
import type { PoolState } from "../src/lib/raydium";

const T = txs as Record<string, unknown>;
function revive(tx: unknown): ParsedTransactionWithMeta {
  const t = JSON.parse(JSON.stringify(tx)) as ParsedTransactionWithMeta;
  for (const k of t.transaction.message.accountKeys) (k as { pubkey: PublicKey }).pubkey = new PublicKey(k.pubkey as unknown as string);
  return t;
}
const sigOf = (name: string) => (T[name] as { transaction: { signatures: string[] } }).transaction.signatures[0];
const ADMIN = "HuwVSvu39rDuyYJZihkfGaLTGPpd92rCG8BWVmT6MZKb";
const POOL = "6uuazvgCKVt4izeEZg16Gi8j8NfTzLAjVUu29puA4Q1z";

describe("syncTrades", () => {
  it("reads every page back to the last signature seen, stores oldest first and moves the cursor", async () => {
    const db = await freshDb();
    await db.query(
      `insert into coins (mint, pool_id, network, name, symbol, creator, created_at, create_sig, decimals, supply, total_sell, fund_target_lamports)
       values ($1,$2,'devnet','Assay Test Coin','ASSAY',$3,now(),$4,6,$5,$5,1500000000)`,
      [keys.mint, POOL, ADMIN, sigOf("create"), keys.supply]);
    // Newest first, as the RPC answers: a full first page (the fill, then 999 failed transactions), then the sell and the buy.
    const filler = Array.from({ length: 999 }, (_, i) => ({ signature: `failed${i}`, slot: 0, err: { InstructionError: [0, "Custom"] }, memo: null, blockTime: null }));
    const pages = [[{ signature: sigOf("fill"), slot: 3, err: null, memo: null, blockTime: null }, ...filler],
      [{ signature: sigOf("sell"), slot: 2, err: null, memo: null, blockTime: null }, { signature: sigOf("buy"), slot: 1, err: null, memo: null, blockTime: null }]];
    const calls: { until?: string; before?: string }[] = [];
    const byName = new Map(["buy", "sell", "fill"].map((n) => [sigOf(n), revive(T[n])]));
    const conn = {
      getSignaturesForAddress: async (_: PublicKey, o: { until?: string; before?: string }) => { calls.push({ until: o.until, before: o.before }); return pages[calls.length - 1] ?? []; },
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => byName.get(s) ?? null),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    const state = { vaultA: new PublicKey(keys.vaultA), vaultB: new PublicKey(keys.vaultB), creator: new PublicKey(ADMIN), platformId: new PublicKey("2nQcifUC6ZX7bL4T83iuyAHZ9auVfi9EdhE543HjUdXM") } as unknown as PoolState;
    const coin = (await db.one<CoinRow>("select * from coins"))!;

    const n = await syncTrades(db, conn, { ...coin, last_sig: sigOf("create") }, state, "devnet");

    expect(n).toBe(3);
    expect(calls).toEqual([{ until: sigOf("create"), before: undefined }, { until: sigOf("create"), before: "failed998" }]);
    const rows = await db.query<{ sig: string; side: string }>("select sig, side from trades order by ts, slot");
    expect(rows.map((r) => r.side)).toEqual(["buy", "sell", "buy"]);
    expect((await kv.get<{ sig: string }>(db, `last_sig:${keys.mint}`))?.sig).toBe(sigOf("fill"));
    await db.close();
  });

  // A pool's signatures as the RPC serves them: newest first, `before` and `until` exclusive, at most `limit`.
  function chain(oldestFirst: { signature: string; err: unknown }[]) {
    const newest = [...oldestFirst].reverse().map((s, i) => ({ ...s, slot: oldestFirst.length - i, memo: null, blockTime: null }));
    return async (_: PublicKey, o: { limit: number; until?: string; before?: string }) => {
      let from = 0;
      if (o.before) from = newest.findIndex((s) => s.signature === o.before) + 1;
      let to = newest.length;
      if (o.until) { const u = newest.findIndex((s) => s.signature === o.until); if (u >= 0) to = u; }
      return newest.slice(from, Math.min(to, from + o.limit));
    };
  }
  const failed = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ signature: `${tag}${i}`, err: { InstructionError: [0, "Custom"] } }));
  const ok = (name: string) => ({ signature: sigOf(name), err: null });
  const state = () => ({ vaultA: new PublicKey(keys.vaultA), vaultB: new PublicKey(keys.vaultB), creator: new PublicKey(ADMIN), platformId: new PublicKey("2nQcifUC6ZX7bL4T83iuyAHZ9auVfi9EdhE543HjUdXM") } as unknown as PoolState);
  async function seed() {
    const db = await freshDb();
    await db.query(
      `insert into coins (mint, pool_id, network, name, symbol, creator, created_at, create_sig, decimals, supply, total_sell, fund_target_lamports)
       values ($1,$2,'devnet','Assay Test Coin','ASSAY',$3,now(),$4,6,$5,$5,1500000000)`,
      [keys.mint, POOL, ADMIN, sigOf("create"), keys.supply]);
    return db;
  }
  const cursor = async (db: Awaited<ReturnType<typeof freshDb>>) => (await kv.get<{ sig: string }>(db, `last_sig:${keys.mint}`))?.sig ?? sigOf("create");
  const coinAt = async (db: Awaited<ReturnType<typeof freshDb>>) => ({ ...(await db.one<CoinRow>("select * from coins"))!, last_sig: await cursor(db) });

  it("with more than ten pages waiting, reads on over later passes and skips nothing", async () => {
    const db = await seed();
    const byName = new Map(["buy", "sell", "fill"].map((n) => [sigOf(n), revive(T[n])]));
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ...failed(10_500, "f"), ok("fill")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => byName.get(s) ?? null),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;

    // pass 1 reads the newest 10,000 and stores nothing, since the oldest are not in hand yet
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(0);
    expect(await cursor(db)).toBe(sigOf("create"));
    expect(await tradesCaughtUp(db, keys.mint)).toBe(false); // stats and readings wait
    // pass 2 reads on from there to the cursor and stores the buy and the sell
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(2);
    expect(await kv.get(db, `sig_scan:${keys.mint}`)).toBeNull();
    expect(await tradesCaughtUp(db, keys.mint)).toBe(false); // the newer signatures past the backlog are not read yet
    // pass 3 starts again from the newest and picks up the rest
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(1);
    expect(await cursor(db)).toBe(sigOf("fill"));
    expect(await tradesCaughtUp(db, keys.mint)).toBe(true);
    const rows = await db.query<{ side: string }>("select side from trades order by ts, slot");
    expect(rows.map((r) => r.side)).toEqual(["buy", "sell", "buy"]);
    await db.close();
  });

  it("asks for version-1 transactions, which the RPC otherwise refuses for the whole batch (mainnet carries them)", async () => {
    const db = await seed();
    const byName = new Map(["buy", "sell", "fill"].map((n) => [sigOf(n), revive(T[n])]));
    const asked: (number | undefined)[] = [];
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ok("fill")]),
      getParsedTransactions: async (sigs: string[], o?: { maxSupportedTransactionVersion?: number }) => {
        asked.push(o?.maxSupportedTransactionVersion);
        // As the mainnet RPC answers when one transaction in the batch is version 1 and the caller allows less.
        if ((o?.maxSupportedTransactionVersion ?? -1) < 1) throw new Error("Transaction version (1) is not supported by the requesting client.");
        return sigs.map((s) => byName.get(s) ?? null);
      },
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;

    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(3);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((v) => v === 1)).toBe(true);
    await db.close();
  });

  it("stops before a landed transaction the RPC has not got yet, and stores it on a later pass", async () => {
    const db = await seed();
    const byName = new Map(["buy", "sell", "fill"].map((n) => [sigOf(n), revive(T[n])]));
    let lagging = true;
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ok("fill")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => (lagging && s === sigOf("sell") ? null : byName.get(s) ?? null)),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;

    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(1);
    expect(await cursor(db)).toBe(sigOf("buy"));
    expect(await tradesCaughtUp(db, keys.mint)).toBe(false); // the sell is held back, so stats and readings wait
    lagging = false;
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(2);
    expect(await cursor(db)).toBe(sigOf("fill"));
    expect(await tradesCaughtUp(db, keys.mint)).toBe(true);
    await db.close();
  });

  it("moves past a transaction still missing after five passes, and stores it once the RPC serves it", async () => {
    const db = await seed();
    const byName = new Map(["buy", "fill"].map((n) => [sigOf(n), revive(T[n])]));
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ok("fill")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => byName.get(s) ?? null),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    for (let i = 0; i < 4; i++) await syncTrades(db, conn, await coinAt(db), state(), "devnet");
    expect(await cursor(db)).toBe(sigOf("buy"));
    await syncTrades(db, conn, await coinAt(db), state(), "devnet");
    expect(await cursor(db)).toBe(sigOf("fill"));
    expect(await kv.get(db, `sig_retry:${keys.mint}`)).toEqual([{ sig: sigOf("sell"), tries: 0 }]);
    expect(await tradesCaughtUp(db, keys.mint)).toBe(false); // the sell is still owed: no stats or readings yet
    // still missing: kept in the queue
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(0);
    expect(await kv.get(db, `sig_retry:${keys.mint}`)).toEqual([{ sig: sigOf("sell"), tries: 1 }]);
    expect(await tradesCaughtUp(db, keys.mint)).toBe(false);
    // the RPC catches up: the sell is stored and leaves the queue
    byName.set(sigOf("sell"), revive(T.sell));
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(1);
    expect(await kv.get(db, `sig_retry:${keys.mint}`)).toBeNull();
    expect(await tradesCaughtUp(db, keys.mint)).toBe(true);
    const rows = await db.query<{ side: string }>("select side from trades order by ts, slot");
    expect(rows.map((r) => r.side)).toEqual(["buy", "sell", "buy"]);
    await db.close();
  });

  it("keeps a coin graduated long ago in the pass while its trades are not all in", async () => {
    const db = await seed();
    await db.query("update coins set graduated_at = now() - interval '3 days'");
    expect(await activeCoins(db, "devnet", 200)).toHaveLength(0);
    for (const k of ["sig_scan", "sig_behind", "sig_missing", "sig_retry"]) {
      await kv.set(db, `${k}:${keys.mint}`, {});
      expect((await activeCoins(db, "devnet", 200)).map((c) => c.mint)).toEqual([keys.mint]);
      await kv.del(db, `${k}:${keys.mint}`);
    }
    await db.close();
  });

  it("gives every eligible coin its turn when more qualify than a pass takes, newest launches first", async () => {
    const db = await seed();
    // The backlog coin graduated days ago; 5 live coins launched an hour ago crowd it out of a newest-first pick.
    await db.query("update coins set created_at = now() - interval '4 days', graduated_at = now() - interval '3 days'");
    await kv.set(db, `sig_retry:${keys.mint}`, [{ sig: "x", tries: 0 }]);
    for (let i = 0; i < 5; i++)
      await db.query(`insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports)
                      values ($1,$2,'devnet','C','C','X',now() - interval '1 hour',6,1,1,1)`, [`live${i}`, `pool${i}`]);
    const pass = async () => {
      const picked = (await activeCoins(db, "devnet", 2)).map((c) => c.mint);
      for (const m of picked) await markVisited(db, m);
      return picked;
    };
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) for (const m of await pass()) seen.add(m);
    expect(seen).toEqual(new Set([keys.mint, "live0", "live1", "live2", "live3", "live4"]));
    // A coin that just launched goes ahead of every coin waiting its turn.
    await db.query(`insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports)
                    values ('fresh','poolF','devnet','C','C','X',now(),6,1,1,1)`);
    expect((await pass())[0]).toBe("fresh");
    await db.close();
  });

  it("keeps a share of every pass for older coins while new launches fill the rest", async () => {
    const db = await seed();
    await db.query("update coins set created_at = now() - interval '4 days', graduated_at = now() - interval '3 days'");
    await kv.set(db, `sig_retry:${keys.mint}`, [{ sig: "x", tries: 0 }]);
    for (let i = 0; i < 12; i++)
      await db.query(`insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports)
                      values ($1,$2,'devnet','C','C','X',now(),6,1,1,1)`, [`new${i}`, `pool${i}`]);
    // 12 coins under 10 minutes old against a limit of 4: the backlog coin still makes every pass, and the new
    // launches rotate through the other 3 places.
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const picked = (await activeCoins(db, "devnet", 4)).map((c) => c.mint);
      expect(picked).toHaveLength(4);
      expect(picked).toContain(keys.mint);
      for (const m of picked) { seen.add(m); await markVisited(db, m); }
    }
    expect(seen.size).toBe(13);
    await db.close();
  });

  it("gives both groups a place with the smallest pass, and refuses a pass too small to share", async () => {
    const db = await seed();
    await db.query("update coins set created_at = now() - interval '4 days', graduated_at = now() - interval '3 days'");
    await kv.set(db, `sig_retry:${keys.mint}`, [{ sig: "x", tries: 0 }]);
    for (let i = 0; i < 3; i++)
      await db.query(`insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports)
                      values ($1,$2,'devnet','C','C','X',now(),6,1,1,1)`, [`new${i}`, `pool${i}`]);
    for (let i = 0; i < 3; i++) {
      const picked = (await activeCoins(db, "devnet", 2)).map((c) => c.mint);
      expect(picked).toEqual([`new${i}`, keys.mint]); // a new launch and the backlog coin, every pass
      for (const m of picked) await markVisited(db, m);
    }
    await expect(activeCoins(db, "devnet", 1)).rejects.toBeInstanceOf(RangeError);
    await expect(activeCoins(db, "devnet", 0)).rejects.toBeInstanceOf(RangeError);
    await db.close();
  });

  it("never trims the dead-letter list: every signature past the retry queue stays there for backfill", async () => {
    const db = await seed();
    const byName = new Map(["buy", "fill"].map((n) => [sigOf(n), revive(T[n])]));
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ok("fill")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => byName.get(s) ?? null),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    const old = Array.from({ length: 6_000 }, (_, i) => `old${i}`);
    await kv.set(db, `sig_dead:${keys.mint}`, old);
    await kv.set(db, `sig_retry:${keys.mint}`, [{ sig: sigOf("sell"), tries: 49 }]);
    await kv.set(db, `last_sig:${keys.mint}`, { sig: sigOf("fill") });
    await syncTrades(db, conn, await coinAt(db), state(), "devnet");
    const dead = (await kv.get<string[]>(db, `sig_dead:${keys.mint}`))!;
    expect(dead).toHaveLength(6_001);
    expect(dead[0]).toBe("old0");
    expect(dead.at(-1)).toBe(sigOf("sell"));
    await db.close();
  });

  it("writes nothing once another pass takes its lease mid-pass", async () => {
    const db = await seed();
    const byName = new Map(["buy", "sell", "fill"].map((n) => [sigOf(n), revive(T[n])]));
    const a = (await kv.lease(db, "lock:indexer", 120_000))!;
    let b: string | null = null;
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ok("fill")]),
      // A pauses here, after its last renewal; its lease runs out, B takes over and moves the cursor.
      getParsedTransactions: async (sigs: string[]) => {
        await db.query("update kv set updated_at = now() - interval '5 minutes' where k = 'lock:indexer'");
        b = await kv.lease(db, "lock:indexer", 120_000);
        await kv.set(db, `last_sig:${keys.mint}`, { sig: "B-cursor" });
        await kv.set(db, `sig_retry:${keys.mint}`, [{ sig: "B-retry", tries: 3 }]);
        return sigs.map((s) => byName.get(s) ?? null);
      },
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    const w = kvWriter(db, { lease: "lock:indexer", token: a });
    await expect(syncTrades(db, conn, await coinAt(db), state(), "devnet", async () => {}, w)).rejects.toBeInstanceOf(LeaseLost);
    expect(b).not.toBeNull();
    // B's cursor and retry queue stand; A wrote neither.
    expect(await cursor(db)).toBe("B-cursor");
    expect(await kv.get(db, `sig_retry:${keys.mint}`)).toEqual([{ sig: "B-retry", tries: 3 }]);
    await db.close();
  });

  it("asks for a large requeued backlog in RPC-sized chunks, a bounded share per pass, and reaches all of it", async () => {
    const db = await seed();
    const byName = new Map(["buy", "sell", "fill"].map((n) => [sigOf(n), revive(T[n])]));
    const asked: number[] = [];
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ok("fill")]),
      getParsedTransactions: async (sigs: string[]) => { asked.push(sigs.length); return sigs.map((s) => byName.get(s) ?? null); },
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    await syncTrades(db, conn, await coinAt(db), state(), "devnet");
    const backlog = Array.from({ length: 450 }, (_, i) => ({ sig: `gone${i}`, tries: 0 }));
    await kv.set(db, `sig_retry:${keys.mint}`, backlog);
    asked.length = 0;
    await syncTrades(db, conn, await coinAt(db), state(), "devnet");
    expect(Math.max(...asked)).toBeLessThanOrEqual(100);
    expect(asked.reduce((a, b) => a + b, 0)).toBe(200);
    let q = (await kv.get<{ sig: string; tries: number }[]>(db, `sig_retry:${keys.mint}`))!;
    expect(q).toHaveLength(450);
    expect(q[0]).toEqual({ sig: "gone200", tries: 0 }); // the ones not reached go first next time
    await syncTrades(db, conn, await coinAt(db), state(), "devnet");
    await syncTrades(db, conn, await coinAt(db), state(), "devnet");
    q = (await kv.get<{ sig: string; tries: number }[]>(db, `sig_retry:${keys.mint}`))!;
    expect(q.every((r) => r.tries >= 1)).toBe(true); // three passes reached all 450
    await db.close();
  });

  it("keeps a transaction that outlasts the retries for backfill, and stores it once requeued", async () => {
    const db = await seed();
    const byName = new Map(["buy", "fill"].map((n) => [sigOf(n), revive(T[n])]));
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ok("fill")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => byName.get(s) ?? null),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    await syncTrades(db, conn, await coinAt(db), state(), "devnet");
    await kv.set(db, `sig_retry:${keys.mint}`, [{ sig: sigOf("sell"), tries: 49 }]); // one retry left
    await kv.del(db, `sig_missing:${keys.mint}`);
    await kv.set(db, `last_sig:${keys.mint}`, { sig: sigOf("fill") });
    await syncTrades(db, conn, await coinAt(db), state(), "devnet");
    expect(await kv.get(db, `sig_retry:${keys.mint}`)).toBeNull();
    expect(await kv.get(db, `sig_dead:${keys.mint}`)).toEqual([sigOf("sell")]);
    // the RPC serves it later: a backfill requeues it and the next pass stores it
    byName.set(sigOf("sell"), revive(T.sell));
    expect(await requeueDead(db, keys.mint)).toBe(1); // takes and frees the indexer lease
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(1);
    expect(await kv.get(db, `sig_dead:${keys.mint}`)).toBeNull();
    expect((await db.query("select 1 from trades where sig = $1", [sigOf("sell")])).length).toBe(1);
    await db.close();
  });
});
