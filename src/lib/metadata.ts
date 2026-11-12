// Coin metadata: the Metaplex metadata account LaunchLab writes at creation, plus the JSON behind its uri.
import { Connection, PublicKey } from "@solana/web3.js";
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export const METAPLEX_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export function metadataPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX_PROGRAM.toBuffer(), mint.toBuffer()], METAPLEX_PROGRAM)[0];
}

const readStr = (buf: Buffer, off: number) => {
  const len = buf.readUInt32LE(off);
  const s = buf.subarray(off + 4, off + 4 + len).toString("utf8").replace(/\0+$/g, "");
  return { s, next: off + 4 + len };
};

export interface OnchainMeta { name: string; symbol: string; uri: string }

export function decodeMetaplex(data: Buffer): OnchainMeta {
  // key(1) updateAuthority(32) mint(32) then borsh strings name, symbol, uri
  let off = 1 + 32 + 32;
  const name = readStr(data, off); off = name.next;
  const symbol = readStr(data, off); off = symbol.next;
  const uri = readStr(data, off);
  return { name: name.s.trim(), symbol: symbol.s.trim(), uri: uri.s.trim() };
}

/** Token-2022 mints carry their metadata in the mint itself (TokenMetadata extension); classic mints use Metaplex. */
export async function readOnchainMeta(connection: Connection, mint: PublicKey, token2022 = false): Promise<OnchainMeta | null> {
  if (token2022) {
    try {
      const m = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
      if (m) return { name: m.name.trim(), symbol: m.symbol.trim(), uri: m.uri.trim() };
    } catch { /* fall through to Metaplex */ }
  }
  const acc = await connection.getAccountInfo(metadataPda(mint), "confirmed");
  if (!acc) return null;
  try { return decodeMetaplex(acc.data); } catch { return null; }
}

export interface OffchainMeta {
  image?: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  holderRewardBps?: number;
}

const GATEWAYS = ["https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/", "https://gateway.pinata.cloud/ipfs/"];

export function httpUrl(uri: string, gateway = 0) {
  if (uri.startsWith("ipfs://")) return GATEWAYS[gateway] + uri.slice(7);
  return uri;
}

/**
 * True for hosts a server must never fetch on a creator's behalf: localhost, internal names, and IP addresses in
 * private, loopback, link-local (cloud metadata) or reserved ranges. Used on the URL's host text and again on every
 * address a name resolves to, at connect time (see `guardedAgent`).
 */
export function blockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") || !h.includes(".") && !h.includes(":")) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
  return /^[\d.]+$/.test(h) || /^0x/i.test(h); // decimal or hex encoded IPv4 tricks
}

export function fetchableUrl(u: string): URL | null {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    return blockedHost(url.hostname) ? null : url;
  } catch { return null; }
}

const MAX_JSON_BYTES = 200_000;

/**
 * A connection pool whose DNS lookup refuses private addresses. The check runs inside the connect itself, on the very
 * addresses the socket will use, so a public-looking name that resolves (or re-resolves) to an internal address is
 * refused for the first request and for every redirect. TLS still verifies the certificate against the hostname.
 */
type Addr = { address: string; family: number };
type LookupCb = (err: Error | null, address: string | Addr[], family?: number) => void;
type Resolve = (hostname: string, options: { all: true }, cb: (err: Error | null, addresses: Addr[]) => void) => void;

/** A socket lookup that resolves every address of a name and refuses the name if any of them is private. */
export function privateRefusingLookup(resolve: Resolve) {
  return (hostname: string, options: { all?: boolean } & Record<string, unknown>, cb: LookupCb) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, "");
      if (!addresses?.length || addresses.some((a) => blockedHost(a.address))) {
        return cb(Object.assign(new Error(`refused: ${hostname} resolves to a private address`), { code: "EPRIVATE" }), "");
      }
      if (options.all) return cb(null, addresses);
      cb(null, addresses[0].address, addresses[0].family);
    });
  };
}

let agent: import("undici").Agent | null = null;
async function guardedAgent() {
  if (agent) return agent;
  const [{ Agent }, dns] = await Promise.all([import("undici"), import("node:dns")]);
  const lookup = privateRefusingLookup(dns.lookup as unknown as Resolve);
  agent = new Agent({ connect: { lookup: lookup as never, timeout: 4000 } });
  return agent;
}

/** GET with redirects followed by hand (each hop re-checked) and the body cut off at a byte cap. */
async function guardedText(start: string, signal: AbortSignal): Promise<string | null> {
  let url = fetchableUrl(start);
  const { fetch: guardedFetch } = await import("undici");
  const dispatcher = await guardedAgent();
  for (let hop = 0; url && hop < 4; hop++) {
    const res = await guardedFetch(url, { signal, headers: { accept: "application/json" }, redirect: "manual", dispatcher });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      const loc = res.headers.get("location");
      url = loc ? fetchableUrl(new URL(loc, url).toString()) : null;
      continue;
    }
    if (!res.ok || !res.body) { await res.body?.cancel().catch(() => {}); return null; }
    if (Number(res.headers.get("content-length") || 0) > MAX_JSON_BYTES) { await res.body.cancel().catch(() => {}); return null; }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return null;
}

/** Fetch the uri JSON with a short deadline. Only public https hosts and ipfs are followed; nothing else is trusted. */
export async function readOffchainMeta(uri: string, deadlineMs = 4000): Promise<OffchainMeta | null> {
  if (!/^(https:\/\/|ipfs:\/\/)/.test(uri)) return null;
  for (let g = 0; g < (uri.startsWith("ipfs://") ? GATEWAYS.length : 1); g++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), deadlineMs);
    try {
      const text = await guardedText(httpUrl(uri, g), ctl.signal);
      if (text == null) continue;
      const j = JSON.parse(text) as Record<string, unknown>;
      if (!j || typeof j !== "object") continue;
      const str = (k: string) => (typeof j[k] === "string" ? (j[k] as string).slice(0, 2000) : undefined);
      const ext = (j.extensions ?? {}) as Record<string, unknown>;
      const extStr = (k: string) => (typeof ext[k] === "string" ? (ext[k] as string).slice(0, 500) : undefined);
      return {
        image: str("image"),
        description: str("description"),
        website: str("website") ?? extStr("website"),
        twitter: str("twitter") ?? extStr("twitter"),
        telegram: str("telegram") ?? extStr("telegram"),
        discord: str("discord") ?? extStr("discord"),
        holderRewardBps: typeof j.holderRewardBps === "number" ? j.holderRewardBps : undefined,
      };
    } catch {
      // try the next gateway
    } finally {
      clearTimeout(t);
    }
  }
  return null;
}

/** Only http(s) images, so the board never renders a javascript: or data: URL from a creator. */
export function safeImage(u: string | undefined | null) {
  if (!u) return null;
  const h = httpUrl(u);
  return /^https:\/\//.test(h) && h.length < 2000 ? h : null;
}
