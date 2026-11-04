// End-to-end devnet run: create a Token-2022 coin with a 1% holder-reward transfer fee through our platform,
// buy with a referred trader (caller share fee), sell, then fill the curve and watch the pool flip to "graduating".
// Every step is checked against on-chain state. Prints a JSON summary that the test suite and the README quote.
//
//   ADMIN_KEYPAIR=... npx tsx scripts/e2e-devnet.ts
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_2022_PROGRAM_ID, getTransferFeeAmount, unpackAccount, NATIVE_MINT, getMint, getTransferFeeConfig } from "@solana/spl-token";
import { getPdaPlatformVault, getPdaCreatorVault } from "@raydium-io/raydium-sdk-v2";
import { loadRaydium, ids, BN, sdkTxVersion, readPool, readGlobalConfig, poolIdFor, toLamports, toBase, fromLamports, fromBase, poolStatus, curvePriceSol, bondingProgress } from "../src/lib/raydium";
import { FEES, LAUNCH, WSOL, platformId } from "../src/lib/chain";
import { connection, loadKeypair, network, log, sleep } from "./_env";

const SOL = LAMPORTS_PER_SOL;

async function fund(conn: ReturnType<typeof connection>, from: Keypair, to: PublicKey, sol: number) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Math.round(sol * SOL) }));
  return sendAndConfirmTransaction(conn, tx, [from], { commitment: "confirmed" });
}

