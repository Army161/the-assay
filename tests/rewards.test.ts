// The rewards run's guards (one run at a time, never on mainnet while it is closed) and its bookkeeping: every
// transaction is written down before it is sent and settled from the chain, so a run cut off anywhere loses nothing
// and pays nothing twice.
import { describe, it, expect } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { freshDb, kv } from "../src/lib/db";
import { runRewards, settlePending, shareOut, base58, loadRewardState, deferUnpayable, releaseHeld, unpayableAccount, loadRewardsKeypair, type RewardState } from "../src/lib/rewards";

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
    const other = await kv.lease(db, "lock:rewards", 15 * 60_000); // another run in progress
    expect(other).not.toBeNull();
    const r = await runRewards(db, noRpc, "devnet", { keypair: Keypair.generate() });
    expect(r.errors).toEqual(["another rewards run is in progress"]);
    expect(r.coins).toBe(0);
    await kv.release(db, "lock:rewards", other!);
    // with no reward coins the run takes the lease, finds nothing, and gives it back
    const ok = await runRewards(db, noRpc, "devnet", { keypair: Keypair.generate() });
    expect(ok.errors).toEqual([]);
    expect(await kv.lease(db, "lock:rewards", 15 * 60_000)).not.toBeNull();
    await db.close();
  });

  it("leaves a coin alone while a transaction from a cut-off run may still land", async () => {
    const db = await freshDb();
    await db.query(
      `insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports, transfer_fee_bps)
       values ('M1','P1','devnet','Fee Coin','FEE','C1',now(),6,1000000,800000,1500000000,100)`);
    await kv.set(db, "reward_state:M1", { carry: 0, owed: [{ to: "W1", lamports: 900_000 }], pending: { kind: "pay", sig: "S1", lastValidBlockHeight: 100, to: ["W1"] } });
    const conn = {
      getSignatureStatuses: async () => ({ value: [null] }),
      getBlockHeight: async () => 90,
    } as unknown as Connection; // anything else would throw
    const r = await runRewards(db, conn, "devnet", { keypair: Keypair.generate() });
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual([{ mint: "M1", reason: "waiting for S1 to settle" }]);
    expect((await loadRewardState(db, "M1")).owed).toHaveLength(1);
    await db.close();
  });
});

