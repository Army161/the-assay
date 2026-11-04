"use client";
// The record: the sealed hash chain, the live grad rate by tier, and the pump.fun back-test next to it for what it is.
import Link from "next/link";
import { usePoll } from "@/lib/client/api";
import { CHECKPOINTS, CHECKPOINT_LABEL, TIERS, oddsText, type Checkpoint } from "@/lib/grade/assay";
import { Empty } from "./bits";

interface TierRec { n: number; grads: number; rel: number | null }
interface Rec {
  since: string | null; sealed: number; head: string; minAgeMin: number; model: string;
  checkpoints: Record<string, { n: number; grads: number; tiers: Record<string, TierRec> }>;
  chain: { ok: boolean; sealed: number; head: string; brokenAt: number | null };
  backtest: Record<Checkpoint, { tiers: { tier: string; n: number; grads: number; grad_rate: number; rel_odds: number; per_fold: number[] }[] }>;
}

export function RecordView() {
  const { data, loading } = usePoll<Rec>("/api/record", 30000);
  const r = data;
  return (
    <div className="pt-6 space-y-6">
      <section className="card p-6 sm:p-8 relative overflow-hidden">
        <div className="absolute -left-16 -top-24 w-64 h-64 rounded-full bg-info/10 blur-3xl pointer-events-none" />
        <div className="eyebrow mb-2">The record</div>
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight max-w-2xl">Every reading is sealed before anyone knows how the coin turns out.</h1>
        <p className="text-text-2 mt-3 max-w-2xl">Each grade is hashed into a chain the moment it is made: its position, time, mint, checkpoint, score, percentile and tier. Change one reading and every hash after it breaks. Anyone can re-run the check from the public API.</p>
        <div className="mt-5 grid sm:grid-cols-4 gap-3">
          <Stat label="Readings sealed" value={r ? String(r.sealed) : "–"} />
          <Stat label="Chain check" value={r ? (r.chain.ok ? "intact" : `broken at #${r.chain.brokenAt}`) : "–"} tone={r ? (r.chain.ok ? "up" : "down") : undefined} />
          <Stat label="Head hash" value={r ? r.head.slice(0, 12) + "…" : "–"} mono />
          <Stat label="Model" value={r ? r.model : "–"} mono />
        </div>
        {r?.since && <p className="kicker mt-3">Sealing since {new Date(r.since).toLocaleString()} · readings younger than {r.minAgeMin} minutes are not counted below, because their outcome is still open.</p>}
      </section>

      <section className="grid lg:grid-cols-2 gap-5 items-start">
        <div className="card p-5">
          <div className="eyebrow">Live record on this network</div>
          <p className="kicker mt-1">Graduation rate by tier, counting only graduations that came after the reading. A tier that graduates more often than the average has a lift above 1.0×.</p>
          {loading && !r ? <div className="skeleton h-40 mt-4" /> : null}
          {r && Object.keys(r.checkpoints).length === 0 && <div className="mt-4"><Empty title="Nothing old enough yet" body="Readings show here once they are 30 minutes old." /></div>}
          {r && CHECKPOINTS.filter((cp) => r.checkpoints[cp]).map((cp) => {
            const c = r.checkpoints[cp];
            return (
              <div key={cp} className="mt-4">
                <div className="flex items-baseline justify-between"><div className="font-display font-semibold">{CHECKPOINT_LABEL[cp]}</div><div className="kicker num">{c.grads} of {c.n} graduated · {c.n ? ((c.grads / c.n) * 100).toFixed(1) : "0"}%</div></div>
                <table className="table mt-2"><thead><tr><th>Tier</th><th className="text-right">Read</th><th className="text-right">Graduated</th><th className="text-right">Rate</th><th className="text-right">Lift</th></tr></thead>
                  <tbody>{TIERS.map((t) => { const x = c.tiers[t.key]; return (
                    <tr key={t.key}><td>{t.label}</td><td className="num text-right">{x?.n ?? 0}</td><td className="num text-right">{x?.grads ?? 0}</td><td className="num text-right">{x?.n ? ((x.grads / x.n) * 100).toFixed(1) + "%" : "–"}</td><td className="num text-right">{x?.rel == null ? "–" : `${x.rel.toFixed(2)}×`}</td></tr>); })}</tbody></table>
              </div>
            );
          })}
        </div>
        <div className="card p-5">
          <div className="eyebrow">Back-test on pump.fun history</div>
          <p className="kicker mt-1">The same models, scored on 469k pump.fun launches the models never trained on (5-fold). This is where the tiers come from. It is Solana history, not a measurement of this launchpad, and it is shown so you can see what transferred.</p>
          {r && CHECKPOINTS.map((cp) => (
            <div key={cp} className="mt-4">
              <div className="font-display font-semibold">{CHECKPOINT_LABEL[cp]}</div>
              <table className="table mt-2"><thead><tr><th>Tier</th><th className="text-right">Launches</th><th className="text-right">Grad rate</th><th className="text-right">Lift</th><th>Read as</th></tr></thead>
                <tbody>{r.backtest[cp].tiers.map((t) => (
                  <tr key={t.tier}><td>{TIERS.find((x) => x.key === t.tier)?.label ?? t.tier}</td><td className="num text-right">{t.n.toLocaleString()}</td><td className="num text-right">{(t.grad_rate * 100).toFixed(2)}%</td><td className="num text-right" title={`per fold: ${t.per_fold.map((f) => f.toFixed(2)).join(", ")}`}>{t.rel_odds.toFixed(2)}×</td><td className="kicker">{oddsText(t.rel_odds)}</td></tr>))}</tbody></table>
            </div>
          ))}
        </div>
      </section>

      <section className="card p-5">
        <div className="eyebrow">Check it yourself</div>
        <ol className="mt-2 text-sm text-text-2 space-y-2 list-decimal pl-5 max-w-3xl">
          <li>Fetch any reading: <code className="font-mono text-text">/api/record/&lt;seq&gt;</code>. It returns the sealed body, the previous hash, the stored hash, and the hash recomputed on the spot.</li>
          <li>The rule is one line: <code className="font-mono text-text">sha256(prev + JSON.stringify(&#123;seq, t, mint, checkpoint, score, pct, tier, model&#125;))</code>, with <code className="font-mono text-text">prev</code> = the hash of the reading before it and sixty-four zeros for the first.</li>
          <li>Fetch <code className="font-mono text-text">/api/record</code> for the head hash and the chain check across every reading. Compare the head with one you saved earlier: it can only grow forward.</li>
        </ol>
        <p className="kicker mt-3">Readings are percentiles among the hour&apos;s launches, not predictions. A top-tier reading on a dead hour is still a weak coin. <Link href="/how-it-works" className="text-amber-2 hover:underline">How the grade is made →</Link></p>
      </section>
    </div>
  );
}

function Stat({ label, value, tone, mono }: { label: string; value: string; tone?: "up" | "down"; mono?: boolean }) {
  return <div className="rounded-[12px] border border-line bg-bg-2 p-3"><div className="kicker">{label}</div><div className={`mt-0.5 font-display font-semibold text-lg truncate ${mono ? "font-mono text-sm pt-1" : ""} ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : ""}`} title={value}>{value}</div></div>;
}
