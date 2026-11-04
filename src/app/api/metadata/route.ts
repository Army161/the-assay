// Builds the token metadata JSON that LaunchLab stores in the mint's uri. Returns the public URL to pass to createLaunchpad.
import { getDb } from "@/lib/db";
import { json, bad, rateLimit, clientIp, readJson } from "@/lib/http";
import { storeFile, validateMetadata, metadataJson } from "@/lib/files";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!rateLimit(`meta:${clientIp(req)}`, 30)) return bad("too many requests", 429);
  const body = await readJson(req, 8_000);
  let m;
  try { m = validateMetadata(body); } catch (e) { return bad((e as Error).message); }
  const doc = metadataJson(m);
  const url = await storeFile(await getDb(), new TextEncoder().encode(JSON.stringify(doc)), "application/json", "json");
  return json({ uri: url, metadata: doc });
}
