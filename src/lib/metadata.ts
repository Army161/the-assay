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

/** Fetch the uri JSON with a short deadline. Only https and ipfs are followed; nothing else is trusted. */
export async function readOffchainMeta(uri: string, deadlineMs = 4000): Promise<OffchainMeta | null> {
  if (!/^(https:\/\/|ipfs:\/\/)/.test(uri)) return null;
  for (let g = 0; g < (uri.startsWith("ipfs://") ? GATEWAYS.length : 1); g++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), deadlineMs);
    try {
      const res = await fetch(httpUrl(uri, g), { signal: ctl.signal, headers: { accept: "application/json" }, redirect: "follow" });
      if (!res.ok) continue;
      const len = Number(res.headers.get("content-length") || 0);
      if (len > 200_000) return null;
      const text = (await res.text()).slice(0, 200_000);
      const j = JSON.parse(text) as Record<string, unknown>;
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
