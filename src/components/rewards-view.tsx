"use client";
// Holder rewards: every payout run across every coin, with the signatures to check.
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePoll } from "@/lib/client/api";
import { Address, Empty } from "./bits";
import { fmtSol, fmtCompact, timeAgo } from "@/lib/format";
import { FEES } from "@/lib/chain";

interface Run { id: number; mint: string; symbol: string; run_at: string; withheld_base: string; sol_lamports: string; holders: number; sigs: string[]; status?: string }

export function RewardsView() {
  const { data, loading } = usePoll<{ rewards: Run[] }>("/api/rewards?limit=100", 15000);
  const runs = data?.rewards ?? [];
  const total = runs.reduce((a, r) => a + Number(r.sol_lamports) / 1e9, 0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(id); }, []);
  return (
    <div className="pt-6 space-y-6">
      <section className="card p-6 sm:p-8 relative overflow-hidden">
        <div className="absolute -right-16 -top-24 w-64 h-64 rounded-full bg-up/10 blur-3xl pointer-events-none" />
        <div className="eyebrow mb-2">Holder rewards</div>
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight max-w-2xl">Coins that pay you for holding.</h1>
        <p className="text-text-2 mt-3 max-w-2xl">A creator can launch with a transfer fee of {FEES.holderRewardBps.filter(Boolean).map((b) => `${b / 100}%`).join(" or ")}. Every transfer of that coin withholds the fee inside the token itself (a Token-2022 rule, not a promise). About every ten minutes the rewards run collects what was withheld, sells it for SOL on the coin&apos;s own market, and sends the SOL to the top holders in proportion to what they hold.</p>
        <div className="mt-5 grid sm:grid-cols-3 gap-3">
          <Stat label="Paid out so far" value={fmtSol(total)} />
          <Stat label="Payout runs" value={String(runs.length)} />
          <Stat label="Holders paid, last run" value={runs[0] ? String(runs[0].holders) : "–"} />
        </div>
      </section>
      <section className="card p-5">
        <div className="flex items-baseline justify-between"><div className="eyebrow">Every payout</div><span className="kicker">refreshes every 15 s</span></div>
        {loading && !data ? <div className="skeleton h-32 mt-3" /> : null}
        {data && runs.length === 0 && <div className="mt-3"><Empty title="No payouts yet" body="The first run pays as soon as a reward coin has been transferred enough to be worth a transaction." /></div>}
        {runs.length > 0 && (
          <div className="overflow-x-auto mt-3">
            <table className="table"><thead><tr><th>When</th><th>Coin</th><th className="text-right">Fee collected</th><th className="text-right">SOL paid</th><th className="text-right">Holders</th><th>Transactions</th></tr></thead>
              <tbody>{runs.map((r) => (
                <tr key={r.id}>
                  <td className="kicker num" title={new Date(r.run_at).toLocaleString()}>{timeAgo(r.run_at, now)} ago{r.status === "partial" && <span className="text-amber-2" title="Some of this round is still owed; the next run pays the rest"> · partial</span>}</td>
                  <td><Link href={`/coin/${r.mint}`} className="hover:text-amber-2 font-medium">{r.symbol}</Link></td>
                  <td className="num text-right">{fmtCompact(Number(r.withheld_base) / 1e6)}</td>
                  <td className="num text-right text-up">{fmtSol(Number(r.sol_lamports) / 1e9)}</td>
                  <td className="num text-right">{r.holders}</td>
                  <td className="flex gap-2 flex-wrap">{r.sigs.slice(0, 4).map((s) => <Address key={s} value={s} kind="tx" n={3} />)}{r.sigs.length > 4 && <span className="kicker">+{r.sigs.length - 4}</span>}</td>
                </tr>))}</tbody></table>
          </div>
        )}
      </section>
      <section className="card p-5 text-sm text-text-2 space-y-2">
        <div className="eyebrow">The rules</div>
        <p>The fee is set once at creation and can never be raised. The withdraw authority is the platform wallet, which does one thing with the tokens: sells them and pays holders. Each run is a row above with the transaction signatures, so a missing payout is visible; a run marked partial stopped before paying everyone, and the next run pays the rest to the same wallets.</p>
        <p>Payouts go to the top 120 holders by balance, excluding the curve, the Raydium pool and the platform. Amounts under 0.0005 SOL are carried into the next run rather than lost to transaction fees.</p>
        <p>On a reward coin the fee applies to every transfer, including buys and sells, so quoted amounts on the trade panel are after the fee. <Link href="/how-it-works#rewards" className="text-amber-2 hover:underline">More in How it works →</Link></p>
      </section>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-[12px] border border-line bg-bg-2 p-3"><div className="kicker">{label}</div><div className="mt-0.5 font-display font-semibold text-lg">{value}</div></div>;
}
