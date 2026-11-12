// Backfill trades the RPC kept missing: puts a coin's dead-lettered signatures (sig_dead:<mint>) back in its retry
// queue, so the next indexer pass asks for them again and stores any the RPC now serves. With no mint, every coin.
//   npx tsx scripts/backfill-trades.ts [mint]
import { getDb } from "../src/lib/db";
import { requeueDead } from "../src/lib/indexer";
import { log } from "./_env";

async function main() {
  const db = await getDb();
  const mints = process.argv[2]
    ? [process.argv[2]]
    : (await db.query<{ k: string }>("select k from kv where k like 'sig_dead:%'")).map((r) => r.k.slice("sig_dead:".length));
  for (const mint of mints) {
    const n = await requeueDead(db, mint);
    log(mint, n === null ? "skipped: an indexer pass is running; try again in a minute" : `requeued ${n}`);
  }
  await db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
