import { getDb } from "@/lib/db";
import { trades } from "@/lib/queries";
import { json, bad, isPubkey, clampInt } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ mint: string }> }) {
  const { mint } = await ctx.params;
  if (!isPubkey(mint)) return bad("bad mint");
  const u = new URL(req.url);
  const before = u.searchParams.get("before");
  const rows = await trades(await getDb(), mint, clampInt(u.searchParams.get("limit"), 60, 1, 200), before && !Number.isNaN(Date.parse(before)) ? before : undefined);
  return json({ trades: rows }, { headers: { "cache-control": "public, s-maxage=2" } });
}
