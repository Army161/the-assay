// Top holders straight from RPC (largest token accounts), refreshed at most every two minutes per coin and cached in kv.
import { Connection, PublicKey } from "@solana/web3.js";
import { getDb, kv } from "@/lib/db";
import { json, bad, isPubkey } from "@/lib/http";
import { SERVER_RPC_URL } from "@/lib/chain";
import { topHolders } from "@/lib/holders";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ mint: string }> }) {
  const { mint } = await ctx.params;
  if (!isPubkey(mint)) return bad("bad mint");
  const db = await getDb();
  const coin = await db.one<{ supply: string; decimals: number; token_2022: boolean; pool_id: string; creator: string }>("select supply, decimals, token_2022, pool_id, creator from coins where mint = $1 and hidden_at is null", [mint]);
  if (!coin) return bad("not found", 404);
  const key = `holders:${mint}`;
  const cached = await kv.get<{ at: number; holders: unknown[]; count: number | null }>(db, key);
  if (cached && Date.now() - cached.at < 120_000) return json(cached);
  // One refresh per coin every two minutes, whoever asks: the account scan behind it is the costliest RPC call we make.
  if (!(await kv.claim(db, `holders_refresh:${mint}`, 120_000))) {
    return json(cached ? { ...cached, stale: true } : { at: Date.now(), holders: [], count: null, top10Share: null, stale: true }, { headers: { "cache-control": "no-store" } });
  }
  const conn = new Connection(SERVER_RPC_URL, "confirmed");
  let result: Awaited<ReturnType<typeof topHolders>>;
  try {
    result = await topHolders(conn, db, new PublicKey(mint), coin);
  } catch (e) {
    // RPC trouble (rate limit, outage): serve the last snapshot rather than an error, marked stale.
    console.warn("holders", mint, (e as Error).message.slice(0, 120));
    if (cached) return json({ ...cached, stale: true }, { headers: { "cache-control": "no-store" } });
    return json({ at: Date.now(), holders: [], count: null, top10Share: null, stale: true }, { headers: { "cache-control": "no-store" } });
  }
  const payload = { at: Date.now(), ...result };
  await kv.set(db, key, payload);
  if (result.count != null || result.top10Share != null) {
    await db.query("update coins set holders = coalesce($2, holders), top10_share = coalesce($3, top10_share) where mint = $1", [mint, result.count, result.top10Share]);
  }
  return json(payload, { headers: { "cache-control": "public, s-maxage=30" } });
}
