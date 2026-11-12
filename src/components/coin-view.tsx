"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePoll } from "@/lib/client/api";
import { CoinImage, Progress, TierChip, Address, Price, Empty } from "./bits";
import { Chart, type Candle } from "./chart";
import { TradePanel } from "./trade-panel";
import { CreatorFees } from "./creator-fees";
import { AssayCard, type ReadingView } from "./assay-card";
import { fmtSol, fmtCompact, timeAgo, short, pct } from "@/lib/format";
import { EXPLORER, FEES } from "@/lib/chain";

interface Coin {
  mint: string; poolId: string; name: string; symbol: string; image: string | null; description: string | null; creator: string; createdAt: string; status: string; graduatedAt: string | null;
  priceSol: number; mcapSol: number; progress: number; volSol: number; vol24hSol: number; trades: number; holders: number | null; devBuyPct: number; transferFeeBps: number;
  tier: string | null; tierLabel: string; checkpoint: string | null; socials: Record<string, string | null>; uri: string; decimals: number; supply: string; token2022: boolean;
  fundTargetLamports: string; realBLamports: string; top10Share: number | null; readings: ReadingView[]; createSig: string | null; callerPaid: boolean; skipped: string[];
}
interface Trade { sig: string; ts: string; side: "buy" | "sell"; wallet: string; sol: number; tokens: string; priceSol: number; referrer: string | null }
interface Holder { account: string; owner: string | null; amount: string; share: number; label: string | null }
interface Holders { holders: Holder[]; count: number | null; top10Share: number | null; stale?: boolean }

