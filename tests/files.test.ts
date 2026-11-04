import { describe, it, expect } from "vitest";
import { validateMetadata, sniffImage, metadataJson } from "@/lib/files";

describe("metadata validation", () => {
  it("accepts a normal coin and normalises the symbol", () => {
    const m = validateMetadata({ name: "Dog Wif Hat", symbol: "dwh", image: "https://x.test/a.png", twitter: "https://x.com/dwh", holderRewardBps: 100 });
    expect(m.symbol).toBe("DWH"); expect(metadataJson(m).holderRewardBps).toBe(100); expect(metadataJson(m).extensions.twitter).toBe("https://x.com/dwh");
  });
  it("rejects what a creator should not be able to smuggle in", () => {
    expect(() => validateMetadata({ name: "x", symbol: "X", image: "javascript:alert(1)" })).toThrow(/https/);
    expect(() => validateMetadata({ name: "x", symbol: "X Y", image: "https://x.test/a.png" })).toThrow(/symbol/);
    expect(() => validateMetadata({ name: "x".repeat(40), symbol: "X", image: "https://x.test/a.png" })).toThrow(/longer/);
    expect(() => validateMetadata({ name: "x\u0007", symbol: "X", image: "https://x.test/a.png" })).toThrow(/control/);
    expect(() => validateMetadata({ name: "x", symbol: "X", image: "https://x.test/a.png", holderRewardBps: 500 })).toThrow(/holderRewardBps/);
    expect(() => validateMetadata(null)).toThrow();
  });
  it("sniffs image bytes rather than trusting the header", () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0]))).toBe("image/png");
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
  });
});
