"use client";
// Browser-side transaction building. The wallet signs; nothing here ever sees a private key.
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { getPdaCreatorVault } from "@raydium-io/raydium-sdk-v2";
import { loadRaydium, ids, BN, sdkTxVersion, readPool, readGlobalConfig, quoteBuy, quoteSell, toLamports, toBase, type PoolState, type LaunchpadConfigInfo, mintProgramOf } from "@/lib/raydium";
import { FEES, LAUNCH, NETWORK, platformId, assertNetworkAllowed } from "@/lib/chain";

export interface Market { pool: PoolState; cfg: LaunchpadConfigInfo }

export async function loadMarket(connection: Connection, poolId: string): Promise<Market | null> {
  const [pool, cfg] = await Promise.all([readPool(connection, new PublicKey(poolId)), readGlobalConfig(connection, NETWORK)]);
  return pool ? { pool, cfg } : null;
}

export function quote(m: Market, side: "buy" | "sell", amount: number, decimals: number, referred: boolean) {
  const share = new BN(referred ? FEES.callerShareRate : 0);
  if (side === "buy") { const out = quoteBuy(m.pool, m.cfg, toLamports(amount), new BN(FEES.platformFeeRate), share); return Number(out.amount.toString()) / 10 ** decimals; }
  const out = quoteSell(m.pool, m.cfg, toBase(amount, decimals), new BN(FEES.platformFeeRate), share);
  return Number(out.toString()) / 1e9;
}

async function sdkFor(connection: Connection, wallet: WalletContextState) {
  assertNetworkAllowed();
  if (!wallet.publicKey || !wallet.signAllTransactions) throw new Error("Connect a wallet first");
  return loadRaydium(connection, wallet.publicKey, NETWORK, wallet.signAllTransactions);
}

export async function buy(connection: Connection, wallet: WalletContextState, p: { mint: string; token2022: boolean; sol: number; slippageBps: number; referrer: string | null }) {
  const sdk = await sdkFor(connection, wallet);
  const { execute } = await sdk.launchpad.buyToken({
    programId: ids().program, mintA: new PublicKey(p.mint), mintAProgram: p.token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    buyAmount: toLamports(p.sol), slippage: new BN(p.slippageBps),
    shareFeeRate: new BN(p.referrer ? FEES.callerShareRate : 0), shareFeeReceiver: p.referrer ? new PublicKey(p.referrer) : undefined,
    txVersion: sdkTxVersion,
  });
  return (await execute({ sendAndConfirm: true })).txId;
}

export async function sell(connection: Connection, wallet: WalletContextState, p: { mint: string; token2022: boolean; tokens: number; decimals: number; slippageBps: number; referrer: string | null }) {
  const sdk = await sdkFor(connection, wallet);
  await sdk.account.fetchWalletTokenAccounts({ forceUpdate: true });
  const { execute } = await sdk.launchpad.sellToken({
    programId: ids().program, mintA: new PublicKey(p.mint), mintAProgram: p.token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    sellAmount: toBase(p.tokens, p.decimals), slippage: new BN(p.slippageBps),
    shareFeeRate: new BN(p.referrer ? FEES.callerShareRate : 0), shareFeeReceiver: p.referrer ? new PublicKey(p.referrer) : undefined,
    txVersion: sdkTxVersion,
  });
  return (await execute({ sendAndConfirm: true })).txId;
}

export interface CreateParams { name: string; symbol: string; uri: string; holderRewardBps: number; initialBuySol: number }

/** Creates the coin through our platform. Returns the mint and the first signature. */
export async function create(connection: Connection, wallet: WalletContextState, p: CreateParams) {
  const sdk = await sdkFor(connection, wallet);
  const mint = Keypair.generate();
  const cfg = await readGlobalConfig(connection, NETWORK);
  const token2022 = p.holderRewardBps > 0;
  const { execute, extInfo } = await sdk.launchpad.createLaunchpad({
    programId: ids().program, platformId: platformId(), mintA: mint.publicKey, decimals: LAUNCH.decimals,
    name: p.name, symbol: p.symbol, uri: p.uri, migrateType: LAUNCH.migrateType, configId: ids().globalConfig, configInfo: cfg,
    supply: toBase(LAUNCH.supply), totalSellA: toBase(LAUNCH.totalSellA), totalFundRaisingB: toLamports(LAUNCH.totalFundRaisingSol),
    buyAmount: toLamports(Math.max(p.initialBuySol, 0)), createOnly: p.initialBuySol <= 0, slippage: new BN(1000),
    token2022, transferFeeExtensionParams: token2022 ? { transferFeeBasePoints: p.holderRewardBps, maxinumFee: toBase(LAUNCH.supply) } : undefined,
    extraSigners: [mint], txVersion: sdkTxVersion,
  });
  const r = await execute({ sequentially: true, sendAndConfirm: true });
  return { mint: mint.publicKey.toBase58(), poolId: extInfo.address.poolId.toBase58(), txIds: r.txIds };
}

/**
 * Creator fees from every coin a wallet launched build up in one LaunchLab vault per creator (in wrapped SOL).
 * Returns the unclaimed amount in lamports.
 */
export async function unclaimedCreatorFees(connection: Connection, creator: PublicKey): Promise<number> {
  const vault = getPdaCreatorVault(ids().program, creator, NATIVE_MINT).publicKey;
  const bal = await connection.getTokenAccountBalance(vault, "confirmed").catch(() => null);
  return Number(bal?.value.amount ?? 0);
}

/** The creator claims their fees to their own wallet. Only the creator's wallet can sign this. */
export async function claimCreatorFees(connection: Connection, wallet: WalletContextState) {
  const sdk = await sdkFor(connection, wallet);
  const { execute } = await sdk.launchpad.claimCreatorFee({ programId: ids().program, mintB: NATIVE_MINT, mintBProgram: TOKEN_PROGRAM_ID, txVersion: sdkTxVersion });
  return (await execute({ sendAndConfirm: true })).txId;
}

export const programOf = mintProgramOf;
