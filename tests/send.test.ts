import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, SendTransactionError } from "@solana/web3.js";
import { sendAndConfirm, signatureOf, TxExpired, TxFailed } from "../src/lib/send";
import bs58 from "bs58";

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
    const expired = { sendRawTransaction: async () => "x", getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 101 };
    await expect(sendAndConfirm(expired as never, tx.serialize(), 100, { pollMs: 1 })).rejects.toBeInstanceOf(TxExpired);
  });
});
