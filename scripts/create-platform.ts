// Create (or show) The Assay's LaunchLab platform config with our fee design. Idempotent: if the platform
// account for the admin wallet already exists it prints it and exits.
//
//   ADMIN_KEYPAIR=/path/to/admin.json npx tsx scripts/create-platform.ts
//
// Wallets (devnet): all four roles are the admin key. On mainnet set PLATFORM_FEE_WALLET (where SOL fees are claimed to),
// PLATFORM_LOCK_WALLET (receives the locked-LP NFTs) and REWARDS_AUTHORITY (withdraws withheld Token-2022 fees for holder rewards).
import { PublicKey } from "@solana/web3.js";
import { getPdaPlatformId } from "@raydium-io/raydium-sdk-v2";
import { loadRaydium, ids, BN, sdkTxVersion, PlatformConfig } from "../src/lib/raydium";
import { FEES } from "../src/lib/chain";
import { connection, loadKeypair, network, log } from "./_env";

async function main() {
  const admin = loadKeypair();
  const conn = connection();
  const { program, cpmmConfig } = ids(network);
  const platformId = getPdaPlatformId(program, admin.publicKey).publicKey;
  log(`network=${network} admin=${admin.publicKey.toBase58()} platformId=${platformId.toBase58()}`);

  const existing = await conn.getAccountInfo(platformId, "confirmed");
  if (existing) {
    const p = PlatformConfig.decode(existing.data);
    log("platform already exists:", {
      name: p.name, web: p.web, feeRate: p.feeRate.toString(), creatorFeeRate: p.creatorFeeRate.toString(),
      claimFeeWallet: p.platformClaimFeeWallet.toBase58(), lockNftWallet: p.platformLockNftWallet.toBase58(),
      cpConfigId: p.cpConfigId.toBase58(), transferFeeExtensionAuth: p.transferFeeExtensionAuth.toBase58(),
    });
    console.log(`\nNEXT_PUBLIC_PLATFORM_ID_${network.toUpperCase()}=${platformId.toBase58()}`);
    return;
  }

  const feeWallet = new PublicKey(process.env.PLATFORM_FEE_WALLET || admin.publicKey);
  const lockWallet = new PublicKey(process.env.PLATFORM_LOCK_WALLET || admin.publicKey);
  const rewardsAuth = new PublicKey(process.env.REWARDS_AUTHORITY || admin.publicKey);
  // The rewards key lives on the server; the admin key must not. Off devnet they have to be different wallets.
  if (network !== "devnet" && rewardsAuth.equals(admin.publicKey)) throw new Error("Set REWARDS_AUTHORITY to the separate rewards wallet (not the admin).");

  // Shown by wallets and Raydium next to every launch. Mainnet must name our own live site, never a guessed domain.
  const web = (process.env.PLATFORM_WEB || process.env.NEXT_PUBLIC_SITE_URL || (network === "devnet" ? "https://the-assay.vercel.app" : "")).trim().replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+/.test(web)) throw new Error("Set PLATFORM_WEB to the site's https URL (it is written on chain with the platform).");
  const img = process.env.PLATFORM_IMG || `${web}/icon.svg`;
  log({ feeWallet: feeWallet.toBase58(), lockWallet: lockWallet.toBase58(), rewardsAuth: rewardsAuth.toBase58(), web, img });

  const raydium = await loadRaydium(conn, admin, network);
  const { execute, extInfo } = await raydium.launchpad.createPlatformConfig({
    programId: program,
    platformAdmin: admin.publicKey,
    platformClaimFeeWallet: feeWallet,
    platformLockNftWallet: lockWallet,
    platformVestingWallet: admin.publicKey,
    cpConfigId: cpmmConfig,
    migrateCpLockNftScale: {
      platformScale: new BN(FEES.lp.platformScale),
      creatorScale: new BN(FEES.lp.creatorScale),
      burnScale: new BN(FEES.lp.burnScale),
    },
    transferFeeExtensionAuth: rewardsAuth,
    creatorFeeRate: new BN(FEES.creatorFeeRate),
    feeRate: new BN(FEES.platformFeeRate),
    name: "The Assay",
    web,
    img,
    txVersion: sdkTxVersion,
  });
  const { txId } = await execute({ sendAndConfirm: true });
  log("created platform", extInfo.platformId.toBase58(), "tx", txId);
  console.log(`\nNEXT_PUBLIC_PLATFORM_ID_${network.toUpperCase()}=${extInfo.platformId.toBase58()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
