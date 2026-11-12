import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, SendTransactionError, type PublicKey } from "@solana/web3.js";
import { inFinalizedHistory, sendAndConfirm, signAndSendAll, signatureOf, TxExpired, TxFailed, TxUnknown } from "../src/lib/send";
import bs58 from "bs58";
import { sendErrorToast } from "../src/components/toast";

function signedTx() {
  const payer = Keypair.generate();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bs58.encode(new Uint8Array(32).fill(1)), instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}

// The blockhash the test transactions are signed on: valid up to height 100, fetched at slot 900.
const SPAN = { lastValidBlockHeight: 100, minSlot: 900 };
type Entry = { signature: string; slot: number; err?: unknown };
type HistoryOpts = { before?: string; limit?: number; minContextSlot?: number };
const slotsFrom = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => start + i);
/**
 * The node's finalized blocks: every slot a block, at its height on the chain (the one at the blockhash's slot 150
 * below its last valid height), less the ones in `gap`, which the node lacks. Every call is kept, with its arguments.
 */
const blocks = (span = SPAN, gap: number[] = []) => {
  const blockCalls: unknown[][] = [];
  return {
    blockCalls,
    getBlocks: async (start: number, end: number, commitment?: string) => { blockCalls.push(["getBlocks", start, end, commitment]); return slotsFrom(start, end).filter((s) => !gap.includes(s)); },
    getBlock: async (slot: number, config: unknown) => { blockCalls.push(["getBlock", slot, config]); return { blockHeight: span.lastValidBlockHeight - 150 + slot - span.minSlot }; },
  };
};
/**
 * The fee payer's finalized history: one page per call, then empty pages, from a node that holds every block since the
 * blockhash. Every call is kept, with its arguments.
 */
