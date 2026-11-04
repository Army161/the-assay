import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { hashRow, GENESIS } from "@/lib/ledger";
import { CHECKPOINT_LABEL, tierLabel, relOdds, type Checkpoint } from "@/lib/grade/assay";
import { EXPLORER } from "@/lib/chain";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sealed reading" };

const FEATURE_LABEL: Record<string, string> = {
  dev_buy_pct: "Creator buy, % of supply", initial_buy_sol: "Creator buy, SOL", creator_launches_24h: "Creator launches, 24h", creator_prior_grads: "Creator prior graduations",
  secs_since_creator_last: "Seconds since creator's last launch", same_name_24h: "Same name, 24h", word_grads_7d: "Name word in graduations, 7d", word_launches_1h: "Name word in launches, 1h",
  uniq_buyers: "Unique buyers", buy_sol: "SOL bought", creator_sells: "Creator sells", first2s_buy_share: "Non-creator buys in first 2s, share", top3_share: "Top 3 wallets, share",
};

export default async function ReadingPage({ params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  if (!/^\d{1,12}$/.test(seq)) return <div className="pt-10 card p-8 text-center">That is not a reading number.</div>;
  const db = await getDb();
  const r = await db.one<Record<string, unknown>>(
    "select r.*, extract(epoch from r.t) * 1000 as t_ms, c.name, c.symbol, c.image, c.graduated_at from readings r join coins c on c.mint = r.mint where r.seq = $1", [Number(seq)]);
  if (!r) return <div className="pt-10 card p-8 text-center">No reading #{seq} yet. <Link className="text-amber-2 hover:underline" href="/record">Back to the record</Link></div>;
  const body = { seq: Number(r.seq), t: Math.round(Number(r.t_ms)), mint: r.mint as string, checkpoint: r.checkpoint as string, score: Number(r.score), pct: Number(r.pct), tier: r.tier as string, model: r.model as string };
  const recomputed = hashRow(r.prev as string, body);
  const valid = recomputed === r.hash;
  const cp = body.checkpoint as Checkpoint;
  const odds = relOdds(cp, body.tier);
  const features = (r.features ?? {}) as Record<string, number | null>;
  const signals = (r.signals ?? []) as { level: string; text: string }[];
  const gradAfter = r.graduated_at ? new Date(String(r.graduated_at)).getTime() >= body.t : false;
  return (
    <div className="pt-6 max-w-3xl mx-auto space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/record" className="btn btn-sm btn-ghost">← The record</Link>
        <span className="kicker">Reading <span className="font-mono text-text">#{body.seq}</span></span>
        <span className={`chip ${valid ? "chip-up" : "chip-down"} ml-auto`}>{valid ? "hash verified" : "hash mismatch"}</span>
      </div>
      <section className="card p-6">
        <div className="eyebrow">{CHECKPOINT_LABEL[cp] ?? cp}</div>
        <h1 className="font-display text-2xl font-bold mt-1"><Link href={`/coin/${body.mint}`} className="hover:text-amber-2">{String(r.name)} <span className="text-text-2 font-normal">{String(r.symbol)}</span></Link></h1>
        <div className="mt-4 grid sm:grid-cols-3 gap-3">
          <Cell k="Tier" v={tierLabel(body.tier)} />
          <Cell k="Percentile in its hour" v={`${(body.pct * 100).toFixed(1)}%`} sub={`among ${Number(r.pool_n)} launches`} />
          <Cell k="Sealed at" v={new Date(body.t).toLocaleString()} />
        </div>
        <p className="text-sm text-text-2 mt-4">On pump.fun history, this tier at this checkpoint graduated at {odds.text} (lift {odds.x.toFixed(2)}×, folds {odds.range[0].toFixed(2)}–{odds.range[1].toFixed(2)}×). {r.graduated_at ? (gradAfter ? "This coin graduated after the reading." : "This coin had already graduated when it was read.") : "This coin has not graduated."}</p>
      </section>
      {signals.length > 0 && (
        <section className="card p-5">
          <div className="eyebrow">What the reading saw</div>
          <ul className="mt-2 text-sm space-y-1.5">{signals.map((s, i) => <li key={i} className={s.level === "bad" ? "text-down" : s.level === "warn" ? "text-amber-2" : s.level === "good" ? "text-up" : "text-text-2"}>• {s.text}</li>)}</ul>
        </section>
      )}
      <section className="card p-5">
        <div className="eyebrow">Inputs</div>
        <table className="table mt-2"><tbody>{Object.entries(features).map(([k, v]) => <tr key={k}><td className="text-text-2">{FEATURE_LABEL[k] ?? k}</td><td className="num text-right">{v == null ? "–" : typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(4)) : String(v)}</td></tr>)}</tbody></table>
      </section>
      <section className="card p-5">
        <div className="eyebrow">The seal</div>
        <dl className="mt-2 text-xs font-mono space-y-2 break-all">
          <div><dt className="kicker font-sans">Body hashed</dt><dd className="text-text-2">{JSON.stringify(body)}</dd></div>
          <div><dt className="kicker font-sans">Previous hash {r.prev === GENESIS ? "(genesis)" : ""}</dt><dd className="text-text-2">{String(r.prev)}</dd></div>
          <div><dt className="kicker font-sans">Stored hash</dt><dd className="text-text">{String(r.hash)}</dd></div>
          <div><dt className="kicker font-sans">Recomputed now</dt><dd className={valid ? "text-up" : "text-down"}>{recomputed}</dd></div>
        </dl>
        <p className="kicker mt-3">sha256(prev + JSON.stringify(body)). Raw JSON: <a className="text-amber-2 hover:underline" href={`/api/record/${body.seq}`} target="_blank" rel="noreferrer">/api/record/{body.seq}</a> · mint <a className="text-amber-2 hover:underline" href={EXPLORER(body.mint, "address")} target="_blank" rel="noreferrer">on Solscan ↗</a></p>
      </section>
    </div>
  );
}
function Cell({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return <div className="rounded-[12px] border border-line bg-bg-2 p-3"><div className="kicker">{k}</div><div className="font-display font-semibold text-lg mt-0.5">{v}</div>{sub && <div className="kicker num">{sub}</div>}</div>;
}
