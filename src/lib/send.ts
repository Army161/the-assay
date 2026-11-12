// Sending transactions so that "confirmed" means confirmed. Used by the browser (wallet-signed trades and launches)
// and by the server (rewards). Mainnet drops transactions under load, so each one carries a priority fee, is checked
// by the RPC before it is sent (preflight), and is re-sent until it lands or its blockhash expires.
import { type Connection, type PublicKey, type Signer, type VersionedTransaction, type TransactionSignature } from "@solana/web3.js";
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

/**
 * Send a signed transaction and wait until it is confirmed. The first send runs preflight (a failing trade is refused
 * before it costs anything); after that the same bytes are re-sent every few seconds until the cluster confirms it,
 * reports an error, or the blockhash expires. Returns the signature only once it is confirmed without error.
 */
export async function sendAndConfirm(conn: SendConn, raw: Uint8Array, lastValidBlockHeight: number, opts: { pollMs?: number; resendMs?: number; skipPreflight?: boolean } = {}): Promise<TransactionSignature> {
  const pollMs = opts.pollMs ?? 1500;
  const resendMs = opts.resendMs ?? 3000;
  const signature = await conn.sendRawTransaction(raw, { skipPreflight: opts.skipPreflight ?? false, preflightCommitment: "confirmed", maxRetries: 0 });
  let lastSend = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
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
    if (Date.now() - lastSend >= resendMs) {
      await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      lastSend = Date.now();
    }
  }
}

/**
 * Wallet path for SDK-built transactions: put a fresh blockhash on each, sign with the SDK's extra signers (a new
 * mint keypair, say) and then the wallet, and send them one at a time, each confirmed before the next is sent.
 */
export async function signAndSendAll(
  conn: SendConn & Pick<Connection, "getLatestBlockhash">,
  signAll: <T extends VersionedTransaction>(txs: T[]) => Promise<T[]>,
  txs: VersionedTransaction[],
  signers: Signer[][],
): Promise<string[]> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  txs.forEach((tx, i) => {
    tx.message.recentBlockhash = blockhash;
    tx.signatures = tx.signatures.map(() => new Uint8Array(64));
    if (signers[i]?.length) tx.sign(signers[i]);
  });
  const signed = await signAll(txs);
  signed.forEach((tx, i) => { if (signers[i]?.length) { try { tx.sign(signers[i]); } catch { /* the wallet kept them */ } } });
  const sigs: string[] = [];
  for (const tx of signed) sigs.push(await sendAndConfirm(conn, tx.serialize(), lastValidBlockHeight));
  return sigs;
}
