// Network facts and the fee design. Everything the app and the scripts need to agree on lives here.
// Mainnet stays closed until Jeremy gives the written go AND the platform config exists on mainnet.
import { PublicKey } from "@solana/web3.js";
import { cleanEnv, envUrl } from "./env";

export type Network = "devnet" | "mainnet";

/** Flip to true only on Jeremy's written go. Until then every mainnet path refuses. */
export const MAINNET_OPEN = false;

/** "mainnet" or "mainnet-beta" mean mainnet; anything else (or unset) is devnet, and an unknown value is reported. */
export const NETWORK: Network = parseNetwork(process.env.NEXT_PUBLIC_NETWORK);
export function parseNetwork(raw: string | undefined): Network {
  const v = cleanEnv(raw)?.toLowerCase();
  if (v === "mainnet" || v === "mainnet-beta") return "mainnet";
  if (v && v !== "devnet") console.error(`[config] NEXT_PUBLIC_NETWORK="${v}" is not mainnet or devnet; running on devnet.`);
  return "devnet";
}

export function assertNetworkAllowed(network: Network = NETWORK) {
  if (network === "mainnet" && !MAINNET_OPEN) {
    throw new Error("Mainnet is closed: the launchpad runs on devnet until the written go.");
  }
}

// Each NEXT_PUBLIC_ variable is read as a literal `process.env.X` so Next inlines it into the client bundle.
export const RPC_URL = envUrl(
  "NEXT_PUBLIC_RPC_URL",
  process.env.NEXT_PUBLIC_RPC_URL,
  NETWORK === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com",
);

/** Server-only RPC (a keyed provider). Falls back to the public URL. */
export const SERVER_RPC_URL = envUrl("RPC_URL", process.env.RPC_URL, RPC_URL);

// Raydium LaunchLab program ids, verified on 2026-11-04 against @raydium-io/raydium-sdk-v2 0.2.81.
export const LAUNCHLAB = {
  devnet: {
    program: new PublicKey("DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6"),
    auth: new PublicKey("5xqNaZXX5eUi4p5HU4oz9i5QnwRNT2y6oN7yyn4qENeq"),
    // Global config: curve 0 (constant product), index 0, quote WSOL, 0.25% protocol fee, 1% max share fee.
    globalConfig: new PublicKey("7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt"),
    cpmmProgram: new PublicKey("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb"),
    // CPMM fee config index 0 (0.25% trade fee). Listed from the devnet CPMM program on 2026-11-04.
    cpmmConfig: new PublicKey("5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy"),
  },
  mainnet: {
    program: new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"),
    auth: new PublicKey("WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh"),
    globalConfig: new PublicKey("6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX"),
    cpmmProgram: new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
    // CPMM fee config index 0 (0.25%). Re-verify against the mainnet program before any mainnet platform creation.
    cpmmConfig: new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2"),
  },
} as const;

export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

/**
 * Highest transaction version the indexer and the rewards run ask the RPC for. Mainnet carries version 1 transactions
 * (about a third of LaunchLab traffic on 2026-11-12, mostly bots); asking for less makes the RPC refuse the whole
 * batch that contains one, which would stall a coin's indexing for good.
 */
export const MAX_TX_VERSION = 1;

/**
 * True when a token account's owner is a program address (a PDA: off the ed25519 curve) and not a person's wallet.
 * The LaunchLab vault authority, the CPMM pool authority and every other pool or locker on any DEX are PDAs, so this
 * keeps them out of holder counts and holder rewards on every network without a list of addresses to maintain.
 * (A multisig vault such as Squads is a PDA too and is treated the same way.)
 */
export function isProgramOwner(owner: PublicKey | string): boolean {
  const key = typeof owner === "string" ? new PublicKey(owner) : owner;
  return !PublicKey.isOnCurve(key.toBytes());
}

/**
 * Parses a public key from an environment variable. A malformed value must not crash the build or every page that
 * imports this module, so it is reported once and treated as unset; platformId() then names the variable to fix.
 */
export function envPublicKey(name: string, raw: string | undefined): PublicKey | null {
  const v = cleanEnv(raw);
  if (!v) return null;
  try {
    return new PublicKey(v);
  } catch {
    console.error(`[config] ${name} is not a valid Solana address; treating it as unset.`);
    return null;
  }
}

/** Our platform config account on each network (set by scripts/create-platform.ts). */
export const PLATFORM_ID: Record<Network, PublicKey | null> = {
  devnet: envPublicKey("NEXT_PUBLIC_PLATFORM_ID_DEVNET", process.env.NEXT_PUBLIC_PLATFORM_ID_DEVNET),
  mainnet: envPublicKey("NEXT_PUBLIC_PLATFORM_ID_MAINNET", process.env.NEXT_PUBLIC_PLATFORM_ID_MAINNET),
};

export function platformId(network: Network = NETWORK): PublicKey {
  const id = PLATFORM_ID[network];
  if (!id) {
    const v = network === "mainnet" ? "NEXT_PUBLIC_PLATFORM_ID_MAINNET" : "NEXT_PUBLIC_PLATFORM_ID_DEVNET";
    throw new Error(`No valid platform id configured for ${network} (set ${v} to the platform config address)`);
  }
  return id;
}

/**
 * The fee design. Rates are parts per million, the unit LaunchLab uses.
 * Verified caps (Raydium docs, 2026-11-04): platform fee <= 500,000? No: <= 50,000 (5.00%),
 * creator fee <= 5,000 (0.50%), share fee <= global max (10,000 = 1.00% on the configs we use).
 */
export const FEES = {
  /** 1.00% of every curve trade to the platform wallet. */
  platformFeeRate: 10_000,
  /** 0.50% of every curve trade to the coin's creator. */
  creatorFeeRate: 5_000,
  /** 0.50% of a referred trade to the caller whose link brought it. */
  callerShareRate: 5_000,
  /** Raydium's own protocol fee on the devnet/mainnet global config we use: 0.25%. */
  protocolFeeRate: 2_500,
  /** After graduation: locked LP split. 20% to the platform's locked position, 80% burned, 0% creator (LaunchLab requires 0). */
  lp: { platformScale: 200_000, creatorScale: 0, burnScale: 800_000 },
  /** Holder reward options a creator can pick (Token-2022 transfer fee, basis points). */
  holderRewardBps: [0, 100, 200] as const,
  /** Token-2022 cap on LaunchLab: 5%. */
  maxTransferFeeBps: 500,
  RATE_DENOMINATOR: 1_000_000,
} as const;

export const pct = (ppm: number) => `${(ppm / 10_000).toFixed(2)}%`;

/** Default launch shape (mirrors LaunchLab's defaults, in whole tokens / SOL). */
export const LAUNCH = {
  decimals: 6,
  supply: 1_000_000_000,
  /** Tokens sold on the curve before graduation (LaunchLab default 793.1M of 1B). */
  totalSellA: 793_100_000,
  /** SOL raised on the curve to graduate. Devnet uses a small target so tests can graduate. */
  totalFundRaisingSol: NETWORK === "mainnet" ? 85 : 1.5,
  migrateType: "cpmm" as const,
  /** LaunchLab's lock rate cap is 30% of supply. */
  maxLockedPct: 30,
} as const;

/** Callers only get paid on coins that are not in the bottom half at their latest reading. */
export const CALLER_PAY_TIERS = new Set(["top1", "top10", "top25", "upper_half"]);

export const EXPLORER = (sig: string, kind: "tx" | "address" = "tx") =>
  `https://solscan.io/${kind}/${sig}${NETWORK === "devnet" ? "?cluster=devnet" : ""}`;
