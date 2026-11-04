// A caller registers by signing a message with their wallet. No funds move; we store the code -> wallet map.
import { getDb } from "@/lib/db";
import { json, bad, isPubkey, rateLimit, clientIp, readJson } from "@/lib/http";
import { registrationMessage, verifySignature, register, callerStats } from "@/lib/callers";

export const dynamic = "force-dynamic";
const CHANNELS = new Set(["telegram", "x", "discord", "other"]);

export async function POST(req: Request) {
  if (!rateLimit(`reg:${clientIp(req)}`, 10)) return bad("too many requests", 429);
  const body = await readJson<{ wallet?: string; nonce?: string; signature?: number[]; handle?: string; channel?: string }>(req, 8_000);
  if (!body || !isPubkey(body.wallet)) return bad("wallet required");
  if (typeof body.nonce !== "string" || !/^[0-9a-f]{16,64}$/.test(body.nonce)) return bad("bad nonce");
  const ts = Number.parseInt(body.nonce.slice(0, 12), 16);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 10 * 60_000) return bad("nonce expired");
  if (!Array.isArray(body.signature) || body.signature.length !== 64 || !body.signature.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) return bad("bad signature");
  if (!verifySignature(body.wallet, registrationMessage(body.wallet, body.nonce), body.signature)) return bad("signature does not match wallet", 401);
  const handle = typeof body.handle === "string" ? body.handle.replace(/[^\w.@-]/g, "").slice(0, 32) || null : null;
  const channel = typeof body.channel === "string" && CHANNELS.has(body.channel) ? body.channel : null;
  const db = await getDb();
  await register(db, body.wallet, handle, channel);
  return json(await callerStats(db, body.wallet));
}
