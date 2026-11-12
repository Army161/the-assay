import { describe, expect, it, vi } from "vitest";
import { envPublicKey, isProgramOwner } from "../src/lib/chain";
import { envUrl } from "../src/lib/env";
import { assertDurableDb } from "../src/lib/db";

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
  it("refuses to run mainnet on an in-memory database, and allows it on devnet, with a URL, or with a PGlite directory", () => {
    expect(() => assertDurableDb(undefined, "mainnet", undefined)).toThrow(/DATABASE_URL/);
    expect(() => assertDurableDb(undefined, ' "mainnet" ', undefined)).toThrow(/DATABASE_URL/);
    expect(() => assertDurableDb("postgres://x", "mainnet", undefined)).not.toThrow();
    expect(() => assertDurableDb(undefined, "mainnet", "/data/pg")).not.toThrow();
    expect(() => assertDurableDb(undefined, "devnet", undefined)).not.toThrow();
    expect(() => assertDurableDb(undefined, undefined, undefined)).not.toThrow();
  });
});
