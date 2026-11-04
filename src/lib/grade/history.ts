// Rolling platform memory the narrative features need: launches by word, symbol and name (24 h),
// graduations by word (7 d) and creator launch times. Serialisable, so it lives in the kv table between cron runs.
import { words } from "./text";
const H = 3600e3, D = 24 * H;

type Serialised = { span: number; m: [string, number[]][] };

class TimeIndex {
  span: number;
  m = new Map<string, number[]>();
  constructor(span: number) { this.span = span; }
  add(key: string, t: number) { let a = this.m.get(key); if (!a) this.m.set(key, (a = [])); a.push(t); }
  count(key: string, now: number, window: number) {
    const a = this.m.get(key); if (!a) return 0;
    let n = 0;
    for (let i = a.length - 1; i >= 0; i--) { const t = a[i]; if (t > now) continue; if (t < now - window) break; n++; }
    return n;
  }
  prune(now: number) {
    for (const [k, a] of this.m) {
      let i = 0; while (i < a.length && a[i] < now - this.span) i++;
      if (i === a.length) this.m.delete(k); else if (i) a.splice(0, i);
    }
  }
  toJSON(): Serialised { return { span: this.span, m: [...this.m] }; }
  static from(o: Serialised) { const t = new TimeIndex(o.span); t.m = new Map(o.m); return t; }
}

export interface HistoryJson {
  since: number;
  wordLaunch: Serialised; wordGrad: Serialised; symbol: Serialised; name: Serialised; creator: Serialised;
  creatorGrads: [string, number][];
}

export class History {
  wordLaunch = new TimeIndex(D); wordGrad = new TimeIndex(7 * D);
  symbol = new TimeIndex(D); name = new TimeIndex(D);
  creator = new TimeIndex(D); creatorGrads = new Map<string, number>();
  since = Date.now();

  /** features for a launch at time t, computed BEFORE the launch itself is recorded */
  narrative(name: string, symbol: string, t: number) {
    const ws = words(name, symbol);
    let wl24 = 0, wl1 = 0, wg24 = 0, wg7 = 0;
    for (const w of ws) {
      wl24 = Math.max(wl24, this.wordLaunch.count(w, t, D));
      wl1 = Math.max(wl1, this.wordLaunch.count(w, t, H));
      wg24 = Math.max(wg24, this.wordGrad.count(w, t, D));
      wg7 = Math.max(wg7, this.wordGrad.count(w, t, 7 * D));
    }
    return {
      word_launches_24h: wl24, word_launches_1h: wl1, word_grads_24h: wg24, word_grads_7d: wg7, n_words: ws.length,
      same_symbol_24h: this.symbol.count((symbol ?? "").toLowerCase(), t, D),
      same_name_24h: this.name.count((name ?? "").toLowerCase(), t, D),
      _words: ws,
    };
  }
  pickWord(ws: string[], now: number) {
    let best: string | null = null, bs = -1;
    for (const w of ws) {
      const v = this.wordGrad.count(w, now, 7 * D) * 100 + this.wordLaunch.count(w, now, H);
      if (v > bs) { bs = v; best = w; }
    }
    return best;
  }
  recordLaunch(name: string, symbol: string, creator: string, t: number) {
    for (const w of words(name, symbol)) this.wordLaunch.add(w, t);
    this.symbol.add((symbol ?? "").toLowerCase(), t); this.name.add((name ?? "").toLowerCase(), t);
    if (creator) this.creator.add(creator, t);
  }
  recordGraduation(name: string, symbol: string, creator: string, t: number) {
    for (const w of words(name, symbol)) this.wordGrad.add(w, t);
    if (creator) this.creatorGrads.set(creator, (this.creatorGrads.get(creator) ?? 0) + 1);
  }
  creatorFeatures(creator: string, t: number) {
    const a = this.creator.m.get(creator) ?? [];
    const prev = a.filter((x) => x < t);
    return {
      creator_launches_24h: prev.filter((x) => x >= t - D).length,
      secs_since_creator_last: prev.length ? (t - prev[prev.length - 1]) / 1000 : null,
      creator_prior_grads: this.creatorGrads.get(creator) ?? 0,
    };
  }
  prune(now = Date.now()) { for (const x of [this.wordLaunch, this.wordGrad, this.symbol, this.name, this.creator]) x.prune(now); }
  coverageHours(now = Date.now()) { return (now - this.since) / H; }
  toJSON(): HistoryJson {
    return { since: this.since, wordLaunch: this.wordLaunch.toJSON(), wordGrad: this.wordGrad.toJSON(), symbol: this.symbol.toJSON(), name: this.name.toJSON(),
      creator: this.creator.toJSON(), creatorGrads: [...this.creatorGrads] };
  }
  static from(o: HistoryJson) {
    const h = new History(); h.since = o.since;
    h.wordLaunch = TimeIndex.from(o.wordLaunch); h.wordGrad = TimeIndex.from(o.wordGrad);
    h.symbol = TimeIndex.from(o.symbol); h.name = TimeIndex.from(o.name); h.creator = TimeIndex.from(o.creator);
    h.creatorGrads = new Map(o.creatorGrads); return h;
  }
}
