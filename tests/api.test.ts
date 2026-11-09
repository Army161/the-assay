// Route handlers called directly against a seeded in-memory database.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { sign } from "tweetnacl";
import { freshDb, type Db } from "@/lib/db";

let db: Db;
vi.mock("@/lib/db", async (orig) => {
  const m = await orig<typeof import("@/lib/db")>();
  return { ...m, getDb: async () => db };
});

import { GET as coinsGet } from "@/app/api/coins/route";
import { GET as coinGet } from "@/app/api/coins/[mint]/route";
import { GET as tradesGet } from "@/app/api/coins/[mint]/trades/route";
import { GET as candlesGet } from "@/app/api/coins/[mint]/candles/route";
import { POST as registerPost } from "@/app/api/callers/register/route";
import { GET as recordGet } from "@/app/api/record/route";
import { GET as statsGet } from "@/app/api/stats/route";
import { GET as cronGet } from "@/app/api/cron/index/route";
import { POST as metadataPost } from "@/app/api/metadata/route";
import { POST as uploadPost } from "@/app/api/upload/route";
import { GET as fileGet } from "@/app/api/files/[id]/route";
import { registrationMessage } from "@/lib/callers";
import { seal } from "@/lib/ledger";

const MINT = Keypair.generate().publicKey.toBase58();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = (o: Record<string, string>) => ({ params: Promise.resolve(o) }) as any;

beforeAll(async () => {
  db = await freshDb();
  await db.query(`insert into coins (mint, pool_id, network, name, symbol, creator, created_at, supply, total_sell, fund_target_lamports, price_sol, mcap_sol, vol_sol, vol_24h_sol, trades, latest_tier, latest_checkpoint)
    values ($1, 'pool', 'devnet', 'Assay Test', 'ASSAY', 'creator', now() - interval '10 minutes', 1000000000000000, 793100000000000, 1500000000, 0.000000001, 1, 2.5, 2.5, 3, 'top10', 'm5')`, [MINT]);
  for (let i = 0; i < 3; i++) await db.query("insert into trades (sig, mint, slot, ts, side, wallet, sol_lamports, token_base, price_sol) values ($1,$2,$3,now() - ($4 || ' minutes')::interval,'buy','w',100000000,1000,$5)", [`s${i}`, MINT, i, String(9 - i), 1e-9 * (i + 1)]);
  await seal(db, { t: Date.now() - 600e3, mint: MINT, checkpoint: "launch", score: 0.8, pct: 0.95, tier: "top10", model: "t", poolN: 7, features: { a: 1 }, signals: [{ level: "note", text: "x", short: "x" }] });
});

