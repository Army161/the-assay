import { describe, it, expect } from "vitest";
import { TierWindow, tierOf, oddsText, score, signals, relOdds, CHECKPOINTS, BACKTEST } from "@/lib/grade/assay";
import { liveFeatures } from "@/lib/grade/features";
import { nameFeatures } from "@/lib/grade/text";

describe("tiers", () => {
  it("places a score by percentile in the trailing hour", () => {
    const w = new TierWindow();
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 99; i++) w.place("launch", i / 100, t0 + i * 1000);
    const top = w.place("launch", 0.999, t0 + 100_000);
    expect(top.n).toBe(100); expect(top.pct).toBe(1); expect(tierOf(top.pct).key).toBe("top1");
    const mid = w.place("launch", 0.5, t0 + 101_000);
    expect(tierOf(mid.pct).key).toBe("upper_half");
    // entries older than an hour fall out
    const later = w.place("launch", 0.0, t0 + 3600e3 + 200_000);
    expect(later.n).toBe(1);
  });
  it("survives a JSON round trip", () => {
    const w = new TierWindow(); w.place("m1", 0.3, 1); w.add("m5", 2);
    const w2 = TierWindow.from(JSON.parse(JSON.stringify(w)));
    expect(w2.w.m1).toEqual([[1, 0.3]]); expect(w2.w.m5).toEqual([[2, -1]]);
  });
  it("words odds honestly", () => {
    expect(oddsText(4.2)).toBe("about 4x the average chance");
    expect(oddsText(1)).toBe("about the average chance");
    expect(oddsText(0.05)).toBe("well under a tenth of the average chance");
    for (const cp of CHECKPOINTS) for (const t of BACKTEST[cp].tiers) expect(relOdds(cp, t.tier).x).toBe(t.rel_odds);
  });
});

describe("models", () => {
  it("score every checkpoint on plain features and stays in [0,1]", () => {
    const f = { ...nameFeatures("Dog Wif Hat", "DWH", "https://x/y.json", new Date()), dev_buy_pct: 5, initial_buy_sol: 0.5, creator_launches_24h: 0, creator_prior_grads: 0 };
    for (const cp of CHECKPOINTS) { const s = score(cp, f); expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(1); }
    expect(score("launch", f)).toBe(score("launch", f)); // deterministic
  });
  it("derives live features from trades", () => {
    const t = [
      { s: 1, isBuy: true, wallet: "a", share: 0.02, sol: 0.5, priceRatio: 1, byCreator: false },
      { s: 5, isBuy: true, wallet: "b", share: 0.01, sol: 0.3, priceRatio: 1.2, byCreator: false },
      { s: 20, isBuy: false, wallet: "c", share: 0.005, sol: 0.1, priceRatio: 1.1, byCreator: true },
      { s: 400, isBuy: true, wallet: "d", share: 0.01, sol: 0.3, priceRatio: 1.5, byCreator: false },
    ];
    const f = liveFeatures(t, 60);
    expect(f.n_trades).toBe(3); expect(f.uniq_buyers).toBe(2); expect(f.creator_sells).toBe(1); expect(f.first2s_buy_share).toBeCloseTo(0.02); expect(f.max_mcap_mult).toBe(1.2);
  });
  it("writes plain signals, worst first", () => {
    const s = signals({ features: { dev_buy_pct: 12, initial_buy_sol: 1, creator_launches_24h: 4 }, live: { creator_sells: 1, first2s_buy_share: 0.1, top3_share: 0.3, buy_sol: 12, uniq_buyers: 25 }, transferFeeBps: 100 });
    expect(s[0].level).toBe("bad");
    expect(s.map((x) => x.short)).toContain("Holders earn 1%");
    expect(s.some((x) => x.short.startsWith("Serial creator"))).toBe(true);
  });
});
