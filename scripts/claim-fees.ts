// Claim The Assay's platform trading fees (SOL) from the LaunchLab platform fee vault to the platform's claim wallet.
// Fees from every coin on the platform build up in one vault per quote mint (WSOL); one transaction claims them all.
//
//   NEXT_PUBLIC_NETWORK=mainnet NEXT_PUBLIC_PLATFORM_ID_MAINNET=… CLAIM_KEYPAIR=/path/to/fee-wallet.json npx tsx scripts/claim-fees.ts
//
// CLAIM_KEYPAIR is the platform's claim fee wallet (the admin wallet unless PLATFORM_FEE_WALLET was set at creation);
// it defaults to ADMIN_KEYPAIR. DRY_RUN=1 only shows the balance.
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createCloseAccountInstruction } from "@solana/spl-token";
import { getPdaPlatformVault } from "@raydium-io/raydium-sdk-v2";
import { loadRaydium, ids, sdkTxVersion, PlatformConfig } from "../src/lib/raydium";
import { platformId, isTokenAccount } from "../src/lib/chain";
import { connection, loadKeypair, network, log } from "./_env";
import { claimPlan } from "./_claim";

async function main() {
  const PLATFORM_ID = platformId(network);
  const wallet = loadKeypair(process.env.CLAIM_KEYPAIR || undefined);
  const conn = connection();
  const { program } = ids(network);
  const info = await conn.getAccountInfo(PLATFORM_ID, "confirmed");
  if (!info) throw new Error(`platform ${PLATFORM_ID.toBase58()} not found on ${network}`);
  const platform = PlatformConfig.decode(info.data);
  if (!platform.platformClaimFeeWallet.equals(wallet.publicKey)) {
    throw new Error(`this key is ${wallet.publicKey.toBase58()}, but the platform pays fees to ${platform.platformClaimFeeWallet.toBase58()}`);
  }
  const vault = getPdaPlatformVault(program, PLATFORM_ID, NATIVE_MINT).publicKey;
  // No vault account yet means nothing was ever traded; any other failure is an RPC problem and must not read as zero.
  const vaultInfo = await conn.getAccountInfo(vault, "confirmed");
  const lamports = vaultInfo ? BigInt((await conn.getTokenAccountBalance(vault, "confirmed")).value.amount) : 0n;
  // Wrapped SOL already in the wallet is a claim from a run whose unwrap failed; read it the same strict way. Each run
  // closes the WSOL account, and anyone can then send SOL to its address, leaving a system-owned account there.
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const wsolInfo = await conn.getAccountInfo(wsolAta, "confirmed");
  const wrapped = isTokenAccount(wsolInfo) ? BigInt((await conn.getTokenAccountBalance(wsolAta, "confirmed")).value.amount) : 0n;
  log(`network=${network} platform=${PLATFORM_ID.toBase58()} vault=${vault.toBase58()} unclaimed=${Number(lamports) / 1e9} SOL wrapped=${Number(wrapped) / 1e9} SOL`);
  const plan = claimPlan({ unclaimed: lamports, wrapped, dryRun: !!process.env.DRY_RUN });
  if (!plan.claim && !plan.unwrap) return;

  const before = await conn.getBalance(wallet.publicKey, "confirmed");
  if (plan.claim) {
    const raydium = await loadRaydium(conn, wallet, network);
    const { execute } = await raydium.launchpad.claimVaultPlatformFee({
      programId: program,
      platformId: PLATFORM_ID,
      mintB: NATIVE_MINT,
      mintBProgram: TOKEN_PROGRAM_ID,
      claimFeeWallet: wallet.publicKey,
      txVersion: sdkTxVersion,
    });
    const { txId } = await execute({ sendAndConfirm: true });
    log(`claimed tx ${txId}`);
  }
  // The fees land as wrapped SOL; closing the wrapped-SOL account turns them back into plain SOL in the wallet.
  // This runs even with nothing new to claim: a run whose close failed left WSOL here with the vault already empty.
  if (plan.unwrap && isTokenAccount(await conn.getAccountInfo(wsolAta, "confirmed"))) {
    const unwrap = await sendAndConfirmTransaction(conn, new Transaction().add(createCloseAccountInstruction(wsolAta, wallet.publicKey, wallet.publicKey)), [wallet], { commitment: "confirmed" });
    log(`unwrapped tx ${unwrap}`);
  }
  const after = await conn.getBalance(wallet.publicKey, "confirmed");
  log(`wallet SOL ${before / 1e9} -> ${after / 1e9}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
