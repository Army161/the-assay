// Live trade features at a checkpoint (60 s or 300 s). Mirrors the scanner's features.js / model/01_build.py live().
export interface LiveTrade {
  /** seconds since the coin was created */
  s: number;
  isBuy: boolean;
  wallet: string | null;
  /** fraction of total supply moved */
  share: number;
  sol: number | null;
  /** trade price / launch price */
  priceRatio: number | null;
  byCreator: boolean;
}

export const LIVE = [
  "n_trades", "n_buys", "n_sells", "uniq_buyers", "uniq_sellers", "buy_sol", "sell_sol", "creator_sells",
  "max_mcap_mult", "last_mcap_mult", "last_trade_s", "max_early_buy_share", "first2s_buy_share", "top_holder_share", "top3_share", "held_share",
] as const;

export type LiveFeatures = Record<(typeof LIVE)[number], number>;

export function liveFeatures(trades: LiveTrade[], h: number): LiveFeatures {
  const t = trades.filter((x) => x.s <= h);
  if (!t.length)
    return {
      n_trades: 0, n_buys: 0, n_sells: 0, uniq_buyers: 0, uniq_sellers: 0, buy_sol: 0, sell_sol: 0, creator_sells: 0,
      max_mcap_mult: 1, last_mcap_mult: 1, last_trade_s: -1, max_early_buy_share: 0, first2s_buy_share: 0, top_holder_share: 0, top3_share: 0, held_share: 0,
    };
  const buyers = new Set<string>(), sellers = new Set<string>(), net = new Map<string, number>();
  let nb = 0, ns = 0, bs = 0, ss = 0, cs = 0, maxm = -Infinity, last = t[0], early: number | null = null, f2 = 0;
  for (const x of t) {
    if (x.isBuy) { nb++; if (x.wallet) buyers.add(x.wallet); if (x.sol != null) bs += x.sol; }
    else { ns++; if (x.wallet) sellers.add(x.wallet); if (x.sol != null) ss += x.sol; if (x.byCreator) cs++; }
    if (x.priceRatio != null && x.priceRatio > maxm) maxm = x.priceRatio;
    if (x.s >= last.s) last = x;
    if (x.s <= 7.5 && x.isBuy) early = early === null ? x.share : Math.max(early, x.share);
    if (x.s <= 2 && x.isBuy && !x.byCreator) f2 += x.share;
    if (x.wallet) net.set(x.wallet, (net.get(x.wallet) ?? 0) + (x.isBuy ? x.share : -x.share));
  }
  const nets = [...net.values()].sort((a, b) => b - a);
  return {
    n_trades: t.length, n_buys: nb, n_sells: ns, uniq_buyers: buyers.size, uniq_sellers: sellers.size, buy_sol: bs, sell_sol: ss,
    creator_sells: cs, max_mcap_mult: maxm === -Infinity ? 1 : maxm, last_mcap_mult: last.priceRatio ?? 1, last_trade_s: Math.max(...t.map((x) => x.s)),
    max_early_buy_share: early ?? 0, first2s_buy_share: f2,
    top_holder_share: nets.length ? nets[0] : 0,
    top3_share: nets.slice(0, 3).reduce((a, b) => a + b, 0),
    held_share: nets.filter((v) => v > 0).reduce((a, b) => a + b, 0),
  };
}

export const suffix = (f: Record<string, number>, sfx: string) =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [`${k}_${sfx}`, v]));
