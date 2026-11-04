// Token accounts of a mint. Keyed RPCs answer getProgramAccounts; the public ones refuse it for the token programs,
// so the fallback assembles the accounts we can name: the ATA of every wallet that ever traded the coin on our
// platform (from the trades table), the 20 largest accounts, and the pool vaults. That is every holder who bought
// here and still holds in their wallet, which is what the rewards and the holder list are for.
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, type Account } from "@solana/spl-token";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Db } from "./db";

export interface TokenAccountRow { pubkey: PublicKey; acc: Account }

export async function tokenAccountsForMint(conn: Connection, db: Db, mint: PublicKey, token2022: boolean, extra: PublicKey[] = []): Promise<{ accounts: TokenAccountRow[]; complete: boolean }> {
  const program = token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  try {
    const accs = await conn.getProgramAccounts(program, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }, ...(token2022 ? [] : [{ dataSize: 165 }])] });
    return { accounts: accs.map((a) => ({ pubkey: a.pubkey, acc: unpackAccount(a.pubkey, a.account, program) })), complete: true };
  } catch {
    // fall through to the named-accounts path
  }
  const wallets = await db.query<{ wallet: string }>("select distinct wallet from trades where mint = $1", [mint.toBase58()]);
  const keys = new Map<string, PublicKey>();
  for (const w of wallets) { try { const k = getAssociatedTokenAddressSync(mint, new PublicKey(w.wallet), true, program); keys.set(k.toBase58(), k); } catch { /* skip */ } }
  for (const k of extra) keys.set(k.toBase58(), k);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { for (const l of (await conn.getTokenLargestAccounts(mint, "confirmed")).value) keys.set(l.address.toBase58(), l.address); break; }
    catch { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); }
  }
  const list = [...keys.values()];
  const accounts: TokenAccountRow[] = [];
  for (let i = 0; i < list.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(list.slice(i, i + 100), "confirmed");
    infos.forEach((info: AccountInfo<Buffer> | null, j) => {
      if (!info || !info.owner.equals(program)) return;
      try { accounts.push({ pubkey: list[i + j], acc: unpackAccount(list[i + j], info, program) }); } catch { /* not a token account */ }
    });
  }
  return { accounts, complete: false };
}
