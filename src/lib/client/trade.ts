"use client";
// Browser-side transaction building. The wallet signs; nothing here ever sees a private key.
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { getPdaCreatorVault } from "@raydium-io/raydium-sdk-v2";
import { loadRaydium, ids, BN, sdkTxVersion, poolIdFor, readPool, readGlobalConfig, quoteBuy, quoteSell, toLamports, toBase, type PoolState, type LaunchpadConfigInfo, mintProgramOf } from "@/lib/raydium";
import { FEES, LAUNCH, NETWORK, platformId, assertNetworkAllowed, isTokenAccount } from "@/lib/chain";
import { computeBudget, signAndSendAll, UNITS } from "@/lib/send";
import { TransactionMessage, VersionedTransaction, type Signer } from "@solana/web3.js";

export interface Market { pool: PoolState; cfg: LaunchpadConfigInfo }

export async function loadMarket(connection: Connection, poolId: string): Promise<Market | null> {
  const [pool, cfg] = await Promise.all([readPool(connection, new PublicKey(poolId)), readGlobalConfig(connection, NETWORK)]);
  return pool ? { pool, cfg } : null;
}

/**
 * Expected output of a trade. On a holder-reward coin the token's own transfer fee (`transferFeeBps`) is taken from
 * the tokens as they move: from what a buyer receives, and from what a seller sends to the curve before it is priced.
 */
export function quote(m: Market, side: "buy" | "sell", amount: number, decimals: number, referred: boolean, transferFeeBps = 0) {
  const share = new BN(referred ? FEES.callerShareRate : 0);
  const keep = 1 - transferFeeBps / 10_000;
  if (side === "buy") { const out = quoteBuy(m.pool, m.cfg, toLamports(amount), new BN(FEES.platformFeeRate), share); return (Number(out.amount.toString()) * keep) / 10 ** decimals; }
  const out = quoteSell(m.pool, m.cfg, toBase(amount * keep, decimals), new BN(FEES.platformFeeRate), share);
  return Number(out.toString()) / 1e9;
}

/** What an SDK builder hands back: one transaction or several, with the extra signers each needs. */
type Built = { transaction?: VersionedTransaction; transactions?: VersionedTransaction[]; signers: Signer[] | Signer[][] };

/** Sign with the wallet and send, returning only once every transaction is confirmed without error. */
async function send(connection: Connection, wallet: WalletContextState, built: Built): Promise<string[]> {
  if (!wallet.signAllTransactions) throw new Error("This wallet cannot sign transactions");
  const txs = built.transactions ?? (built.transaction ? [built.transaction] : []);
  const signers = built.transactions ? (built.signers as Signer[][]) : [built.signers as Signer[]];
  return signAndSendAll(connection, wallet.signAllTransactions, txs, signers);
}

async function sdkFor(connection: Connection, wallet: WalletContextState) {
  assertNetworkAllowed();
  if (!wallet.publicKey || !wallet.signAllTransactions) throw new Error("Connect a wallet first");
  return loadRaydium(connection, wallet.publicKey, NETWORK, wallet.signAllTransactions);
}

export async function buy(connection: Connection, wallet: WalletContextState, p: { mint: string; token2022: boolean; sol: number; slippageBps: number; referrer: string | null }) {
  const sdk = await sdkFor(connection, wallet);
  const built = await sdk.launchpad.buyToken({
    programId: ids().program, mintA: new PublicKey(p.mint), mintAProgram: p.token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    buyAmount: toLamports(p.sol), slippage: new BN(p.slippageBps),
    shareFeeRate: new BN(p.referrer ? FEES.callerShareRate : 0), shareFeeReceiver: p.referrer ? new PublicKey(p.referrer) : undefined,
    computeBudgetConfig: await computeBudget(connection, NETWORK, [poolIdFor(new PublicKey(p.mint))], UNITS.trade),
    txVersion: sdkTxVersion,
  });
  return (await send(connection, wallet, built))[0];
}

/** `raw`, when given, is the exact amount in base units (a percentage of the balance), so 100% sells exactly what is held. */
export async function sell(connection: Connection, wallet: WalletContextState, p: { mint: string; token2022: boolean; tokens: number; decimals: number; slippageBps: number; referrer: string | null; raw?: bigint }) {
  const sdk = await sdkFor(connection, wallet);
  await sdk.account.fetchWalletTokenAccounts({ forceUpdate: true });
  const built = await sdk.launchpad.sellToken({
    programId: ids().program, mintA: new PublicKey(p.mint), mintAProgram: p.token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    sellAmount: p.raw != null ? new BN(p.raw.toString()) : toBase(p.tokens, p.decimals), slippage: new BN(p.slippageBps),
    shareFeeRate: new BN(p.referrer ? FEES.callerShareRate : 0), shareFeeReceiver: p.referrer ? new PublicKey(p.referrer) : undefined,
    computeBudgetConfig: await computeBudget(connection, NETWORK, [poolIdFor(new PublicKey(p.mint))], UNITS.trade),
    txVersion: sdkTxVersion,
  });
  return (await send(connection, wallet, built))[0];
}

