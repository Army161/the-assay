// What a platform fee claim run sends, decided from what it read, kept apart from claim-fees.ts so it can be tested.

/**
 * The claim goes out when the platform vault holds fees. The unwrap goes out whenever wrapped SOL waits in the wallet:
 * a claim always leaves some, and a run whose unwrap failed leaves some with the vault already empty. `wrapped` is read
 * only from a token account (see isTokenAccount), so a system-owned account at that address counts as none. A dry
 * run sends nothing.
 */
export function claimPlan(p: { unclaimed: bigint; wrapped: bigint; dryRun: boolean }): { claim: boolean; unwrap: boolean } {
  if (p.dryRun) return { claim: false, unwrap: false };
  return { claim: p.unclaimed > 0n, unwrap: p.unclaimed > 0n || p.wrapped > 0n };
}
