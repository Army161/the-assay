"use client";
import Link from "next/link";
import type { CoinCard as Card } from "@/lib/queries";
import { CoinImage, Progress, TierChip } from "./bits";
import { fmtSol, timeAgo, short, pct } from "@/lib/format";

export function CoinCard({ c, now, fresh }: { c: Card; now: number; fresh?: boolean }) {
  const graduated = !!c.graduatedAt;
  return (
    <Link href={`/coin/${c.mint}`} className={`card card-hover p-3 flex gap-3 ${fresh ? "flash" : ""}`} prefetch={false}>
      <CoinImage src={c.image} alt={c.symbol || c.name} size={64} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0">
            <div className="font-display font-semibold leading-tight truncate">{c.name || "Unnamed"} <span className="text-muted font-sans font-medium">{c.symbol}</span></div>
            <div className="kicker mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span>{timeAgo(c.createdAt, now)}</span><span>·</span><span className="font-mono">{short(c.creator)}</span>
              {c.devBuyPct > 0 && <><span>·</span><span className={c.devBuyPct > 5 ? "text-amber-2" : ""}>dev {c.devBuyPct.toFixed(1)}%</span></>}
            </div>
          </div>
          <div className="ml-auto text-right shrink-0">
            <div className="num font-semibold text-[15px]">{fmtSol(c.mcapSol, { unit: false })} <span className="text-muted text-xs font-sans">SOL mcap</span></div>
            <div className="kicker num">vol {fmtSol(c.vol24hSol, { unit: false })} · {c.trades} tx</div>
          </div>
        </div>
        {c.description && <p className="text-text-2 text-xs mt-1.5 line-clamp-1">{c.description}</p>}
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1"><Progress value={c.progress} done={graduated} /></div>
          <span className="num text-xs text-text-2 w-12 text-right">{graduated ? "100%" : pct(c.progress, 0)}</span>
        </div>
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <TierChip tier={c.tier} label={c.tierLabel} checkpoint={c.checkpoint} />
          {graduated && <span className="chip chip-up">Graduated</span>}
          {c.status === "graduating" && <span className="chip chip-up">Migrating</span>}
          {c.transferFeeBps > 0 && <span className="chip chip-info">Holders earn {c.transferFeeBps / 100}%</span>}
          {c.holders != null && <span className="chip chip-muted">{c.holders} holders</span>}
        </div>
      </div>
    </Link>
  );
}

export function CoinCardSkeleton() {
  return <div className="card p-3 flex gap-3"><div className="skeleton w-16 h-16" /><div className="flex-1 space-y-2"><div className="skeleton h-4 w-2/3" /><div className="skeleton h-3 w-1/3" /><div className="skeleton h-2 w-full mt-3" /><div className="skeleton h-4 w-1/2" /></div></div>;
}
