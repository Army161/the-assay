// parseTrade against real devnet transactions from the 2026-11-04 end-to-end run (tests/fixtures/devnet-txs.json).
import { describe, it, expect } from "vitest";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import txs from "./fixtures/devnet-txs.json";
import keys from "./fixtures/devnet-keys.json";
import { parseTrade } from "@/lib/indexer";

// JSON fixtures hold pubkeys as strings; the parser only calls toBase58() on them
function revive(tx: unknown): ParsedTransactionWithMeta {
  const t = JSON.parse(JSON.stringify(tx)) as ParsedTransactionWithMeta;
  for (const k of t.transaction.message.accountKeys) (k as { pubkey: PublicKey }).pubkey = new PublicKey(k.pubkey as unknown as string);
  return t;
}
const T = txs as Record<string, unknown>;
const TRADER = "8pEWdNpw9J5Ku8jfti2Gos9pAcb4cT8Ujcw9WgpBtA1g", CALLER = "4SpvrEbNnGWeaTJfoCQP4iV6D28H3h3Twk1v1QWjBcCy", ADMIN = "HuwVSvu39rDuyYJZihkfGaLTGPpd92rCG8BWVmT6MZKb";

describe("parseTrade on real LaunchLab transactions", () => {
  it("reads the creation transaction as the creator's dev buy", () => {
    const t = parseTrade(revive(T.create), keys)!;
    expect(t.side).toBe("buy");
    expect(t.wallet).toBe(ADMIN);
    expect(t.solLamports).toBe(49_250_000n); // 0.05 SOL minus 1.5% fees reached the curve
    expect(t.tokenBase).toBe(91_110_910_769_853n); // 9.11% of supply
    expect(t.referrer).toBeNull();
  });
  it("reads a referred buy with the caller as referrer", () => {
    const t = parseTrade(revive(T.buy), keys)!;
    expect(t.side).toBe("buy");
    expect(t.wallet).toBe(TRADER);
    expect(t.solLamports).toBe(294_000_000n); // 0.3 SOL minus 2% fees
    expect(t.tokenBase).toBe(330_288_924_642_439n);
    expect(t.referrer).toBe(CALLER);
    expect(t.sig).toMatch(/^2mw3UXys/);
  });
  it("reads a sell", () => {
    const t = parseTrade(revive(T.sell), keys)!;
    expect(t.side).toBe("sell");
    expect(t.wallet).toBe(TRADER);
    expect(t.tokenBase).toBe(161_858_087_521_026n); // what reached the vault after the 1% transfer fee
    expect(t.solLamports).toBe(173_027_898n);
    expect(t.referrer).toBe(CALLER);
  });
  it("reads an unreferred buy with no referrer (platform vault is not a caller)", () => {
    const t = parseTrade(revive(T.fill), keys)!;
    expect(t.side).toBe("buy");
    expect(t.wallet).toBe(ADMIN);
    expect(t.referrer).toBeNull();
  });
  it("ignores the migration and the fee claim", () => {
    expect(parseTrade(revive(T.migrate), keys)).toBeNull();
    expect(parseTrade(revive(T.claim), keys)).toBeNull();
  });
});

describe("parseTrade on a trade routed through another program", () => {
  it("takes the trader and caller from the LaunchLab instruction, not the relayer that paid the fee", () => {
    const t = revive(T.buy);
    const msg = t.transaction.message;
    // Put a relayer in front as fee payer, and move the LaunchLab instruction inside an aggregator's instruction.
    msg.accountKeys.unshift({ pubkey: new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), signer: true, writable: true, source: "transaction" });
    for (const b of [...(t.meta!.preTokenBalances ?? []), ...(t.meta!.postTokenBalances ?? [])]) b.accountIndex += 1;
    const lp = msg.instructions.findIndex((i) => ((i as { accounts?: unknown[] }).accounts?.length ?? 0) >= 18);
    const [ix] = msg.instructions.splice(lp, 1);
    t.meta!.innerInstructions = [...(t.meta!.innerInstructions ?? []), { index: 0, instructions: [ix] }];
    const p = parseTrade(t, keys)!;
    expect(p.wallet).toBe(TRADER);
    expect(p.referrer).toBe(CALLER);
    expect(p.side).toBe("buy");
  });
});

describe("parseTrade ignores look-alike instructions", () => {
  it("does not take a trader or caller from another program's instruction that copies the vault positions", () => {
    const t = revive(T.buy);
    const msg = t.transaction.message;
    const lp = msg.instructions.findIndex((i) => ((i as { accounts?: unknown[] }).accounts?.length ?? 0) >= 18);
    const real = msg.instructions[lp] as { programId: PublicKey; accounts: PublicKey[]; data: string };
    const fake = { ...real, programId: new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), accounts: [new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), ...real.accounts.slice(1)] };
    msg.instructions.splice(lp, 0, fake as never);
    const p = parseTrade(t, keys)!;
    expect(p.wallet).toBe(TRADER);
  });
});