async function main() {
  const admin = loadKeypair();
  const conn = connection();
  const { program } = ids(network);
  const platform = platformId(network);
  const out: Record<string, unknown> = { network, platform: platform.toBase58() };

  // Actors: creator = admin (already funded), trader + caller = fresh keypairs funded from admin.
  const trader = Keypair.generate();
  const caller = Keypair.generate();
  log("funding trader and caller");
  await fund(conn, admin, trader.publicKey, 0.9);
  await fund(conn, admin, caller.publicKey, 0.02);

  // 1. Create the coin (Token-2022, 1% transfer fee to holders) with a small creator buy.
  const mint = Keypair.generate();
  const cfg = await readGlobalConfig(conn, network);
  const creatorSdk = await loadRaydium(conn, admin, network);
  const holderRewardBps = 100;
  const { execute: createExec, extInfo } = await creatorSdk.launchpad.createLaunchpad({
    programId: program,
    platformId: platform,
    mintA: mint.publicKey,
    decimals: LAUNCH.decimals,
    name: "Assay Test Coin",
    symbol: "ASSAY",
    uri: "https://the-assay.vercel.app/meta/assay-test.json",
    migrateType: LAUNCH.migrateType,
    configId: ids(network).globalConfig,
    configInfo: cfg,
    supply: toBase(LAUNCH.supply),
    totalSellA: toBase(LAUNCH.totalSellA),
    totalFundRaisingB: toLamports(LAUNCH.totalFundRaisingSol),
    buyAmount: toLamports(0.05),
    slippage: new BN(500), // 5%
    token2022: true,
    transferFeeExtensionParams: { transferFeeBasePoints: holderRewardBps, maxinumFee: toBase(LAUNCH.supply) },
    extraSigners: [mint],
    txVersion: sdkTxVersion,
  });
  const created = await createExec({ sequentially: true, sendAndConfirm: true });
  log("created coin", mint.publicKey.toBase58(), "pool", extInfo.address.poolId.toBase58(), "txs", created.txIds);
  out.mint = mint.publicKey.toBase58(); out.poolId = extInfo.address.poolId.toBase58(); out.createTxs = created.txIds;
  if (!poolIdFor(mint.publicKey, network).equals(extInfo.address.poolId)) throw new Error("pool id derivation mismatch");

  let pool = (await readPool(conn, extInfo.address.poolId))!;
  if (!pool.platformId.equals(platform)) throw new Error("pool not attached to our platform");
  if (pool.mintProgramFlag !== 1) throw new Error("expected a Token-2022 mint");
  const mintInfo = await getMint(conn, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  const tf = getTransferFeeConfig(mintInfo);
  if (!tf || tf.newerTransferFee.transferFeeBasisPoints !== holderRewardBps) throw new Error("transfer fee not set");
  log("transfer fee bps", tf.newerTransferFee.transferFeeBasisPoints, "withdraw authority", tf.withdrawWithheldAuthority.toBase58());
  out.transferFeeBps = tf.newerTransferFee.transferFeeBasisPoints;
  out.withdrawWithheldAuthority = tf.withdrawWithheldAuthority.toBase58();
  log("after create: realB", fromLamports(pool.realB), "SOL, progress", bondingProgress(pool).toFixed(4), "price", curvePriceSol(pool));

  // 2. Referred buy: trader buys 0.3 SOL through caller's link (share fee 0.5% to caller).
  const traderSdk = await loadRaydium(conn, trader, network);
  const platformVault = getPdaPlatformVault(program, platform, WSOL).publicKey;
  const creatorVault = getPdaCreatorVault(program, admin.publicKey, WSOL).publicKey;
  const bal = async (k: PublicKey) => (await conn.getBalance(k, "confirmed"));
  const pv0 = await bal(platformVault), cv0 = await bal(creatorVault);
  const callerAta = getAssociatedTokenAddressSync(NATIVE_MINT, caller.publicKey);
  const buySol = 0.3;
  const { execute: buyExec, extInfo: buyInfo } = await traderSdk.launchpad.buyToken({
    programId: program,
    mintA: mint.publicKey,
    mintAProgram: TOKEN_2022_PROGRAM_ID,
    buyAmount: toLamports(buySol),
    slippage: new BN(300),
    shareFeeRate: new BN(FEES.callerShareRate),
    shareFeeReceiver: caller.publicKey,
    txVersion: sdkTxVersion,
  });
  const buy = await buyExec({ sendAndConfirm: true });
  log("trader bought", fromBase(buyInfo.amountA.amount, LAUNCH.decimals), "tokens for", buySol, "SOL, tx", buy.txId);
  out.buyTx = buy.txId;
  await sleep(1500);
  const pv1 = await bal(platformVault), cv1 = await bal(creatorVault);
  const callerWsol = await getAccount(conn, callerAta, "confirmed").then((a) => Number(a.amount)).catch(() => 0);
  const expectPlatform = Math.round(buySol * SOL * FEES.platformFeeRate / FEES.RATE_DENOMINATOR);
  const expectCreator = Math.round(buySol * SOL * FEES.creatorFeeRate / FEES.RATE_DENOMINATOR);
  const expectCaller = Math.round(buySol * SOL * FEES.callerShareRate / FEES.RATE_DENOMINATOR);
  log("fees on the buy: platform", pv1 - pv0, "(expect", expectPlatform, ") creator", cv1 - cv0, "(expect", expectCreator, ") caller WSOL", callerWsol, "(expect", expectCaller, ")");
  if (pv1 - pv0 !== expectPlatform) throw new Error("platform fee mismatch");
  if (cv1 - cv0 !== expectCreator) throw new Error("creator fee mismatch");
  if (callerWsol !== expectCaller) throw new Error("caller share mismatch");
  out.fees = { platformLamports: pv1 - pv0, creatorLamports: cv1 - cv0, callerLamports: callerWsol };

  // Transfer-fee check: the trader's token account carries withheld tokens (1% of what the pool sent).
  const traderAta = getAssociatedTokenAddressSync(mint.publicKey, trader.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const traderAcc = unpackAccount(traderAta, await conn.getAccountInfo(traderAta, "confirmed"), TOKEN_2022_PROGRAM_ID);
  const withheld = getTransferFeeAmount(traderAcc)?.withheldAmount ?? 0n;
  log("trader holds", fromBase(traderAcc.amount, LAUNCH.decimals), "withheld for holders", fromBase(withheld, LAUNCH.decimals));
  if (withheld <= 0n) throw new Error("no withheld transfer fee");
  out.withheldAfterBuy = withheld.toString();

  // 3. Trader sells half. The SDK caches the wallet's token accounts at load, so refresh them first
  // (the trader had none before the buy). The app does the same before every sell.
  await traderSdk.account.fetchWalletTokenAccounts({ forceUpdate: true });
  const sellAmount = new BN((traderAcc.amount / 2n).toString());
  const { execute: sellExec, extInfo: sellInfo } = await traderSdk.launchpad.sellToken({
    programId: program,
    mintA: mint.publicKey,
    mintAProgram: TOKEN_2022_PROGRAM_ID,
    sellAmount,
    slippage: new BN(300),
    shareFeeRate: new BN(FEES.callerShareRate),
    shareFeeReceiver: caller.publicKey,
    txVersion: sdkTxVersion,
  });
  const sell = await sellExec({ sendAndConfirm: true });
  log("trader sold", fromBase(sellAmount, LAUNCH.decimals), "tokens for", fromLamports(sellInfo.outAmount), "SOL, tx", sell.txId);
  out.sellTx = sell.txId;

  // 4. Fill the curve: admin buys the remainder (+ margin) so the pool reaches its fund target.
  pool = (await readPool(conn, extInfo.address.poolId))!;
  const remaining = fromLamports(pool.totalFundRaisingB.sub(pool.realB));
  log("remaining to target", remaining, "SOL");
  const { execute: fillExec } = await creatorSdk.launchpad.buyToken({
    programId: program,
    mintA: mint.publicKey,
    mintAProgram: TOKEN_2022_PROGRAM_ID,
    buyAmount: toLamports(remaining * 1.08 + 0.01),
    slippage: new BN(1000),
    txVersion: sdkTxVersion,
  });
  const fill = await fillExec({ sendAndConfirm: true });
  log("fill tx", fill.txId);
  out.fillTx = fill.txId;
  await sleep(1500);
  pool = (await readPool(conn, extInfo.address.poolId))!;
  log("pool status", pool.status, poolStatus(pool.status), "realB", fromLamports(pool.realB), "target", fromLamports(pool.totalFundRaisingB), "progress", bondingProgress(pool));
  out.statusAfterFill = { code: pool.status, label: poolStatus(pool.status), progress: bondingProgress(pool) };
  if (pool.status === 0) throw new Error("curve did not complete");

  // 5. Watch for Raydium's migration crank for up to 90 s (status 2 = trading on the CPMM pool).
  for (let i = 0; i < 18 && pool.status !== 2; i++) { await sleep(5000); pool = (await readPool(conn, extInfo.address.poolId))!; }
  log("final status", pool.status, poolStatus(pool.status));
  out.finalStatus = { code: pool.status, label: poolStatus(pool.status) };

  // 6. Creator claims the accumulated creator fee.
  const { execute: claimExec } = await creatorSdk.launchpad.claimCreatorFee({ programId: program, mintB: WSOL, txVersion: sdkTxVersion });
  const claim = await claimExec({ sendAndConfirm: true });
  log("creator fee claimed, tx", claim.txId, "vault now", await bal(creatorVault));
  out.claimCreatorTx = claim.txId;

  out.ok = true;
  console.log("\nE2E_RESULT " + JSON.stringify(out));
}

main().catch((e) => { console.error(e); process.exit(1); });
