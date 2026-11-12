// One holder-rewards pass. On devnet the admin key doubles as the rewards wallet; on mainnet use the separate rewards key.
//   REWARDS_KEYPAIR="$(cat /mnt/project-files/the-assay-secrets/devnet-admin.json)" npx tsx scripts/rewards-once.ts
import { getDb } from "../src/lib/db";
import { runRewards } from "../src/lib/rewards";
import { connection, network, log } from "./_env";

async function main() {
  const db = await getDb();
  const out = await runRewards(db, connection(), network, { maxCoins: 5 });
  log(JSON.stringify(out, null, 1));
  console.table(await db.query("select mint, run_at, withheld_base, sol_lamports, holders from rewards order by run_at desc"));
  await db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