const history = (...pages: Entry[][]) => {
  const calls: { address: string; opts: HistoryOpts; commitment?: string }[] = [];
  const getSignaturesForAddress = async (address: PublicKey, opts: HistoryOpts, commitment?: string) => {
    calls.push({ address: address.toBase58(), opts, commitment });
    return (pages[calls.length - 1] ?? []).map((e) => ({ err: null, memo: null, confirmationStatus: "finalized", ...e }));
  };
  return { calls, getSignaturesForAddress, ...blocks() };
};
/** A page with only another transaction, from before the blockhash: read that far, the one looked for is not there. */
const olderOnly = (): Entry[] => [{ signature: "older", slot: SPAN.minSlot - 1 }];
/** As the RPC refuses a node whose finalized root is below minContextSlot. */
const notReached = () => Object.assign(new Error("failed to get signatures for address: Minimum context slot has not been reached"), { code: -32016 });

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
    await expect(sendAndConfirm(conn as never, tx.serialize(), SPAN, { pollMs: 1, resendMs: 1 })).resolves.toBe(sig);
  });

  it("stops on a preflight refusal, an on-chain error, and expiry", async () => {
    const tx = signedTx();
    const refused = { sendRawTransaction: async () => { throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "Transaction simulation failed", logs: [] }); }, getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 10 };
    await expect(sendAndConfirm(refused as never, tx.serialize(), SPAN, { pollMs: 1 })).rejects.toBeInstanceOf(SendTransactionError);
    const failed = { sendRawTransaction: async () => "x", getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }] }), getBlockHeight: async () => 10 };
    await expect(sendAndConfirm(failed as never, tx.serialize(), SPAN, { pollMs: 1 })).rejects.toBeInstanceOf(TxFailed);
    const expired = { sendRawTransaction: async () => "x", getSignatureStatuses: async () => ({ context: { slot: 5 }, value: [null] }), getBlockHeight: async () => 101, getEpochInfo: async () => ({ blockHeight: 101, absoluteSlot: 5 }), ...history(olderOnly()) };
    await expect(sendAndConfirm(expired as never, tx.serialize(), SPAN, { pollMs: 1 })).rejects.toBeInstanceOf(TxExpired);
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
    await expect(sendAndConfirm(conn as never, tx.serialize(), SPAN, fast)).resolves.toBe(signatureOf(tx.serialize()));
  }, 5_000);

  it("waits for the finalized chain before calling a missing trade expired", async () => {
    // A node a slot behind has not seen a copy that landed just before the last valid height.
    const tx = signedTx();
    const conn = { sendRawTransaction: async () => "x", getSignatureStatuses: statuses(null, null, null, confirmed), ...heights(101, 90) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), SPAN, fast)).resolves.toBe(signatureOf(tx.serialize()));
  }, 5_000);

  it("does not call a missing trade expired while the node that found nothing is behind the finalized block", async () => {
    // As on devnet, where the finalized chain does not trail the confirmed one: the trade landed in the last valid
    // block, and the lookups go to a node that has not processed the finalized block past it yet.
    const tx = signedTx();
    const lagging = { sendRawTransaction: async () => "x", getSignatureStatuses: statusesAt(FINALIZED_SLOT - 2, null), ...heights(101) };
    const e = await outcome(sendAndConfirm(lagging as never, tx.serialize(), SPAN, soon));
    expect(e).toBeInstanceOf(TxUnknown);
    expect(e).not.toBeInstanceOf(TxExpired);
    const shows = { sendRawTransaction: async () => "x", getSignatureStatuses: statusesAt(FINALIZED_SLOT - 2, null, null, null, confirmed), ...heights(101) };
    await expect(sendAndConfirm(shows as never, tx.serialize(), SPAN, fast)).resolves.toBe(signatureOf(tx.serialize()));
  }, 5_000);

  it("succeeds only on an explicit confirmed or finalized status", async () => {
    const tx = signedTx();
    const conn = { sendRawTransaction: async () => "x", getSignatureStatuses: statuses({ err: null, slot: 1, confirmations: 1 }), ...heights(101) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), SPAN, soon)).rejects.toBeInstanceOf(TxUnknown);
  }, 5_000);

  it("reports a copy that never confirms as unknown, not expired", async () => {
    const tx = signedTx();
    const sig = signatureOf(tx.serialize());
    const conn = { sendRawTransaction: async () => "x", getSignatureStatuses: statuses(processed), ...heights(101) };
    const e = await outcome(sendAndConfirm(conn as never, tx.serialize(), SPAN, soon));
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
    await expect(sendAndConfirm(conn as never, tx.serialize(), SPAN, fast)).resolves.toBe(signatureOf(tx.serialize()));
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
      ...history(olderOnly()),
    };
    await expect(sendAndConfirm(conn as never, tx.serialize(), SPAN, fast)).rejects.toBeInstanceOf(TxExpired);
    expect(finalizedCalls).toBe(6);
    expect(sends).toBe(sendsAtExpiry);
  }, 5_000);

  it("gives up as unknown, with the signature, when the RPC never answers", async () => {
    const tx = signedTx();
    const fail = async () => { throw new Error("fetch failed"); };
    const conn = { sendRawTransaction: fail, getSignatureStatuses: fail, getBlockHeight: fail, getEpochInfo: fail };
    const e = await outcome(sendAndConfirm(conn as never, tx.serialize(), SPAN, soon));
    expect(e).toBeInstanceOf(TxUnknown);
    expect(e).not.toBeInstanceOf(TxExpired);
    expect((e as TxUnknown).signature).toBe(signatureOf(tx.serialize()));
  }, 5_000);

  it("does not let a stalled RPC call hold the loop", async () => {
    const tx = signedTx();
    const conn = { sendRawTransaction: async () => "x", getSignatureStatuses: () => new Promise(() => {}), ...heights(101) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), SPAN, { ...soon, callMs: 10 })).rejects.toBeInstanceOf(TxUnknown);
  }, 5_000);

  it("reports unknown, not expired, when expiry cannot be established", async () => {
    const tx = signedTx();
    // A node stuck below the last valid height.
    const stuck = { sendRawTransaction: async () => "x", getSignatureStatuses: statuses(null), ...heights(10) };
    await expect(sendAndConfirm(stuck as never, tx.serialize(), SPAN, soon)).rejects.toBeInstanceOf(TxUnknown);
    // Past it, but the last look through the history keeps failing.
    const blind = {
      sendRawTransaction: async () => "x",
      getSignatureStatuses: async (_: string[], cfg?: { searchTransactionHistory?: boolean }) => { if (cfg?.searchTransactionHistory) throw new Error("socket hang up"); return { context: { slot: FINALIZED_SLOT }, value: [null] }; },
      ...heights(101),
    };
    await expect(sendAndConfirm(blind as never, tx.serialize(), SPAN, soon)).rejects.toBeInstanceOf(TxUnknown);
  }, 5_000);

  it("bounds the first send and keeps tracking after it stalls", async () => {
    const tx = signedTx();
    let sends = 0;
    const conn = { sendRawTransaction: () => (++sends === 1 ? new Promise(() => {}) : Promise.resolve("x")), getSignatureStatuses: statuses(null, confirmed), ...heights(10) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), SPAN, { ...fast, callMs: 10 })).resolves.toBe(signatureOf(tx.serialize()));
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
    await expect(sendAndConfirm(conn as never, tx.serialize(), SPAN, { ...fast, callMs: 10 })).rejects.toBeInstanceOf(SendTransactionError);
    expect(r.skips.length).toBeGreaterThan(1);
    expect(r.skips).not.toContain(true);
  }, 5_000);

  it("re-sends without preflight only once a send was accepted", async () => {
    const tx = signedTx();
    let acceptedAt = -1;
    const r = recorder((n) => (n === 1 ? later(60, () => { acceptedAt = r.skips.length; return "x"; }) : new Promise(() => {})));
    const conn = { sendRawTransaction: r.sendRawTransaction, getSignatureStatuses: statuses(...Array(20).fill(null), confirmed), ...heights(10) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), SPAN, { ...fast, callMs: 10 })).resolves.toBe(signatureOf(tx.serialize()));
    expect(acceptedAt).toBeGreaterThan(0);
    expect(r.skips.slice(0, acceptedAt)).not.toContain(true);
    expect(r.skips.slice(acceptedAt)).toContain(true);
  }, 5_000);

  it("does not take a refusal as final while an earlier copy may have got through", async () => {
    // The first send is lost in transit (the node may have forwarded it); the copies after it are refused by preflight.
    const tx = signedTx();
    const r = recorder((n) => Promise.reject(n === 1 ? new Error("fetch failed") : refusal()));
    const conn = { sendRawTransaction: r.sendRawTransaction, getSignatureStatuses: statuses(null, null, null, confirmed), ...heights(10) };
    await expect(sendAndConfirm(conn as never, tx.serialize(), SPAN, fast)).resolves.toBe(signatureOf(tx.serialize()));
    expect(r.skips.length).toBeGreaterThan(1);
    expect(r.skips).not.toContain(true);
  }, 5_000);

  // Past expiry, a node that has processed the finalized block finds nothing: what the payer's finalized history says.
  const lost = (h: ReturnType<typeof history>) => ({ sendRawTransaction: async () => "x", getSignatureStatuses: statuses(null), ...heights(101), ...blocks(), ...h });

  it("calls a trade expired only once the fee payer's finalized history back to the blockhash is read without it", async () => {
    const tx = signedTx();
    const h = history(olderOnly());
    await expect(sendAndConfirm(lost(h) as never, tx.serialize(), SPAN, fast)).rejects.toBeInstanceOf(TxExpired);
    // The payer's history, at finalized, from a node rooted at least at the finalized block past the blockhash.
    expect(h.calls).toEqual([{ address: tx.message.staticAccountKeys[0].toBase58(), opts: { before: undefined, limit: 1000, minContextSlot: FINALIZED_SLOT }, commitment: "finalized" }]);
  }, 5_000);

  it("does not call a trade expired that the finalized history holds: a node on a minority fork found nothing", async () => {
    const tx = signedTx();
    const sig = signatureOf(tx.serialize());
    const landed = history([{ signature: "newer", slot: 990 }, { signature: sig, slot: 950 }, ...olderOnly()]);
    await expect(sendAndConfirm(lost(landed) as never, tx.serialize(), SPAN, fast)).resolves.toBe(sig);
    // Landed with an error: that is final too, and it is not "nothing was charged".
    const failed = history([{ signature: sig, slot: 950, err: { InstructionError: [0, "Custom"] } }]);
    await expect(sendAndConfirm(lost(failed) as never, tx.serialize(), SPAN, fast)).rejects.toBeInstanceOf(TxFailed);
  }, 5_000);

  it("reports unknown, not expired, while the finalized history cannot be read, and asks again meanwhile", async () => {
    const tx = signedTx();
    for (const err of [notReached(), new Error("fetch failed")]) {
      let calls = 0;
      const conn = lost({ calls: [], getSignaturesForAddress: async () => { calls++; throw err; } } as never);
      const e = await outcome(sendAndConfirm(conn as never, tx.serialize(), SPAN, soon));
      expect(e).toBeInstanceOf(TxUnknown);
      expect(e).not.toBeInstanceOf(TxExpired);
      expect((e as TxUnknown).signature).toBe(signatureOf(tx.serialize()));
      expect(calls).toBeGreaterThan(1);
    }
    // A node that was not yet rooted that far, then one that is.
    let n = 0;
    const rooted = history(olderOnly());
    const catchesUp = lost({ calls: [], getSignaturesForAddress: async (...a: Parameters<typeof rooted.getSignaturesForAddress>) => { if (n++ < 2) throw notReached(); return rooted.getSignaturesForAddress(...a); } } as never);
    await expect(sendAndConfirm(catchesUp as never, tx.serialize(), SPAN, fast)).rejects.toBeInstanceOf(TxExpired);
  }, 5_000);

  it("reports unknown, at once, when there is more history since the blockhash than it reads", async () => {
    const tx = signedTx();
    const full = (page: number) => Array.from({ length: 1000 }, (_, i) => ({ signature: `p${page}-${i}`, slot: 2_000 - page }));
    const h = history(...[0, 1, 2, 3, 4, 5].map(full), olderOnly());
    const e = await outcome(sendAndConfirm(lost(h) as never, tx.serialize(), SPAN, fast));
    expect(e).toBeInstanceOf(TxUnknown);
    expect(e).not.toBeInstanceOf(TxExpired);
    expect(h.calls).toHaveLength(5); // the cap, once
  }, 5_000);

  it("does not call a trade expired when a node without the ledger back to the blockhash answers with an empty page", async () => {
    const tx = signedTx();
    // Newer entries, none older than the blockhash, then nothing: the node's ledger ends there, the payer's does not.
    const e = await outcome(sendAndConfirm(lost(history([{ signature: "newer", slot: 990 }])) as never, tx.serialize(), SPAN, fast));
    expect(e).toBeInstanceOf(TxUnknown);
    expect(e).not.toBeInstanceOf(TxExpired);
  }, 5_000);

  it("does not call a trade expired on a node with a gap in its ledger over the blockhash's blocks, and asks again meanwhile", async () => {
    // Restarted from a newer snapshot with its older ledger kept: its history jumps from entries above the gap to one
    // before the blockhash, and the trade (landed at slot 950) is in what it lacks.
    const tx = signedTx();
    const gapped = { ...history(olderOnly(), olderOnly(), olderOnly()), ...blocks(SPAN, slotsFrom(940, 960)) };
    const e = await outcome(sendAndConfirm(lost(gapped) as never, tx.serialize(), SPAN, soon));
    expect(e).toBeInstanceOf(TxUnknown);
    expect(e).not.toBeInstanceOf(TxExpired);
    expect(gapped.calls.length).toBeGreaterThan(1);
    // A node that is only behind (its root short of the last valid height), then has them all: the trade expired.
    let n = 0;
    const all = blocks();
    const behind = { ...history(olderOnly(), olderOnly(), olderOnly()), getBlocks: async (a: number, b: number, c?: string) => (await all.getBlocks(a, b, c)).slice(0, n++ < 2 ? 100 : undefined) };
    await expect(sendAndConfirm(lost(behind) as never, tx.serialize(), SPAN, fast)).rejects.toBeInstanceOf(TxExpired);
    expect(n).toBe(3);
  }, 5_000);
});

