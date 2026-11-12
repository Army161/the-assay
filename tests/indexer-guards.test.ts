// Guards that keep the mainnet indexer honest and cheap: foreign pools under our platform id are not listed, and a
// pool that has not moved is not rescanned.
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { nonStandardPool, poolFingerprint } from "../src/lib/indexer";
import { LAUNCHLAB, WSOL } from "../src/lib/chain";
import type { PoolState } from "../src/lib/raydium";

const std = (over: Partial<Record<string, unknown>> = {}) => ({
  configId: LAUNCHLAB.devnet.globalConfig, mintB: WSOL, mintDecimalsA: 6,
  supply: new BN("1000000000000000"), totalSellA: new BN("793100000000000"), totalFundRaisingB: new BN(1_500_000_000),
  vestingSchedule: { totalLockedAmount: new BN(0) }, migrateType: 1, status: 0, realA: new BN(5), realB: new BN(7),
  ...over,
}) as unknown as PoolState;

describe("pools created under our platform id", () => {
  it("lists a pool made the way the launch form makes it", () => {
    expect(nonStandardPool(std(), "devnet")).toBeNull();
  });
  it("leaves out other curves, quote tokens, sizes, team allocations and migrations", () => {
    expect(nonStandardPool(std({ configId: PublicKey.default }), "devnet")).toMatch(/config/);
    expect(nonStandardPool(std({ mintB: PublicKey.default }), "devnet")).toMatch(/SOL/);
    expect(nonStandardPool(std({ supply: new BN("2000000000000000") }), "devnet")).toMatch(/supply/);
    expect(nonStandardPool(std({ totalSellA: new BN(1) }), "devnet")).toMatch(/curve size/);
    expect(nonStandardPool(std({ totalFundRaisingB: new BN(1) }), "devnet")).toMatch(/target/);
    expect(nonStandardPool(std({ vestingSchedule: { totalLockedAmount: new BN(10) } }), "devnet")).toMatch(/vesting/);
    expect(nonStandardPool(std({ migrateType: 0 }), "devnet")).toMatch(/CPMM/);
    expect(nonStandardPool(std(), "mainnet")).toMatch(/config/); // devnet config on mainnet
  });
});

describe("pool fingerprint", () => {
  it("changes with every trade and with graduation, and only then", () => {
    const a = poolFingerprint(std());
    expect(poolFingerprint(std())).toBe(a);
    expect(poolFingerprint(std({ realB: new BN(8) }))).not.toBe(a);
    expect(poolFingerprint(std({ realA: new BN(4) }))).not.toBe(a);
    expect(poolFingerprint(std({ status: 1 }))).not.toBe(a);
  });
});
