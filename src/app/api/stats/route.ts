import { getDb } from "@/lib/db";
import { json } from "@/lib/http";
import { stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(await stats(await getDb()), { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" } });
}