describe("inFinalizedHistory", () => {
  const payer = Keypair.generate().publicKey;
  const find = (h: ReturnType<typeof history>, sig = "wanted") => inFinalizedHistory(h as never, payer, sig, SPAN, 1_000, (c) => c);

  it("reads page by page, newest first, and stops at the first entry older than the blockhash", async () => {
    // A node rooted past the finalized block answers the first page with newer entries; every page is older still.
    const h = history([{ signature: "a", slot: 1_010 }, { signature: "b", slot: 1_005 }], [{ signature: "c", slot: 950 }, { signature: "d", slot: 899 }], [{ signature: "wanted", slot: 880 }]);
    expect(await find(h)).toBe("absent");
    expect(h.calls.map((c) => c.opts)).toEqual([
      { before: undefined, limit: 1000, minContextSlot: 1_000 },
      // Below the last entry read, from a node that has it: one rooted at least at its slot.
      { before: "b", limit: 1000, minContextSlot: 1_005 },
    ]);
  });

  it("reads on past a short page, and takes an empty one before an entry older than the blockhash as unknown, not as the end", async () => {
    // A node whose ledger starts after the blockhash (pruned, or restarted from a recent snapshot): what it holds, then
    // nothing. The transaction may be in what it lacks, so this proves nothing.
    const h = history([{ signature: "a", slot: 950 }]);
    expect(await find(h)).toBeNull();
    expect(h.calls).toHaveLength(2);
    expect(await find(history([]))).toBeNull();
    // A short page is read on from, and the older entry on the next one settles it.
    expect(await find(history([{ signature: "a", slot: 950 }], olderOnly()))).toBe("absent");
  });

  it("reads on below where an earlier call stopped, so a payer busier than the cap is still read to the end", async () => {
    const full = (page: number) => Array.from({ length: 1000 }, (_, i) => ({ signature: `p${page}-${i}`, slot: 2_000 - page }));
    const scan: { before?: string } = {};
    const first = history(...[0, 1, 2, 3, 4].map(full));
    expect(await inFinalizedHistory(first as never, payer, "wanted", SPAN, 1_000, (c) => c, scan)).toBeNull();
    expect(first.calls).toHaveLength(5);
    expect(scan.before).toBe("p4-999");
    // Later, with more history on top by then: none of that is read, the reading goes on below the last entry read.
    const later = history(full(5), olderOnly());
    expect(await inFinalizedHistory(later as never, payer, "wanted", SPAN, 3_000, (c) => c, scan)).toBe("absent");
    expect(later.calls.map((c) => c.opts)).toEqual([
      { before: "p4-999", limit: 1000, minContextSlot: 3_000 },
      { before: "p5-999", limit: 1000, minContextSlot: 3_000 },
    ]);
  });

  it("keeps how far it read only from a node that holds every block since the blockhash, and nothing when a call throws", async () => {
    const full = (page: number) => Array.from({ length: 1000 }, (_, i) => ({ signature: `p${page}-${i}`, slot: 2_000 - page }));
    const gappy = blocks(SPAN, [1_000]);
    // Past the page cap, and on an empty page, from a node with a gap where the transaction can be: what it listed may
    // skip the gap, so a later call reading on from below would never list it. Nothing is kept, and it throws.
    for (const pages of [[0, 1, 2, 3, 4].map(full), [full(0)]]) {
      const scan: { before?: string } = { before: "saved" };
      await expect(inFinalizedHistory({ ...history(...pages), ...gappy } as never, payer, "wanted", SPAN, 1_000, (c) => c, scan)).rejects.toThrow(/does not hold every block/);
      expect(scan).toEqual({ before: "saved" });
    }
    // An RPC error after some pages were read keeps nothing of them either.
    const scan: { before?: string } = { before: "saved" };
    let n = 0;
    const failing = { ...history(), getSignaturesForAddress: async () => { if (n++ < 2) return full(n); throw new Error("fetch failed"); } };
    await expect(inFinalizedHistory(failing as never, payer, "wanted", SPAN, 1_000, (c) => c, scan)).rejects.toThrow(/fetch failed/);
    expect(scan).toEqual({ before: "saved" });
    // A first page that comes back empty reads nothing, so it is not checked and keeps where it was.
    const empty = history();
    expect(await inFinalizedHistory(empty as never, payer, "wanted", SPAN, 1_000, (c) => c, scan)).toBeNull();
    expect(scan).toEqual({ before: "saved" });
    expect(empty.blockCalls).toEqual([]);
  });

  it("takes reading past the blockhash's slot as proof only from a node that holds every block since then", async () => {
    // What it asks: the finalized blocks in a window of slots from the blockhash's, and the height of the 150th after it.
    const h = history(olderOnly());
    expect(await find(h)).toBe("absent");
    expect(h.blockCalls).toEqual([
      ["getBlocks", 900, 1_900, "finalized"],
      ["getBlock", 1_050, { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }],
    ]);
    // A gap in the node's ledger (restarted from a newer snapshot, its older ledger kept) where the transaction can be:
    // its history reads past the blockhash's slot all the same, and the transaction may be in what it lacks.
    await expect(find({ ...history(olderOnly()), ...blocks(SPAN, [1_000]) })).rejects.toThrow(/does not hold every block/);
    // A node whose finalized root is short of the last valid height.
    await expect(find({ ...history(olderOnly()), ...blocks(SPAN, slotsFrom(1_040, 1_900)) })).rejects.toThrow(/does not hold every block/);
    // A gap before the blockhash, or after its last valid height, leaves out no block the transaction can be in.
    expect(await find({ ...history(olderOnly()), ...blocks(SPAN, [899, 1_051, 1_200]) })).toBe("absent");
  });

  it("returns the entry when it is there", async () => {
    expect(await find(history([{ signature: "a", slot: 990 }], [{ signature: "wanted", slot: 960 }]))).toMatchObject({ signature: "wanted", slot: 960, err: null });
  });

  it("throws what the RPC throws: an unreadable history is not an empty one", async () => {
    await expect(find({ calls: [], getSignaturesForAddress: async () => { throw notReached(); } } as never)).rejects.toThrow(/Minimum context slot/);
  });
});

