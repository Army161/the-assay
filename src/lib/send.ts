// Sending transactions so that "confirmed" means confirmed. Used by the browser (wallet-signed trades and launches)
// and by the server (rewards). Mainnet drops transactions under load, so each one carries a priority fee, is checked
// by the RPC before it is sent (preflight), and is re-sent until it lands or its blockhash expires.
import { SendTransactionError, VersionedTransaction, type ConfirmedSignatureInfo, type Connection, type PublicKey, type SignatureStatus, type Signer, type TransactionSignature } from "@solana/web3.js";
import bs58 from "bs58";
import type { Network } from "./chain";

/** Priority fee bounds in micro-lamports per compute unit. 1_000_000 at 300k units is 0.0003 SOL. */
export const PRIORITY = {
  mainnet: { min: 20_000, max: 1_000_000 },
  devnet: { min: 1_000, max: 100_000 },
} as const;

/** Compute units we ask for: about three times what devnet used on 2026-11-12 (create with a first buy 159k, buy 51k, sell 46k). */
export const UNITS = { trade: 150_000, create: 300_000, claim: 100_000, payout: 60_000, rewardSell: 200_000 } as const;

/**
 * A priority fee from what recently landed on the accounts this transaction writes: the 75th percentile of the
 * non-zero fees, held between the network's floor and cap. Falls back to the floor when the RPC has no answer.
 */
export async function priorityFee(conn: Pick<Connection, "getRecentPrioritizationFees">, network: Network, writable: PublicKey[]): Promise<number> {
  const { min, max } = PRIORITY[network];
  try {
    const recent = await conn.getRecentPrioritizationFees({ lockedWritableAccounts: writable.slice(0, 128) });
    const fees = recent.map((r) => r.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
    const p75 = fees.length ? fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))] : 0;
    return Math.max(min, Math.min(max, Math.ceil(p75)));
  } catch {
    return min;
  }
}

export async function computeBudget(conn: Pick<Connection, "getRecentPrioritizationFees">, network: Network, writable: PublicKey[], units: number) {
  return { units, microLamports: await priorityFee(conn, network, writable) };
}

export class TxFailed extends Error {
  constructor(public signature: string, public reason: string) { super(`Transaction ${signature} failed: ${reason}`); }
}
export class TxExpired extends Error {
  constructor(public signature: string) { super(`Transaction ${signature} did not land before its blockhash expired. Nothing was charged; try again.`); }
}
/** Sent, but the outcome is not known: a copy was seen and never confirmed, or the RPC could not say in time. It may still land. */
export class TxUnknown extends Error {
  constructor(public signature: string) { super(`Transaction ${signature} was sent but could not be confirmed in time. It may still go through: check it in an explorer before trying again.`); }
}

type SendConn = Pick<Connection, "sendRawTransaction" | "getSignatureStatuses" | "getBlockHeight" | "getEpochInfo" | "getSignaturesForAddress" | "getBlocks" | "getBlock">;
/**
 * Where a transaction signed on a blockhash can land: after `minSlot`, the slot the blockhash was fetched at (it is
 * that slot's, so no transaction using it is in that slot or an earlier one), and no later than `lastValidBlockHeight`.
 */
export type BlockhashSpan = { lastValidBlockHeight: number; minSlot: number };
type SendOpts = { pollMs?: number; resendMs?: number; skipPreflight?: boolean; callMs?: number; giveUpMs?: number };

/** Longest wait for one RPC call. web3.js sets no fetch timeout, so a stalled call would otherwise hold the loop for good. */
const CALL_MS = 10_000;
/**
 * Longest wait for an outcome, from the first send. A blockhash lives about 150 blocks (60-90 s) and the finalized
 * chain trails the confirmed one by at most about 13 s, so expiry is normally known well inside this.
 */
const GIVE_UP_MS = 150_000;

/** Waits for an RPC call for at most `ms`. The abandoned call's late result or error is swallowed. */
function within<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    call,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("RPC call timed out")), Math.max(0, ms)); }),
  ]).finally(() => { clearTimeout(timer); call.catch(() => {}); });
}

/** Confirmed or finalized. A processed copy can still be dropped with its fork, and a status with no level settles nothing. */
export const settled = (s: SignatureStatus | null | undefined): s is SignatureStatus => s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized";

/**
 * True when a lookup that found nothing settles a transaction as never landing, given the slot of a finalized block
 * past its blockhash: only when the node that answered had itself processed that block, so every block the transaction
 * could be in was in its view. A load-balanced RPC can answer from a node a few slots behind, and waiting for the
 * finalized chain adds no margin when it does not trail the confirmed one (on devnet on 2026-11-12 it did not).
 */
export const expiredFor = (lookup: { st: SignatureStatus | null; slot: number }, finalizedSlot: number) => !lookup.st && lookup.slot >= finalizedSlot;

