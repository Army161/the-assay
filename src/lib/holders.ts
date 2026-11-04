// Holder lists from RPC. getTokenLargestAccounts gives the top 20 accounts; the pool vault and the creator are labelled.
import { Connection, PublicKey } from "@solana/web3.js";
import { getPdaLaunchpadVaultId } from "@raydium-io/raydium-sdk-v2";
import { LAUNCHLAB, NETWORK } from "./chain";
import { tokenAccountsForMint } from "./token-accounts";
import type { Db } from "./db";

export interface Holder { account: string; owner: string | null; amount: string; share: number; label: "pool" | "creator" | "amm" | null }

export async function topHolders(conn: Connection, db: Db, mint: PublicKey, coin: { supply: string; decimals: number; token_2022: boolean; pool_id: string; creator: string }) {
  const vaultA = getPdaLaunchpadVaultId(LAUNCHLAB[NETWORK].program, new PublicKey(coin.pool_id), mint).publicKey.toBase58();
  const largest = await conn.getTokenLargestAccounts(mint, "confirmed");
  const accounts = largest.value.slice(0, 20);
  const infos = await conn.getMultipleParsedAccounts(accounts.map((a) => a.address), { commitment: "confirmed" });
  const supply = Number(coin.supply);
  const holders: Holder[] = accounts.map((a, i) => {
    const info = infos.value[i];
    const parsed = info && "parsed" in info.data ? (info.data as { parsed: { info: { owner: string } } }).parsed.info : null;
    const owner = parsed?.owner ?? null;
    const acct = a.address.toBase58();
    const label: Holder["label"] = acct === vaultA ? "pool" : owner === coin.creator ? "creator" : owner && owner.startsWith("DRay") ? "amm" : null;
    return { account: acct, owner, amount: a.amount, share: supply > 0 ? Number(a.amount) / supply : 0, label };
  });
  // holder count: token accounts with a balance, minus the pool vault. A keyed RPC gives the full set; the public one gives the named set.
  let count: number | null = null;
  try {
    const { accounts } = await tokenAccountsForMint(conn, db, mint, coin.token_2022);
    count = accounts.filter((a) => a.acc.amount > 0n && a.pubkey.toBase58() !== vaultA && !a.acc.owner.toBase58().startsWith("DRay")).length;
  } catch { /* count stays unknown */ }
  const real = holders.filter((h) => h.label !== "pool" && h.label !== "amm");
  const top10Share = real.length ? real.slice(0, 10).reduce((s, h) => s + h.share, 0) : null;
  return { holders, count, top10Share };
}
