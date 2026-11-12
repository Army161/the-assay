// The rewards run's guards (one run at a time, never on mainnet while it is closed) and its bookkeeping: every
// transaction is written down before it is sent and settled from the chain, so a run cut off anywhere loses nothing
// and pays nothing twice.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { MintLayout, MINT_SIZE, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { freshDb, kv } from "../src/lib/db";
import { runRewards, settlePending, sendTracked, shareOut, base58, loadRewardState, deferUnpayable, releaseHeld, unpayableAccount, loadRewardsKeypair, type RewardState } from "../src/lib/rewards";

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
      getSignatureStatuses: async () => ({ context: { slot: 95 }, value: [null] }),
      getEpochInfo: async () => ({ blockHeight: 90, absoluteSlot: 95 }),
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
  // The finalized block is at slot 50; the status lookups are answered by a node that has processed it.
  const conn = (o: { status?: unknown; height?: number; pre?: number; post?: number; preTok?: Tok[]; postTok?: Tok[] }) => ({
    getSignatureStatuses: async () => ({ context: { slot: 50 }, value: [o.status ?? null] }),
    getEpochInfo: async () => ({ blockHeight: o.height ?? 0, absoluteSlot: 50 }),
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

  // A wrong "failed" leaves the batch on owed and the next run pays it a second time.
  const pay = (): RewardState => ({ unsold: "0", carry: 0, owed: [{ to: "A", lamports: 1 }], pending: { kind: "pay", sig: "S", lastValidBlockHeight: 10, to: ["A"] } });
  // Statuses answered in turn (the last one repeats), each by a node at `slots` (the last one repeats); the finalized
  // block's height and slot.
  const byLevel = (statuses: unknown[], finalized: { height: number; slot?: number }, slots: number[] = [finalized.slot ?? 0]) => {
    let n = 0;
    return {
      getSignatureStatuses: async () => { const i = n++; return { context: { slot: slots[Math.min(i, slots.length - 1)] }, value: [statuses[Math.min(i, statuses.length - 1)]] }; },
      getEpochInfo: async (c: string) => (c === "finalized" ? { blockHeight: finalized.height, absoluteSlot: finalized.slot ?? 0 } : null),
    } as unknown as Parameters<typeof settlePending>[0];
  };

  it("does not call a payout failed on an error seen only at processed: that fork can be dropped", async () => {
    const st = pay();
    expect(await settlePending(byLevel([{ confirmationStatus: "processed", err: { InstructionError: [0, "x"] } }], { height: 11 }), st)).toBe("waiting");
    expect(st).toEqual(pay());
  });

  it("does not call an unseen payout failed while only the confirmed chain is past its blockhash", async () => {
    // a load-balanced RPC: the status from a node a few slots behind, the height from one that is not
    const st = pay();
    expect(await settlePending(byLevel([null], { height: 10, slot: 120 }), st)).toBe("waiting");
    expect(st).toEqual(pay());
  });

  it("does not call an unseen payout failed when the node that found nothing is behind the finalized block", async () => {
    // As on devnet, where the finalized chain does not trail the confirmed one: the batch landed in the last valid
    // block, the finalized block past it is at slot 120, and the lookups go to a node that has processed only slot 118.
    let st = pay();
    expect(await settlePending(byLevel([null], { height: 11, slot: 120 }, [118]), st)).toBe("waiting");
    expect(st).toEqual(pay());
    // Once a node that has processed that block answers, nothing found is final.
    st = pay();
    expect(await settlePending(byLevel([null], { height: 11, slot: 120 }, [118, 121]), st)).toBe("failed");
    expect(st.owed).toHaveLength(1); expect(st.pending).toBeNull();
  });

  it("looks once more after the finalized chain is past the blockhash, and settles a copy that shows up", async () => {
    let st = pay();
    expect(await settlePending(byLevel([null, { confirmationStatus: "finalized", err: null }], { height: 11 }), st)).toBe("landed");
    expect(st.owed).toEqual([]);
    st = pay();
    expect(await settlePending(byLevel([null, null], { height: 11 }), st)).toBe("failed");
    expect(st.owed).toHaveLength(1); expect(st.pending).toBeNull();
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


describe("waits that the run budget bounds", () => {
  it("stops waiting on a confirmation once the budget and its slack are spent, without an unhandled rejection", async () => {
    const { confirmOk } = await import("../src/lib/rewards");
    let fail: (e: Error) => void = () => {};
    const conn = { confirmTransaction: () => new Promise((_, reject) => { fail = reject; }) };
    const past = Date.now() - 61_000;
    await expect(confirmOk(conn as never, "sig", "hash", 1, past)).rejects.toThrow(/time budget/);
    fail(new Error("block height exceeded")); // the abandoned wait settling later must not surface
    await new Promise((r) => setTimeout(r, 10));
  });

  it("still reports an on-chain error inside the budget", async () => {
    const { confirmOk } = await import("../src/lib/rewards");
    const conn = { confirmTransaction: async () => ({ value: { err: { InstructionError: [0, "Custom"] } } }) };
    await expect(confirmOk(conn as never, "sig", "hash", 1, Date.now() + 60_000)).rejects.toThrow(/failed/);
  });
});

describe("stalled RPC calls inside a run", () => {
  it("end the wait at the budget plus slack and swallow the late result", async () => {
    const { withinBudget } = await import("../src/lib/rewards");
    let settle: (v: number) => void = () => {};
    const stalled = new Promise<number>((r) => { settle = r; });
    await expect(withinBudget(stalled, Date.now() - 61_000)).rejects.toThrow(/time budget/);
    settle(1);
    await expect(withinBudget(Promise.resolve(7), Date.now() + 60_000)).resolves.toBe(7);
    await expect(withinBudget(Promise.resolve(8), Infinity)).resolves.toBe(8);
  });

  // An RPC call that never answers until the test lets it, and a deadline whose slack is already spent.
  const stall = <T>() => { let settle: (v: T) => void = () => {}; const p = new Promise<T>((r) => { settle = r; }); return { p, settle }; };
  const spent = () => Date.now() - 61_000;
  const later = () => new Promise((r) => setTimeout(r, 10));
  type SettleConn = Parameters<typeof settlePending>[0];
  const payPending = (): RewardState => ({ unsold: "0", carry: 0, owed: [{ to: "A", lamports: 1 }], pending: { kind: "pay", sig: "S", lastValidBlockHeight: 10, to: ["A"] } });

  it("a stalled status lookup ends the settle with the pending record kept", async () => {
    const s = stall<unknown>();
    const st = payPending();
    await expect(settlePending({ getSignatureStatuses: () => s.p } as unknown as SettleConn, st, spent())).rejects.toThrow(/time budget/);
    s.settle({ context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: null }] }); // a late answer must not apply either
    await later();
    expect(st).toEqual(payPending());
  });

  it("a stalled transaction read leaves unsold, carry and the pending sale untouched", async () => {
    const s = stall<unknown>();
    const sale = (): RewardState => ({ unsold: "700", carry: 1_000, owed: [], pending: { kind: "sale", sig: "S", lastValidBlockHeight: 10, tokens: "500" } });
    const st = sale();
    const conn = { getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: null }] }), getTransaction: () => s.p } as unknown as SettleConn;
    await expect(settlePending(conn, st, spent())).rejects.toThrow(/time budget/);
    s.settle({ meta: { preBalances: [0], postBalances: [5_000_000], preTokenBalances: [], postTokenBalances: [] } });
    await later();
    expect(st).toEqual(sale());
  });

  it("a stalled block height read does not expire the pending record", async () => {
    const s = stall<{ blockHeight: number; absoluteSlot: number }>();
    const st = payPending();
    const conn = { getSignatureStatuses: async () => ({ context: { slot: 5 }, value: [null] }), getEpochInfo: () => s.p } as unknown as SettleConn;
    await expect(settlePending(conn, st, spent())).rejects.toThrow(/time budget/);
    s.settle({ blockHeight: 11, absoluteSlot: 5 }); // past lastValidBlockHeight: applied, it would have dropped the record
    await later();
    expect(st).toEqual(payPending());
  });

  it("settles as before when the calls answer inside the budget", async () => {
    const st = payPending();
    const conn = { getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [{ confirmationStatus: "finalized", err: null }] }) } as unknown as SettleConn;
    expect(await settlePending(conn, st, Date.now() + 60_000)).toBe("landed");
    expect(st.owed).toEqual([]);
    expect(st.pending).toBeNull();
  });

  // Before signing, a tracked send reads a blockhash and a priority fee; a stall in either must end the run with
  // nothing signed and no pending record written.
  const stalledSend = async (conn: Record<string, unknown>) => {
    const db = await freshDb();
    const token = (await kv.lease(db, "lock:rewards", 60_000))!;
    const auth = Keypair.generate();
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: auth.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 }));
    const st: RewardState = { unsold: "0", carry: 0, owed: [{ to: "A", lamports: 1_000_000 }], pending: null };
    const sent = sendTracked(db, { lease: "lock:rewards", token }, conn as unknown as Connection, "M", st, tx, [auth], { kind: "pay", to: ["A"] }, spent());
    await expect(sent).rejects.toThrow(/time budget/);
    return { db, st, tx };
  };
  const blockhash = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 };

  it("a stalled blockhash read stops a tracked send before it signs or records anything", async () => {
    const s = stall<typeof blockhash>();
    const { db, st, tx } = await stalledSend({ rpcEndpoint: "https://api.devnet.solana.com", getLatestBlockhash: () => s.p });
    s.settle(blockhash);
    await later();
    expect(st.pending).toBeNull();
    expect(tx.signature).toBeNull();
    expect(await kv.get(db, "reward_state:M")).toBeNull();
    await db.close();
  });

  it("a stalled priority fee read stops a tracked send the same way", async () => {
    const s = stall<{ slot: number; prioritizationFee: number }[]>();
    const { db, st, tx } = await stalledSend({
      rpcEndpoint: "https://api.devnet.solana.com", getLatestBlockhash: async () => blockhash, getRecentPrioritizationFees: () => s.p,
    });
    s.settle([]);
    await later();
    expect(st.pending).toBeNull();
    expect(tx.signature).toBeNull();
    expect(await kv.get(db, "reward_state:M")).toBeNull();
    await db.close();
  });
});

