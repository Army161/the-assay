import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { sign } from "tweetnacl";
import { codeFor, isCode, registrationMessage, verifySignature, register, callerStats, resolveCode } from "@/lib/callers";
import { freshDb } from "@/lib/db";

describe("callers", () => {
  it("gives one stable code per wallet", () => {
    const w = Keypair.generate().publicKey.toBase58();
    expect(codeFor(w)).toBe(codeFor(w)); expect(isCode(codeFor(w))).toBe(true); expect(codeFor(w)).not.toBe(codeFor(Keypair.generate().publicKey.toBase58()));
  });
  it("verifies a wallet signature and rejects a forged one", () => {
    const kp = Keypair.generate(); const w = kp.publicKey.toBase58();
    const msg = registrationMessage(w, "00000000000000ab");
    const sig = sign.detached(Buffer.from(msg), kp.secretKey);
    expect(verifySignature(w, msg, sig)).toBe(true);
    expect(verifySignature(w, msg + " ", sig)).toBe(false);
    expect(verifySignature(Keypair.generate().publicKey.toBase58(), msg, sig)).toBe(false);
    expect(verifySignature("not-a-key", msg, sig)).toBe(false);
  });
  it("attributes referred trades", async () => {
    const db = await freshDb();
    const w = Keypair.generate().publicKey.toBase58();
    const code = await register(db, w, "alice", "telegram");
    expect((await resolveCode(db, code))?.wallet).toBe(w);
    await db.query("insert into coins (mint, pool_id, network, name, symbol, creator, created_at, supply, total_sell, fund_target_lamports) values ('m','p','devnet','n','s','c',now(),1,1,1)");
    await db.query("insert into trades (sig, mint, slot, ts, side, wallet, sol_lamports, token_base, price_sol, referrer) values ('s1','m',1,now(),'buy','t',980000000,1,1,$1), ('s2','m',2,now(),'sell','t',500000000,1,1,null)", [w]);
    const s = (await callerStats(db, w))!;
    expect(s.trades).toBe(1); expect(s.volumeSol).toBeCloseTo(0.98); expect(s.earnedSol).toBeCloseTo(0.005); expect(s.handle).toBe("alice");
    await db.close();
  });
});
