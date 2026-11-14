import { describe, it, expect } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { isTokenAccount } from "../src/lib/chain";
import { claimPlan } from "../scripts/_claim";

describe("platform fee claims", () => {
  it("reads wrapped SOL only from a token account, not from SOL sent to the address of a closed one", () => {
    expect(isTokenAccount({ owner: TOKEN_PROGRAM_ID })).toBe(true);
    expect(isTokenAccount({ owner: SystemProgram.programId })).toBe(false);
    expect(isTokenAccount({ owner: Keypair.generate().publicKey })).toBe(false);
    expect(isTokenAccount(null)).toBe(false);
  });

  it("claims and unwraps when the vault holds fees", () => {
    expect(claimPlan({ unclaimed: 5n, wrapped: 0n, dryRun: false })).toEqual({ claim: true, unwrap: true });
  });

  it("unwraps what a run whose unwrap failed left behind, with the vault already empty", () => {
    expect(claimPlan({ unclaimed: 0n, wrapped: 7n, dryRun: false })).toEqual({ claim: false, unwrap: true });
  });

  it("sends nothing when there is nothing to claim or unwrap, or on a dry run", () => {
    expect(claimPlan({ unclaimed: 0n, wrapped: 0n, dryRun: false })).toEqual({ claim: false, unwrap: false });
    expect(claimPlan({ unclaimed: 5n, wrapped: 7n, dryRun: true })).toEqual({ claim: false, unwrap: false });
  });
});