/** Pages of a fee payer's finalized history read at most while looking for one transaction, and entries per page. */
const HISTORY_PAGES = 5;
const HISTORY_PAGE = 1000;
/**
 * Blocks a blockhash stays valid for: lastValidBlockHeight is the height of the block it was fetched at plus this
 * (checked on devnet on 2026-11-12). And the slots read to find those blocks: far more than they take (a few percent
 * of slots are skipped), and far inside the 500,000 getBlocks allows.
 */
const BLOCKHASH_BLOCKS = 150;
const WINDOW_SLOTS = 1_000;

/**
 * Whether the node holds every block a transaction on the blockhash could be in, which its history cannot show: a node
 * restarted from a newer snapshot that kept its older ledger lists the entries above that gap and then those below
 * it, so reading past `minSlot` proves nothing about the blocks in the gap. Heights go up by one per block and the
 * block at `minSlot` is BLOCKHASH_BLOCKS below the last valid height, so the block that many places on in the node's
 * list is at that height only if it lacks none of them (a node whose root is short of them lists too few). A fixed
 * window of slots, not one up to the finalized block, so a settle days later still fits getBlocks's range. A
 * load-balanced RPC may answer this from another node than the history: its nodes are taken to hold the same ledger.
 */
async function holdsWindow(conn: Pick<Connection, "getBlocks" | "getBlock">, span: BlockhashSpan, bound: <T>(call: Promise<T>) => Promise<T>): Promise<boolean> {
  const slots = await bound(conn.getBlocks(span.minSlot, span.minSlot + WINDOW_SLOTS, "finalized"));
  if (slots.length <= BLOCKHASH_BLOCKS) return false;
  const last = await bound(conn.getBlock(slots[BLOCKHASH_BLOCKS], { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }));
  // web3.js parses blockHeight from the answer but leaves it off its type.
  return (last as { blockHeight?: number | null } | null)?.blockHeight === span.lastValidBlockHeight;
}

/**
 * Proof from the finalized ledger itself that a transaction is not in it. expiredFor alone is not enough: the status
 * lookup answers from the node's processed bank, and a node on a minority fork can be past the finalized slot and
 * still lack a transaction the cluster finalized. Every transaction is in its fee payer's history, so this reads that
 * history at "finalized", newest first, from a node whose finalized root is at least `finalizedSlot` (minContextSlot:
 * any other node refuses). That block is past the blockhash's last valid height, so by then the transaction is in the
 * history or never will be; and it cannot be in a slot before `minSlot`, so the reading stops at the first entry older
 * than that.
 * Returns the entry when it is there (it landed, with or without an error), "absent" once an entry older than
 * `minSlot` was read without it from a node that lacks no block since then (see holdsWindow), and null when neither
 * came within the page cap (a busy payer), or a page came back empty first. Only an entry that old proves the reading
 * went back far enough: every fee payer has one (the transfer that funded it, at the least), and a node without the
 * older ledger (a pruned one, or one restarted from a recent snapshot) answers with what it holds, then with an empty
 * page.
 * `scan.before` is where the reading starts, and it moves down as pages are read. The history below an entry read at
 * finalized never changes and new entries only come above it, so a later call given the same `scan` reads on from
 * there rather than from the newest entry: a payer busier than the cap is still read to the end over a few calls.
 * An RPC error (MinContextSlotNotReached too) is thrown, as it shows nothing, and so is a node that lacks some of the
 * blocks since the blockhash: one that is behind can catch up, so it is worth asking again. `bound` limits each call.
 */
export async function inFinalizedHistory(
  conn: Pick<Connection, "getSignaturesForAddress" | "getBlocks" | "getBlock">, payer: PublicKey, signature: string, span: BlockhashSpan,
  finalizedSlot: number, bound: <T>(call: Promise<T>) => Promise<T>, scan: { before?: string } = {},
): Promise<ConfirmedSignatureInfo | "absent" | null> {
  const { minSlot } = span;
  let rootAtLeast = finalizedSlot;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const list = await bound(conn.getSignaturesForAddress(payer, { before: scan.before, limit: HISTORY_PAGE, minContextSlot: rootAtLeast }, "finalized"));
    const hit = list.find((e) => e.signature === signature);
    if (hit) return hit;
    if (list.some((e) => e.slot < minSlot)) {
      if (!(await holdsWindow(conn, span, bound))) throw new Error("the RPC node does not hold every block since the blockhash");
      return "absent";
    }
    // Not the end of the history, as there is an older entry: this node does not hold it. A short page goes on too, as
    // it may be a provider's own limit on the page size.
    if (!list.length) return null;
    const last = list[list.length - 1];
    scan.before = last.signature;
    // The next page starts below that entry, so it must come from a node rooted at least at its slot: one behind it
    // would not know the entry and would answer with an empty page, which settles nothing.
    rootAtLeast = Math.max(rootAtLeast, last.slot);
  }
  return null;
}