describe("a tracked send's wait for its outcome", () => {
  afterEach(() => { vi.useRealTimers(); });

  // A payout batch sent through a fake RPC: statuses are answered in turn (the last one repeats), heights by level.
  const track = async (statuses: unknown[], height: (level: string, call: number) => number) => {
    const db = await freshDb();
    const token = (await kv.lease(db, "lock:rewards", 60_000))!;
    const auth = Keypair.generate();
    const to = Keypair.generate().publicKey.toBase58();
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: auth.publicKey, toPubkey: new PublicKey(to), lamports: 1_000_000 }));
    const st: RewardState = { unsold: "0", carry: 0, owed: [{ to, lamports: 1_000_000 }], pending: null };
    let looks = 0, heights = 0;
    const conn = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
      getRecentPrioritizationFees: async () => [],
      sendRawTransaction: vi.fn(async () => "sent"),
      getSignatureStatuses: async () => ({ context: { slot: 500 }, value: [statuses[Math.min(looks++, statuses.length - 1)]] }),
      getBlockHeight: async (level: string) => height(level, heights++),
      getEpochInfo: async (level: string) => ({ blockHeight: height(level, heights++), absoluteSlot: 500 }),
    };
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const sent = sendTracked(db, { lease: "lock:rewards", token }, conn as unknown as Connection, "M", st, tx, [auth], { kind: "pay", to: [to] });
    await vi.runAllTimersAsync();
    await sent;
    vi.useRealTimers();
    const settledAs = await settlePending(conn as unknown as Parameters<typeof settlePending>[0], st);
    await db.close();
    return { st, settledAs, sends: conn.sendRawTransaction.mock.calls.length };
  };

  it("keeps re-sending past an error at processed and past the confirmed chain's expiry, so a copy that lands is paid once", async () => {
    // A copy fails on a fork that is dropped, then a node a few slots behind shows nothing while the confirmed chain
    // is already past the blockhash; the copy that landed just before expiry then confirms.
    const r = await track(
      [{ confirmationStatus: "processed", err: { InstructionError: [0, "x"] } }, null, { confirmationStatus: "confirmed", err: null }],
      (level) => (level === "finalized" ? 90 : 101),
    );
    expect(r.sends).toBe(3); // the first send and two re-sends
    expect(r.settledAs).toBe("landed");
    expect(r.st.owed).toEqual([]);
  });

  it("stops once the finalized chain is past the blockhash, and the settle then calls an unseen payout failed", async () => {
    const r = await track([null], (level, call) => (level === "finalized" && call >= 2 ? 101 : 90));
    expect(r.sends).toBe(3);
    expect(r.settledAs).toBe("failed");
    expect(r.st.owed).toHaveLength(1); // still owed, to be sent again on a new blockhash
    expect(r.st.pending).toBeNull();
  });
});

