import { getDb } from "@/lib/db";
import { json, bad } from "@/lib/http";
import { hashRow } from "@/lib/ledger";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ seq: string }> }) {
  const { seq } = await ctx.params;
  if (!/^\d{1,12}$/.test(seq)) return bad("bad seq");
  const db = await getDb();
  const r = await db.one<Record<string, unknown>>(
    "select r.*, extract(epoch from r.t) * 1000 as t_ms, c.name, c.symbol from readings r join coins c on c.mint = r.mint where r.seq = $1", [Number(seq)]);
  if (!r) return bad("not found", 404);
  const body = { seq: Number(r.seq), t: Math.round(Number(r.t_ms)), mint: r.mint as string, checkpoint: r.checkpoint as string, score: Number(r.score), pct: Number(r.pct), tier: r.tier as string, model: r.model as string };
  const recomputed = hashRow(r.prev as string, body);
  return json({ ...body, name: r.name, symbol: r.symbol, poolN: Number(r.pool_n), features: r.features, signals: r.signals, prev: r.prev, hash: r.hash, recomputed, valid: recomputed === r.hash, how: "sha256(prev + JSON.stringify(body))" });
}
