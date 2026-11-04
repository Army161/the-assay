import { getDb } from "@/lib/db";
import { scheduleTick } from "@/lib/tick";
import { board, type Sort } from "@/lib/queries";
import { json, clampInt } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const db = await getDb();
  scheduleTick(db);
  const status = u.searchParams.get("status");
  const coins = await board(db, {
    sort: (u.searchParams.get("sort") as Sort) ?? "new",
    q: u.searchParams.get("q")?.slice(0, 40) || undefined,
    status: status === "live" || status === "graduated" ? status : "all",
    tier: u.searchParams.get("tier") || undefined,
    limit: clampInt(u.searchParams.get("limit"), 48, 1, 100),
    offset: clampInt(u.searchParams.get("offset"), 0, 0, 5000),
  });
  return json({ coins }, { headers: { "cache-control": "public, s-maxage=3, stale-while-revalidate=10" } });
}
