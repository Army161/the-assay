// Callers: anyone with a wallet gets a short code. Trades made through their link carry their wallet as the
// share-fee receiver, so the 0.5% is paid by the LaunchLab program itself, on-chain, in the same transaction.
// We only keep the code -> wallet map and the attribution stats; we never hold caller money.
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { Db } from "./db";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i

/** Deterministic 8-char code from the wallet, so a caller can never claim two codes. */
export function codeFor(wallet: string) {
  const h = createHash("sha256").update("assay-caller:" + wallet).digest();
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[h[i] % ALPHABET.length];
  return out;
}

export const isCode = (s: string) => /^[a-z2-9]{8}$/.test(s);

export { registrationMessage } from "./callers-shared";

/** Ed25519 check of a wallet-adapter signMessage() result (raw 64-byte signature over the UTF-8 message). */
export function verifySignature(wallet: string, message: string, signature: Uint8Array | number[]) {
  try {
    const pk = new PublicKey(wallet).toBytes();
    // SPKI DER prefix for an Ed25519 raw public key
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pk)]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

export interface CallerStats { wallet: string; code: string; handle: string | null; channel: string | null; trades: number; volumeSol: number; earnedSol: number; coins: number; since: string }

/** Attribution from the trades table: every trade whose share fee went to this wallet. */
export async function callerStats(db: Db, wallet: string, shareRate = 0.005): Promise<CallerStats | null> {
  const c = await db.one<{ wallet: string; code: string; handle: string | null; channel: string | null; created_at: string }>(
    "select wallet, code, handle, channel, created_at from callers where wallet = $1", [wallet]);
  if (!c) return null;
  const s = await db.one<{ n: number; vol: number; coins: number }>(
    "select count(*)::int as n, coalesce(sum(sol_lamports),0)/1e9 as vol, count(distinct mint)::int as coins from trades where referrer = $1", [wallet]);
  const vol = Number(s?.vol ?? 0);
  // amounts in `trades` are net of fees; gross = net / (1 - 2%), and the caller's cut is 0.5% of gross
  const gross = vol / 0.98;
  return { wallet: c.wallet, code: c.code, handle: c.handle, channel: c.channel, trades: s?.n ?? 0, volumeSol: vol, earnedSol: gross * shareRate, coins: s?.coins ?? 0, since: c.created_at };
}

export async function leaderboard(db: Db, limit = 50) {
  return db.query<{ wallet: string; code: string; handle: string | null; channel: string | null; trades: number; volume_sol: number; coins: number }>(
    `select c.wallet, c.code, c.handle, c.channel, count(t.sig)::int as trades, coalesce(sum(t.sol_lamports),0)/1e9 as volume_sol, count(distinct t.mint)::int as coins
       from callers c left join trades t on t.referrer = c.wallet
      group by c.wallet, c.code, c.handle, c.channel order by volume_sol desc, trades desc limit $1`, [limit]);
}

export async function resolveCode(db: Db, code: string) {
  if (!isCode(code)) return null;
  const r = await db.one<{ wallet: string; handle: string | null }>("select wallet, handle from callers where code = $1", [code]);
  return r;
}

export async function register(db: Db, wallet: string, handle: string | null, channel: string | null) {
  const code = codeFor(wallet);
  await db.query(
    `insert into callers (wallet, code, handle, channel, last_seen) values ($1,$2,$3,$4,now())
     on conflict (wallet) do update set handle = coalesce(excluded.handle, callers.handle), channel = coalesce(excluded.channel, callers.channel), last_seen = now()`,
    [wallet, code, handle, channel]);
  return code;
}
