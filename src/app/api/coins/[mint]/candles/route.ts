import { getDb } from "@/lib/db";
import { candles } from "@/lib/queries";
import { json, bad, isPubkey, clampInt } from "@/lib/http";

export const dynamic = "force-dynamic";
const RES = new Set([15, 60, 300, 900, 3600]);

export async function GET(req: Request, ctx: { params: Promise<{ mint: string }> }) {
  const { mint } = await ctx.params;
  if (!isPubkey(mint)) return bad("bad mint");
  const u = new URL(req.url);
  const res = clampInt(u.searchParams.get("res"), 60, 15, 3600);
  const rows = await candles(await getDb(), mint, RES.has(res) ? res : 60, clampInt(u.searchParams.get("limit"), 300, 10, 1000));
  return json({ candles: rows }, { headers: { "cache-control": "public, s-maxage=5" } });
}
