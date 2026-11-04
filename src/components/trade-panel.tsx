"use client";
import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadMarket, quote, buy, sell, type Market } from "@/lib/client/trade";
import { storedRef } from "./ref-catcher";
import { useToast } from "./toast";
import { EXPLORER, FEES, pct as pctFee, MAINNET_OPEN, NETWORK } from "@/lib/chain";
import { fmtSol, fmtCompact } from "@/lib/format";

interface Props { mint: string; poolId: string; symbol: string; decimals: number; token2022: boolean; graduated: boolean; callerPaid: boolean; onTraded?: () => void }
const QUICK_SOL = [0.1, 0.5, 1, 2];
const QUICK_PCT = [25, 50, 75, 100];

export function TradePanel({ mint, poolId, symbol, decimals, token2022, graduated, callerPaid, onTraded }: Props) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const toast = useToast();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("0.1");
  const [slip, setSlip] = useState(3);
  const [busy, setBusy] = useState(false);
  const [market, setMarket] = useState<Market | null>(null);
  const [balance, setBalance] = useState<{ sol: number; tokens: number }>({ sol: 0, tokens: 0 });
  const [storedReferrer, setReferrer] = useState<string | null>(null);
  const [refHandle, setRefHandle] = useState<string | null>(null);
  // Callers are only paid on coins the Assay did not put in the bottom half (see CALLER_PAY_TIERS).
  const referrer = callerPaid ? storedReferrer : null;
  const closed = NETWORK === "mainnet" && !MAINNET_OPEN;

  useEffect(() => {
    const code = storedRef();
    if (!code) return;
    fetch(`/api/callers/${code}`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.wallet) { setReferrer(j.wallet); setRefHandle(j.handle); } }).catch(() => {});
  }, []);
  useEffect(() => {
    let alive = true;
    const go = () => loadMarket(connection, poolId).then((m) => { if (alive && m) setMarket(m); }).catch(() => {});
    go(); const id = setInterval(go, 6000); return () => { alive = false; clearInterval(id); };
  }, [connection, poolId]);
  useEffect(() => {
    let alive = true;
    const go = async () => {
      if (!wallet.publicKey) { if (alive) setBalance({ sol: 0, tokens: 0 }); return; }
      const sol = (await connection.getBalance(wallet.publicKey!, "confirmed")) / 1e9;
      let tokens = 0;
      try {
        const ata = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey!, false, token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
        tokens = Number((await getAccount(connection, ata, "confirmed", token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID)).amount) / 10 ** decimals;
      } catch { /* no account yet */ }
      if (alive) setBalance({ sol, tokens });
    };
    void go(); const id = setInterval(go, 8000); return () => { alive = false; clearInterval(id); };
  }, [connection, wallet.publicKey, mint, token2022, decimals, busy]);

  const n = Number(amount) || 0;
  const q = useMemo(() => { try { return market && n > 0 ? quote(market, side, n, decimals, !!referrer) : null; } catch { return null; } }, [market, side, n, decimals, referrer]);
  const totalFeePct = (FEES.platformFeeRate + FEES.creatorFeeRate + FEES.protocolFeeRate + (referrer ? FEES.callerShareRate : 0)) / 10_000;

  async function go() {
    if (!wallet.publicKey) { setVisible(true); return; }
    if (n <= 0) return;
    setBusy(true);
    try {
      const sig = side === "buy"
        ? await buy(connection, wallet, { mint, token2022, sol: n, slippageBps: slip * 100, referrer })
        : await sell(connection, wallet, { mint, token2022, tokens: n, decimals, slippageBps: slip * 100, referrer });
      toast.push({ kind: "ok", title: side === "buy" ? `Bought ${symbol}` : `Sold ${symbol}`, body: `${n} ${side === "buy" ? "SOL" : symbol} · confirmed`, href: EXPLORER(sig) });
      onTraded?.();
    } catch (e) {
      const msg = (e as Error).message || String(e);
      toast.push({ kind: "err", title: "Transaction failed", body: /User rejected/i.test(msg) ? "You cancelled in the wallet." : msg.slice(0, 240) });
    } finally { setBusy(false); }
  }

  if (graduated) {
    return (
      <div className="card p-4">
        <div className="eyebrow mb-2">Graduated</div>
        <p className="text-sm text-text-2">This coin filled its curve and now trades on Raydium. The curve is closed; trade it on <a className="text-amber-2 hover:underline" href={`https://raydium.io/swap/?inputMint=sol&outputMint=${mint}`} target="_blank" rel="noreferrer">Raydium ↗</a>.</p>
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="grid grid-cols-2 gap-1 p-1 rounded-[10px] bg-bg-2 border border-line">
        <button className={`py-2 rounded-lg text-sm font-semibold transition ${side === "buy" ? "bg-up text-[#04150b]" : "text-text-2 hover:text-text"}`} onClick={() => { setSide("buy"); setAmount("0.1"); }}>Buy</button>
        <button className={`py-2 rounded-lg text-sm font-semibold transition ${side === "sell" ? "bg-down text-[#1b0404]" : "text-text-2 hover:text-text"}`} onClick={() => { setSide("sell"); setAmount(""); }}>Sell</button>
      </div>
      <div className="mt-3 flex items-center justify-between kicker">
        <span>{side === "buy" ? "You pay" : "You sell"}</span>
        <span className="num">Balance: {side === "buy" ? fmtSol(balance.sol) : `${fmtCompact(balance.tokens)} ${symbol}`}</span>
      </div>
      <div className="mt-1 relative">
        <input className="input num pr-16 text-lg" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.0" aria-label="Amount" />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-text-2 font-semibold">{side === "buy" ? "SOL" : symbol}</span>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {side === "buy"
          ? QUICK_SOL.map((v) => <button key={v} className="btn btn-sm num" onClick={() => setAmount(String(v))}>{v} SOL</button>)
          : QUICK_PCT.map((p) => <button key={p} className="btn btn-sm num" onClick={() => setAmount(((balance.tokens * p) / 100).toFixed(decimals > 4 ? 4 : decimals).replace(/\.?0+$/, ""))}>{p}%</button>)}
      </div>
      <div className="mt-3 rounded-[10px] bg-bg-2 border border-line p-3 text-sm space-y-1.5">
        <Row k={side === "buy" ? "You receive about" : "You receive about"} v={q == null ? "–" : side === "buy" ? `${fmtCompact(q)} ${symbol}` : fmtSol(q)} strong />
        <Row k="Fees inside the trade" v={`${totalFeePct.toFixed(2)}%`} title={`Platform ${pctFee(FEES.platformFeeRate)} · creator ${pctFee(FEES.creatorFeeRate)} · Raydium ${pctFee(FEES.protocolFeeRate)}${referrer ? ` · caller ${pctFee(FEES.callerShareRate)}` : ""}`} />
        {token2022 && <Row k="Holder reward on transfer" v="paid by the coin's transfer fee" />}
        <Row k="Max slippage" v={<span className="flex gap-1">{[1, 3, 10].map((s) => <button key={s} className={`px-1.5 rounded text-xs num ${slip === s ? "bg-amber-dim text-amber-2" : "text-text-2 hover:text-text"}`} onClick={() => setSlip(s)}>{s}%</button>)}</span>} />
        {referrer && <Row k="Caller" v={<span className="text-amber-2">{refHandle ? `@${refHandle}` : referrer.slice(0, 4) + "…"} earns {pctFee(FEES.callerShareRate)}</span>} />}
        {storedReferrer && !callerPaid && <Row k="Caller" v={<span className="text-muted" title="Caller links pay only on coins outside the bottom half of their hour">not paid on this grade</span>} />}
      </div>
      <button className={`btn w-full mt-3 py-3 text-base ${side === "buy" ? "btn-up" : "btn-down"}`} disabled={busy || closed || (!!wallet.publicKey && n <= 0)} onClick={go}>
        {closed ? "Mainnet trading opens after launch" : busy ? "Confirm in wallet…" : !wallet.publicKey ? "Connect wallet" : side === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`}
      </button>
      <p className="kicker mt-2 text-center">Your wallet signs. The Assay never holds your funds.</p>
    </div>
  );
}

function Row({ k, v, strong, title }: { k: string; v: React.ReactNode; strong?: boolean; title?: string }) {
  return <div className="flex items-center justify-between gap-3" title={title}><span className="text-text-2">{k}</span><span className={`num ${strong ? "font-semibold" : ""}`}>{v}</span></div>;
}
