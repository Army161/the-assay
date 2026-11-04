// The Assay: scores, tiers (percentile among the trailing hour of launches) and the plain-language read.
// Models were trained on 469k pump.fun launches (see the scanner README). On this launchpad the ranking is what
// transfers; the back-test odds are shown as what they are: pump.fun history, not a measurement of our coins yet.
import { loadModel, predict, type ModelJson } from "./gbm";
import launchJson from "./models/launch.json";
import m1Json from "./models/m1.json";
import m5Json from "./models/m5.json";
import tiersJson from "./models/tiers.json";

export const CHECKPOINTS = ["launch", "m1", "m5"] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];
export const CHECKPOINT_LABEL: Record<Checkpoint, string> = { launch: "At launch", m1: "At 1 minute", m5: "At 5 minutes" };
export const MODEL_VERSION = "assay-scan-2026-10-12";

const MODELS = {
  launch: loadModel(launchJson as unknown as ModelJson),
  m1: loadModel(m1Json as unknown as ModelJson),
  m5: loadModel(m5Json as unknown as ModelJson),
};

interface TierRow { tier: string; n: number; grads: number; grad_rate: number; rel_odds: number; per_fold: number[] }
export const BACKTEST = tiersJson as unknown as Record<Checkpoint, { tiers: TierRow[] }>;

export const TIERS = [
  { key: "top1", lo: 0.99, label: "Top 1%" },
  { key: "top10", lo: 0.9, label: "Top 10%" },
  { key: "top25", lo: 0.75, label: "Top 25%" },
  { key: "upper_half", lo: 0.5, label: "Upper half" },
  { key: "bottom_half", lo: 0, label: "Bottom half" },
] as const;
export type TierKey = (typeof TIERS)[number]["key"];
export const tierOf = (pct: number) => TIERS.find((t) => pct >= t.lo)!;
export const tierLabel = (key: string | null | undefined) => TIERS.find((t) => t.key === key)?.label ?? "Unread";

export function oddsText(x: number) {
  if (x >= 1.5) return `about ${x >= 10 ? Math.round(x / 5) * 5 : Math.round(x)}x the average chance`;
  if (x >= 0.8) return "about the average chance";
  if (x >= 0.4) return "about half the average chance";
  if (x >= 0.2) return "about a quarter of the average chance";
  if (x >= 0.08) return "about a tenth of the average chance";
  return "well under a tenth of the average chance";
}
export function relOdds(checkpoint: Checkpoint, tierKey: string) {
  const r = BACKTEST[checkpoint].tiers.find((t) => t.tier === tierKey)!;
  return { x: r.rel_odds, range: [Math.min(...r.per_fold), Math.max(...r.per_fold)] as [number, number], text: oddsText(r.rel_odds) };
}

const HOUR = 3600e3;
export type TierWindowJson = Record<Checkpoint, [number, number][]>;
/** Percentile of a score among this checkpoint's scores in the trailing hour (average rank, itself included). */
export class TierWindow {
  w: TierWindowJson = { launch: [], m1: [], m5: [] };
  place(checkpoint: Checkpoint, score: number, t: number) {
    const a = this.w[checkpoint]; a.push([t, score]);
    while (a.length && a[0][0] < t - HOUR) a.shift();
    let less = 0, eq = 0;
    for (const [, s] of a) { if (s < score) less++; else if (s === score) eq++; }
    return { pct: (less + (eq + 1) / 2) / a.length, n: a.length };
  }
  add(checkpoint: Checkpoint, t: number, score = -1) { this.w[checkpoint].push([t, score]); }
  toJSON() { return this.w; }
  static from(o: TierWindowJson) { const t = new TierWindow(); Object.assign(t.w, o); return t; }
}

export function score(checkpoint: Checkpoint, features: Record<string, number | null | undefined>) {
  return predict(MODELS[checkpoint], features);
}

