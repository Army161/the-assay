// Builds the token metadata JSON that LaunchLab stores in the mint's uri. Returns the public URL to pass to createLaunchpad.
import { getDb, kv } from "@/lib/db";
import { json, bad, rateLimit, clientIp, readJson } from "@/lib/http";
import { storeFile, validateMetadata, metadataJson } from "@/lib/files";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!rateLimit(`meta:${clientIp(req)}`, 30)) return bad("too many requests", 429);
  const body = await readJson(req, 8_000);
  let m;
  try { m = validateMetadata(body); } catch (e) { return bad((e as Error).message); }
  const doc = metadataJson(m);
  const db = await getDb();
  // Shared across instances (the in-memory limit above is per instance): one stored file per address every 3 seconds.
  if (!(await kv.claim(db, `meta:${clientIp(req)}`, 3_000))) return bad("too many requests", 429);
  let url: string;
  try { url = await storeFile(db, new TextEncoder().encode(JSON.stringify(doc)), "application/json", "json"); } catch (e) { return bad((e as Error).message, 503); }
  return json({ uri: url, metadata: doc });
}
