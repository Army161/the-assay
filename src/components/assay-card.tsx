"use client";
import Link from "next/link";
import { TierChip } from "./bits";
import { BACKTEST, CHECKPOINTS, CHECKPOINT_LABEL, tierLabel, type Checkpoint } from "@/lib/grade/assay";
import { timeAgo } from "@/lib/format";

export interface ReadingView { seq: number; t: string; checkpoint: Checkpoint; checkpointLabel: string; pct: number; tier: string; tierLabel: string; poolN: number; signals: { level: string; text: string; short: string }[]; hash: string; backtest: { x: number; range: [number, number]; text: string } }

const LEVEL: Record<string, string> = { bad: "text-down", warn: "text-amber-2", good: "text-up", note: "text-text-2" };
const DOT: Record<string, string> = { bad: "bg-down", warn: "bg-amber", good: "bg-up", note: "bg-muted" };

export function AssayCard({ readings, createdAt, now, skipped }: { readings: ReadingView[]; createdAt: string; now: number; skipped?: string[] }) {
  const latest = readings.at(-1) ?? null;
  const ageS = (now - new Date(createdAt).getTime()) / 1000;
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <div><div className="eyebrow">The Assay</div><div className="kicker">Where this launch ranks among the last hour of launches</div></div>
        {latest && <TierChip tier={latest.tier} label={latest.tierLabel} checkpoint={latest.checkpoint} size="md" />}
      </div>
      <ol className="mt-4 grid grid-cols-3 gap-2">
        {CHECKPOINTS.map((cp) => {
          const r = readings.find((x) => x.checkpoint === cp);
          const due = cp === "launch" ? 0 : cp === "m1" ? 68 : 308;
          const state = r ? "done" : skipped?.includes(cp) ? "skipped" : ageS < due ? "pending" : "soon";
          return (
            <li key={cp} className={`rounded-[10px] border p-2.5 ${r ? "border-line bg-bg-2" : "border-dashed border-line"}`}>
              <div className="kicker">{CHECKPOINT_LABEL[cp]}</div>
              {r ? (
                <>
                  <div className="font-display font-semibold mt-0.5">{r.tierLabel}</div>
                  <div className="kicker num">of {r.poolN} · <Link href={`/record/${r.seq}`} className="hover:text-amber-2 font-mono" title={r.hash}>#{r.seq}</Link></div>
                </>
              ) : state === "pending" ? (
                <div className="text-sm text-text-2 mt-0.5">in {Math.max(0, Math.ceil(due - ageS))}s</div>
              ) : state === "skipped" ? (
                <div className="text-sm text-muted mt-0.5" title="The indexer could not read this coin in time, so it is ranked below every coin that was read">not read</div>
              ) : (
                <div className="text-sm text-text-2 mt-0.5">reading…</div>
              )}
            </li>
          );
        })}
      </ol>
      {latest && (
        <>
          <ul className="mt-4 space-y-1.5">
            {latest.signals.map((s, i) => (
              <li key={i} className={`flex items-start gap-2 text-sm ${LEVEL[s.level] ?? ""}`}><span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${DOT[s.level] ?? "bg-muted"}`} />{s.text}</li>
            ))}
          </ul>
          <div className="hairline my-3" />
          <p className="text-xs text-text-2">
            On the 469k pump.fun launches the model was trained on, coins in the <b className="text-text">{latest.tierLabel}</b> {latest.checkpointLabel.toLowerCase()} graduated at <b className="text-text">{latest.backtest.text}</b>
            {" "}(folds: {latest.backtest.range[0].toFixed(1)}× to {latest.backtest.range[1].toFixed(1)}×). That is pump.fun history, not a measurement of this market yet; the live record is <Link href="/record" className="text-amber-2 hover:underline">here</Link>.
          </p>
          <p className="kicker mt-2">Sealed {timeAgo(latest.t, now)} ago · hash <span className="font-mono">{latest.hash.slice(0, 12)}…</span> · readings are sealed before the outcome is known and cannot be edited afterwards.</p>
        </>
      )}
      {!latest && <p className="text-sm text-text-2 mt-3">{skipped?.includes("launch") ? "This coin was indexed too late for an honest reading, so it ranks below every coin that was read in its hour." : "The launch reading is sealed within a minute of the creation transaction."}</p>}
      <BacktestFoot />
    </div>
  );
}

function BacktestFoot() {
  const t = BACKTEST.m5.tiers;
  return (
    <details className="mt-3">
      <summary className="kicker cursor-pointer hover:text-text">What the tiers meant on pump.fun (5-minute reading)</summary>
      <table className="table mt-2"><thead><tr><th>Tier</th><th>Launches</th><th>Graduation rate</th><th>vs. average</th></tr></thead>
        <tbody>{t.map((r) => <tr key={r.tier}><td>{tierLabel(r.tier)}</td><td className="num">{r.n.toLocaleString()}</td><td className="num">{(r.grad_rate * 100).toFixed(2)}%</td><td className="num">{r.rel_odds.toFixed(2)}×</td></tr>)}</tbody></table>
    </details>
  );
}
