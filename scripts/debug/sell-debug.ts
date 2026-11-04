import { PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { loadRaydium, ids, BN, sdkTxVersion, toBase } from "../../src/lib/raydium";
import { connection, loadKeypair, network } from "../_env";
(async () => {
  const admin = loadKeypair(); const conn = connection();
  const sdk = await loadRaydium(conn, admin, network);
  const mint = new PublicKey("8F4HDRfVH1xRsKNdRFw2sNQTdXW9wZSAHFcrKfWdKJKt");
  for (const [variant, receiver] of [["none", undefined], ["fresh", Keypair.generate().publicKey], ["admin", admin.publicKey]] as const) {
    try {
      const r = await sdk.launchpad.sellToken({ programId: ids(network).program, mintA: mint, mintAProgram: TOKEN_2022_PROGRAM_ID, sellAmount: toBase(1000), slippage: new BN(300), shareFeeRate: receiver ? new BN(5000) : undefined, shareFeeReceiver: receiver, txVersion: sdkTxVersion });
      console.log(variant, "built ok", r.extInfo.outAmount.toString());
    } catch (e) { console.log(variant, "ERR", (e as Error).message); }
    try {
      const r = await sdk.launchpad.sellToken({ programId: ids(network).program, mintA: mint, mintAProgram: TOKEN_2022_PROGRAM_ID, sellAmount: toBase(1000), slippage: new BN(300), shareFeeRate: receiver ? new BN(5000) : undefined, shareFeeReceiver: receiver, txVersion: sdkTxVersion });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ins = (r as any).builder.allInstructions as any[];
      for (const i of ins) console.log(" ", i.programId.toBase58(), JSON.stringify(i.keys.map((k: { pubkey?: { toBase58?: () => string } }) => k.pubkey?.toBase58?.() ?? String(k.pubkey))));
    } catch (e) { console.log(variant, "ERR2", (e as Error).message); }
  }
})();
