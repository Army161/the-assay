// Vercel cron, every 10 minutes: distribute holder rewards for coins with a transfer fee.
import { Connection } from "@solana/web3.js";
import { getDb } from "@/lib/db";
import { json, bad, cronAllowed } from "@/lib/http";
import { SERVER_RPC_URL, NETWORK } from "@/lib/chain";
import { runRewards } from "@/lib/rewards";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!cronAllowed(req)) return bad("forbidden", 403);
  if (!process.env.REWARDS_KEYPAIR) return json({ ok: false, skipped: "REWARDS_KEYPAIR not set" });
  const db = await getDb();
  const out = await runRewards(db, new Connection(SERVER_RPC_URL, "confirmed"), NETWORK, { maxCoins: 5 });
  return json(out);
}
