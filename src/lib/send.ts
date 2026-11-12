// Sending transactions so that "confirmed" means confirmed. Used by the browser (wallet-signed trades and launches)
// and by the server (rewards). Mainnet drops transactions under load, so each one carries a priority fee, is checked
// by the RPC before it is sent (preflight), and is re-sent until it lands or its blockhash expires.
import { SendTransactionError, type Connection, type PublicKey, type Signer, type VersionedTransaction, type TransactionSignature } from "@solana/web3.js";
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

type SendConn = Pick<Connection, "sendRawTransaction" | "getSignatureStatuses" | "getBlockHeight">;

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
 * Send a signed transaction and wait until it is confirmed. The first send runs preflight (a failing trade is refused
 * before it costs anything); after that the same bytes are re-sent every few seconds until the cluster confirms it,
 * reports an error, or the blockhash expires. Returns the signature only once it is confirmed without error.
 *
 * The signature is read from the bytes, not from the RPC's answer, so a dropped response or a failed status call never
 * loses track of a transaction that may have landed: only a definitive refusal, an on-chain error or expiry ends it.
 */
export async function sendAndConfirm(conn: SendConn, raw: Uint8Array, lastValidBlockHeight: number, opts: { pollMs?: number; resendMs?: number; skipPreflight?: boolean } = {}): Promise<TransactionSignature> {
  const pollMs = opts.pollMs ?? 1500;
  const resendMs = opts.resendMs ?? 3000;
  const signature = signatureOf(raw);
  try {
    await conn.sendRawTransaction(raw, { skipPreflight: opts.skipPreflight ?? false, preflightCommitment: "confirmed", maxRetries: 0 });
  } catch (e) {
    if (definitive(e)) throw e;
    // Transport failure: the node may still have it. Keep tracking the same signature; the re-send loop covers a miss.
  }
  let lastSend = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: false })).value[0];
      if (st?.err) throw new TxFailed(signature, JSON.stringify(st.err));
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return signature;
      if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
        // One last look: it may have landed between the two calls.
        const again = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
        if (again?.err) throw new TxFailed(signature, JSON.stringify(again.err));
        if (again && again.confirmationStatus !== "processed") return signature;
        throw new TxExpired(signature);
      }
    } catch (e) {
      if (e instanceof TxFailed || e instanceof TxExpired) throw e;
      // An RPC hiccup says nothing about the transaction: keep watching it.
    }
    if (Date.now() - lastSend >= resendMs) {
      await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      lastSend = Date.now();
    }
  }
}

/** Blocks a blockhash must still have left before a transaction is sent with it (about 25 seconds). */
const MIN_BLOCKS_LEFT = 60;

/** The current block height, retried a few times; null when the RPC cannot say. */
async function blockHeight(conn: Pick<Connection, "getBlockHeight">, tries = 3): Promise<number | null> {
  for (let i = 0; i < tries; i++) {
    try { return await conn.getBlockHeight("confirmed"); } catch { if (i < tries - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
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
  conn: SendConn & Pick<Connection, "getLatestBlockhash">,
  signAll: <T extends VersionedTransaction>(txs: T[]) => Promise<T[]>,
  txs: VersionedTransaction[],
  signers: Signer[][],
): Promise<string[]> {
  const prepare = async (batch: VersionedTransaction[], first: number) => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    batch.forEach((tx, j) => {
      tx.message.recentBlockhash = blockhash;
      tx.signatures = tx.signatures.map(() => new Uint8Array(64));
      if (signers[first + j]?.length) tx.sign(signers[first + j]);
    });
    const signed = await signAll(batch);
    signed.forEach((tx, j) => { if (signers[first + j]?.length) { try { tx.sign(signers[first + j]); } catch { /* the wallet kept them */ } } });
    return { signed, lastValidBlockHeight };
  };
  let { signed, lastValidBlockHeight } = await prepare(txs, 0);
  const sigs: string[] = [];
  for (let i = 0; i < signed.length; i++) {
    let tx = signed[i];
    let valid = lastValidBlockHeight;
    if (i > 0) {
      const height = await blockHeight(conn);
      // An unknown height counts as running low: refresh rather than risk sending on an expired blockhash. The refresh
      // fetches a new blockhash, so if the RPC is still down it throws here, before anything more is sent.
      if (height == null || valid - height < MIN_BLOCKS_LEFT) {
        // Re-sign this one and the rest together: one more wallet prompt, only on this slow path.
        const again = await prepare(txs.slice(i), i);
        signed = [...signed.slice(0, i), ...again.signed];
        lastValidBlockHeight = valid = again.lastValidBlockHeight;
        tx = signed[i];
      }
    }
    sigs.push(await sendAndConfirm(conn, tx.serialize(), valid));
  }
  return sigs;
}
