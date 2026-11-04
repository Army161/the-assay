// Small helpers shared by the API routes: JSON responses, input checks, a per-instance rate limit and the cron guard.
import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

export const json = (data: unknown, init: number | ResponseInit = 200) =>
  NextResponse.json(data, typeof init === "number" ? { status: init } : init);

export const bad = (message: string, status = 400) => json({ error: message }, status);

export function isPubkey(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

export const clampInt = (v: string | null, def: number, min: number, max: number) => {
  const n = v == null ? def : Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** Token bucket per key, local to this server instance. Enough to blunt abuse; the database is the real limit. */
const buckets = new Map<string, { tokens: number; at: number }>();
export function rateLimit(key: string, perMinute: number) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
  b.at = now;
  if (b.tokens < 1) { buckets.set(key, b); return false; }
  b.tokens -= 1; buckets.set(key, b);
  if (buckets.size > 10_000) buckets.clear();
  return true;
}

export const clientIp = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";

/** Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. Without the secret set, cron routes only run locally. */
export function cronAllowed(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export function readJson<T>(req: Request, maxBytes = 64_000): Promise<T | null> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > maxBytes) return Promise.resolve(null);
  return req.text().then((t) => (t.length > maxBytes ? null : (JSON.parse(t) as T))).catch(() => null);
}
