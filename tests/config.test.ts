import { describe, expect, it, vi } from "vitest";
import { envPublicKey, isProgramOwner, parseNetwork } from "../src/lib/chain";
import { envUrl } from "../src/lib/env";
import { parseUnits } from "../src/lib/format";
import { assertDurableDb, claimNetwork, freshDb } from "../src/lib/db";

const ID = "2nQcifUC6ZX7bL4T83iuyAHZ9auVfi9EdhE543HjUdXM";

describe("environment values pasted into a hosting dashboard", () => {
  it("reads a platform id with stray whitespace, a newline or quotes around it", () => {
    for (const raw of [ID, ` ${ID} `, `${ID}\n`, `"${ID}"`, `'${ID}'`, ` "${ID}"\n`]) {
      expect(envPublicKey("X", raw)?.toBase58()).toBe(ID);
    }
  });

  it("treats a missing or blank value as unset", () => {
    expect(envPublicKey("X", undefined)).toBeNull();
    expect(envPublicKey("X", "  ")).toBeNull();
  });

  it("reports a malformed value instead of throwing, so the build and every page still load", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(envPublicKey("NEXT_PUBLIC_PLATFORM_ID_DEVNET", "not-a-key!")).toBeNull();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("NEXT_PUBLIC_PLATFORM_ID_DEVNET"));
    err.mockRestore();
  });

  it("adds https:// to an RPC or site URL pasted without it, and keeps a good URL as is", () => {
    const fb = "https://api.devnet.solana.com";
    expect(envUrl("X", "https://devnet.helius-rpc.com/?api-key=k", fb)).toBe("https://devnet.helius-rpc.com/?api-key=k");
    expect(envUrl("X", ' "devnet.helius-rpc.com/?api-key=k"\n', fb)).toBe("https://devnet.helius-rpc.com/?api-key=k");
    expect(envUrl("X", "the-assay.vercel.app", fb)).toBe("https://the-assay.vercel.app");
    expect(envUrl("X", undefined, fb)).toBe(fb);
    expect(envUrl("X", " ", fb)).toBe(fb);
  });

  it("falls back and names the variable when the value is not an http(s) URL, such as a bare API key", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fb = "https://api.devnet.solana.com";
    expect(envUrl("NEXT_PUBLIC_RPC_URL", "3f1c2b9e-1111-2222-3333-444455556666", fb)).toBe(fb);
    expect(envUrl("NEXT_PUBLIC_RPC_URL", "wss://devnet.helius-rpc.com", fb)).toBe(fb);
    expect(envUrl("NEXT_PUBLIC_RPC_URL", "https://", fb)).toBe(fb);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("NEXT_PUBLIC_RPC_URL"));
    err.mockRestore();
  });
});

describe("telling pools apart from people's wallets", () => {
  it("treats the LaunchLab and CPMM pool authorities on both networks as programs, and a wallet as a person", () => {
    for (const pda of ["WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh", "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
      "5xqNaZXX5eUi4p5HU4oz9i5QnwRNT2y6oN7yyn4qENeq", "CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq"]) expect(isProgramOwner(pda)).toBe(true);
    expect(isProgramOwner("HuwVSvu39rDuyYJZihkfGaLTGPpd92rCG8BWVmT6MZKb")).toBe(false);
  });
});

describe("the database on mainnet", () => {
  it("refuses to run mainnet without Postgres, even with a PGlite directory, and allows devnet without it", () => {
    expect(() => assertDurableDb(undefined, "mainnet", undefined)).toThrow(/DATABASE_URL/);
    expect(() => assertDurableDb(undefined, ' "mainnet" ', undefined)).toThrow(/DATABASE_URL/);
    expect(() => assertDurableDb("postgres://x", "mainnet", undefined)).not.toThrow();
    expect(() => assertDurableDb(undefined, "mainnet", "/data/pg")).toThrow(/DATABASE_URL/);
    expect(() => assertDurableDb(undefined, "Mainnet-Beta", undefined)).toThrow(/DATABASE_URL/);
    expect(() => assertDurableDb(undefined, "devnet", undefined, false)).not.toThrow();
    expect(() => assertDurableDb(undefined, undefined, undefined, false)).not.toThrow();
  });
});

