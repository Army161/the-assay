import { getDb } from "@/lib/db";
import { json, bad, isPubkey, clampInt } from "@/lib/http";
import { rewardsHistory } from "@/lib/rewards";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const mint = u.searchParams.get("mint");
  if (mint && !isPubkey(mint)) return bad("bad mint");
  const rows = await rewardsHistory(await getDb(), mint ?? undefined, clampInt(u.searchParams.get("limit"), 50, 1, 200));
  return json({ rewards: rows }, { headers: { "cache-control": "public, s-maxage=15" } });
}