describe("rewards bookkeeping", () => {
  type Tok = { mint: string; owner: string; uiTokenAmount: { amount: string } };
  const conn = (o: { status?: unknown; height?: number; pre?: number; post?: number; preTok?: Tok[]; postTok?: Tok[] }) => ({
    getSignatureStatuses: async () => ({ value: [o.status ?? null] }),
    getBlockHeight: async () => o.height ?? 0,
    getTransaction: async () => ({ meta: { preBalances: [o.pre ?? 0], postBalances: [o.post ?? 0], preTokenBalances: o.preTok ?? [], postTokenBalances: o.postTok ?? [] } }),
  }) as unknown as Parameters<typeof settlePending>[0];
  const confirmed = { confirmationStatus: "confirmed", err: null };

  it("adds a landed sale's exact proceeds to carry", async () => {
    const st: RewardState = { unsold: "700", carry: 1_000, owed: [], pending: { kind: "sale", sig: "S", lastValidBlockHeight: 10, tokens: "500" } };
    expect(await settlePending(conn({ status: confirmed, pre: 5_000_000, post: 7_500_000 }), st)).toBe("landed");
    expect(st).toEqual({ unsold: "200", carry: 2_501_000, owed: [], pending: null });
  });

  it("counts only what a landed withdrawal moved into the rewards wallet as unsold fees", async () => {
    const st: RewardState = { unsold: "100", carry: 0, owed: [], pending: { kind: "withdraw", sig: "S", lastValidBlockHeight: 10, mint: "M", owner: "R" } };
    const tok = (mint: string, owner: string, amount: string): Tok => ({ mint, owner, uiTokenAmount: { amount } });
    // the wallet already held 5,000 tokens of its own; the withdrawal brought 250 more
    expect(await settlePending(conn({ status: confirmed, preTok: [tok("M", "R", "5000"), tok("X", "R", "1")], postTok: [tok("M", "R", "5250"), tok("X", "R", "1")] }), st)).toBe("landed");
    expect(st.unsold).toBe("350");
  });

  it("takes a landed payout's wallets off owed, and only those", async () => {
    const st: RewardState = { unsold: "0", carry: 0, owed: [{ to: "A", lamports: 1 }, { to: "B", lamports: 2 }, { to: "C", lamports: 3 }], pending: { kind: "pay", sig: "S", lastValidBlockHeight: 10, to: ["A", "B"] } };
    expect(await settlePending(conn({ status: { confirmationStatus: "finalized", err: null } }), st)).toBe("landed");
    expect(st.owed).toEqual([{ to: "C", lamports: 3 }]);
    expect(st.pending).toBeNull();
  });

  it("keeps owed when a payout failed or expired, and waits while it can still land", async () => {
    const mk = (): RewardState => ({ unsold: "0", carry: 0, owed: [{ to: "A", lamports: 1 }], pending: { kind: "pay", sig: "S", lastValidBlockHeight: 10, to: ["A"] } });
    let st = mk();
    expect(await settlePending(conn({ status: { confirmationStatus: "confirmed", err: { InstructionError: [0, "x"] } } }), st)).toBe("failed");
    expect(st.owed).toHaveLength(1); expect(st.pending).toBeNull();
    st = mk();
    expect(await settlePending(conn({ height: 11 }), st)).toBe("failed");
    expect(st.owed).toHaveLength(1); expect(st.pending).toBeNull();
    st = mk();
    expect(await settlePending(conn({ height: 10 }), st)).toBe("waiting");
    expect(st.pending).not.toBeNull();
    st = mk();
    expect(await settlePending(conn({ status: { confirmationStatus: "processed", err: null } }), st)).toBe("waiting");
  });

  it("shares out by wallet, carrying shares under the minimum", () => {
    const owed = shareOut(10_000_000, [{ owner: "A", amount: 600n }, { owner: "B", amount: 300n }, { owner: "A", amount: 60n }, { owner: "D", amount: 40n }]);
    expect(owed).toEqual([{ to: "A", lamports: 6_600_000 }, { to: "B", lamports: 3_000_000 }]); // D's 400_000 is under 0.0005 SOL
  });

  it("reads the carry kept by earlier versions", async () => {
    const db = await freshDb();
    await kv.set(db, "reward_carry:M2", { lamports: 42 });
    expect(await loadRewardState(db, "M2")).toEqual({ unsold: "0", carry: 42, owed: [], held: {}, pending: null });
    await db.close();
  });

  it("encodes signatures as base58", () => {
    expect(base58(Uint8Array.from([0, 0, 1]))).toBe("112");
    expect(base58(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV");
  });
});

describe("payouts to wallets a transfer cannot fund", () => {
  it("holds a share that would leave an empty wallet below the rent-exempt minimum for that wallet, and pays the rest", async () => {
    const [empty, funded, big] = [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((k) => k.publicKey.toBase58());
    const balance: Record<string, number> = { [funded]: 2_000_000 };
    const conn = {
      getMinimumBalanceForRentExemption: async () => 890_880,
      getMultipleAccountsInfo: async (keys: { toBase58(): string }[]) =>
        keys.map((k) => (balance[k.toBase58()] !== undefined ? { lamports: balance[k.toBase58()] } : null)),
    } as unknown as Parameters<typeof deferUnpayable>[0];
    const st: RewardState = { unsold: "0", carry: 100, pending: null, owed: [
      { to: empty, lamports: 500_000 },   // empty wallet: 500k alone is below the minimum, the batch would fail
      { to: funded, lamports: 500_000 },  // already holds SOL: fine
      { to: big, lamports: 1_000_000 },   // empty, but the share alone clears the minimum: fine
    ] };
    expect(await deferUnpayable(conn, st)).toBe(500_000);
    expect(st.owed.map((o) => o.to)).toEqual([funded, big]);
    expect(st.carry).toBe(100); // not handed back to be shared among everyone
    expect(st.held).toEqual({ [empty]: 500_000 });
    expect(await deferUnpayable(conn, st)).toBe(0); // nothing left to defer

    // the next run offers it again: still unfunded, so it stays held and nobody else gets any of it
    st.owed = [];
    expect(releaseHeld(st)).toBe(500_000);
    expect(await deferUnpayable(conn, st)).toBe(500_000);
    expect(st.held).toEqual({ [empty]: 500_000 });

    // a later round adds a new share for the same wallet: together they clear the minimum and are paid as one transfer
    st.owed = [{ to: empty, lamports: 400_000 }, { to: funded, lamports: 300_000 }];
    releaseHeld(st);
    expect(st.owed).toEqual([{ to: empty, lamports: 900_000 }, { to: funded, lamports: 300_000 }]);
    expect(await deferUnpayable(conn, st)).toBe(0);
    expect(st.held).toEqual({});

    // or the wallet gets funded: the held share is paid on its own
    st.owed = []; st.held = { [empty]: 500_000 }; balance[empty] = 1_000_000;
    releaseHeld(st);
    expect(await deferUnpayable(conn, st)).toBe(0);
    expect(st.owed).toEqual([{ to: empty, lamports: 500_000 }]);
  });
});

describe("payouts to accounts no transfer can reach", () => {
  it("gives a program or sysvar's share back to carry instead of failing every batch, and keeps paying wallets", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const program = Keypair.generate().publicKey.toBase58();
    const sysvarOwned = Keypair.generate().publicKey.toBase58();
    const SYSTEM = new PublicKey("11111111111111111111111111111111");
    const info: Record<string, { lamports: number; executable: boolean; owner: PublicKey }> = {
      [wallet]: { lamports: 5_000_000, executable: false, owner: SYSTEM },
      [program]: { lamports: 5_000_000, executable: true, owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111") },
      [sysvarOwned]: { lamports: 5_000_000, executable: false, owner: new PublicKey("Sysvar1111111111111111111111111111111111111") },
    };
    const conn = {
      getMinimumBalanceForRentExemption: async () => 890_880,
      getMultipleAccountsInfo: async (keys: { toBase58(): string }[]) => keys.map((k) => info[k.toBase58()] ?? null),
    } as unknown as Parameters<typeof deferUnpayable>[0];
    const st: RewardState = { unsold: "0", carry: 7, pending: null, owed: [
      { to: wallet, lamports: 600_000 }, { to: program, lamports: 600_000 }, { to: sysvarOwned, lamports: 600_000 },
      { to: "11111111111111111111111111111111", lamports: 600_000 },
    ] };
    expect(await deferUnpayable(conn, st)).toBe(1_800_000);
    expect(st.owed.map((o) => o.to)).toEqual([wallet]);
    expect(st.carry).toBe(1_800_007);
    expect(st.held).toEqual({});
  });

  it("knows which owners can be paid", () => {
    expect(unpayableAccount("11111111111111111111111111111111", null)).toBe(true);
    expect(unpayableAccount("1nc1nerator11111111111111111111111111111111", null)).toBe(true);
    expect(unpayableAccount(Keypair.generate().publicKey.toBase58(), null)).toBe(false);
    expect(unpayableAccount(Keypair.generate().publicKey.toBase58(), { executable: false, owner: new PublicKey("11111111111111111111111111111111") })).toBe(false);
  });
});

describe("the rewards key", () => {
  it("gives a fixed message for a malformed value and never echoes it", () => {
    expect(() => loadRewardsKeypair("[1,2,secret")).toThrow("REWARDS_KEYPAIR is not a JSON array of 64 numbers");
    try { loadRewardsKeypair("[1,2,secret"); } catch (e) { expect(String(e)).not.toContain("secret"); }
    expect(loadRewardsKeypair(` ${JSON.stringify(Array.from(Keypair.generate().secretKey))}\n`).publicKey).toBeTruthy();
  });
});

