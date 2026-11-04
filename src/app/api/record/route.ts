// The live record: every sealed reading at least 30 minutes old, grouped by checkpoint and tier, plus the chain check.
import { getDb } from "@/lib/db";
import { json } from "@/lib/http";
import { record, verifyChain } from "@/lib/ledger";
import { MODEL_VERSION, BACKTEST, TIERS } from "@/lib/grade/assay";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await getDb();
  const [rec, chain] = await Promise.all([record(db), verifyChain(db)]);
  return json({ ...rec, chain, model: MODEL_VERSION, backtest: BACKTEST, tiers: TIERS }, { headers: { "cache-control": "public, s-maxage=30" } });
}