/** The fee payer is the first account of the message, and the transaction is always in its history. */
const feePayerOf = (raw: Uint8Array): PublicKey => VersionedTransaction.deserialize(raw).message.staticAccountKeys[0];

/** The transaction id is its first signature, which is in the signed bytes before anything is sent. */
export function signatureOf(raw: Uint8Array): TransactionSignature {
  // compact-u16 signature count, then 64-byte signatures; the first one is the fee payer's and names the transaction
  let off = 0, n = 0, shift = 0;
  for (;;) { const b = raw[off++]; n |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  if (n < 1 || raw.length < off + 64) throw new Error("not a signed transaction");
  return bs58.encode(raw.subarray(off, off + 64));
}

/** A refusal from the node (preflight simulation failed, bad signature): the transaction will never land. */
function definitive(e: unknown): boolean {
  if (e instanceof SendTransactionError) return true;
  const m = (e as Error)?.message ?? "";
  return /simulation failed|preflight|signature verification|invalid transaction/i.test(m);
}

/**
 * Send a signed transaction and wait until it is confirmed. Every copy runs preflight (a failing trade is refused before
 * it costs anything) until the node accepts one; only then are the same bytes re-sent without it, every few seconds
 * until the blockhash expires. A refusal ends it only while every copy sent so far was refused, as none of those was
 * forwarded: a send that is still unanswered or was lost in transit may have been, and that copy can still land.
 * Returns the signature only once it is confirmed or finalized without error; TxFailed once it is confirmed with one.
 * "processed" settles nothing: that fork can still be dropped, and a load-balanced RPC can answer from a node a slot
 * or two behind, which shows a copy that lands as processed or not at all.
 *
 * The signature is read from the bytes, not from the RPC's answer, so a dropped response or a failed status call never
 * loses track of a transaction that may have landed. TxExpired ("nothing was charged") is thrown only once the
 * finalized chain is past the blockhash, the signature was never seen, a lookup answered by a node that has itself
 * processed that finalized block finds nothing (see expiredFor), and the fee payer's finalized history back to the
 * blockhash's slot does not hold it (see inFinalizedHistory). Every RPC call is bounded, and when neither outcome is
 * known by the deadline it throws TxUnknown with the signature, never TxExpired: it may still land.
 */
export async function sendAndConfirm(conn: SendConn, raw: Uint8Array, span: BlockhashSpan, opts: SendOpts = {}): Promise<TransactionSignature> {
  const pollMs = opts.pollMs ?? 1500;
  const resendMs = opts.resendMs ?? 3000;
  const callMs = opts.callMs ?? CALL_MS;
  const giveUp = Date.now() + (opts.giveUpMs ?? GIVE_UP_MS);
  const { lastValidBlockHeight } = span;
  const signature = signatureOf(raw);
  const payer = feePayerOf(raw);
  let accepted = opts.skipPreflight ?? false, sent = 0, refused = 0, refusal: unknown;
  let lastSend = 0, expired = false, seen = false;
  /**
   * One copy, waited on for at most callMs. Its answer is noted whenever it comes: a slow preflight that refuses late
   * still counts, and one that is accepted late is what lets later copies skip preflight.
   */
  const send = async () => {
    sent++;
    const answer = conn.sendRawTransaction(raw, accepted ? { skipPreflight: true, maxRetries: 0 } : { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 })
      .then(() => { accepted = true; }, (e) => { if (definitive(e)) { refused++; refusal = e; } });
    // A timeout or transport failure leaves it unknown: the node may still have it, and the loop keeps tracking it.
    await within(answer, callMs).catch(() => {});
    lastSend = Date.now();
  };
  /** Every copy sent so far was refused and none was ever seen, so none was forwarded and nothing can land. */
  const refusedOutright = () => refused === sent && !seen;
  await send();
  if (refusedOutright()) throw refusal;
  /**
   * One status lookup, with the slot of the node that answered (its processed bank). Notes whether the signature was
   * ever seen; an error counts only once it is confirmed.
   */
  const look = async (history: boolean) => {
    const r = await within(conn.getSignatureStatuses([signature], { searchTransactionHistory: history }), callMs);
    const st = r.value[0];
    if (st) seen = true;
    if (settled(st) && st.err) throw new TxFailed(signature, JSON.stringify(st.err));
    return { st, slot: r.context.slot };
  };
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      // Once expired, the history is searched too: the node's cache of recent statuses can drop it before we know.
      if (settled((await look(expired)).st)) return signature;
      expired ||= (await within(conn.getBlockHeight("confirmed"), callMs)) > lastValidBlockHeight;
      if (expired && !seen) {
        const fin = await within(conn.getEpochInfo("finalized"), callMs);
        if ((fin.blockHeight ?? 0) > lastValidBlockHeight) {
          // One last look, as it may have landed between the calls.
          const again = await look(true);
          if (settled(again.st)) return signature;
          if (expiredFor(again, fin.absoluteSlot)) {
            // Telling a trader nothing was charged takes the finalized ledger's word too: a node on a minority fork can
            // find nothing for a trade that went through. An RPC error here (a node not yet rooted that far, say) is a
            // hiccup like any other, and the next poll asks again.
            const found = await inFinalizedHistory(conn, payer, signature, span, fin.absoluteSlot, (c) => within(c, callMs));
            if (found === "absent") throw new TxExpired(signature);
            // More history since the blockhash than is read, or a node without the older ledger: say it is unknown now.
            if (!found) throw new TxUnknown(signature);
            if (found.err) throw new TxFailed(signature, JSON.stringify(found.err));
            return signature;
          }
        }
      }
    } catch (e) {
      if (e instanceof TxFailed || e instanceof TxExpired || e instanceof TxUnknown) throw e;
      // An RPC hiccup or timeout says nothing about the transaction: keep watching it.
    }
    // A preflight that answered late with a refusal, and no other copy that may have got through.
    if (refusedOutright()) throw refusal;
    // Seen but never confirmed, or the RPC could not establish confirmation or expiry: say so rather than guess.
    if (Date.now() >= giveUp) throw new TxUnknown(signature);
    // Past the blockhash's last valid height a re-send can no longer land.
    if (!expired && Date.now() - lastSend >= resendMs) await send();
  }
}

