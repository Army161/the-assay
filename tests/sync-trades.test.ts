// syncTrades pages back to the last signature it saw, so trades older than one page are not skipped.
import { describe, it, expect } from "vitest";
import { PublicKey, type ParsedTransactionWithMeta, type Connection } from "@solana/web3.js";
import txs from "./fixtures/devnet-txs.json";
import keys from "./fixtures/devnet-keys.json";
import { freshDb, kv, kvWriter, LeaseLost } from "../src/lib/db";
import { SCHEMA_SQL } from "../src/lib/db/schema";
import { syncTrades, tradesCaughtUp, tradesCoverRealA, tradesCoverSold, requeueDead, activeCoins, markVisited, parseTrade, soldDelta, type CoinRow } from "../src/lib/indexer";
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
const EVENT_AUTHORITY = "4uAB7seenFJKPUXqYewAdfra2u6baBgjiXU8x1SC7Ycz"; // LaunchLab devnet's emit_cpi signer
function vaultA(t: ParsedTransactionWithMeta) {
  const i = t.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === keys.vaultA);
  return { pre: t.meta!.preTokenBalances!.find((x) => x.accountIndex === i)?.uiTokenAmount, post: t.meta!.postTokenBalances!.find((x) => x.accountIndex === i)!.uiTokenAmount };
}
/** The fixture with `extra` base units also sent straight to vault A in the same transaction (anyone can). */
function deposit(name: string, extra: bigint): ParsedTransactionWithMeta {
  const t = revive(T[name]);
  const { post } = vaultA(t);
  post.amount = (BigInt(post.amount) + extra).toString();
  return t;
}
/** The fixture without LaunchLab's event instructions, as an older transaction with no inner instructions reads. */
function noEvent(t: ParsedTransactionWithMeta): ParsedTransactionWithMeta {
  for (const g of t.meta!.innerInstructions!)
    g.instructions = g.instructions.filter((i) => String((i as { accounts?: unknown[] }).accounts?.[0]) !== EVENT_AUTHORITY);
  return t;
}

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

  it("stores a trade by LaunchLab's count when the same transaction also sends tokens to the vault, so coverage still holds", async () => {
    const db = await seed();
    const byName = new Map(["create", "buy", "sell", "fill"].map((n) => [sigOf(n), n === "buy" ? deposit("buy", 1n) : revive(T[n])]));
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ok("fill")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => byName.get(s) ?? null),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    expect(await syncTrades(db, conn, { ...(await db.one<CoinRow>("select * from coins"))!, last_sig: null }, state(), "devnet")).toBe(4);
    const buy = await db.one<{ token_base: string }>("select token_base::text from trades where sig = $1", [sigOf("buy")]);
    expect(buy?.token_base.split(".")[0]).toBe("330288924642439"); // not 1 less, as vault A's balance alone would say
    expect(await tradesCoverRealA(db, keys.mint, 793_100_000_000_000n)).toBe(true);
    await db.close();
  });

  it("keeps a trade for each coin when one transaction trades on two of our pools", async () => {
    const db = await seed();
    const other = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
    // Its own pool, whose event this transaction does not carry, so its trade is read from the vaults.
    await db.query(
      `insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports)
       values ($1,$2,'devnet','Other Coin','OTHER',$3,now(),6,$4,$4,1500000000)`, [other, new PublicKey(new Uint8Array(32).fill(8)).toBase58(), ADMIN, keys.supply]);
    const conn = {
      getSignaturesForAddress: chain([ok("buy")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map(() => revive(T.buy)),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    for (const mint of [keys.mint, other]) {
      const coin = (await db.one<CoinRow>("select * from coins where mint = $1", [mint]))!;
      expect(await syncTrades(db, conn, { ...coin, last_sig: null }, state(), "devnet")).toBe(1);
    }
    const rows = await db.query<{ mint: string }>("select mint from trades where sig = $1 order by mint", [sigOf("buy")]);
    expect(rows.map((r) => r.mint)).toEqual([keys.mint, other].sort());
    await db.close();
  });

  it("re-keys a trades table from before by signature and coin, once", async () => {
    const db = await seed();
    // As the table was: keyed by signature alone.
    await db.query("alter table trades drop constraint trades_pkey, add primary key (sig)");
    const add = (mint: string) => db.query(
      "insert into trades (sig, mint, slot, ts, side, wallet, sol_lamports, token_base, price_sol) values ('S', $1, 1, now(), 'buy', 'W', 1, 1, 1) on conflict do nothing", [mint]);
    const other = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
    await db.query(`insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports)
       values ($1,'P2','devnet','Other Coin','OTHER',$2,now(),6,1,1,1)`, [other, ADMIN]);
    await add(keys.mint);
    await add(other);
    expect(await db.query("select 1 from trades")).toHaveLength(1);
    const key = async () => (await db.one<{ cols: string }>(
      "select array_to_string(array(select a.attname from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k order by a.attname), ',') as cols from pg_constraint c where c.conrelid = 'trades'::regclass and c.contype = 'p'"))?.cols;
    for (let i = 0; i < 2; i++) {
      await db.query(SCHEMA_SQL);
      expect(await key()).toBe("mint,sig");
    }
    await add(other);
    expect(await db.query("select 1 from trades")).toHaveLength(2);
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

describe("trade amounts from LaunchLab's TradeEvent", () => {
  const k = { ...keys, pool: POOL };
  it("reads each trade's change to the pool's sold count, and nothing from other transactions or pools", () => {
    expect(soldDelta(revive(T.create), POOL)).toBe(91_110_910_769_853n);
    expect(soldDelta(revive(T.buy), POOL)).toBe(330_288_924_642_439n);
    expect(soldDelta(revive(T.sell), POOL)).toBe(-161_858_087_521_026n); // what reached the vault after the 1% transfer fee
    expect(soldDelta(revive(T.fill), POOL)).toBe(533_558_252_108_734n);
    expect(soldDelta(revive(T.migrate), POOL)).toBeNull();
    expect(soldDelta(revive(T.claim), POOL)).toBeNull();
    expect(soldDelta(revive(T.buy), keys.vaultA)).toBeNull(); // another pool's event
  });
  it("is not moved by tokens sent to vault A in the same transaction", () => {
    expect(parseTrade(deposit("buy", 1n), k)).toMatchObject({ side: "buy", tokenBase: 330_288_924_642_439n, solLamports: 294_000_000n });
    expect(parseTrade(deposit("sell", 1n), k)).toMatchObject({ side: "sell", tokenBase: 161_858_087_521_026n });
    expect(parseTrade(deposit("create", 1n), k)).toMatchObject({ side: "buy", tokenBase: 91_110_910_769_853n });
  });
  it("still reads a buy when the deposit outweighs it and vault A ends higher than it started", () => {
    const t = revive(T.buy);
    const v = vaultA(t);
    v.post.amount = (BigInt(v.pre!.amount) + 1n).toString();
    expect(parseTrade(t, k)).toMatchObject({ side: "buy", tokenBase: 330_288_924_642_439n });
  });
  it("falls back to the vault balances without the event, or without the pool", () => {
    expect(parseTrade(noEvent(deposit("buy", 1n)), k)).toMatchObject({ side: "buy", tokenBase: 330_288_924_642_438n });
    expect(parseTrade(deposit("buy", 1n), keys)).toMatchObject({ side: "buy", tokenBase: 330_288_924_642_438n });
    expect(parseTrade(noEvent(revive(T.sell)), k)).toMatchObject({ side: "sell", tokenBase: 161_858_087_521_026n });
  });
  it("ignores an event-shaped instruction that LaunchLab's event authority did not sign, or another program's", () => {
    // The buy with a bundled deposit, its event instruction edited as a look-alike would carry it.
    const forged = (edit: (i: { programId: unknown; accounts: unknown[] }) => void) => {
      const t = deposit("buy", 1n);
      for (const i of t.meta!.innerInstructions!.flatMap((g) => g.instructions) as unknown as { programId: unknown; accounts: unknown[] }[])
        if (String(i.accounts?.[0]) === EVENT_AUTHORITY) edit(i);
      return t;
    };
    expect(soldDelta(forged((i) => { i.accounts = [ADMIN]; }), POOL)).toBeNull();
    expect(soldDelta(forged((i) => { i.programId = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"; }), POOL)).toBeNull();
    expect(parseTrade(forged((i) => { i.accounts = [ADMIN]; }), k)).toMatchObject({ tokenBase: 330_288_924_642_438n });
  });
});

describe("tradesCoverRealA", () => {
  // Vault A balances from the devnet run: created holding the supply, then the dev buy, a buy, a sell and the fill.
  const legs: [string, "buy" | "sell", bigint][] = [
    ["create", "buy", 1_000_000_000_000_000n - 908_889_089_230_147n],
    ["buy", "buy", 908_889_089_230_147n - 578_600_164_587_708n],
    ["sell", "sell", 740_458_252_108_734n - 578_600_164_587_708n],
    ["fill", "buy", 740_458_252_108_734n - 206_900_000_000_000n],
  ];
  async function setup(skip?: string) {
    const db = await freshDb();
    await db.query(
      `insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports)
       values ($1,$2,'devnet','T','T',$3,now(),6,$4,$5,1)`, [keys.mint, POOL, ADMIN, keys.supply, "793100000000000"]);
    for (const [i, [sig, side, tokens]] of legs.entries()) {
      if (sig === skip) continue;
      await db.query(`insert into trades (sig, mint, slot, ts, side, wallet, sol_lamports, token_base, price_sol) values ($1,$2,$3,now(),$4,$5,1,$6,0)`,
        [sig, keys.mint, i, side, ADMIN, tokens.toString()]);
    }
    return db;
  }
  // The pool's realA after the sell and after the fill, from LaunchLab's TradeEvents in the same run.
  it("holds when the stored trades add up to the pool's sold count to the base unit", async () => {
    expect(await tradesCoverRealA(await setup(), keys.mint, 793_100_000_000_000n)).toBe(true);
    expect(await tradesCoverRealA(await setup("fill"), keys.mint, 259_541_747_891_266n)).toBe(true);
  });
  it("fails while a trade the pool already counts is missing", async () => {
    expect(await tradesCoverRealA(await setup("sell"), keys.mint, 793_100_000_000_000n)).toBe(false);
    expect(await tradesCoverRealA(await setup("sell"), keys.mint, 259_541_747_891_266n)).toBe(false);
  });
  it("on a full curve, holds only when the stored trades add up to the curve's total sale", async () => {
    expect(await tradesCoverSold(await setup(), keys.mint)).toBe(true);
    expect(await tradesCoverSold(await setup("fill"), keys.mint)).toBe(false); // the final trade arrived late
  });
});
