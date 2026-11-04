// Run one indexer pass against the configured network, using the local database (PGlite unless DATABASE_URL is set).
//   npx tsx scripts/index-once.ts
import { getDb } from "../src/lib/db";
import { indexOnce } from "../src/lib/indexer";
import { verifyChain, record } from "../src/lib/ledger";
import { connection, network, log } from "./_env";

async function main() {
  const db = await getDb();
  const stats = await indexOnce(db, connection(), network);
  log("stats", JSON.stringify(stats));
  const coins = await db.query("select mint, symbol, status, progress, trades, vol_sol, latest_tier, latest_checkpoint, dev_buy_pct, initial_buy_sol, transfer_fee_bps, graduated_at from coins order by created_at");
  console.table(coins);
  const trades = await db.query("select sig, side, wallet, sol_lamports, token_base, referrer from trades order by ts");
  console.table(trades.map((t: Record<string, unknown>) => ({ ...t, sig: String(t.sig).slice(0, 12) })));
  const readings = await db.query("select seq, mint, checkpoint, tier, pct, pool_n, hash from readings order by seq");
  console.table(readings.map((r: Record<string, unknown>) => ({ ...r, hash: String(r.hash).slice(0, 12) })));
  log("chain", JSON.stringify(await verifyChain(db)));
  log("record", JSON.stringify(await record(db, 0)));
  await db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