export type SignalLevel = "good" | "note" | "warn" | "bad";
export interface Signal { level: SignalLevel; text: string; short: string }
const pctf = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

/** Plain facts behind the read, each one checkable on-chain. */
export function signals(tok: { features?: Record<string, number | null | undefined>; live?: Record<string, number> | null; word?: string | null; transferFeeBps?: number }): Signal[] {
  const s: [SignalLevel, string, string][] = [], f = tok.features ?? {}, live = tok.live;
  if (f.dev_buy_pct != null) {
    const d = f.dev_buy_pct;
    if (d === 0) s.push(["note", "Creator bought nothing at launch", "No dev buy"]);
    else s.push([d > 5 ? "warn" : "note", `Creator bought ${d.toFixed(1)}% of supply at launch (${(f.initial_buy_sol ?? 0).toFixed(2)} SOL)`, `Dev bought ${d.toFixed(1)}%`]);
  }
  const n24 = f.creator_launches_24h ?? 0;
  if (n24 >= 3) s.push(["warn", `Creator launched ${n24} other coins in the last 24 hours`, `Serial creator · ${n24} in 24h`]);
  else if (n24 > 0) s.push(["note", `Creator launched ${n24} other coin${n24 > 1 ? "s" : ""} in the last 24 hours`, `Creator: ${n24} in 24h`]);
  else if (f.secs_since_creator_last == null) s.push(["note", "First coin from this wallet on the Assay", "New creator"]);
  if ((f.creator_prior_grads ?? 0) > 0) s.push(["good", `Creator has graduated ${f.creator_prior_grads} coin${f.creator_prior_grads! > 1 ? "s" : ""} here before`, `Creator graduated ${f.creator_prior_grads} before`]);
  if ((f.same_name_24h ?? 0) >= 3) s.push(["warn", `${f.same_name_24h} other launches used this exact name in 24 hours`, `Copycat · ${f.same_name_24h} same name`]);
  const w = tok.word;
  if (w && (f.word_grads_7d ?? 0) > 0) s.push(["good", `"${w}" is in ${f.word_grads_7d} graduated name${f.word_grads_7d! > 1 ? "s" : ""} this week`, `"${w}" graduating`]);
  else if (w && (f.word_launches_1h ?? 0) >= 5) s.push(["note", `"${w}" is in ${f.word_launches_1h} launches this hour`, `"${w}" ×${f.word_launches_1h} this hour`]);
  if (tok.transferFeeBps) s.push(["note", `${tok.transferFeeBps / 100}% of every transfer goes to holders`, `Holders earn ${tok.transferFeeBps / 100}%`]);
  if (live) {
    if (live.creator_sells > 0) s.push(["bad", `Creator has sold ${live.creator_sells} time${live.creator_sells > 1 ? "s" : ""}`, "Dev sold"]);
    if (live.first2s_buy_share > 0.05) s.push(["warn", `Wallets other than the creator took ${pctf(live.first2s_buy_share)} of supply in the first 2 seconds`, `Snipers ${pctf(live.first2s_buy_share, 0)} in 2s`]);
    if (live.top3_share > 0.2) s.push(["warn", `Three wallets bought ${pctf(live.top3_share)} of supply`, `Top 3 hold ${pctf(live.top3_share, 0)}`]);
    const sol = live.buy_sol >= 10 ? live.buy_sol.toFixed(0) : live.buy_sol.toFixed(1);
    s.push([live.uniq_buyers >= 20 ? "good" : "note", `${live.uniq_buyers} different buyer${live.uniq_buyers === 1 ? "" : "s"}, ${sol} SOL in`, `${live.uniq_buyers} buyers · ${sol} SOL`]);
  }
  const order: Record<SignalLevel, number> = { bad: 0, warn: 1, good: 2, note: 3 };
  return s.map(([level, text, short]) => ({ level, text, short })).sort((a, b) => order[a.level] - order[b.level]);
}
