import { getDb } from "@/lib/db";
import { json } from "@/lib/http";
import { leaderboard } from "@/lib/callers";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await leaderboard(await getDb(), 50);
  return json({ callers: rows.map((r) => ({ ...r, volume_sol: Number(r.volume_sol) })) }, { headers: { "cache-control": "public, s-maxage=30" } });
}
