// Keeps the indexer and the rewards run moving without a per-minute cron (Vercel Hobby allows one cron a day).
// Any request to a read API claims a tick when the last pass is old enough; the work runs after the response is sent.
// The claim is one atomic SQL statement, so many concurrent requests start exactly one pass.
import { Connection } from "@solana/web3.js";
import { after } from "next/server";
import { kv, type Db } from "./db";
import { indexOnce } from "./indexer";
import { runRewards } from "./rewards";
import { SERVER_RPC_URL, NETWORK } from "./chain";

export const INDEX_EVERY_MS = 20_000;
export const REWARDS_EVERY_MS = 10 * 60_000;

/** Returns true if this caller won the right to run `job` now (last run older than `everyMs`). */
export function claim(db: Db, job: string, everyMs: number): Promise<boolean> {
  return kv.claim(db, `tick:${job}`, everyMs);
}

export async function tick(db: Db, opts: { rewards?: boolean } = {}): Promise<{ indexed: boolean; rewarded: boolean; errors: string[] }> {
  const out = { indexed: false, rewarded: false, errors: [] as string[] };
  // The public mainnet endpoint refuses the account scans the indexer and rewards need; a keyed RPC_URL is required.
  if (NETWORK === "mainnet" && /api\.mainnet-beta\.solana\.com/.test(SERVER_RPC_URL)) {
    out.errors.push("RPC_URL is not set to a keyed mainnet RPC (Helius); the indexer and rewards are paused");
    return out;
  }
  const conn = new Connection(SERVER_RPC_URL, "confirmed");
  if (await claim(db, "index", INDEX_EVERY_MS)) {
    out.indexed = true;
    const before = out.errors.length;
    try { const s = await indexOnce(db, conn, NETWORK); out.errors.push(...s.errors); } catch (e) { out.errors.push(`index: ${(e as Error).message}`); }
    await note(db, "index", out.errors.length - before);
  }
  if (opts.rewards !== false && process.env.REWARDS_KEYPAIR && (await claim(db, "rewards", REWARDS_EVERY_MS))) {
    out.rewarded = true;
    const before = out.errors.length;
    try { const s = await runRewards(db, conn, NETWORK, { maxCoins: 3 }); out.errors.push(...s.errors); } catch (e) { out.errors.push(`rewards: ${(e as Error).message}`); }
    await note(db, "rewards", out.errors.length - before);
  }
  return out;
}

export interface JobHealth { lastRun: string; lastOk: string | null; errors: number }

/** Records when a job last ran and last ran clean, for /api/health. Never throws. */
async function note(db: Db, job: string, errors: number) {
  try {
    const prev = await kv.get<JobHealth>(db, `health:${job}`);
    const now = new Date().toISOString();
    await kv.set(db, `health:${job}`, { lastRun: now, lastOk: errors === 0 ? now : prev?.lastOk ?? null, errors } satisfies JobHealth);
  } catch { /* health notes are best effort */ }
}

/** Fire-and-forget: never throws, never delays the response. */
export function tickLater(db: Db) {
  return tick(db).then((r) => { if (r.errors.length) console.warn("tick", r.errors.join("; ")); }).catch((e) => console.warn("tick", (e as Error).message));
}

/** Call from a route handler: runs the tick after the response is sent. Outside a request scope (tests) it does nothing. */
export function scheduleTick(db: Db) {
  try { after(() => tickLater(db)); } catch { /* no request scope */ }
}
