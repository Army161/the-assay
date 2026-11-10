import { describe, expect, it, vi } from "vitest";
import { envPublicKey } from "../src/lib/chain";

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
});
