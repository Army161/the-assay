// Public health check for an uptime monitor: is the indexer moving, is the rewards run clean, can the rewards
// wallet pay its own fees. Shows no secrets. Answers 503 when something needs a person, so a free pinger can alert.
// Hitting it also schedules a tick, so the pinger keeps the indexer moving on a plan without a per-minute cron.
import { Connection } from "@solana/web3.js";
import { getDb, kv } from "@/lib/db";
import { json } from "@/lib/http";
import { NETWORK, SERVER_RPC_URL } from "@/lib/chain";
import { scheduleTick, INDEX_EVERY_MS, REWARDS_EVERY_MS, type JobHealth } from "@/lib/tick";
import { loadRewardsKeypair } from "@/lib/rewards";

export const dynamic = "force-dynamic";

const LOW_SOL = 0.02;
const BALANCE_STALE_MS = 10 * 60_000;
const ageMs = (iso: string | null | undefined) => (iso ? Date.now() - Date.parse(iso) : null);

export async function GET() {
  const db = await getDb();
  scheduleTick(db);
  const [index, rewards] = await Promise.all([kv.get<JobHealth>(db, "health:index"), kv.get<JobHealth>(db, "health:rewards")]);
  const problems: string[] = [];

  const indexAge = ageMs(index?.lastOk);
  if (indexAge == null || indexAge > Math.max(5 * 60_000, INDEX_EVERY_MS * 10)) problems.push("indexer has not finished a clean pass in 5 minutes");

  let rewardsWallet: { address: string; sol: number | null } | null = null;
  if (!process.env.REWARDS_KEYPAIR) {
    // Without the key no holder rewards run at all; that only matters once a coin with a transfer fee exists.
    const due = await db.one("select 1 from coins where network = $1 and transfer_fee_bps > 0 and hidden_at is null limit 1", [NETWORK]);
    if (due) problems.push("coins with holder rewards exist but REWARDS_KEYPAIR is not set");
  } else {
    const rewardsAge = ageMs(rewards?.lastOk);
    if (rewardsAge == null || rewardsAge > REWARDS_EVERY_MS * 6) problems.push("rewards run has not finished clean in an hour");
    try {
      const pk = loadRewardsKeypair(undefined, NETWORK).publicKey;
      // One RPC call a minute at most, however often this is hit.
      const cached = await kv.get<{ sol: number; at?: string }>(db, "health:balance");
      let sol = cached?.sol ?? null;
      let checkedAt = cached?.at ?? null;
      if (await kv.claim(db, "health:balance_refresh", 60_000)) {
        try {
          sol = (await new Connection(SERVER_RPC_URL, "confirmed").getBalance(pk)) / 1e9;
          checkedAt = new Date().toISOString();
          await kv.set(db, "health:balance", { sol, at: checkedAt });
        } catch { /* RPC down: keep the last value, which goes stale below */ }
      }
      const balanceAge = ageMs(checkedAt);
      if (sol == null || balanceAge == null || balanceAge > BALANCE_STALE_MS) { problems.push("rewards wallet balance unknown (no successful check in 10 minutes)"); sol = null; }
      rewardsWallet = { address: pk.toBase58(), sol };
      if (sol != null && sol < LOW_SOL) problems.push(`rewards wallet below ${LOW_SOL} SOL`);
    } catch {
      problems.push("REWARDS_KEYPAIR is set but cannot be used");
    }
  }

  return json(
    { ok: problems.length === 0, network: NETWORK, problems, index, rewards, rewardsWallet },
    { status: problems.length ? 503 : 200, headers: { "cache-control": "no-store" } },
  );
}
