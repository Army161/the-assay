import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, SendTransactionError } from "@solana/web3.js";
import { sendAndConfirm, signAndSendAll, signatureOf, TxExpired, TxFailed, TxUnknown } from "../src/lib/send";
import bs58 from "bs58";
import { sendErrorToast } from "../src/components/toast";

function signedTx() {
  const payer = Keypair.generate();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bs58.encode(new Uint8Array(32).fill(1)), instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}

describe("sendAndConfirm", () => {
  it("reads the signature from the signed bytes", () => {
    const tx = signedTx();
    expect(signatureOf(tx.serialize())).toBe(bs58.encode(tx.signatures[0]));
  });

  it("keeps tracking the transaction when the send response and a status call are lost", async () => {
    const tx = signedTx();
    const sig = bs58.encode(tx.signatures[0]);
    let statusCalls = 0;
    const conn = {
      sendRawTransaction: async () => { throw new Error("fetch failed"); },
      getSignatureStatuses: async () => {
        statusCalls++;
        if (statusCalls === 1) throw new Error("socket hang up");
        return { context: { slot: 1 }, value: [statusCalls >= 3 ? { confirmationStatus: "confirmed", err: null, slot: 1, confirmations: 1 } : null] };
      },
      getBlockHeight: async () => 10,
    };
    await expect(sendAndConfirm(conn as never, tx.serialize(), 100, { pollMs: 1, resendMs: 1 })).resolves.toBe(sig);
  });

  it("stops on a preflight refusal, an on-chain error, and expiry", async () => {
    const tx = signedTx();
    const refused = { sendRawTransaction: async () => { throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "Transaction simulation failed", logs: [] }); }, getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 10 };
    await expect(sendAndConfirm(refused as never, tx.serialize(), 100, { pollMs: 1 })).rejects.toBeInstanceOf(SendTransactionError);
    const failed = { sendRawTransaction: async () => "x", getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }] }), getBlockHeight: async () => 10 };
    await expect(sendAndConfirm(failed as never, tx.serialize(), 100, { pollMs: 1 })).rejects.toBeInstanceOf(TxFailed);
    const expired = { sendRawTransaction: async () => "x", getSignatureStatuses: async () => ({ context: { slot: 5 }, value: [null] }), getBlockHeight: async () => 101, getEpochInfo: async () => ({ blockHeight: 101, absoluteSlot: 5 }) };
    await expect(sendAndConfirm(expired as never, tx.serialize(), 100, { pollMs: 1 })).rejects.toBeInstanceOf(TxExpired);
  });

  // The block height each commitment reports, with the finalized block at FINALIZED_SLOT, and statuses answered in turn
  // (the last one repeats) by a node at `slot`, by default one that has processed the finalized block.
  const FINALIZED_SLOT = 1_000;
  const heights = (confirmed: number, finalized = confirmed) => ({
    getBlockHeight: async (c?: string) => (c === "finalized" ? finalized : confirmed),
    getEpochInfo: async () => ({ blockHeight: finalized, absoluteSlot: FINALIZED_SLOT }),
  });
  const statusesAt = (slot: number, ...seq: unknown[]) => { let i = 0; return async () => ({ context: { slot }, value: [seq[Math.min(i++, seq.length - 1)]] }); };
  const statuses = (...seq: unknown[]) => statusesAt(FINALIZED_SLOT, ...seq);
  const processed = { confirmationStatus: "processed", err: null, slot: 1, confirmations: 0 };
  const confirmed = { confirmationStatus: "confirmed", err: null, slot: 1, confirmations: 1 };
  // Quick timings: `fast` leaves time to settle, `soon` gives up early for the cases that end in TxUnknown.
  const fast = { pollMs: 1, resendMs: 1, callMs: 20, giveUpMs: 1_000 };
  const soon = { ...fast, giveUpMs: 50 };
  const outcome = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  it("keeps watching a trade seen as processed when its blockhash expires", async () => {
    const tx = signedTx();
    const conn = { sendRawTransaction: async () => "x", getSignatureStatuses: statuses(processed, processed, processed, confirmed), ...heights(101) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), 100, fast)).resolves.toBe(signatureOf(tx.serialize()));
  }, 5_000);

  it("waits for the finalized chain before calling a missing trade expired", async () => {
    // A node a slot behind has not seen a copy that landed just before the last valid height.
    const tx = signedTx();
    const conn = { sendRawTransaction: async () => "x", getSignatureStatuses: statuses(null, null, null, confirmed), ...heights(101, 90) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), 100, fast)).resolves.toBe(signatureOf(tx.serialize()));
  }, 5_000);

  it("does not call a missing trade expired while the node that found nothing is behind the finalized block", async () => {
    // As on devnet, where the finalized chain does not trail the confirmed one: the trade landed in the last valid
    // block, and the lookups go to a node that has not processed the finalized block past it yet.
    const tx = signedTx();
    const lagging = { sendRawTransaction: async () => "x", getSignatureStatuses: statusesAt(FINALIZED_SLOT - 2, null), ...heights(101) };
    const e = await outcome(sendAndConfirm(lagging as never, tx.serialize(), 100, soon));
    expect(e).toBeInstanceOf(TxUnknown);
    expect(e).not.toBeInstanceOf(TxExpired);
    const shows = { sendRawTransaction: async () => "x", getSignatureStatuses: statusesAt(FINALIZED_SLOT - 2, null, null, null, confirmed), ...heights(101) };
    await expect(sendAndConfirm(shows as never, tx.serialize(), 100, fast)).resolves.toBe(signatureOf(tx.serialize()));
  }, 5_000);

  it("succeeds only on an explicit confirmed or finalized status", async () => {
    const tx = signedTx();
    const conn = { sendRawTransaction: async () => "x", getSignatureStatuses: statuses({ err: null, slot: 1, confirmations: 1 }), ...heights(101) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), 100, soon)).rejects.toBeInstanceOf(TxUnknown);
  }, 5_000);

  it("reports a copy that never confirms as unknown, not expired", async () => {
    const tx = signedTx();
    const sig = signatureOf(tx.serialize());
    const conn = { sendRawTransaction: async () => "x", getSignatureStatuses: statuses(processed), ...heights(101) };
    const e = await outcome(sendAndConfirm(conn as never, tx.serialize(), 100, soon));
    expect(e).toBeInstanceOf(TxUnknown);
    expect(e).not.toBeInstanceOf(TxExpired);
    expect((e as TxUnknown).signature).toBe(sig);
    // The trade panel shows the first 240 characters: they must carry the signature and say it may still land.
    const shown = (e as Error).message.slice(0, 240);
    expect(shown).toContain(sig);
    expect(shown).toMatch(/may still go through/);
    expect(shown).not.toMatch(/Nothing was charged/);
  }, 5_000);

  it("does not treat an error seen only at processed as final", async () => {
    const tx = signedTx();
    const conn = { sendRawTransaction: async () => "x", getSignatureStatuses: statuses({ ...processed, err: { InstructionError: [0, "Custom"] } }, confirmed), ...heights(10) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), 100, fast)).resolves.toBe(signatureOf(tx.serialize()));
  }, 5_000);

  it("stops re-sending once the blockhash has expired", async () => {
    const tx = signedTx();
    let sends = 0, sendsAtExpiry = -1, finalizedCalls = 0;
    const conn = {
      sendRawTransaction: async () => { sends++; return "x"; },
      getSignatureStatuses: statuses(null),
      getBlockHeight: async () => {
        if (sends >= 3) { if (sendsAtExpiry < 0) sendsAtExpiry = sends; return 101; }
        return 10;
      },
      getEpochInfo: async () => ({ blockHeight: ++finalizedCalls > 5 ? 101 : 90, absoluteSlot: FINALIZED_SLOT }),
    };
    await expect(sendAndConfirm(conn as never, tx.serialize(), 100, fast)).rejects.toBeInstanceOf(TxExpired);
    expect(finalizedCalls).toBe(6);
    expect(sends).toBe(sendsAtExpiry);
  }, 5_000);

  it("gives up as unknown, with the signature, when the RPC never answers", async () => {
    const tx = signedTx();
    const fail = async () => { throw new Error("fetch failed"); };
    const conn = { sendRawTransaction: fail, getSignatureStatuses: fail, getBlockHeight: fail, getEpochInfo: fail };
    const e = await outcome(sendAndConfirm(conn as never, tx.serialize(), 100, soon));
    expect(e).toBeInstanceOf(TxUnknown);
    expect(e).not.toBeInstanceOf(TxExpired);
    expect((e as TxUnknown).signature).toBe(signatureOf(tx.serialize()));
  }, 5_000);

  it("does not let a stalled RPC call hold the loop", async () => {
    const tx = signedTx();
    const conn = { sendRawTransaction: async () => "x", getSignatureStatuses: () => new Promise(() => {}), ...heights(101) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), 100, { ...soon, callMs: 10 })).rejects.toBeInstanceOf(TxUnknown);
  }, 5_000);

  it("reports unknown, not expired, when expiry cannot be established", async () => {
    const tx = signedTx();
    // A node stuck below the last valid height.
    const stuck = { sendRawTransaction: async () => "x", getSignatureStatuses: statuses(null), ...heights(10) };
    await expect(sendAndConfirm(stuck as never, tx.serialize(), 100, soon)).rejects.toBeInstanceOf(TxUnknown);
    // Past it, but the last look through the history keeps failing.
    const blind = {
      sendRawTransaction: async () => "x",
      getSignatureStatuses: async (_: string[], cfg?: { searchTransactionHistory?: boolean }) => { if (cfg?.searchTransactionHistory) throw new Error("socket hang up"); return { context: { slot: FINALIZED_SLOT }, value: [null] }; },
      ...heights(101),
    };
    await expect(sendAndConfirm(blind as never, tx.serialize(), 100, soon)).rejects.toBeInstanceOf(TxUnknown);
  }, 5_000);

  it("bounds the first send and keeps tracking after it stalls", async () => {
    const tx = signedTx();
    let sends = 0;
    const conn = { sendRawTransaction: () => (++sends === 1 ? new Promise(() => {}) : Promise.resolve("x")), getSignatureStatuses: statuses(null, confirmed), ...heights(10) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), 100, { ...fast, callMs: 10 })).resolves.toBe(signatureOf(tx.serialize()));
  }, 5_000);

  // A preflight refusal as the RPC gives it, and a send that records whether each copy skipped preflight.
  const refusal = () => new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1772", logs: [] });
  const recorder = (answer: (n: number, skip: boolean) => Promise<unknown>) => {
    const skips: boolean[] = [];
    return { skips, sendRawTransaction: (_: Uint8Array, o?: { skipPreflight?: boolean }) => { skips.push(!!o?.skipPreflight); return answer(skips.length, !!o?.skipPreflight); } };
  };
  const later = <T,>(ms: number, f: () => T) => new Promise<T>((res, rej) => setTimeout(() => { try { res(f()); } catch (e) { rej(e); } }, ms));

  it("stops on a slow preflight's refusal and never sends without preflight before one is accepted", async () => {
    // Simulation takes longer than the per-call limit, then refuses (slippage, say); so does every other copy.
    const tx = signedTx();
    const r = recorder((n) => (n === 1 ? later(60, () => { throw refusal(); }) : Promise.reject(refusal())));
    const conn = { sendRawTransaction: r.sendRawTransaction, getSignatureStatuses: statuses(null), ...heights(10) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), 100, { ...fast, callMs: 10 })).rejects.toBeInstanceOf(SendTransactionError);
    expect(r.skips.length).toBeGreaterThan(1);
    expect(r.skips).not.toContain(true);
  }, 5_000);

  it("re-sends without preflight only once a send was accepted", async () => {
    const tx = signedTx();
    let acceptedAt = -1;
    const r = recorder((n) => (n === 1 ? later(60, () => { acceptedAt = r.skips.length; return "x"; }) : new Promise(() => {})));
    const conn = { sendRawTransaction: r.sendRawTransaction, getSignatureStatuses: statuses(...Array(20).fill(null), confirmed), ...heights(10) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), 100, { ...fast, callMs: 10 })).resolves.toBe(signatureOf(tx.serialize()));
    expect(acceptedAt).toBeGreaterThan(0);
    expect(r.skips.slice(0, acceptedAt)).not.toContain(true);
    expect(r.skips.slice(acceptedAt)).toContain(true);
  }, 5_000);

  it("does not take a refusal as final while an earlier copy may have got through", async () => {
    // The first send is lost in transit (the node may have forwarded it); the copies after it are refused by preflight.
    const tx = signedTx();
    const r = recorder((n) => Promise.reject(n === 1 ? new Error("fetch failed") : refusal()));
    const conn = { sendRawTransaction: r.sendRawTransaction, getSignatureStatuses: statuses(null, null, null, confirmed), ...heights(10) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), 100, fast)).resolves.toBe(signatureOf(tx.serialize()));
    expect(r.skips.length).toBeGreaterThan(1);
    expect(r.skips).not.toContain(true);
  }, 5_000);
});

