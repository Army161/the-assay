import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { loadRaydium, BN, sdkTxVersion } from "../../src/lib/raydium";
import { cpmmPoolId } from "../../src/lib/rewards";
import { WSOL } from "../../src/lib/chain";
import { connection, loadKeypair, network } from "../_env";
(async () => {
  const admin = loadKeypair(); const conn = connection();
  const mint = new PublicKey("GXb1sJPzRf8qoTS5Ku67F5gZasQ1mKcQJ2js4a3YVZka");
  const ata = getAssociatedTokenAddressSync(mint, admin.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const bal = (await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  console.log("admin holds", bal.toString());
  const sdk = await loadRaydium(conn, admin, network);
  await sdk.account.fetchWalletTokenAccounts({ forceUpdate: true });
  const ids = cpmmPoolId(network, mint);
  const infos = await conn.getMultipleAccountsInfo(ids);
  const poolId = ids[infos.findIndex((x) => x)].toBase58();
  console.log("cpmm pool", poolId);
  try {
    const { poolInfo, poolKeys, computePoolInfo, rpcData } = await sdk.cpmm.getPoolInfoFromRpc(poolId);
    console.log("mintA", poolInfo.mintA.address, "mintB", poolInfo.mintB.address, "vaultA", rpcData.vaultAAmount?.toString(), "vaultB", rpcData.vaultBAmount?.toString());
    const baseIn = poolInfo.mintA.address === mint.toBase58();
    const amountIn = new BN(10_000_000_000_000); // 10M tokens
    const q = sdk.cpmm.computeSwapAmount({ pool: computePoolInfo, amountIn, outputMint: WSOL, slippage: 0.1, swapBaseIn: true });
    console.log("quote out", q.amountOut.toString(), "min", q.minAmountOut.toString(), "baseIn", baseIn);
    const { execute } = await sdk.cpmm.swap({ poolInfo, poolKeys, inputAmount: amountIn, swapResult: q.swapResult, baseIn, slippage: 0.1, txVersion: sdkTxVersion });
    const r = await execute({ sendAndConfirm: true });
    console.log("swap tx", r.txId);
  } catch (e) { console.log("ERR", e, (e as Error)?.stack); }
})();
