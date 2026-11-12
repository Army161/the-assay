// Vercel cron (daily safety pass; the live cadence comes from src/lib/tick.ts on API traffic). Callable locally without CRON_SECRET.
import { Connection } from "@solana/web3.js";
import { getDb } from "@/lib/db";
import { indexOnce } from "@/lib/indexer";
import { json, bad, cronAllowed } from "@/lib/http";
import { SERVER_RPC_URL, NETWORK } from "@/lib/chain";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!cronAllowed(req)) return bad("forbidden", 403);
  const db = await getDb();
  const stats = await indexOnce(db, new Connection(SERVER_RPC_URL, "confirmed"), NETWORK);
  return json({ ok: stats.errors.length === 0, ...stats });
}
