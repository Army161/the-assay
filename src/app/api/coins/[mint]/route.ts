import { getDb } from "@/lib/db";
import { coin } from "@/lib/queries";
import { json, bad, isPubkey } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ mint: string }> }) {
  const { mint } = await ctx.params;
  if (!isPubkey(mint)) return bad("bad mint");
  const c = await coin(await getDb(), mint);
  if (!c) return bad("not found", 404);
  return json(c, { headers: { "cache-control": "public, s-maxage=2, stale-while-revalidate=10" } });
}