/** Blocks a blockhash must still have left before a transaction is sent with it (about 25 seconds). */
const MIN_BLOCKS_LEFT = 60;

/** The current block height, retried a few times; null when the RPC cannot say. */
async function blockHeight(conn: Pick<Connection, "getBlockHeight">, callMs: number, tries = 3): Promise<number | null> {
  for (let i = 0; i < tries; i++) {
    try { return await within(conn.getBlockHeight("confirmed"), callMs); } catch { if (i < tries - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  return null;
}

/**
 * Wallet path for SDK-built transactions: put a fresh blockhash on each, sign with the SDK's extra signers (a new
 * mint keypair, say) and then the wallet, and send them one at a time, each confirmed before the next is sent. The
 * wallet signs them all at once; a later one whose blockhash has run low (because an earlier one was slow) gets a new
 * blockhash and is signed again on its own, rather than failing after the earlier ones already landed.
 */
export async function signAndSendAll(
  conn: SendConn & Pick<Connection, "getLatestBlockhashAndContext">,
  signAll: <T extends VersionedTransaction>(txs: T[]) => Promise<T[]>,
  txs: VersionedTransaction[],
  signers: Signer[][],
  opts: SendOpts = {},
): Promise<string[]> {
  const callMs = opts.callMs ?? CALL_MS;
  const prepare = async (batch: VersionedTransaction[], first: number) => {
    // The slot it is fetched at bounds where the transactions can land, for the search that proves one expired.
    const { context, value: { blockhash, lastValidBlockHeight } } = await within(conn.getLatestBlockhashAndContext("confirmed"), callMs);
    batch.forEach((tx, j) => {
      tx.message.recentBlockhash = blockhash;
      tx.signatures = tx.signatures.map(() => new Uint8Array(64));
      if (signers[first + j]?.length) tx.sign(signers[first + j]);
    });
    const signed = await signAll(batch);
    signed.forEach((tx, j) => { if (signers[first + j]?.length) { try { tx.sign(signers[first + j]); } catch { /* the wallet kept them */ } } });
    return { signed, span: { lastValidBlockHeight, minSlot: context.slot } };
  };
  let { signed, span } = await prepare(txs, 0);
  const sigs: string[] = [];
  for (let i = 0; i < signed.length; i++) {
    let tx = signed[i];
    if (i > 0) {
      const height = await blockHeight(conn, callMs);
      // An unknown height counts as running low: refresh rather than risk sending on an expired blockhash. The refresh
      // fetches a new blockhash, so if the RPC is still down it throws here, before anything more is sent.
      if (height == null || span.lastValidBlockHeight - height < MIN_BLOCKS_LEFT) {
        // Re-sign this one and the rest together: one more wallet prompt, only on this slow path.
        const again = await prepare(txs.slice(i), i);
        signed = [...signed.slice(0, i), ...again.signed];
        span = again.span;
        tx = signed[i];
      }
    }
    sigs.push(await sendAndConfirm(conn, tx.serialize(), span, opts));
  }
  return sigs;
}