export interface CreateParams { name: string; symbol: string; uri: string; holderRewardBps: number; initialBuySol: number }

/** Creates the coin through our platform. Returns the mint and the first signature. */
export async function create(connection: Connection, wallet: WalletContextState, p: CreateParams) {
  const sdk = await sdkFor(connection, wallet);
  const mint = Keypair.generate();
  const cfg = await readGlobalConfig(connection, NETWORK);
  const token2022 = p.holderRewardBps > 0;
  const built = await sdk.launchpad.createLaunchpad({
    programId: ids().program, platformId: platformId(), mintA: mint.publicKey, decimals: LAUNCH.decimals,
    name: p.name, symbol: p.symbol, uri: p.uri, migrateType: LAUNCH.migrateType, configId: ids().globalConfig, configInfo: cfg,
    supply: toBase(LAUNCH.supply), totalSellA: toBase(LAUNCH.totalSellA), totalFundRaisingB: toLamports(LAUNCH.totalFundRaisingSol),
    buyAmount: toLamports(Math.max(p.initialBuySol, 0)), createOnly: p.initialBuySol <= 0, slippage: new BN(1000),
    token2022, transferFeeExtensionParams: token2022 ? { transferFeeBasePoints: p.holderRewardBps, maxinumFee: toBase(LAUNCH.supply) } : undefined,
    extraSigners: [mint], txVersion: sdkTxVersion,
    computeBudgetConfig: await computeBudget(connection, NETWORK, [ids().globalConfig, platformId()], UNITS.create),
  });
  const txIds = await send(connection, wallet, built as unknown as Built);
  return { mint: mint.publicKey.toBase58(), poolId: built.extInfo.address.poolId.toBase58(), txIds };
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
  const built = await sdk.launchpad.claimCreatorFee({
    programId: ids().program, mintB: NATIVE_MINT, mintBProgram: TOKEN_PROGRAM_ID, txVersion: sdkTxVersion,
    computeBudgetConfig: await computeBudget(connection, NETWORK, [wallet.publicKey!], UNITS.claim),
  });
  return (await send(connection, wallet, built as unknown as Built))[0];
}

/**
 * A caller's share is paid in wrapped SOL to the caller's WSOL account. If that account does not exist, the trade
 * would open it at the trader's expense (about 0.002 SOL), so trades only carry a share once the caller has it.
 * Only a token account counts: SOL sent to the address of a closed one leaves a system-owned account that the trade
 * would take over, again at the trader's expense (see isTokenAccount).
 * A failed lookup rejects instead of answering false, so an RPC hiccup is never taken for a closed account.
 */
export async function callerCanBePaid(connection: Connection, caller: string): Promise<boolean> {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(caller));
  return isTokenAccount(await connection.getAccountInfo(ata, "confirmed"));
}

/**
 * The caller who goes on a trade being sent now. Checked again at send time, as the last check can be 30 s old (longer
 * in a background tab): a closed or unreadable caller account means no share on this trade, which only leaves the
 * trader more than quoted. `closed` says the account is known to be gone, so the panel stops showing the caller.
 */
export async function referrerAtSend(connection: Connection, referrer: string | null): Promise<{ ref: string | null; closed: boolean }> {
  if (!referrer) return { ref: null, closed: false };
  const payable = await callerCanBePaid(connection, referrer).catch(() => null);
  return { ref: payable ? referrer : null, closed: payable === false };
}

/**
 * Checks the caller's WSOL account now and again `everyMs` after each check, until stopped: a caller who activates
 * starts earning without a reload, and one who closes it (unwrapping their WSOL does) stops being paid, so no trade
 * pays to reopen it. A failed check reports nothing and is retried. Returns the function that stops it.
 */
export function watchCallerPayouts(connection: Connection, caller: string, onAnswer: (payable: boolean) => void, everyMs = 30_000): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    void callerCanBePaid(connection, caller)
      .then((ok) => { if (alive) onAnswer(ok); }, () => { /* unknown: keep the last answer */ })
      .finally(() => { if (alive) timer = setTimeout(check, everyMs); });
  };
  check();
  return () => { alive = false; if (timer) clearTimeout(timer); };
}

/** The caller opens their own WSOL account once (about 0.002 SOL of rent, theirs to keep), so trades can pay them. */
export async function activateCallerPayouts(connection: Connection, wallet: WalletContextState) {
  assertNetworkAllowed();
  if (!wallet.publicKey) throw new Error("Connect a wallet first");
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, wallet.publicKey, NATIVE_MINT)],
  }).compileToV0Message();
  return (await send(connection, wallet, { transaction: new VersionedTransaction(msg), signers: [] }))[0];
}

export const programOf = mintProgramOf;