describe("signAndSendAll", () => {
  const harness = (latestFails: boolean) => {
    const sent: string[] = [];
    let latestCalls = 0, signRounds = 0;
    const conn = {
      getLatestBlockhash: async () => {
        latestCalls++;
        if (latestFails && latestCalls > 1) throw new Error("fetch failed");
        return { blockhash: bs58.encode(new Uint8Array(32).fill(latestCalls)), lastValidBlockHeight: 1000 };
      },
      // Answers while the first transaction confirms, then goes dark before the second is sent.
      getBlockHeight: async () => { if (sent.length >= 1) throw new Error("socket hang up"); return 10; },
      sendRawTransaction: async (raw: Uint8Array) => { const sig = signatureOf(raw); sent.push(sig); return sig; },
      getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: null, slot: 1, confirmations: 1 }] }),
    };
    const payer = Keypair.generate();
    const tx = () => new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bs58.encode(new Uint8Array(32)), instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message());
    const signAll = async <T extends VersionedTransaction>(txs: T[]) => { signRounds++; txs.forEach((t) => t.sign([payer])); return txs; };
    return { conn, signAll, txs: [tx(), tx()], sent, rounds: () => signRounds };
  };

  it("refreshes the blockhash when the block height cannot be read", async () => {
    const h = harness(false);
    const sigs = await signAndSendAll(h.conn as never, h.signAll, h.txs, [[], []]);
    expect(sigs).toHaveLength(2);
    expect(h.sent).toHaveLength(2);
    expect(h.rounds()).toBe(2);
  }, 10_000);

  it("stops before the next send when neither the height nor a new blockhash can be read", async () => {
    const h = harness(true);
    await expect(signAndSendAll(h.conn as never, h.signAll, h.txs, [[], []])).rejects.toThrow(/fetch failed/);
    expect(h.sent).toHaveLength(1);
  }, 10_000);

  it("stops at a transaction whose outcome is unknown, before sending the next", async () => {
    const h = harness(false);
    h.conn.getSignatureStatuses = async () => { throw new Error("socket hang up"); };
    await expect(signAndSendAll(h.conn as never, h.signAll, h.txs, [[], []], { pollMs: 1, resendMs: 1_000, giveUpMs: 50 })).rejects.toBeInstanceOf(TxUnknown);
    expect(new Set(h.sent).size).toBe(1);
  }, 5_000);

  it("does not hang on a stalled blockhash fetch", async () => {
    const h = harness(false);
    h.conn.getLatestBlockhash = () => new Promise(() => {});
    await expect(signAndSendAll(h.conn as never, h.signAll, h.txs, [[], []], { callMs: 10 })).rejects.toThrow(/timed out/);
    expect(h.sent).toHaveLength(0);
  }, 5_000);
});

describe("sendErrorToast", () => {
  it("shows an unknown outcome as not failed, links it, and keeps it up until dismissed", () => {
    const sig = signatureOf(signedTx().serialize());
    const t = sendErrorToast(new TxUnknown(sig), "Transaction failed");
    expect(t).toMatchObject({ kind: "info", title: "Not confirmed yet", sticky: true });
    expect(t.title).not.toMatch(/fail/i);
    expect(t.body).toMatch(/may still go through/);
    expect(t.href).toContain(sig);
  });

  it("shows other errors as failures that go away", () => {
    const expired = sendErrorToast(new TxExpired("abc"), "Launch failed");
    expect(expired).toMatchObject({ kind: "err", title: "Launch failed" });
    expect(expired.sticky).toBeFalsy();
    expect(sendErrorToast(new Error("User rejected the request."), "Claim failed").body).toBe("You cancelled in the wallet.");
  });
});