describe("one database per network", () => {
  it("writes its network on first start and refuses another network after that", async () => {
    const db = await freshDb();
    await claimNetwork(db, "devnet");
    await claimNetwork(db, undefined);
    await expect(claimNetwork(db, "mainnet")).rejects.toThrow(/devnet data/);
    await db.close();
  });
  it("never stamps an unmarked database that already holds another network's coins", async () => {
    const db = await freshDb();
    await db.query("delete from kv where k = 'network'");
    await db.query("insert into coins (mint, pool_id, network, name, symbol, creator, created_at, supply, total_sell, fund_target_lamports) values ('M', 'P', 'devnet', 'n', 's', 'C', now(), 1, 1, 1)");
    await expect(claimNetwork(db, "mainnet")).rejects.toThrow(/devnet coins/);
    await claimNetwork(db, "devnet");
    await db.close();
  });
  it("reads mainnet spellings and reports unknown values", () => {
    expect(parseNetwork(" mainnet ")).toBe("mainnet");
    expect(parseNetwork("Mainnet-Beta")).toBe("mainnet");
    expect(parseNetwork(undefined)).toBe("devnet");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseNetwork("main")).toBe("devnet");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("NEXT_PUBLIC_NETWORK"));
    err.mockRestore();
  });
});

describe("metadata fetch guard", () => {
  it("refuses private, internal and odd hosts", async () => {
    const { blockedHost, fetchableUrl } = await import("@/lib/metadata");
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "[::1]", "fd00::1", "metadata", "foo.internal", "2130706433", "0x7f000001"]) {
      expect(blockedHost(h), h).toBe(true);
    }
    for (const h of ["ipfs.io", "gateway.pinata.cloud", "8.8.8.8", "the-assay.vercel.app"]) expect(blockedHost(h), h).toBe(false);
    expect(fetchableUrl("http://ipfs.io/x")).toBeNull();
    expect(fetchableUrl("https://user:pw@ipfs.io/x")).toBeNull();
    expect(fetchableUrl("https://ipfs.io:8080/x")).toBeNull();
    expect(fetchableUrl("https://169.254.169.254/latest")).toBeNull();
    expect(fetchableUrl("https://ipfs.io/ipfs/abc")?.hostname).toBe("ipfs.io");
  });
});

describe("metadata fetch resolves before it connects", () => {
  it("refuses a name whose addresses include a private one, and passes public ones through", async () => {
    const { privateRefusingLookup } = await import("@/lib/metadata");
    const fake = (addrs: string[]) => privateRefusingLookup((_h, _o, cb) => cb(null, addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))));
    const run = (l: ReturnType<typeof fake>, all: boolean) => new Promise<{ err: Error | null; address: unknown }>((r) => l("x.example", { all }, (err, address) => r({ err, address })));
    expect((await run(fake(["93.184.216.34", "10.0.0.5"]), false)).err?.message).toMatch(/private/);
    expect((await run(fake(["169.254.169.254"]), true)).err?.message).toMatch(/private/);
    expect((await run(fake(["::1"]), true)).err?.message).toMatch(/private/);
    expect(await run(fake(["93.184.216.34"]), false)).toEqual({ err: null, address: "93.184.216.34" });
    expect((await run(fake(["93.184.216.34", "2606:2800:220:1::1"]), true)).address).toHaveLength(2);
  });
});

describe("parseUnits", () => {
  it("converts typed decimals to exact base units", () => {
    expect(parseUnits("1.9", 0)).toBe(1n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(parseUnits("12.5", 6)).toBe(12_500_000n);
    expect(parseUnits(".5", 2)).toBe(50n);
    expect(parseUnits("3.", 2)).toBe(300n);
    expect(parseUnits("1.23456789", 6)).toBe(1_234_567n);
    expect(parseUnits("", 6)).toBeNull();
    expect(parseUnits(".", 6)).toBeNull();
    expect(parseUnits("1e3", 6)).toBeNull();
  });
});
