// Name/symbol handling. Mirrors the scanner's model/01_build.py exactly so the trained trees keep their meaning.
const STOP = new Set(["the", "and", "coin", "token", "sol", "pump", "for", "you", "official", "inu", "meme", "with", "are", "not"]);

export function words(name: string | null | undefined, symbol: string | null | undefined) {
  const s = `${(name ?? "").toLowerCase()} ${(symbol ?? "").toLowerCase()}`;
  const out = new Set<string>();
  for (const w of s.split(/[^a-z0-9]+/)) if (w.length >= 3 && !STOP.has(w)) out.add(w);
  return [...out];
}

const len = (s: string) => [...(s ?? "")].length;

export function nameFeatures(name: string | null | undefined, symbol: string | null | undefined, uri: string | null | undefined, date: Date) {
  name = name ?? "";
  symbol = symbol ?? "";
  return {
    name_len: len(name),
    symbol_len: len(symbol),
    symbol_upper: symbol === symbol.toUpperCase() ? 1 : 0,
    symbol_digit: /[0-9]/.test(symbol) ? 1 : 0,
    name_non_ascii: /[^\x00-\x7F]/.test(name) ? 1 : 0,
    name_eq_symbol: name.toLowerCase() === symbol.toLowerCase() ? 1 : 0,
    uri_ipfs: /ipfs/.test(uri ?? "") ? 1 : 0,
    hour_utc: date.getUTCHours(),
    dow: date.getUTCDay(),
  };
}
