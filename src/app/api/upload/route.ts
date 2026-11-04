// Coin image upload: multipart "file", 2 MB max, real PNG/JPEG/GIF/WebP only (sniffed, not trusted from the header).
import { getDb } from "@/lib/db";
import { json, bad, rateLimit, clientIp } from "@/lib/http";
import { storeFile, sniffImage, IMAGE_TYPES, MAX_IMAGE_BYTES } from "@/lib/files";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!rateLimit(`upload:${clientIp(req)}`, 20)) return bad("too many uploads", 429);
  if (Number(req.headers.get("content-length") || 0) > MAX_IMAGE_BYTES + 4096) return bad("image is larger than 2 MB", 413);
  let form: FormData;
  try { form = await req.formData(); } catch { return bad("multipart form expected"); }
  const f = form.get("file");
  if (!(f instanceof Blob)) return bad("file required");
  if (f.size > MAX_IMAGE_BYTES) return bad("image is larger than 2 MB", 413);
  const bytes = new Uint8Array(await f.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type) return bad("only PNG, JPEG, GIF or WebP images");
  const url = await storeFile(await getDb(), bytes, type, IMAGE_TYPES[type]);
  return json({ url, size: bytes.length, type });
}
