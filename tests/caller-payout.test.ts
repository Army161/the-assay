import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, SystemProgram, type AccountInfo, type Connection } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { callerCanBePaid, referrerAtSend, watchCallerPayouts } from "@/lib/client/trade";

// A caller's WSOL account as getAccountInfo returns it; null stands for a closed account.
const wsol: AccountInfo<Buffer> = { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0, data: Buffer.alloc(165) };
// SOL sent to the address of a closed one: the rent-exempt minimum for an empty account, owned by the system program.
const funded: AccountInfo<Buffer> = { lamports: 890_880, owner: SystemProgram.programId, executable: false, rentEpoch: 0, data: Buffer.alloc(0) };
function fakeRpc() {
  const getAccountInfo = vi.fn();
  return { conn: { getAccountInfo } as unknown as Connection, getAccountInfo };
}
const someCaller = () => Keypair.generate().publicKey.toBase58();

describe("caller payouts", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("asks for the caller's WSOL account and answers whether it exists", async () => {
    const { conn, getAccountInfo } = fakeRpc();
    const caller = Keypair.generate().publicKey;
    getAccountInfo.mockResolvedValueOnce(wsol).mockResolvedValueOnce(null);
    expect(await callerCanBePaid(conn, caller.toBase58())).toBe(true);
    expect(await callerCanBePaid(conn, caller.toBase58())).toBe(false);
    expect(getAccountInfo).toHaveBeenCalledWith(getAssociatedTokenAddressSync(NATIVE_MINT, caller), "confirmed");
  });

  it("does not count SOL sent to the address of a closed account, which a trade would pay to turn into one", async () => {
    const { conn, getAccountInfo } = fakeRpc();
    getAccountInfo.mockResolvedValue(funded);
    expect(await callerCanBePaid(conn, someCaller())).toBe(false);
    getAccountInfo.mockResolvedValue({ ...wsol, owner: Keypair.generate().publicKey });
    expect(await callerCanBePaid(conn, someCaller())).toBe(false);
  });

  it("rejects on an RPC failure instead of reporting the account closed", async () => {
    const { conn, getAccountInfo } = fakeRpc();
    getAccountInfo.mockRejectedValue(new Error("failed to get info about account"));
    await expect(callerCanBePaid(conn, someCaller())).rejects.toThrow(/failed to get info/);
  });

  it("keeps checking after the account is found, and reports it once closed", async () => {
    vi.useFakeTimers();
    const { conn, getAccountInfo } = fakeRpc();
    getAccountInfo.mockResolvedValueOnce(null).mockResolvedValueOnce(wsol).mockResolvedValueOnce(wsol).mockResolvedValue(null);
    const answers: boolean[] = [];
    const stop = watchCallerPayouts(conn, someCaller(), (ok) => answers.push(ok));
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toEqual([false]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(answers).toEqual([false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(answers).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(answers).toEqual([false, true, true, false]);
    stop();
  });

  it("reports nothing for a failed check and tries again on the next round", async () => {
    vi.useFakeTimers();
    const { conn, getAccountInfo } = fakeRpc();
    getAccountInfo.mockResolvedValueOnce(wsol).mockRejectedValueOnce(new Error("429")).mockResolvedValue(null);
    const answers: boolean[] = [];
    const stop = watchCallerPayouts(conn, someCaller(), (ok) => answers.push(ok));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(answers).toEqual([true]);
    expect(getAccountInfo).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(answers).toEqual([true, false]);
    stop();
  });

  it("retries a malformed caller address without throwing", async () => {
    vi.useFakeTimers();
    const { conn, getAccountInfo } = fakeRpc();
    const answers: boolean[] = [];
    const stop = watchCallerPayouts(conn, "not-a-key", (ok) => answers.push(ok));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(answers).toEqual([]);
    expect(getAccountInfo).not.toHaveBeenCalled();
    stop();
  });

  it("stops checking once stopped and drops an answer still in flight", async () => {
    vi.useFakeTimers();
    const { conn, getAccountInfo } = fakeRpc();
    let release!: (v: AccountInfo<Buffer> | null) => void;
    getAccountInfo.mockReturnValueOnce(new Promise((r) => { release = r; })).mockResolvedValue(wsol);
    const answers: boolean[] = [];
    const stop = watchCallerPayouts(conn, someCaller(), (ok) => answers.push(ok));
    stop();
    release(wsol);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(answers).toEqual([]);
    expect(getAccountInfo).toHaveBeenCalledTimes(1);

    const later = watchCallerPayouts(conn, someCaller(), (ok) => answers.push(ok));
    await vi.advanceTimersByTimeAsync(0);
    later();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(answers).toEqual([true]);
    expect(getAccountInfo).toHaveBeenCalledTimes(2);
  });
});

describe("the caller on a trade being sent", () => {
  it("is the caller while their WSOL account is open", async () => {
    const { conn, getAccountInfo } = fakeRpc();
    const caller = someCaller();
    getAccountInfo.mockResolvedValue(wsol);
    expect(await referrerAtSend(conn, caller)).toEqual({ ok: true, ref: caller });
  });

  it("stops the trade, and the caller is dropped so it is re-quoted, once the account is closed or only funded", async () => {
    const { conn, getAccountInfo } = fakeRpc();
    getAccountInfo.mockResolvedValueOnce(null).mockResolvedValueOnce(funded);
    expect(await referrerAtSend(conn, someCaller())).toEqual({ ok: false, closed: true });
    expect(await referrerAtSend(conn, someCaller())).toEqual({ ok: false, closed: true });
  });

  it("stops the trade when the check fails, as it would no longer match its quote, but the caller stays for the next try", async () => {
    const { conn, getAccountInfo } = fakeRpc();
    getAccountInfo.mockRejectedValue(new Error("429"));
    expect(await referrerAtSend(conn, someCaller())).toEqual({ ok: false, closed: false });
  });

  it("asks nothing when there is no caller", async () => {
    const { conn, getAccountInfo } = fakeRpc();
    expect(await referrerAtSend(conn, null)).toEqual({ ok: true, ref: null });
    expect(getAccountInfo).not.toHaveBeenCalled();
  });
});
