import { getDb } from "@/lib/db";
import { readFile } from "@/lib/files";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const f = await readFile(await getDb(), id);
  if (!f) return new Response("not found", { status: 404 });
  return new Response(Buffer.from(f.bytes), {
    headers: { "content-type": f.content_type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" },
  });
}
