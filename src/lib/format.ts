// Number and time formatting for the UI. SOL amounts carry their unit; prices use subscript zeros like GMGN.
export function fmtSol(n: number, opts: { digits?: number; unit?: boolean } = {}) {
  const unit = opts.unit !== false ? " SOL" : "";
  if (!Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 1000) return `${(n / 1000).toFixed(a >= 10_000 ? 1 : 2)}K${unit}`;
  if (a >= 100) return `${n.toFixed(opts.digits ?? 1)}${unit}`;
  if (a >= 1) return `${n.toFixed(opts.digits ?? 2)}${unit}`;
  if (a >= 0.001) return `${n.toFixed(opts.digits ?? 3)}${unit}`;
  if (a === 0) return `0${unit}`;
  return `${n.toFixed(opts.digits ?? 5)}${unit}`;
}

export function fmtCompact(n: number) {
  if (!Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (Number.isInteger(n)) return String(n);
  if (a >= 1) return n.toFixed(a >= 100 ? 0 : 1);
  return n.toFixed(2);
}

/** Price with leading zeros folded: 0.000000589 -> 0.0₆589 */
export function fmtPrice(p: number): { text: string; sub?: { zeros: number; digits: string } } {
  if (!Number.isFinite(p) || p <= 0) return { text: "–" };
  if (p >= 0.01) return { text: p.toPrecision(4).replace(/\.?0+$/, "") };
  const s = p.toFixed(18);
  const m = /^0\.(0+)(\d+)/.exec(s);
  if (!m) return { text: p.toExponential(2) };
  const zeros = m[1].length, digits = m[2].slice(0, 4).replace(/0+$/, "") || "0";
  return { text: `0.0`, sub: { zeros, digits } };
}

export function timeAgo(iso: string | number | Date, now = Date.now()) {
  const t = typeof iso === "number" ? iso : new Date(iso).getTime();
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export const short = (addr: string, n = 4) => (addr.length > n * 2 + 1 ? `${addr.slice(0, n)}…${addr.slice(-n)}` : addr);
export const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
