import { getDb } from "@/lib/db";
import { json, bad } from "@/lib/http";
import { resolveCode, callerStats, isCode } from "@/lib/callers";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  if (!isCode(code)) return bad("bad code");
  const db = await getDb();
  const r = await resolveCode(db, code);
  if (!r) return bad("unknown code", 404);
  const s = await callerStats(db, r.wallet);
  return json({ wallet: r.wallet, handle: r.handle, trades: s?.trades ?? 0, volumeSol: s?.volumeSol ?? 0, coins: s?.coins ?? 0 }, { headers: { "cache-control": "public, s-maxage=30" } });
}