describe("a transaction a cut-off run left behind", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // A reward coin whose state holds `state`, as a run that stopped after sending left it.
  const coinWith = async (state: RewardState) => {
    const db = await freshDb();
    const mint = Keypair.generate().publicKey.toBase58();
    await db.query(
      `insert into coins (mint, pool_id, network, name, symbol, creator, created_at, decimals, supply, total_sell, fund_target_lamports, transfer_fee_bps)
       values ($1,'P1','devnet','Fee Coin','FEE','C1',now(),6,1000000,800000,1500000000,100)`, [mint]);
    await kv.set(db, `reward_state:${mint}`, state);
    return { db, mint };
  };
  const history = (db: Awaited<ReturnType<typeof freshDb>>, mint: string) =>
    db.query<{ withheld_base: string; sol_lamports: string; holders: number; sigs: string[]; status: string }>(
      "select withheld_base, sol_lamports, holders, sigs, status from rewards where mint = $1 order by id", [mint]);
  const confirmed = async () => ({ context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: null }] });
  // A Token-2022 mint with no transfer fee extension: the run settles what was left, then skips the coin.
  const plainMint = async () => {
    const data = Buffer.alloc(MINT_SIZE);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1_000_000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
    return { owner: TOKEN_2022_PROGRAM_ID, data, lamports: 1, executable: false };
  };

  it("counts a payout batch that landed late in the next run's record, once, even when that run then fails", async () => {
    const pending = { kind: "pay" as const, sig: "S1", lastValidBlockHeight: 100, to: ["A", "B"] };
    const { db, mint } = await coinWith({ unsold: "0", carry: 0, owed: [{ to: "A", lamports: 900_000 }, { to: "B", lamports: 700_000 }, { to: "C", lamports: 600_000 }], pending });
    const conn = { getSignatureStatuses: confirmed, getAccountInfo: async () => { throw new Error("rpc down"); } } as unknown as Connection;
    const r = await runRewards(db, conn, "devnet", { keypair: Keypair.generate() });
    expect(r.errors).toEqual([`${mint}: rpc down`]);
    expect(await history(db, mint)).toEqual([{ withheld_base: "0", sol_lamports: "1600000", holders: 2, sigs: ["S1"], status: "partial" }]);
    const st = await loadRewardState(db, mint);
    expect(st.owed).toEqual([{ to: "C", lamports: 600_000 }]);
    expect(st.pending).toBeNull();
    // the run after that has nothing left to settle: no second row, no change to what is owed
    await runRewards(db, conn, "devnet", { keypair: Keypair.generate() });
    expect(await history(db, mint)).toHaveLength(1);
    expect((await loadRewardState(db, mint)).owed).toEqual([{ to: "C", lamports: 600_000 }]);
    await db.close();
  });

  it("counts a sale that landed late in the next run's record", async () => {
    const { db, mint } = await coinWith({ unsold: "700", carry: 1_000, owed: [], pending: { kind: "sale", sig: "S2", lastValidBlockHeight: 100, tokens: "500" } });
    const conn = {
      getSignatureStatuses: confirmed,
      getTransaction: async () => ({ meta: { preBalances: [5_000_000], postBalances: [7_500_000], preTokenBalances: [], postTokenBalances: [] } }),
      getAccountInfo: plainMint,
    } as unknown as Connection;
    const r = await runRewards(db, conn, "devnet", { keypair: Keypair.generate() });
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual([{ mint, reason: "no transfer fee extension" }]);
    expect(await history(db, mint)).toEqual([{ withheld_base: "500", sol_lamports: "0", holders: 0, sigs: ["S2"], status: "done" }]);
    expect(await loadRewardState(db, mint)).toEqual({ unsold: "200", carry: 2_501_000, owed: [], held: {}, pending: null });
    await db.close();
  });

  it("writes no row for one that failed", async () => {
    const { db, mint } = await coinWith({ unsold: "0", carry: 0, owed: [{ to: "A", lamports: 900_000 }], pending: { kind: "pay", sig: "S3", lastValidBlockHeight: 100, to: ["A"] } });
    const conn = { getSignatureStatuses: async () => ({ context: { slot: 5 }, value: [null] }), getEpochInfo: async () => ({ blockHeight: 101, absoluteSlot: 5 }), getAccountInfo: plainMint } as unknown as Connection;
    await runRewards(db, conn, "devnet", { keypair: Keypair.generate() });
    expect(await history(db, mint)).toEqual([]);
    expect((await loadRewardState(db, mint)).owed).toEqual([{ to: "A", lamports: 900_000 }]);
    await db.close();
  });

  it("stops at the run budget while settling it, keeping it pending, without counting an error", async () => {
    const left = (): RewardState => ({ unsold: "0", carry: 0, owed: [{ to: "A", lamports: 900_000 }], held: {}, pending: { kind: "pay", sig: "S4", lastValidBlockHeight: 100, to: ["A"] } });
    const { db, mint } = await coinWith(left());
    // The status lookup never answers, and by the time it is asked the budget and its slack are spent.
    const real = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    const conn = { getSignatureStatuses: () => { skew = 261_000; return new Promise(() => {}); } } as unknown as Connection;
    const r = await runRewards(db, conn, "devnet", { keypair: Keypair.generate() });
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual([{ mint, reason: "time budget reached; the next run carries on from here" }]);
    expect(await loadRewardState(db, mint)).toEqual(left());
    expect(await history(db, mint)).toEqual([]);
    await db.close();
  });
});
