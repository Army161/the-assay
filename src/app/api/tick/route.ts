// Public, throttled: runs one indexer pass (and a rewards run when due) if the last one is old enough.
// Safe to hit from any external pinger; the claim in tick() means it cannot be made to do extra work.
import { getDb } from "@/lib/db";
import { json } from "@/lib/http";
import { tick } from "@/lib/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const r = await tick(await getDb());
  return json({ ok: r.errors.length === 0, ...r }, { headers: { "cache-control": "no-store" } });
}