describe("signAndSendAll", () => {
  const harness = (latestFails: boolean) => {
    const sent: string[] = [];
    let latestCalls = 0, signRounds = 0;
    const conn = {
      getLatestBlockhashAndContext: async () => {
        latestCalls++;
        if (latestFails && latestCalls > 1) throw new Error("fetch failed");
        return { context: { slot: 1 }, value: { blockhash: bs58.encode(new Uint8Array(32).fill(latestCalls)), lastValidBlockHeight: 1000 } };
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
    h.conn.getLatestBlockhashAndContext = () => new Promise(() => {});
    await expect(signAndSendAll(h.conn as never, h.signAll, h.txs, [[], []], { callMs: 10 })).rejects.toThrow(/timed out/);
    expect(h.sent).toHaveLength(0);
  }, 5_000);

  it("searches the fee payer's history back to the slot its blockhash was fetched at before calling a trade expired", async () => {
    const payer = Keypair.generate();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bs58.encode(new Uint8Array(32)), instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message());
    // Fetched at slot 777; the finalized block past it is at 900. The first page reaches no further back than 777 and
    // the second goes past it, so the search reads both.
    const h = history([{ signature: "a", slot: 880 }, { signature: "b", slot: 777 }], [{ signature: "c", slot: 776 }]);
    const conn = {
      getLatestBlockhashAndContext: async () => ({ context: { slot: 777 }, value: { blockhash: bs58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 100 } }),
      sendRawTransaction: async () => "x",
      getSignatureStatuses: async () => ({ context: { slot: 900 }, value: [null] }),
      getBlockHeight: async () => 101,
      getEpochInfo: async () => ({ blockHeight: 101, absoluteSlot: 900 }),
      ...h,
      ...blocks({ minSlot: 777, lastValidBlockHeight: 100 }),
    };
    const signAll = async <T extends VersionedTransaction>(txs: T[]) => { txs.forEach((t) => t.sign([payer])); return txs; };
    await expect(signAndSendAll(conn as never, signAll, [tx], [[]], { pollMs: 1, resendMs: 1, callMs: 20, giveUpMs: 1_000 })).rejects.toBeInstanceOf(TxExpired);
    expect(h.calls.map((c) => [c.address, c.opts.minContextSlot, c.commitment])).toEqual([[payer.publicKey.toBase58(), 900, "finalized"], [payer.publicKey.toBase58(), 900, "finalized"]]);
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
