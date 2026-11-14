// Operator takedown: hides a coin from the board, its page and every API answer, and deletes its stored image and
// metadata file. The chain is untouched (the coin still trades on LaunchLab); this only stops The Assay showing it.
//   curl -X POST https://<site>/api/admin/hide -H "authorization: Bearer $ADMIN_SECRET" \
//        -H "content-type: application/json" -d '{"mint":"…","reason":"impersonation"}'
// {"mint":"…","unhide":true} shows it again (deleted files stay deleted).
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { json, bad, isPubkey, readJson } from "@/lib/http";
import { removeFile } from "@/lib/files";

export const dynamic = "force-dynamic";

function allowed(req: Request) {
  const secret = process.env.ADMIN_SECRET?.trim();
  if (!secret || secret.length < 24) return false; // no secret, no admin
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function POST(req: Request) {
  if (!allowed(req)) return bad("forbidden", 403);
  const body = await readJson<{ mint?: unknown; reason?: unknown; unhide?: unknown }>(req, 4_000);
  if (!body || typeof body !== "object" || !isPubkey(body.mint)) return bad("mint required");
  if (body.unhide !== undefined && typeof body.unhide !== "boolean") return bad("unhide must be true or false");
  if (body.reason !== undefined && typeof body.reason !== "string") return bad("reason must be a string");
  const db = await getDb();
  const coin = await db.one<{ image: string | null; uri: string }>("select image, uri from coins where mint = $1", [body.mint]);
  if (!coin) return bad("not found", 404);
  if (body.unhide) {
    await db.query("update coins set hidden_at = null, hidden_reason = null where mint = $1", [body.mint]);
    return json({ ok: true, mint: body.mint, hidden: false });
  }
  await db.query("update coins set hidden_at = now(), hidden_reason = $2 where mint = $1", [body.mint, (typeof body.reason === "string" ? body.reason : "").slice(0, 200) || null]);
  const removed = { image: await removeFile(db, coin.image).catch(() => false), metadata: await removeFile(db, coin.uri).catch(() => false) };
  await db.query("delete from kv where k = $1", [`holders:${body.mint}`]);
  return json({ ok: true, mint: body.mint, hidden: true, removed });
}
