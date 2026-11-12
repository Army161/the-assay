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
  it("needs an explicit claim to adopt an unmarked database that holds data but no coins", async () => {
    const db = await freshDb();
    await db.query("delete from kv where k = 'network'");
    await db.query("insert into callers (wallet, code) values ('W', 'abc')");
    await expect(claimNetwork(db, "mainnet", undefined)).rejects.toThrow(/DB_NETWORK_CLAIM=mainnet/);
    await expect(claimNetwork(db, "devnet", undefined)).rejects.toThrow(/DB_NETWORK_CLAIM=devnet/);
    await expect(claimNetwork(db, "mainnet", "devnet")).rejects.toThrow(/no network mark/);
    await claimNetwork(db, "mainnet", "mainnet");
    await claimNetwork(db, "mainnet", undefined); // marked now, so the claim is no longer needed
    await db.close();
  });
  it("adopts an empty unmarked database without a claim", async () => {
    const db = await freshDb();
    await db.query("delete from kv where k = 'network'");
    await claimNetwork(db, "mainnet", undefined);
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

  // Each reserved range is checked at both edges, with the first public address just outside it.
  const BLOCKED = [
    "0.0.0.0", "0.255.255.255", "10.0.0.0", "10.255.255.255", "100.64.0.0", "100.127.255.255", "127.0.0.0", "127.255.255.255",
    "169.254.0.0", "169.254.255.255", "172.16.0.0", "172.31.255.255", "192.0.0.0", "192.0.0.255", "192.0.2.0", "192.0.2.255",
    "192.88.99.1", "192.168.0.0", "192.168.255.255", "198.18.0.0", "198.19.255.255", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "256.1.1.1",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::127.0.0.1", "64:ff9b::a00:1", "100::1",
    "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe80::", "fe90::1", "febf:ffff::1", "fec0::1", "feff::1", "ff02::1",
    "2001::1", "2001:1ff:ffff::1", "2001:db8::1", "2002:a00:1::1", "3fff::1", "3fff:fff::1", "1fff:ffff::1", "4000::1",
    "1:2:3:4:5:6:7:8:9", "2001:::1", "fe80::1%eth0", "gggg::1",
  ];
  const PUBLIC = [
    "1.1.1.1", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0", "169.253.255.255",
    "169.255.0.0", "172.15.255.255", "172.32.0.0", "192.0.1.0", "192.0.3.0", "192.167.255.255", "192.169.0.0", "198.17.255.255",
    "198.20.0.0", "223.255.255.255",
    "2000::1", "2001:200::1", "2001:4860:4860::8888", "2001:db9::1", "2003::1", "2606:4700:4700::1111", "3ffe::1", "3fff:1000::1",
  ];
  it("refuses every address inside the reserved ranges, edges included", async () => {
    const { blockedHost } = await import("@/lib/metadata");
    for (const h of BLOCKED) expect(blockedHost(h), h).toBe(true);
    for (const h of BLOCKED.filter((x) => x.includes(":") && !x.includes("%"))) expect(blockedHost(`[${h}]`), `[${h}]`).toBe(true);
  });
  it("allows the public addresses just outside them", async () => {
    const { blockedHost } = await import("@/lib/metadata");
    for (const h of PUBLIC) expect(blockedHost(h), h).toBe(false);
    for (const h of PUBLIC.filter((x) => x.includes(":"))) expect(blockedHost(`[${h}]`), `[${h}]`).toBe(false);
  });
  it("applies the same edges to DNS answers", async () => {
    const { privateRefusingLookup } = await import("@/lib/metadata");
    const answer = (address: string) => new Promise<Error | null>((done) =>
      privateRefusingLookup((_h, _o, cb) => cb(null, [{ address, family: address.includes(":") ? 6 : 4 }]))("example.com", {}, (err) => done(err)));
    for (const a of BLOCKED.filter((x) => !x.includes("%") && !x.startsWith("256") && !x.startsWith("gggg") && !x.includes(":::") && x.split(":").length < 10)) {
      expect((await answer(a))?.message, a).toMatch(/private address/);
    }
    for (const a of PUBLIC) expect(await answer(a), a).toBeNull();
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

describe("metadata guard range edges, generated", () => {
  // Written out here independently of the guard: each range's first and last address must be refused, and the
  // address just outside each edge allowed unless it falls in another listed range.
  const V4: [string, number][] = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
    ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
  ];
  const toN = (ip: string) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
  const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
  const ranges = V4.map(([ip, len]) => { const lo = toN(ip); return [lo, lo + 2 ** (32 - len) - 1] as const; });
  const listed = (n: number) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
  const v4Cases = ranges.flatMap(([lo, hi]) => [[lo, true], [hi, true], [lo - 1, listed(lo - 1)], [hi + 1, listed(hi + 1)]] as const)
    .filter(([n]) => n >= 0 && n < 2 ** 32);

  const V6: [string, boolean][] = [
    ["1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2000::", false], ["3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["4000::", true],
    ["2001::", true], ["2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2001:200::", false],
    ["2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", false], ["2001:db8::", true], ["2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2001:db9::", false],
    ["2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["2002::", true], ["2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2003::", false],
    ["3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["3fff::", true], ["3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["3fff:1000::", false],
    ["fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["fc00::", true], ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true],
    ["fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["fe80::", true], ["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["fec0::", true],
    ["ff00::", true], ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true],
  ];

  it("checks both edges of every IPv4 range and the address just outside each", async () => {
    const { blockedHost } = await import("@/lib/metadata");
    expect(v4Cases.length).toBeGreaterThanOrEqual(V4.length * 3);
    for (const [n, blocked] of v4Cases) expect(blockedHost(toIp(n)), toIp(n)).toBe(blocked);
  });
  it("checks the IPv6 range edges, as text and in brackets", async () => {
    const { blockedHost } = await import("@/lib/metadata");
    for (const [ip, blocked] of V6) { expect(blockedHost(ip), ip).toBe(blocked); expect(blockedHost(`[${ip}]`), ip).toBe(blocked); }
  });
  it("gives DNS answers the same verdicts", async () => {
    const { privateRefusingLookup } = await import("@/lib/metadata");
    const refused = (address: string) => new Promise<boolean>((done) =>
      privateRefusingLookup((_h, _o, cb) => cb(null, [{ address, family: address.includes(":") ? 6 : 4 }]))("example.com", {}, (err) => done(!!err)));
    for (const [n, blocked] of v4Cases) expect(await refused(toIp(n)), toIp(n)).toBe(blocked);
    for (const [ip, blocked] of V6) expect(await refused(ip), ip).toBe(blocked);
  });
});
