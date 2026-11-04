import { getDb } from "@/lib/db";
import { json, bad, isPubkey } from "@/lib/http";
import { callerStats, codeFor } from "@/lib/callers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (!isPubkey(wallet)) return bad("wallet required");
  const s = await callerStats(await getDb(), wallet);
  return json(s ?? { wallet, code: codeFor(wallet), registered: false });
}
