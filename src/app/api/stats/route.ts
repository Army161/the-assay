import { getDb } from "@/lib/db";
import { scheduleTick } from "@/lib/tick";
import { json } from "@/lib/http";
import { stats } from "@/lib/queries";

export const dynamic = "force-dynamic";
// The indexer pass and rewards run scheduled after the response share this function\'s time limit.
export const maxDuration = 300;

export async function GET() {
  const db = await getDb();
  scheduleTick(db);
  return json(await stats(db), { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" } });
}