export function CoinView({ mint }: { mint: string }) {
  const [now, setNow] = useState(() => Date.now());
  const [bump, setBump] = useState(0);
  const [res, setRes] = useState(60);
  const { data: coin, error } = usePoll<Coin>(`/api/coins/${mint}`, 4000, [bump]);
  const { data: tr } = usePoll<{ trades: Trade[] }>(`/api/coins/${mint}/trades?limit=80`, 4000, [bump]);
  const { data: cd } = usePoll<{ candles: Candle[] }>(`/api/coins/${mint}/candles?res=${res}`, 6000, [bump, res]);
  const { data: ho } = usePoll<Holders>(coin ? `/api/coins/${mint}/holders` : null, 30000);
  const { data: rw } = usePoll<{ rewards: { run_at: string; sol_lamports: string; holders: number; sigs: string[]; status?: string }[] }>(coin?.transferFeeBps ? `/api/rewards?mint=${mint}` : null, 30000);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const graduated = !!coin?.graduatedAt;
  const supply = useMemo(() => (coin ? Number(coin.supply) / 10 ** coin.decimals : 0), [coin]);

  if (error === "404") return <div className="pt-10"><Empty title="Not on the board yet" body="If this mint was just created on The Assay it will appear within a minute, once the indexer sees the pool. This page refreshes itself." /></div>;
  if (!coin) return <div className="pt-6 grid lg:grid-cols-[1fr_380px] gap-5"><div className="space-y-3"><div className="skeleton h-20" /><div className="skeleton h-80" /></div><div className="skeleton h-96" /></div>;

  const socials = Object.entries(coin.socials).filter(([, v]) => v) as [string, string][];
  return (
    <div className="pt-5">
      <div className="kicker mb-3"><Link href="/" className="hover:text-text">Board</Link> / <span className="text-text-2">{coin.symbol}</span></div>
      <div className="card p-4 sm:p-5 flex flex-wrap gap-4 items-center">
        <CoinImage src={coin.image} alt={coin.symbol || coin.name} size={72} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="font-display text-2xl font-bold tracking-tight">{coin.name}</h1><span className="text-text-2 text-lg">{coin.symbol}</span>
            <TierChip tier={coin.tier} label={coin.tierLabel} checkpoint={coin.checkpoint} />
            {graduated && <span className="chip chip-up">Graduated</span>}
            {coin.status === "graduating" && <span className="chip chip-up">Migrating to Raydium</span>}
            {coin.transferFeeBps > 0 && <span className="chip chip-info">Holders earn {coin.transferFeeBps / 100}% of every transfer</span>}
          </div>
          {coin.description && <p className="text-text-2 text-sm mt-1 max-w-2xl">{coin.description}</p>}
          <div className="mt-2 flex items-center gap-3 flex-wrap kicker">
            <span>Created {timeAgo(coin.createdAt, now)} ago by <Address value={coin.creator} /></span>
            <span>Mint <Address value={coin.mint} /></span>
            {coin.createSig && <a className="hover:text-text" href={EXPLORER(coin.createSig)} target="_blank" rel="noreferrer">creation tx ↗</a>}
            {socials.map(([k, v]) => <a key={k} className="chip chip-muted hover:text-text" href={/^https:\/\//.test(v) ? v : "#"} target="_blank" rel="noreferrer nofollow">{k}</a>)}
          </div>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-x-5 gap-y-2 w-full lg:w-auto">
          <Stat label="Price" value={<Price value={coin.priceSol} />} />
          <Stat label="Market cap" value={`${fmtSol(coin.mcapSol, { unit: false })} SOL`} />
          <Stat label="Volume 24h" value={`${fmtSol(coin.vol24hSol, { unit: false })} SOL`} />
          <Stat label="Trades" value={String(coin.trades)} />
          <Stat label="Holders" value={ho?.count != null ? String(ho.count) : coin.holders != null ? String(coin.holders) : "–"} />
          <Stat label="Top 10 hold" value={ho?.top10Share != null ? pct(ho.top10Share, 0) : coin.top10Share != null ? pct(coin.top10Share, 0) : "–"} />
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_380px] gap-5 mt-5 items-start">
        <div className="space-y-5 min-w-0">
          <div className="card p-3">
            <div className="flex items-center gap-2 px-1">
              <span className="kicker">Bonding curve</span>
              <div className="flex-1"><Progress value={coin.progress} done={graduated} /></div>
              <span className="num text-sm">{graduated ? "100%" : pct(coin.progress, 1)}</span>
              <span className="kicker num hidden sm:inline">{fmtSol(Number(coin.realBLamports) / 1e9)} of {fmtSol(Number(coin.fundTargetLamports) / 1e9)}</span>
            </div>
            <div className="flex items-center gap-1 mt-3 px-1">
              {[[15, "15s"], [60, "1m"], [300, "5m"], [900, "15m"], [3600, "1h"]].map(([v, l]) => <button key={v} className="tab btn-sm" data-active={res === v} aria-pressed={res === v} onClick={() => setRes(v as number)}>{l}</button>)}
              <span className="ml-auto kicker">SOL per {coin.symbol}</span>
            </div>
            {cd && cd.candles.length > 0 ? <Chart candles={cd.candles} /> : <div className="h-[320px] flex items-center justify-center kicker">{cd ? "No trades yet" : "Loading chart…"}</div>}
          </div>

          <div className="card">
            <div className="flex items-center justify-between px-4 pt-3"><div className="eyebrow">Trades</div><span className="kicker"><span className="live-dot inline-block mr-1.5 align-middle" />live</span></div>
            <div className="overflow-x-auto">
              <table className="table mt-2">
                <thead><tr><th>Age</th><th>Side</th><th className="text-right">SOL</th><th className="text-right">{coin.symbol}</th><th className="text-right">Price</th><th>Wallet</th><th>Via</th><th>Tx</th></tr></thead>
                <tbody>
                  {tr?.trades.map((t) => (
                    <tr key={t.sig}>
                      <td className="num text-text-2">{timeAgo(t.ts, now)}</td>
                      <td><span className={`chip ${t.side === "buy" ? "chip-up" : "chip-down"}`}>{t.side}</span></td>
                      <td className="num text-right">{fmtSol(t.sol, { unit: false })}</td>
                      <td className="num text-right">{fmtCompact(Number(t.tokens) / 10 ** coin.decimals)}</td>
                      <td className="text-right"><Price value={t.priceSol} /></td>
                      <td><Address value={t.wallet} />{t.wallet === coin.creator && <span className="chip chip-amber ml-1">dev</span>}</td>
                      <td className="kicker">{t.referrer ? <span className="text-amber-2" title={t.referrer}>caller</span> : ""}</td>
                      <td><Address value={t.sig} kind="tx" n={3} /></td>
                    </tr>
                  ))}
                  {tr && tr.trades.length === 0 && <tr><td colSpan={8} className="kicker text-center py-6">No trades yet</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <TradePanel mint={coin.mint} poolId={coin.poolId} symbol={coin.symbol} decimals={coin.decimals} token2022={coin.token2022} graduated={graduated || coin.status === "graduating"} callerPaid={coin.callerPaid} onTraded={() => setTimeout(() => setBump((b) => b + 1), 2500)} />
          <AssayCard readings={coin.readings} createdAt={coin.createdAt} now={now} skipped={coin.skipped} />
          <div className="card p-4">
            <div className="eyebrow">Holders</div>
            <ul className="mt-2 space-y-1.5 text-sm">
              {ho?.holders.slice(0, 12).map((h) => (
                <li key={h.account} className="flex items-center gap-2">
                  <span className="flex-1 min-w-0"><Address value={h.owner ?? h.account} /> {h.label === "pool" && <span className="chip chip-muted">curve</span>}{h.label === "amm" && <span className="chip chip-muted">raydium</span>}{h.label === "creator" && <span className="chip chip-amber">dev</span>}</span>
                  <span className="num text-text-2 w-16 text-right">{pct(h.share, 2)}</span>
                  <span className="w-20 progress"><i style={{ width: `${Math.min(100, h.share * 100 * 4)}%` }} /></span>
                </li>
              ))}
              {!ho && <li className="kicker">Loading…</li>}
              {ho && ho.holders.length === 0 && <li className="kicker">{ho.stale ? "Holder list unavailable right now (RPC busy). It refreshes on its own." : "No holders yet"}</li>}
            </ul>
            <p className="kicker mt-2">Supply {fmtCompact(supply)} {coin.symbol} · {fmtCompact(Number(coin.supply) / 10 ** coin.decimals * 0.7931)} on the curve, the rest seeds the Raydium pool.</p>
          </div>
          {coin.transferFeeBps > 0 && (
            <div className="card p-4">
              <div className="eyebrow">Holder rewards</div>
              <p className="text-sm text-text-2 mt-1">{coin.transferFeeBps / 100}% of every transfer of {coin.symbol} is withheld by the token itself, harvested, sold for SOL and paid to holders pro rata every few minutes once enough has accumulated.</p>
              <ul className="mt-2 space-y-1 text-sm">
                {rw?.rewards.slice(0, 5).map((r, i) => <li key={i} className="flex justify-between"><span className="kicker">{timeAgo(r.run_at, now)} ago · {r.holders} holders{r.status === "partial" && <span className="text-amber-2"> · partial</span>}</span><span className="num text-up">+{fmtSol(Number(r.sol_lamports) / 1e9)}</span></li>)}
                {rw && rw.rewards.length === 0 && <li className="kicker">No payout yet. The first one happens after the first 0.005% of supply has been withheld.</li>}
              </ul>
            </div>
          )}
          <CreatorFees creator={coin.creator} />
          <div className="card p-4 text-xs text-text-2 space-y-1">
            <div className="eyebrow mb-1">Fees on this coin</div>
            <div className="flex justify-between"><span>Platform</span><span className="num">{(FEES.platformFeeRate / 10_000).toFixed(2)}%</span></div>
            <div className="flex justify-between"><span>Creator, paid to {short(coin.creator)}</span><span className="num">{(FEES.creatorFeeRate / 10_000).toFixed(2)}%</span></div>
            <div className="flex justify-between"><span>Raydium</span><span className="num">{(FEES.protocolFeeRate / 10_000).toFixed(2)}%</span></div>
            <div className="flex justify-between"><span>Caller, only on trades through a caller link</span><span className="num">{(FEES.callerShareRate / 10_000).toFixed(2)}%</span></div>
            <div className="flex justify-between"><span>At graduation</span><span className="num">LP 80% burned · 20% locked</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><div className="kicker uppercase tracking-wider text-[0.65rem] font-semibold">{label}</div><div className="num font-semibold text-[15px] mt-0.5">{value}</div></div>;
}
