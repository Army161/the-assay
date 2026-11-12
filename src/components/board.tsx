"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { CoinCard as Card, Sort } from "@/lib/queries";
import { usePoll } from "@/lib/client/api";
import { CoinCard, CoinCardSkeleton } from "./coin-card";
import { Empty } from "./bits";
import { fmtSol, fmtCompact } from "@/lib/format";

const TABS: { key: Sort; label: string; hint: string }[] = [
  { key: "new", label: "New", hint: "Newest launches first" },
  { key: "trending", label: "Trending", hint: "Most SOL traded in 24 hours" },
  { key: "graduating", label: "Graduating", hint: "Closest to filling the curve" },
  { key: "top", label: "Top graded", hint: "Best Assay readings first" },
  { key: "graduated", label: "Graduated", hint: "Trading on Raydium" },
];

interface Stats { coins: number; graduated: number; coins24h: number; volumeSol: number; volume24hSol: number; trades: number; readings: number; callers: number; feesSol: { platform: number; creators: number } }

export function Board() {
  const [sort, setSort] = useState<Sort>("new");
  const [q, setQ] = useState("");
  const [live, setLive] = useState<"all" | "live">("all");
  const [now, setNow] = useState(() => Date.now());
  const url = useMemo(() => `/api/coins?sort=${sort}&limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}${live === "live" ? "&status=live" : ""}`, [sort, q, live]);
  const { data, loading } = usePoll<{ coins: Card[] }>(url, 4000);
  const stats = usePoll<Stats>("/api/stats", 15000).data;
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.coins.map((c) => c.mint));
    if (seen.current) { const f = new Set([...ids].filter((m) => !seen.current!.has(m))); if (f.size) { setFresh(f); setTimeout(() => setFresh(new Set()), 2000); } }
    seen.current = ids;
  }, [data]);

  return (
    <div className="pt-6">
      <section className="grid lg:grid-cols-[1.3fr_1fr] gap-5 items-stretch">
        <div className="card p-6 sm:p-8 relative overflow-hidden">
          <div className="absolute -right-20 -top-24 w-72 h-72 rounded-full bg-amber/10 blur-3xl pointer-events-none" />
          <div className="eyebrow mb-3">The fair-launch mint, graded</div>
          <h1 className="font-display text-3xl sm:text-[2.6rem] leading-[1.05] font-bold tracking-tight max-w-xl">Coins are graded live in their first minutes.<br /><span className="text-amber-2">Every reading is sealed</span> before anyone knows how it ends.</h1>
          <p className="text-text-2 mt-4 max-w-lg">Launch on Raydium&apos;s curve with one click. The Assay reads launches at 0, 1 and 5 minutes against the last hour of launches (if a reading cannot be made in time, that checkpoint is skipped), pays callers on-chain in the same transaction as the trade, and routes a share of every transfer to holders.</p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href="/create" className="btn btn-amber">Launch a coin</Link>
            <Link href="/callers" className="btn">Become a caller</Link>
            <Link href="/how-it-works" className="btn btn-ghost">How fees work →</Link>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Coins launched" value={stats ? fmtCompact(stats.coins) : "–"} sub={stats ? `${stats.coins24h} today` : ""} />
          <Stat label="Graduated to Raydium" value={stats ? fmtCompact(stats.graduated) : "–"} sub={stats && stats.coins ? `${((stats.graduated / stats.coins) * 100).toFixed(0)}% of launches` : ""} />
          <Stat label="Volume, 24h" value={stats ? fmtSol(stats.volume24hSol, { unit: false }) : "–"} sub="SOL on the curve" />
          <Stat label="Readings sealed" value={stats ? fmtCompact(stats.readings) : "–"} sub={<Link href="/record" className="text-amber-2 hover:underline">verify the chain →</Link>} />
        </div>
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 flex-wrap" role="tablist">
            {TABS.map((t) => <button key={t.key} role="tab" className="tab" aria-selected={sort === t.key} title={t.hint} onClick={() => setSort(t.key)}>{t.label}</button>)}
          </div>
          <div className="ml-auto flex items-center gap-2 w-full sm:w-auto">
            <label className="flex items-center gap-1.5 text-xs text-text-2 cursor-pointer select-none"><input type="checkbox" className="accent-amber" checked={live === "live"} onChange={(e) => setLive(e.target.checked ? "live" : "all")} /> On the curve only</label>
            <input className="input sm:w-64" placeholder="Search name, symbol or mint" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search coins" />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3 kicker"><span className="live-dot" /> Live · refreshes every 4 s · {TABS.find((t) => t.key === sort)?.hint}</div>
        <div className="grid gap-3 mt-3 sm:grid-cols-2 xl:grid-cols-3">
          {loading && !data ? Array.from({ length: 6 }).map((_, i) => <CoinCardSkeleton key={i} />) : null}
          {data?.coins.map((c) => <CoinCard key={c.mint} c={c} now={now} fresh={fresh.has(c.mint)} />)}
        </div>
        {data && data.coins.length === 0 && <Empty title={q ? "Nothing matches" : "No coins yet"} body={q ? "Try a different name or paste a mint address." : "The first launch on this network will show here within a minute of its transaction."} />}
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return <div className="card p-4 flex flex-col justify-between"><div className="kicker uppercase tracking-wider text-[0.68rem] font-semibold">{label}</div><div className="num font-display text-2xl sm:text-3xl mt-2 font-semibold">{value}</div><div className="kicker mt-1">{sub}</div></div>;
}
