// Reading values pasted into a hosting dashboard. A stray space, quotes, a missing "https://" or a bare API key must not
// crash the build or every page: a bad value is reported in the logs and the safe default is used instead.

/** Trim whitespace and one pair of surrounding quotes. Blank means unset. */
export function cleanEnv(v: string | undefined): string | undefined {
  const t = v?.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  return t ? t : undefined;
}

/**
 * An http(s) URL from the environment, or `fallback` when it is unset or unusable. A host pasted without its scheme
 * ("devnet.helius-rpc.com/?api-key=…") gets https:// added; anything else that is not a URL (a bare API key, say) is
 * logged by variable name and replaced by the fallback.
 */
export function envUrl(name: string, raw: string | undefined, fallback: string): string {
  const v = cleanEnv(raw);
  if (!v) return fallback;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : /^[^\s/]+\.[^\s/]+/.test(v) ? `https://${v}` : v;
  try {
    const u = new URL(candidate);
    if (u.protocol === "http:" || u.protocol === "https:") return candidate;
  } catch {
    // reported below
  }
  console.error(`[config] ${name} is not an http(s) URL; using ${fallback} instead.`);
  return fallback;
}