describe("api", () => {
  it("lists the board with sorting and search", async () => {
    const r = await coinsGet(new Request("http://t/api/coins?sort=trending&q=assay"));
    const j = await r.json();
    expect(r.status).toBe(200); expect(j.coins).toHaveLength(1); expect(j.coins[0]).toMatchObject({ symbol: "ASSAY", tier: "top10", tierLabel: "Top 10%", callerPaid: true });
    expect((await (await coinsGet(new Request("http://t/api/coins?q=zzz"))).json()).coins).toHaveLength(0);
    expect((await coinsGet(new Request("http://t/api/coins?sort=bogus&limit=99999&offset=-5"))).status).toBe(200);
    // an inherited key is not a sort order (it used to reach the SQL and fail with a 500)
    expect((await coinsGet(new Request("http://t/api/coins?sort=constructor"))).status).toBe(200);
  });
  it("returns a coin with its readings and backtest odds", async () => {
    const r = await coinGet(new Request("http://t"), p({ mint: MINT }));
    const j = await r.json();
    expect(j.readings).toHaveLength(1); expect(j.readings[0]).toMatchObject({ tier: "top10", checkpointLabel: "At launch", poolN: 7 }); expect(j.readings[0].backtest.x).toBeGreaterThan(0);
    expect((await coinGet(new Request("http://t"), p({ mint: "nope" }))).status).toBe(400);
    expect((await coinGet(new Request("http://t"), p({ mint: Keypair.generate().publicKey.toBase58() }))).status).toBe(404);
  });
  it("serves trades and candles", async () => {
    const t = await (await tradesGet(new Request("http://t/x?limit=2"), p({ mint: MINT }))).json();
    expect(t.trades).toHaveLength(2); expect(t.trades[0].side).toBe("buy");
    const c = await (await candlesGet(new Request("http://t/x?res=60"), p({ mint: MINT }))).json();
    expect(c.candles.length).toBeGreaterThan(0); expect(c.candles[0]).toHaveProperty("open");
  });
  it("registers a caller only with a valid wallet signature", async () => {
    const kp = Keypair.generate(); const w = kp.publicKey.toBase58();
    const nonce = Date.now().toString(16).padStart(12, "0") + "abcd";
    const sig = Array.from(sign.detached(Buffer.from(registrationMessage(w, nonce)), kp.secretKey));
    const ok = await registerPost(new Request("http://t", { method: "POST", body: JSON.stringify({ wallet: w, nonce, signature: sig, handle: "ali<ce>", channel: "x" }) }));
    expect(ok.status).toBe(200); const j = await ok.json(); expect(j.code).toMatch(/^[a-z2-9]{8}$/); expect(j.handle).toBe("alice");
    const bad = await registerPost(new Request("http://t", { method: "POST", body: JSON.stringify({ wallet: w, nonce, signature: sig.map((b) => b ^ 1) }) }));
    expect(bad.status).toBe(401);
    const stale = await registerPost(new Request("http://t", { method: "POST", body: JSON.stringify({ wallet: w, nonce: "000000000000abcd", signature: sig }) }));
    expect(stale.status).toBe(400);
  });
  it("publishes the record with a verified chain", async () => {
    const j = await (await recordGet()).json();
    expect(j.chain.ok).toBe(true); expect(j.sealed).toBe(1); expect(j.model).toBeTruthy();
    const s = await (await statsGet()).json();
    expect(s.coins).toBe(1); expect(s.feesSol.platform).toBeCloseTo((2.5 / 0.98) * 0.01);
  });
  it("refuses the cron without the secret", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await cronGet(new Request("http://t"))).status).toBe(403);
    expect((await cronGet(new Request("http://t", { headers: { authorization: "Bearer wrong" } }))).status).toBe(403);
    delete process.env.CRON_SECRET;
  });
  it("stores metadata and images in the database when no blob store is configured", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const m = await metadataPost(new Request("http://t", { method: "POST", body: JSON.stringify({ name: "Dog", symbol: "dog", image: "https://x.test/a.png", holderRewardBps: 200 }) }));
    expect(m.status).toBe(200); const mj = await m.json(); expect(mj.uri).toMatch(/\/api\/files\/[0-9a-f]{40}\.json$/); expect(mj.metadata.symbol).toBe("DOG");
    const id = mj.uri.split("/").pop();
    const f = await fileGet(new Request("http://t"), p({ id }));
    expect(f.headers.get("content-type")).toBe("application/json"); expect(JSON.parse(await f.text()).holderRewardBps).toBe(200);
    expect((await metadataPost(new Request("http://t", { method: "POST", body: JSON.stringify({ name: "Dog", symbol: "dog", image: "javascript:x" }) }))).status).toBe(400);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const fd = new FormData(); fd.append("file", new Blob([png], { type: "text/html" }), "x.html");
    const u = await uploadPost(new Request("http://t", { method: "POST", body: fd }));
    expect(u.status).toBe(200); expect((await u.json()).type).toBe("image/png");
    const fd2 = new FormData(); fd2.append("file", new Blob([new TextEncoder().encode("<svg/>")], { type: "image/png" }), "x.png");
    expect((await uploadPost(new Request("http://t", { method: "POST", body: fd2 }))).status).toBe(400);
  });
});
