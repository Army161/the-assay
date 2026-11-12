// Coin images and metadata JSON. With BLOB_READ_WRITE_TOKEN set they go to Vercel Blob (public CDN URLs);
// otherwise they live in the database and are served by /api/files/:id, so a fresh deploy works with just a database.
import { createHash } from "node:crypto";
import type { Db } from "./db";
import { cleanEnv, envUrl } from "./env";

export const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function siteUrl() {
  const vercel = cleanEnv(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  const fallback = vercel ? envUrl("VERCEL_PROJECT_PRODUCTION_URL", vercel, "http://localhost:3000") : "http://localhost:3000";
  return envUrl("NEXT_PUBLIC_SITE_URL", process.env.NEXT_PUBLIC_SITE_URL, fallback).replace(/\/$/, "");
}

const idFor = (bytes: Uint8Array, ext: string) => createHash("sha256").update(bytes).digest("hex").slice(0, 40) + "." + ext;

export async function storeFile(db: Db, bytes: Uint8Array, contentType: string, ext: string): Promise<string> {
  const id = idFor(bytes, ext);
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { put } = await import("@vercel/blob");
    const r = await put(`assay/${id}`, Buffer.from(bytes), { access: "public", contentType, addRandomSuffix: false });
    return r.url;
  }
  await db.query("insert into files (id, content_type, bytes, size) values ($1,$2,$3,$4) on conflict (id) do nothing", [id, contentType, Buffer.from(bytes), bytes.length]);
  return `${siteUrl()}/api/files/${id}`;
}

export async function readFile(db: Db, id: string) {
  if (!/^[0-9a-f]{40}\.(png|jpg|gif|webp|json)$/.test(id)) return null;
  return db.one<{ content_type: string; bytes: Uint8Array }>("select content_type, bytes from files where id = $1", [id]);
}

/** Sniff the real image type from the first bytes; the declared content type is not trusted. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length > 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export interface CoinMetadataInput { name: string; symbol: string; description?: string; image: string; website?: string; twitter?: string; telegram?: string; discord?: string; holderRewardBps?: number }

const URLish = /^https:\/\/[^\s"'<>]{4,300}$/;
const HANDLE = /^[A-Za-z0-9_./:-]{1,80}$/;

/** Validate and normalise what a creator submits. Throws with a plain message on bad input. */
export function validateMetadata(j: unknown): CoinMetadataInput {
  if (!j || typeof j !== "object") throw new Error("body required");
  const o = j as Record<string, unknown>;
  const str = (k: string, max: number, required = false) => {
    const v = o[k];
    if (v == null || v === "") { if (required) throw new Error(`${k} required`); return undefined; }
    if (typeof v !== "string") throw new Error(`${k} must be text`);
    const t = v.trim();
    if (t.length > max) throw new Error(`${k} is longer than ${max} characters`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t)) throw new Error(`${k} has control characters`);
    return t;
  };
  const name = str("name", 32, true)!, symbol = str("symbol", 10, true)!.toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error("symbol: letters and numbers only, up to 10");
  const image = str("image", 300, true)!;
  if (!URLish.test(image)) throw new Error("image must be an https URL");
  const social = (k: string) => { const v = str(k, 120); if (v && !(URLish.test(v) || HANDLE.test(v))) throw new Error(`${k} looks wrong`); return v; };
  const bps = o.holderRewardBps == null ? 0 : Number(o.holderRewardBps);
  if (![0, 100, 200].includes(bps)) throw new Error("holderRewardBps must be 0, 100 or 200");
  return { name, symbol, description: str("description", 500), image, website: social("website"), twitter: social("twitter"), telegram: social("telegram"), discord: social("discord"), holderRewardBps: bps };
}

export function metadataJson(m: CoinMetadataInput) {
  const ext: Record<string, string> = {};
  for (const k of ["website", "twitter", "telegram", "discord"] as const) if (m[k]) ext[k] = m[k]!;
  return {
    name: m.name, symbol: m.symbol, description: m.description ?? "", image: m.image, showName: true, createdOn: siteUrl(),
    ...ext, extensions: ext, holderRewardBps: m.holderRewardBps ?? 0, platform: "The Assay",
  };
}
