// The rewards run's guards: one run at a time, and never on mainnet while it is closed. Neither touches the RPC.
import { describe, it, expect } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { freshDb, kv } from "../src/lib/db";
import { runRewards } from "../src/lib/rewards";

// Any RPC call fails the test: these paths must stop before reaching the chain.
const noRpc = new Proxy({}, { get: () => () => { throw new Error("unexpected RPC call"); } }) as unknown as Connection;

describe("rewards run guards", () => {
  it("refuses mainnet while it is closed", async () => {
    const db = await freshDb();
    await expect(runRewards(db, noRpc, "mainnet", { keypair: Keypair.generate() })).rejects.toThrow(/Mainnet is closed/);
    await db.close();
  });

  it("does nothing while another run holds the lease, and frees the lease when it ends", async () => {
    const db = await freshDb();
    expect(await kv.claim(db, "lock:rewards", 15 * 60_000)).toBe(true); // another run in progress
    const r = await runRewards(db, noRpc, "devnet", { keypair: Keypair.generate() });
    expect(r.errors).toEqual(["another rewards run is in progress"]);
    expect(r.coins).toBe(0);
    await kv.release(db, "lock:rewards");
    // with no reward coins the run takes the lease, finds nothing, and gives it back
    const ok = await runRewards(db, noRpc, "devnet", { keypair: Keypair.generate() });
    expect(ok.errors).toEqual([]);
    expect(await kv.claim(db, "lock:rewards", 15 * 60_000)).toBe(true);
    await db.close();
  });
});
