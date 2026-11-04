"use client";
// Tiny polling fetch hook. Every list on the site refreshes itself; nothing here is a websocket, so a public RPC is enough.
import { useEffect, useRef, useState } from "react";

export function usePoll<T>(url: string | null, intervalMs = 5000, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const tick = useRef(0);
  useEffect(() => {
    if (!url) return;
    let alive = true; const me = ++tick.current;
    const go = async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!alive || me !== tick.current) return;
        if (!r.ok) { setError(`${r.status}`); setLoading(false); return; }
        setData((await r.json()) as T); setError(null); setLoading(false);
      } catch (e) { if (alive) { setError((e as Error).message); setLoading(false); } }
    };
    void go();
    const id = setInterval(() => { if (document.visibilityState === "visible") void go(); }, intervalMs);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, intervalMs, ...deps]);
  return { data, error, loading, refresh: () => setData((d) => d) };
}
