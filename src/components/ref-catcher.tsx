"use client";
// `?ref=<code>` anywhere on the site is remembered for 30 days; the trade panel turns it into the caller's wallet.
import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";

export const REF_KEY = "assay_ref";
function Catcher() {
  const sp = useSearchParams();
  useEffect(() => {
    const ref = sp.get("ref");
    if (ref && /^[a-z2-9]{8}$/.test(ref)) {
      try { localStorage.setItem(REF_KEY, JSON.stringify({ code: ref, at: Date.now() })); } catch { /* private mode */ }
    }
  }, [sp]);
  return null;
}
/** useSearchParams needs a Suspense boundary so static pages can still prerender. */
export function RefCatcher() { return <Suspense fallback={null}><Catcher /></Suspense>; }
export function storedRef(): string | null {
  try {
    const raw = localStorage.getItem(REF_KEY); if (!raw) return null;
    const { code, at } = JSON.parse(raw) as { code: string; at: number };
    return Date.now() - at < 30 * 86400e3 ? code : null;
  } catch { return null; }
}
