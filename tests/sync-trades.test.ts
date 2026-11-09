// syncTrades pages back to the last signature it saw, so trades older than one page are not skipped.
import { describe, it, expect } from "vitest";
import { PublicKey, type ParsedTransactionWithMeta, type Connection } from "@solana/web3.js";
import txs from "./fixtures/devnet-txs.json";
import keys from "./fixtures/devnet-keys.json";
import { freshDb, kv } from "../src/lib/db";
import { syncTrades, type CoinRow } from "../src/lib/indexer";
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
});
