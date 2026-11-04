// Keeps the indexer and the rewards run moving without a per-minute cron (Vercel Hobby allows one cron a day).
// Any request to a read API claims a tick when the last pass is old enough; the work runs after the response is sent.
// The claim is one atomic SQL statement, so many concurrent requests start exactly one pass.
import { Connection } from "@solana/web3.js";
import { after } from "next/server";
import type { Db } from "./db";
import { indexOnce } from "./indexer";
import { runRewards } from "./rewards";
import { SERVER_RPC_URL, NETWORK } from "./chain";

export const INDEX_EVERY_MS = 20_000;
export const REWARDS_EVERY_MS = 10 * 60_000;

/** Returns true if this caller won the right to run `job` now (last run older than `everyMs`). */
export async function claim(db: Db, job: string, everyMs: number): Promise<boolean> {
  const rows = await db.query<{ k: string }>(
    `insert into kv (k, v, updated_at) values ($1, '{}'::jsonb, now())
       on conflict (k) do update set updated_at = now()
       where kv.updated_at < now() - ($2 || ' milliseconds')::interval
     returning k`,
    [`tick:${job}`, String(everyMs)],
  );
  return rows.length > 0;
}

export async function tick(db: Db, opts: { rewards?: boolean } = {}): Promise<{ indexed: boolean; rewarded: boolean; errors: string[] }> {
  const out = { indexed: false, rewarded: false, errors: [] as string[] };
  const conn = new Connection(SERVER_RPC_URL, "confirmed");
  if (await claim(db, "index", INDEX_EVERY_MS)) {
    out.indexed = true;
    try { const s = await indexOnce(db, conn, NETWORK); out.errors.push(...s.errors); } catch (e) { out.errors.push(`index: ${(e as Error).message}`); }
  }
  if (opts.rewards !== false && process.env.REWARDS_KEYPAIR && (await claim(db, "rewards", REWARDS_EVERY_MS))) {
    out.rewarded = true;
    try { const s = await runRewards(db, conn, NETWORK, { maxCoins: 3 }); out.errors.push(...s.errors); } catch (e) { out.errors.push(`rewards: ${(e as Error).message}`); }
  }
  return out;
}

/** Fire-and-forget: never throws, never delays the response. */
export function tickLater(db: Db) {
  return tick(db).then((r) => { if (r.errors.length) console.warn("tick", r.errors.join("; ")); }).catch((e) => console.warn("tick", (e as Error).message));
}

/** Call from a route handler: runs the tick after the response is sent. Outside a request scope (tests) it does nothing. */
export function scheduleTick(db: Db) {
  try { after(() => tickLater(db)); } catch { /* no request scope */ }
}
