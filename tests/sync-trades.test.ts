// syncTrades pages back to the last signature it saw, so trades older than one page are not skipped.
import { describe, it, expect } from "vitest";
import { PublicKey, type ParsedTransactionWithMeta, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import txs from "./fixtures/devnet-txs.json";
import keys from "./fixtures/devnet-keys.json";
import { freshDb, kv, kvWriter, LeaseLost } from "../src/lib/db";
import { SCHEMA_SQL } from "../src/lib/db/schema";
import { liveFeatures } from "../src/lib/grade/features";
import { syncTrades, tradesCaughtUp, tradesCoverRealA, tradesCoverSold, requeueDead, activeCoins, markVisited, parseTrades, tradeEvents, liveTrades, type CoinRow } from "../src/lib/indexer";
import type { PoolState } from "../src/lib/raydium";

const T = txs as Record<string, unknown>;
function revive(tx: unknown): ParsedTransactionWithMeta {
  const t = JSON.parse(JSON.stringify(tx)) as ParsedTransactionWithMeta;
  for (const k of t.transaction.message.accountKeys) (k as { pubkey: PublicKey }).pubkey = new PublicKey(k.pubkey as unknown as string);
  return t;
}
const sigOf = (name: string) => (T[name] as { transaction: { signatures: string[] } }).transaction.signatures[0];
const ADMIN = "HuwVSvu39rDuyYJZihkfGaLTGPpd92rCG8BWVmT6MZKb";
const TRADER = "8pEWdNpw9J5Ku8jfti2Gos9pAcb4cT8Ujcw9WgpBtA1g", CALLER = "4SpvrEbNnGWeaTJfoCQP4iV6D28H3h3Twk1v1QWjBcCy";
const POOL = "6uuazvgCKVt4izeEZg16Gi8j8NfTzLAjVUu29puA4Q1z";
const EVENT_AUTHORITY = "4uAB7seenFJKPUXqYewAdfra2u6baBgjiXU8x1SC7Ycz"; // LaunchLab devnet's emit_cpi signer
function balances(t: ParsedTransactionWithMeta, vault: string) {
  const i = t.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === vault);
  return { pre: t.meta!.preTokenBalances!.find((x) => x.accountIndex === i)?.uiTokenAmount, post: t.meta!.postTokenBalances!.find((x) => x.accountIndex === i)!.uiTokenAmount };
}
const vaultA = (t: ParsedTransactionWithMeta) => balances(t, keys.vaultA);
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
// Building transactions with more than one trade, from the real ones: a LaunchLab buy/sell instruction and its event.
type Ix = { programId: string; accounts: string[]; data: string; stackHeight?: number | null };
const tradeIx = (t: ParsedTransactionWithMeta) => (t.transaction.message.instructions as unknown as Ix[]).find((i) => (i.accounts?.length ?? 0) >= 18)!;
const eventIx = (t: ParsedTransactionWithMeta) => (t.meta!.innerInstructions!.flatMap((g) => g.instructions) as unknown as Ix[]).find((i) => String(i.accounts?.[0]) === EVENT_AUTHORITY)!;
/** The pool's sold count and quote after the event in `t`. */
const after = (t: ParsedTransactionWithMeta) => { const d = Buffer.from(bs58.decode(eventIx(t).data)); return { base: d.readBigUInt64LE(88), quote: d.readBigUInt64LE(96) }; };
/** A TradeEvent like the one in `t`, for a trade from `from` that moves the sold count by `sold` (negative for a sale) and the quote by `quote`. */
function tradeEvent(t: ParsedTransactionWithMeta, from: { base: bigint; quote: bigint }, sold: bigint, quote: bigint, protocolFee: bigint): Ix {
  const d = Buffer.from(bs58.decode(eventIx(t).data));
  d.writeBigUInt64LE(from.base, 72); d.writeBigUInt64LE(from.quote, 80); d.writeBigUInt64LE(from.base + sold, 88); d.writeBigUInt64LE(from.quote + quote, 96);
  d.writeBigUInt64LE(protocolFee, 120); d[152] = sold < 0n ? 1 : 0;
  return { ...eventIx(t), data: bs58.encode(d) };
}
/** `t` with one more top-level LaunchLab trade run after its own: the instruction, then the event it emits. */
function andThen(t: ParsedTransactionWithMeta, ix: Ix, event: Ix): ParsedTransactionWithMeta {
  t.transaction.message.instructions.push(ix as never);
  t.meta!.innerInstructions!.push({ index: t.transaction.message.instructions.length - 1, instructions: [event as never] });
  return t;
}
/** The buy, then a sale of the same tokens by the same trader in the same transaction, as a volume bot would. */
function washed(): ParsedTransactionWithMeta {
  const t = revive(T.buy);
  return andThen(t, tradeIx(revive(T.sell)), tradeEvent(t, after(t), -330_288_924_642_439n, -292_500_000n, 731_250n));
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

  it("stores a buy and a sale of the same tokens in one transaction as two trades, and coverage still holds exactly", async () => {
    const db = await seed();
    const byName = new Map([[sigOf("create"), revive(T.create)], [sigOf("buy"), washed()]]);
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => byName.get(s) ?? null),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    expect(await syncTrades(db, conn, { ...(await coinAt(db)), last_sig: null }, state(), "devnet")).toBe(3);
    const rows = await db.query("select ix, side, wallet, referrer, sol_lamports::text as sol, token_base::text as tokens from trades where sig = $1 order by ix", [sigOf("buy")]);
    expect(rows).toEqual([
      { ix: 0, side: "buy", wallet: TRADER, referrer: CALLER, sol: "294000000", tokens: "330288924642439" },
      { ix: 1, side: "sell", wallet: TRADER, referrer: CALLER, sol: "291768750", tokens: "330288924642439" }, // 292.5m out of the curve, less the protocol fee kept in vault B
    ]);
    // The pool's sold count is back where the creation left it; the stored trades add up to it, with both legs counted.
    expect(await tradesCoverRealA(db, keys.mint, 91_110_910_769_853n)).toBe(true);
    expect(await tradesCoverRealA(db, keys.mint, 91_110_910_769_853n + 330_288_924_642_439n)).toBe(false);
    // A later pass that reads the transactions again adds nothing.
    expect(await syncTrades(db, conn, { ...(await coinAt(db)), last_sig: null }, state(), "devnet")).toBe(3);
    expect(await db.query("select 1 from trades")).toHaveLength(3);
    await db.close();
  });

  it("stores a sale at its price when wrapped SOL is sent to vault B in the same transaction", async () => {
    const db = await seed();
    const sale = revive(T.sell);
    const b = balances(sale, keys.vaultB);
    b.post.amount = b.pre!.amount; // a deposit the size of the proceeds
    const byName = new Map([[sigOf("sell"), sale]]);
    const conn = {
      getSignaturesForAddress: chain([ok("sell")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => byName.get(s) ?? null),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    expect(await syncTrades(db, conn, { ...(await coinAt(db)), last_sig: null }, state(), "devnet")).toBe(1);
    const row = await db.one<{ sol: string; price_sol: number }>("select sol_lamports::text as sol, price_sol from trades");
    expect(row?.sol).toBe("173027898");
    expect(row?.price_sol).toBeCloseTo((173_027_898 / 1e9) / (161_858_087_521_026 / 1e6), 15);
    await db.close();
  });

  it("keeps a trade for each coin when one transaction trades on two of our pools", async () => {
    const db = await seed();
    const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
    const [other, otherPool, otherA, otherB] = [key(7), key(8), key(9), key(10)];
    await db.query(
      `insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports)
       values ($1,$2,'devnet','Other Coin','OTHER',$3,now(),6,$4,$4,1500000000)`, [other, otherPool, ADMIN, keys.supply]);
    // The buy, then a buy on the other coin's pool: its own instruction (its vaults at 7 and 8) and its own event.
    const t = revive(T.buy);
    for (const v of [otherA, otherB]) t.transaction.message.accountKeys.push({ pubkey: new PublicKey(v), signer: false, writable: true, source: "transaction" });
    const a = tradeIx(t).accounts;
    const ev = tradeEvent(t, { base: 0n, quote: 0n }, 100_000_000_000_000n, 120_000_000n, 300_000n);
    const d = Buffer.from(bs58.decode(ev.data));
    d.set(bs58.decode(otherPool), 16);
    andThen(t, { ...tradeIx(t), accounts: [...a.slice(0, 7), otherA, otherB, ...a.slice(9)] }, { ...ev, data: bs58.encode(d) });
    const conn = {
      getSignaturesForAddress: chain([ok("buy")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map(() => t),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    const states: Record<string, PoolState> = { [keys.mint]: state(), [other]: { ...state(), vaultA: new PublicKey(otherA), vaultB: new PublicKey(otherB) } };
    for (const mint of [keys.mint, other]) {
      const coin = (await db.one<CoinRow>("select * from coins where mint = $1", [mint]))!;
      expect(await syncTrades(db, conn, { ...coin, last_sig: null }, states[mint], "devnet")).toBe(1);
    }
    const rows = await db.query("select mint, ix, side, wallet, referrer, sol_lamports::text as sol, token_base::text as tokens from trades where sig = $1 order by mint, ix", [sigOf("buy")]);
    // Each coin's row is its own trade, read from its own pool's event.
    const mine = { mint: keys.mint, ix: 0, side: "buy", wallet: TRADER, referrer: CALLER, sol: "294000000", tokens: "330288924642439" };
    const theirs = { mint: other, ix: 0, side: "buy", wallet: TRADER, referrer: CALLER, sol: "120300000", tokens: "100000000000000" };
    expect(rows).toEqual([mine, theirs].sort((x, y) => (x.mint < y.mint ? -1 : 1)));
    await db.close();
  });

  it("re-keys a trades table from before by signature, coin and trade, once", async () => {
    // As the table was: no trade column, keyed by signature alone, then (earlier in this change) by signature and coin.
    for (const [old, before] of [["sig", 1], ["sig, mint", 2]] as const) {
      const db = await seed();
      await db.query("alter table trades drop column ix"); // takes the key with it
      await db.query(`alter table trades add primary key (${old})`);
      const add = (mint: string) => db.query(
        "insert into trades (sig, mint, slot, ts, side, wallet, sol_lamports, token_base, price_sol) values ('S', $1, 1, now(), 'buy', 'W', 1, 1, 1) on conflict do nothing", [mint]);
      const other = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
      await db.query(`insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports)
         values ($1,'P2','devnet','Other Coin','OTHER',$2,now(),6,1,1,1)`, [other, ADMIN]);
      await add(keys.mint);
      await add(other);
      expect(await db.query("select 1 from trades")).toHaveLength(before);
      const key = async () => (await db.one<{ cols: string }>(
        "select array_to_string(array(select a.attname from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k order by a.attname), ',') as cols from pg_constraint c where c.conrelid = 'trades'::regclass and c.contype = 'p'"))?.cols;
      for (let i = 0; i < 2; i++) {
        await db.query(SCHEMA_SQL);
        expect(await key()).toBe("ix,mint,sig");
      }
      // Rows from before each hold their transaction's trades on the coin as one, marked to be replaced on a re-read.
      expect((await db.query<{ ix: number }>("select ix from trades")).every((r) => r.ix === -1)).toBe(true);
      // A second trade in the same transaction on the same coin gets its own row.
      for (const ix of [0, 1]) await db.query("insert into trades (sig, mint, ix, slot, ts, side, wallet, sol_lamports, token_base, price_sol) values ('S', $1, $2, 1, now(), 'sell', 'W', 1, 1, 1) on conflict (sig, mint, ix) do nothing", [other, ix]);
      expect(await db.query("select 1 from trades")).toHaveLength(before + 2);
      await db.close();
    }
  });

  it("replaces a row stored before trades were kept one by one when its transaction is read again, rather than add to it", async () => {
    // A transaction with two buys on the pool, which the code from before stored as one row of both summed, keyed by
    // signature and coin. The pass that stored it was cut off before it moved the cursor, so it is read again.
    const t = revive(T.buy);
    const OTHER = "CRoGW82mPPbrFkep8ZCL8DDrHP7ntsA673aQvud64zJu";
    const a = tradeIx(t).accounts;
    andThen(t, { ...tradeIx(t), accounts: [OTHER, ...a.slice(1, 15), ...a.slice(16)] }, tradeEvent(t, after(t), 100_000_000_000_000n, 120_000_000n, 300_000n));
    const db = await seed();
    await db.query("alter table trades drop column ix");
    await db.query("alter table trades add primary key (sig, mint)");
    const dev = 91_110_910_769_853n, both = 330_288_924_642_439n + 100_000_000_000_000n;
    const old = (sig: string, slot: number, tokens: bigint) => db.query(
      "insert into trades (sig, mint, slot, ts, side, wallet, sol_lamports, token_base, price_sol) values ($1,$2,$3,now(),'buy',$4,1,$5,1)", [sig, keys.mint, slot, ADMIN, tokens.toString()]);
    await old(sigOf("create"), 1, dev);
    await old(sigOf("buy"), 2, both);
    await db.query(SCHEMA_SQL);
    expect(await tradesCoverRealA(db, keys.mint, dev + both)).toBe(true);
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => (s === sigOf("buy") ? t : null)),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(2);
    const rows = await db.query<{ ix: number; tokens: string }>("select ix, token_base::text as tokens from trades where sig = $1 order by ix", [sigOf("buy")]);
    expect(rows).toEqual([{ ix: 0, tokens: "330288924642439" }, { ix: 1, tokens: "100000000000000" }]);
    expect(await tradesCoverRealA(db, keys.mint, dev + both)).toBe(true);
    // The creation transaction, not read again, keeps its row from before, which still counts.
    expect(await db.query("select 1 from trades where sig = $1 and ix = -1", [sigOf("create")])).toHaveLength(1);
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

  it("holds back a trade served without its TradeEvent, and stores it from the event once the RPC serves it whole", async () => {
    const db = await seed();
    // The buy with one more base unit sent straight to vault A in the same transaction, served at first without its
    // event: read from the vaults it would be one base unit short, and as the row is never rewritten, coverage would
    // fail for good.
    const byName = new Map(["create", "buy", "sell", "fill"].map((n) => [sigOf(n), revive(T[n])]));
    byName.set(sigOf("buy"), noEvent(deposit("buy", 1n)));
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ok("fill")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => byName.get(s) ?? null),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    expect(await syncTrades(db, conn, { ...(await coinAt(db)), last_sig: null }, state(), "devnet")).toBe(1); // the creation alone
    expect(await cursor(db)).toBe(sigOf("create"));
    expect(await db.query("select 1 from trades where sig = $1", [sigOf("buy")])).toHaveLength(0);
    expect(await tradesCaughtUp(db, keys.mint)).toBe(false);
    expect(await tradesCoverRealA(db, keys.mint, 793_100_000_000_000n)).toBe(false);
    // Served whole on a later pass: stored from the event, and coverage holds to the base unit.
    byName.set(sigOf("buy"), deposit("buy", 1n));
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(3);
    const buy = await db.one<{ token_base: string }>("select token_base::text from trades where sig = $1", [sigOf("buy")]);
    expect(buy?.token_base.split(".")[0]).toBe("330288924642439");
    expect(await tradesCaughtUp(db, keys.mint)).toBe(true);
    expect(await tradesCoverRealA(db, keys.mint, 793_100_000_000_000n)).toBe(true);
    await db.close();
  });

  it("moves past a transaction still unreadable after five passes, keeps it for backfill, and stores it once served whole", async () => {
    const db = await seed();
    const byName = new Map(["create", "buy", "sell", "fill"].map((n) => [sigOf(n), revive(T[n])]));
    byName.set(sigOf("sell"), noEvent(revive(T.sell)));
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ok("fill")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => byName.get(s) ?? null),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    for (let i = 0; i < 5; i++) await syncTrades(db, conn, { ...(await coinAt(db)), last_sig: i ? await cursor(db) : null }, state(), "devnet");
    expect(await cursor(db)).toBe(sigOf("fill"));
    expect(await kv.get(db, `sig_retry:${keys.mint}`)).toEqual([{ sig: sigOf("sell"), tries: 0 }]);
    expect(await tradesCaughtUp(db, keys.mint)).toBe(false);
    // Still unreadable through the last retry: dead-lettered, never stored from the vaults.
    await kv.set(db, `sig_retry:${keys.mint}`, [{ sig: sigOf("sell"), tries: 49 }]);
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(0);
    expect(await kv.get(db, `sig_dead:${keys.mint}`)).toEqual([sigOf("sell")]);
    expect(await db.query("select 1 from trades where sig = $1", [sigOf("sell")])).toHaveLength(0);
    expect(await tradesCoverRealA(db, keys.mint, 793_100_000_000_000n)).toBe(false);
    // Served whole later: a backfill requeues it and the next pass stores it; coverage then holds.
    byName.set(sigOf("sell"), revive(T.sell));
    expect(await requeueDead(db, keys.mint)).toBe(1);
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(1);
    expect(await tradesCaughtUp(db, keys.mint)).toBe(true);
    expect(await tradesCoverRealA(db, keys.mint, 793_100_000_000_000n)).toBe(true);
    await db.close();
  });

  // The RPC may answer a getParsedTransactions batch in any order (devnet reordered most on 2026-11-12), and web3.js
  // hands the answers on as they came.
  it("takes each fetched transaction as its own signature's, whatever order the batch comes back in", async () => {
    const db = await seed();
    const byName = new Map(["buy", "sell", "fill"].map((n) => [sigOf(n), revive(T[n])]));
    let lagging = true; // the buy is not served yet
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ok("fill")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => (lagging && s === sigOf("buy") ? null : byName.get(s) ?? null)).reverse(),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    // Read by position, the fill would be taken as the buy and the buy as missing after the sell: stored out of order,
    // the cursor moved past the buy, and the buy never asked for again.
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(0);
    expect(await cursor(db)).toBe(sigOf("create"));
    lagging = false;
    expect(await syncTrades(db, conn, await coinAt(db), state(), "devnet")).toBe(3);
    const rows = await db.query<{ sig: string; side: string }>("select sig, side from trades order by ts, slot, ix");
    expect(rows.map((r) => [r.sig, r.side])).toEqual([[sigOf("buy"), "buy"], [sigOf("sell"), "sell"], [sigOf("fill"), "buy"]]);
    expect(await tradesCaughtUp(db, keys.mint)).toBe(true);
    // The retry queue the same way: the one served is stored, the one still missing stays queued.
    const db2 = await seed();
    await kv.set(db2, `sig_retry:${keys.mint}`, [{ sig: sigOf("buy"), tries: 0 }, { sig: sigOf("sell"), tries: 0 }]);
    await kv.set(db2, `last_sig:${keys.mint}`, { sig: sigOf("fill") });
    const queued = {
      getSignaturesForAddress: chain([ok("create"), ok("buy"), ok("sell"), ok("fill")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => (s === sigOf("sell") ? null : byName.get(s) ?? null)).reverse(),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    expect(await syncTrades(db2, queued, await coinAt(db2), state(), "devnet")).toBe(1);
    expect((await db2.query<{ sig: string }>("select sig from trades")).map((r) => r.sig)).toEqual([sigOf("buy")]);
    expect(await kv.get(db2, `sig_retry:${keys.mint}`)).toEqual([{ sig: sigOf("sell"), tries: 1 }]);
    await db.close(); await db2.close();
  });

  it("keeps another wallet's buy in the creation transaction as a live trade; only the creator's own is the dev buy", async () => {
    const db = await seed();
    // The creation transaction with a second wallet's buy of 30% of supply after the creator's own: a bundled buy.
    const t = revive(T.create);
    const OTHER = "CRoGW82mPPbrFkep8ZCL8DDrHP7ntsA673aQvud64zJu";
    const ev = (t.meta!.innerInstructions!.flatMap((g) => g.instructions) as unknown as Ix[])
      .find((i) => String(i.accounts?.[0]) === EVENT_AUTHORITY && Buffer.from(bs58.decode(i.data)).subarray(8, 16).toString("hex") === "bddb7fd34ee661ee")!;
    const d = Buffer.from(bs58.decode(ev.data));
    const [base, quote] = [d.readBigUInt64LE(88), d.readBigUInt64LE(96)];
    d.writeBigUInt64LE(base, 72); d.writeBigUInt64LE(quote, 80); d.writeBigUInt64LE(base + 300_000_000_000_000n, 88); d.writeBigUInt64LE(quote + 250_000_000n, 96); d[152] = 0;
    andThen(t, { ...tradeIx(t), accounts: [OTHER, ...tradeIx(t).accounts.slice(1)] }, { ...ev, data: bs58.encode(d) });
    // And the first trade after the creation transaction, at another price than the bundled buy.
    const conn = {
      getSignaturesForAddress: chain([ok("create"), ok("buy")]),
      getParsedTransactions: async (sigs: string[]) => sigs.map((s) => (s === sigOf("create") ? t : s === sigOf("buy") ? revive(T.buy) : null)),
    } as unknown as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">;
    const coin = { ...(await db.one<CoinRow>("select * from coins"))!, last_sig: null };
    expect(await syncTrades(db, conn, coin, state(), "devnet")).toBe(3);
    const live = await liveTrades(db, coin, new Date(coin.created_at).getTime());
    expect(live).toMatchObject([{ wallet: OTHER, isBuy: true, share: 0.3, byCreator: false }, { isBuy: true, byCreator: false }]);
    // The ratios are measured from that first trade after the creation transaction, not from the bundled buy in it,
    // and the bundled buy has none: measured from a later trade, it would carry a price from after the checkpoint into
    // a window that holds only it (a reading sealed before that trade was stored would see none).
    const price = async (sig: string, wallet: string) => (await db.one<{ p: number }>("select price_sol as p from trades where sig = $1 and wallet = $2", [sig, wallet]))!.p;
    expect(await price(sigOf("create"), OTHER)).not.toBeCloseTo(await price(sigOf("buy"), live[1].wallet!), 12);
    expect(live[1].priceRatio).toBe(1);
    expect(live[0].priceRatio).toBeNull();
    expect(liveFeatures([live[0]], live[0].s)).toMatchObject({ n_buys: 1, max_mcap_mult: 1, last_mcap_mult: 1 });
    await db.close();
  });
});

describe("trade amounts from LaunchLab's TradeEvent", () => {
  const k = { ...keys, pool: POOL };
  const sold = (t: ParsedTransactionWithMeta, pool = POOL) => tradeEvents(t, pool, keys.vaultA, keys.vaultB).map((e) => e.sold);
  it("reads each trade's change to the pool's sold count, and nothing from other transactions or pools", () => {
    expect(sold(revive(T.create))).toEqual([91_110_910_769_853n]);
    expect(sold(revive(T.buy))).toEqual([330_288_924_642_439n]);
    expect(sold(revive(T.sell))).toEqual([-161_858_087_521_026n]); // what reached the vault after the 1% transfer fee
    expect(sold(revive(T.fill))).toEqual([533_558_252_108_734n]);
    expect(sold(revive(T.migrate))).toEqual([]);
    expect(sold(revive(T.claim))).toEqual([]);
    expect(sold(revive(T.buy), keys.vaultA)).toEqual([]); // another pool's event
  });
  it("is not moved by tokens sent to vault A in the same transaction", () => {
    expect(parseTrades(deposit("buy", 1n), k)).toMatchObject([{ side: "buy", tokenBase: 330_288_924_642_439n, solLamports: 294_000_000n }]);
    expect(parseTrades(deposit("sell", 1n), k)).toMatchObject([{ side: "sell", tokenBase: 161_858_087_521_026n }]);
    expect(parseTrades(deposit("create", 1n), k)).toMatchObject([{ side: "buy", tokenBase: 91_110_910_769_853n }]);
  });
  it("still reads a buy when the deposit outweighs it and vault A ends higher than it started", () => {
    const t = revive(T.buy);
    const v = vaultA(t);
    v.post.amount = (BigInt(v.pre!.amount) + 1n).toString();
    expect(parseTrades(t, k)).toMatchObject([{ side: "buy", tokenBase: 330_288_924_642_439n }]);
  });
  it("reads SOL from the event, so wrapped SOL sent to vault B in the same transaction changes nothing", () => {
    // A sale plus a deposit of its proceeds: vault B ends where it started, and would say the tokens went for nothing.
    const sale = revive(T.sell);
    const b = balances(sale, keys.vaultB);
    b.post.amount = b.pre!.amount;
    expect(parseTrades(sale, k)).toMatchObject([{ side: "sell", solLamports: 173_027_898n, tokenBase: 161_858_087_521_026n }]);
    // A buy plus a deposit: not a bigger buy.
    const buy = revive(T.buy);
    const bb = balances(buy, keys.vaultB);
    bb.post.amount = (BigInt(bb.post.amount) + 5_000_000_000n).toString();
    expect(parseTrades(buy, k)).toMatchObject([{ side: "buy", solLamports: 294_000_000n }]);
  });
  it("with the pool known, will not read a trade whose event is missing from the answer, rather than read the vaults", () => {
    // The vaults would say one base unit less here, and a stored row is never rewritten: coverage would fail for good.
    expect(parseTrades(noEvent(deposit("buy", 1n)), k)).toBeNull();
    expect(parseTrades(noEvent(revive(T.sell)), k)).toBeNull();
    expect(parseTrades(noEvent(revive(T.create)), k)).toBeNull();
  });
  it("with the pool known, reads nothing from the vaults of a transaction without a LaunchLab trade on the pool", () => {
    // Tokens into vault A and SOL out of vault B, as a fee collection with a bundled deposit would show: not a sale.
    const t = noEvent(deposit("sell", 0n));
    t.transaction.message.instructions = t.transaction.message.instructions.filter((i) => ((i as { accounts?: unknown[] }).accounts?.length ?? 0) < 18);
    expect(parseTrades(t, keys)).toMatchObject([{ side: "sell" }]);
    expect(parseTrades(t, k)).toEqual([]);
    expect(parseTrades(revive(T.migrate), k)).toEqual([]);
    expect(parseTrades(revive(T.claim), k)).toEqual([]);
  });
  it("without the pool, reads the vault balances alone", () => {
    expect(parseTrades(deposit("buy", 1n), keys)).toMatchObject([{ side: "buy", tokenBase: 330_288_924_642_438n }]);
    expect(parseTrades(noEvent(revive(T.sell)), keys)).toMatchObject([{ side: "sell", tokenBase: 161_858_087_521_026n }]);
  });
  it("ignores an event-shaped instruction that LaunchLab's event authority did not sign, or another program's", () => {
    // The buy with a bundled deposit, its event instruction edited as a look-alike would carry it.
    const forged = (edit: (i: { programId: unknown; accounts: unknown[] }) => void) => {
      const t = deposit("buy", 1n);
      for (const i of t.meta!.innerInstructions!.flatMap((g) => g.instructions) as unknown as { programId: unknown; accounts: unknown[] }[])
        if (String(i.accounts?.[0]) === EVENT_AUTHORITY) edit(i);
      return t;
    };
    expect(sold(forged((i) => { i.accounts = [ADMIN]; }))).toEqual([]);
    expect(sold(forged((i) => { i.programId = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"; }))).toEqual([]);
    // The buy instruction is still there without an event of its own: not read for now, rather than read from the vaults.
    expect(parseTrades(forged((i) => { i.accounts = [ADMIN]; }), k)).toBeNull();
  });
});

describe("several trades on one pool in one transaction", () => {
  const k = { ...keys, pool: POOL };
  const OTHER = "CRoGW82mPPbrFkep8ZCL8DDrHP7ntsA673aQvud64zJu";
  // A second buyer's instruction: the same buy with another trader, and without a share fee (18 accounts, no account 15).
  const second = (t: ParsedTransactionWithMeta): Ix => { const a = tradeIx(t).accounts; return { ...tradeIx(t), accounts: [OTHER, ...a.slice(1, 15), ...a.slice(16)] }; };
  const expected = [
    { ix: 0, side: "buy", wallet: TRADER, referrer: CALLER, tokenBase: 330_288_924_642_439n, solLamports: 294_000_000n },
    { ix: 1, side: "buy", wallet: OTHER, referrer: null, tokenBase: 100_000_000_000_000n, solLamports: 120_300_000n },
  ];
  it("reads a buy and a sale of the same tokens as two trades, not as nothing", () => {
    expect(parseTrades(washed(), k)).toMatchObject([
      { ix: 0, side: "buy", wallet: TRADER, tokenBase: 330_288_924_642_439n, solLamports: 294_000_000n },
      { ix: 1, side: "sell", wallet: TRADER, tokenBase: 330_288_924_642_439n, solLamports: 291_768_750n },
    ]);
  });
  it("gives each trade the trader and caller of the instruction that made it", () => {
    const t = revive(T.buy);
    andThen(t, second(t), tradeEvent(t, after(t), 100_000_000_000_000n, 120_000_000n, 300_000n));
    expect(parseTrades(t, k)).toMatchObject(expected);
  });
  it("does the same when both trades run inside another program's instruction", () => {
    const t = revive(T.buy);
    const [a, b] = [tradeIx(t), second(t)];
    const [ea, eb] = [eventIx(t), tradeEvent(t, after(t), 100_000_000_000_000n, 120_000_000n, 300_000n)];
    // One router instruction at the top; LaunchLab's instructions one level down, their events one level below those.
    const route = (bLevel: number) => {
      const r = revive(T.buy);
      r.transaction.message.instructions = [{ programId: new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), accounts: [], data: "" } as never];
      r.meta!.innerInstructions = [{ index: 0, instructions: [
        { ...a, stackHeight: 2 }, { ...ea, stackHeight: 3 }, { ...b, stackHeight: 2 }, { ...eb, stackHeight: bLevel },
      ] as never[] }];
      return r;
    };
    expect(parseTrades(route(3), k)).toMatchObject(expected);
    // An event that is not one level below the instruction before it was not emitted by it, and LaunchLab's events
    // only come from its own trades: the answer is not what it seems, so the transaction is not read for now.
    expect(parseTrades(route(2), k)).toBeNull();
  });
  it("will not read a transaction whose trades and events do not pair up one to one", () => {
    // A second buy instruction on the pool with no event of its own.
    const twoIxs = revive(T.buy);
    twoIxs.transaction.message.instructions.push(second(twoIxs) as never);
    expect(parseTrades(twoIxs, k)).toBeNull();
    // A second event after the one buy.
    const twoEvents = revive(T.buy);
    twoEvents.meta!.innerInstructions!.find((g) => g.instructions.some((i) => String((i as { accounts?: unknown[] }).accounts?.[0]) === EVENT_AUTHORITY))!
      .instructions.push(tradeEvent(twoEvents, after(twoEvents), 1_000n, 1_000n, 0n) as never);
    expect(parseTrades(twoEvents, k)).toBeNull();
  });
  it("will not read an event whose own direction disagrees with its sold count", () => {
    const t = revive(T.buy);
    const ev = eventIx(t);
    const d = Buffer.from(bs58.decode(ev.data));
    d[152] = 1; // says sell, while the sold count went up
    ev.data = bs58.encode(d);
    expect(parseTrades(t, k)).toBeNull();
    expect(parseTrades(t, keys)).toHaveLength(1); // the vaults alone still read it, but they are not used once the pool is known
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
