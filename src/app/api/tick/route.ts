// Public, throttled: runs one indexer pass (and a rewards run when due) if the last one is old enough.
// Safe to hit from any external pinger; the claim in tick() means it cannot be made to do extra work.
import { getDb } from "@/lib/db";
import { json } from "@/lib/http";
import { tick } from "@/lib/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // a rewards run may take a few minutes; its lease outlasts this

export async function GET() {
  const r = await tick(await getDb());
  if (r.errors.length) console.warn("tick", r.errors.join("; ")); // details stay in the server logs
  return json({ ok: r.errors.length === 0, indexed: r.indexed, rewarded: r.rewarded }, { headers: { "cache-control": "no-store" } });
}
