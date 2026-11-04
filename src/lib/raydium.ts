// Thin wrapper around the Raydium SDK for LaunchLab. Works in the browser (wallet signs) and on the server (scripts).
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import BN from "bn.js";
import {
  Raydium,
  TxVersion,
  LaunchpadPool,
  LaunchpadConfig,
  PlatformConfig,
  getPdaLaunchpadPoolId,
  getPdaLaunchpadAuth,
  type LaunchpadPoolInfo,
  type LaunchpadConfigInfo,
  Curve,
} from "@raydium-io/raydium-sdk-v2";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { LAUNCHLAB, NETWORK, FEES, LAUNCH, WSOL, platformId, type Network } from "./chain";

export { TxVersion, LaunchpadPool, LaunchpadConfig, PlatformConfig, BN };
export type { LaunchpadPoolInfo, LaunchpadConfigInfo };
export type PlatformConfigInfo = ReturnType<typeof PlatformConfig.decode>;

export const ids = (network: Network = NETWORK) => LAUNCHLAB[network];

const LAMPORTS = 1_000_000_000;
export const toLamports = (sol: number) => new BN(Math.round(sol * LAMPORTS));
export const fromLamports = (bn: BN | bigint | number) => Number(bn.toString()) / LAMPORTS;
export const toBase = (tokens: number, decimals: number = LAUNCH.decimals) => new BN(Math.round(tokens * 10 ** decimals));
export const fromBase = (bn: BN | bigint | number, decimals: number = LAUNCH.decimals) => Number(bn.toString()) / 10 ** decimals;

/**
 * Load an SDK instance. `owner` is a PublicKey in the browser (the wallet signs) or a Keypair in scripts.
 * We never let the SDK call Raydium's hosted API for pool data on devnet; everything is read from RPC.
 */
export async function loadRaydium(
  connection: Connection,
  owner: PublicKey | Keypair,
  network: Network = NETWORK,
  signAllTransactions?: Parameters<typeof Raydium.load>[0]["signAllTransactions"],
) {
  return Raydium.load({
    connection,
    owner,
    cluster: network === "mainnet" ? "mainnet" : "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
    signAllTransactions,
  });
}

/** Deterministic pool id for a coin mint quoted in WSOL on our network. */
export function poolIdFor(mintA: PublicKey, network: Network = NETWORK) {
  return getPdaLaunchpadPoolId(ids(network).program, mintA, WSOL).publicKey;
}

export function launchpadAuth(network: Network = NETWORK) {
  return getPdaLaunchpadAuth(ids(network).program).publicKey;
}

export type PoolState = ReturnType<typeof LaunchpadPool.decode>;

/** Read one pool straight from RPC (no Raydium API). */
export async function readPool(connection: Connection, poolId: PublicKey): Promise<PoolState | null> {
  const acc = await connection.getAccountInfo(poolId, "confirmed");
  if (!acc) return null;
  return LaunchpadPool.decode(acc.data);
}

/** All pools launched through our platform, straight from RPC. */
export async function readPlatformPools(connection: Connection, network: Network = NETWORK) {
  const platform = platformId(network);
  const offset = LaunchpadPool.offsetOf("platformId");
  const accs = await connection.getProgramAccounts(ids(network).program, {
    commitment: "confirmed",
    filters: [{ dataSize: LaunchpadPool.span }, { memcmp: { offset, bytes: platform.toBase58() } }],
  });
  return accs.map((a) => ({ poolId: a.pubkey, state: LaunchpadPool.decode(a.account.data) }));
}

export async function readGlobalConfig(connection: Connection, network: Network = NETWORK) {
  const acc = await connection.getAccountInfo(ids(network).globalConfig, "confirmed");
  if (!acc) throw new Error("LaunchLab global config not found");
  return LaunchpadConfig.decode(acc.data);
}

export async function readPlatformConfig(connection: Connection, network: Network = NETWORK) {
  const acc = await connection.getAccountInfo(platformId(network), "confirmed");
  if (!acc) return null;
  return PlatformConfig.decode(acc.data);
}

/**
 * Pool status as LaunchLab stores it (program enum PoolStatus): 0 Fund = live on the curve,
 * 1 Migrate = curve complete, waiting for Raydium's migration crank, 2 Trade = migrated to the AMM pool.
 * We call 1 "graduating" and 2 "graduated"; both count as a completed curve.
 */
export const POOL_STATUS = { 0: "live", 1: "graduating", 2: "graduated" } as const;
export const curveComplete = (s: number) => s === 1 || s === 2;
export type PoolStatus = (typeof POOL_STATUS)[keyof typeof POOL_STATUS] | "unknown";
export const poolStatus = (s: number): PoolStatus => (POOL_STATUS as Record<number, PoolStatus>)[s] ?? "unknown";

/** Price in SOL per whole token from the virtual reserves (constant product curve). */
export function curvePriceSol(p: PoolState) {
  const a = Number(p.virtualA.add(p.realA).toString()) / 10 ** p.mintDecimalsA;
  const b = Number(p.virtualB.add(p.realB).toString()) / 10 ** p.mintDecimalsB;
  // On a constant-product curve virtual reserves hold the price. LaunchLab's curve: price = (virtualB + realB) / (virtualA - realA).
  const aOut = Number(p.virtualA.sub(p.realA).toString()) / 10 ** p.mintDecimalsA;
  return aOut > 0 ? b / aOut : a > 0 ? b / a : 0;
}

export function bondingProgress(p: PoolState) {
  const target = Number(p.totalFundRaisingB.toString());
  const raised = Number(p.realB.toString());
  return target > 0 ? Math.min(1, raised / target) : 0;
}

export function marketCapSol(p: PoolState) {
  return curvePriceSol(p) * (Number(p.supply.toString()) / 10 ** p.mintDecimalsA);
}

/** Quote a buy of `solIn` lamports: tokens out before slippage. */
export function quoteBuy(p: PoolState, cfg: LaunchpadConfigInfo, solIn: BN, platformFeeRate = new BN(FEES.platformFeeRate), shareFeeRate = new BN(0)) {
  const r = Curve.buyExactIn({
    poolInfo: p as unknown as LaunchpadPoolInfo,
    amountB: solIn,
    protocolFeeRate: cfg.tradeFeeRate,
    platformFeeRate,
    curveType: cfg.curveType,
    shareFeeRate,
    creatorFeeRate: new BN(FEES.creatorFeeRate),
    transferFeeConfigA: undefined,
    slot: 0,
  });
  return r.amountA;
}

export function quoteSell(p: PoolState, cfg: LaunchpadConfigInfo, tokensIn: BN, platformFeeRate = new BN(FEES.platformFeeRate), shareFeeRate = new BN(0)) {
  const r = Curve.sellExactIn({
    poolInfo: p as unknown as LaunchpadPoolInfo,
    amountA: tokensIn,
    protocolFeeRate: cfg.tradeFeeRate,
    platformFeeRate,
    curveType: cfg.curveType,
    shareFeeRate,
    creatorFeeRate: new BN(FEES.creatorFeeRate),
    transferFeeConfigA: undefined,
    slot: 0,
  });
  return r.amountB;
}

export const mintProgramOf = (flag: number) => (flag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);

export const sdkTxVersion = TxVersion.V0;
