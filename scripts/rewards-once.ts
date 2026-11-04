// One holder-rewards pass with the admin key as the rewards wallet (devnet). Uses the local database.
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
