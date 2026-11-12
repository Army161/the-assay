"use client";
import { useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { activateCallerPayouts, watchCallerPayouts } from "@/lib/client/trade";
import { EXPLORER } from "@/lib/chain";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { usePoll } from "@/lib/client/api";
import { registrationMessage } from "@/lib/callers-shared";
import { sendErrorToast, useToast } from "./toast";
import { Address } from "./bits";
import { fmtSol, short } from "@/lib/format";
import { FEES, CALLER_PAY_TIERS } from "@/lib/chain";
import { TIERS } from "@/lib/grade/assay";

interface Me { wallet: string; code: string; handle?: string | null; channel?: string | null; trades?: number; volumeSol?: number; earnedSol?: number; coins?: number; registered?: boolean }
interface Row { wallet: string; code: string; handle: string | null; channel: string | null; trades: number; volume_sol: number; coins: number }

export function CallersView() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  // The last answer on whether the connected wallet can be paid, kept with the wallet it is about; null while unknown.
  const [answer, setAnswer] = useState<{ wallet: string; payable: boolean } | null>(null);
  const payable = answer && answer.wallet === wallet.publicKey?.toBase58() ? answer.payable : null;
  // Confirmed activations so far: a watcher started before the latest one drops its answers, and a new one starts.
  const activations = useRef(0);
  const [round, setRound] = useState(0);
  const toast = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const [handle, setHandle] = useState("");
  const [channel, setChannel] = useState("telegram");
  const [busy, setBusy] = useState(false);
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const { data: lb } = usePoll<{ callers: Row[] }>("/api/callers", 20000);
  useEffect(() => {
    const pk = wallet.publicKey;
    // Only the lookup for the wallet shown now may write; a slow answer for a wallet the user switched away from is dropped.
    let alive = true;
    const load = pk ? fetch(`/api/callers/me?wallet=${pk.toBase58()}`).then((r) => r.json() as Promise<Me>) : Promise.resolve(null);
    load.then((m) => { if (alive) setMe(m); }).catch(() => {});
    return () => { alive = false; };
  }, [wallet.publicKey, busy, connection]);
  useEffect(() => {
    // Rechecked every 30 s until the page closes: a failed lookup is retried instead of hiding the activate box for the
    // whole visit, an activation that confirms late shows up, and so does a WSOL account closed since.
    const w = wallet.publicKey?.toBase58();
    if (!w) return;
    const mine = activations.current;
    return watchCallerPayouts(connection, w, (ok) => { if (mine === activations.current) setAnswer({ wallet: w, payable: ok }); });
  }, [wallet.publicKey, connection, round]);

  async function activate() {
    setBusy(true);
    const w = wallet.publicKey?.toBase58();
    try {
      const sig = await activateCallerPayouts(connection, wallet);
      // Confirmed: shown now rather than at the next check. A check asked before the account existed may still answer
      // "closed" and bring the activate box back, so the watcher that asked it is dropped at once and a new one started.
      activations.current++;
      if (w) setAnswer({ wallet: w, payable: true });
      setRound(activations.current);
      toast.push({ kind: "ok", title: "Payouts active", body: "Trades through your link now pay you.", href: EXPLORER(sig) });
    } catch (e) {
      // An unknown outcome is picked up by the 30 s recheck if it lands.
      toast.push(sendErrorToast(e, "Not activated"));
    } finally { setBusy(false); }
  }

  async function register() {
    if (!wallet.publicKey || !wallet.signMessage) { setVisible(true); return; }
    setBusy(true);
    try {
      const nonce = Date.now().toString(16).padStart(12, "0") + Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, "0")).join("");
      const w = wallet.publicKey.toBase58();
      const sig = await wallet.signMessage(new TextEncoder().encode(registrationMessage(w, nonce)));
      const r = await fetch("/api/callers/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: w, nonce, signature: Array.from(sig), handle: handle || undefined, channel }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "failed");
      setMe(j); toast.push({ kind: "ok", title: "You're a caller", body: `Your code is ${j.code}` });
    } catch (e) { toast.push({ kind: "err", title: "Registration failed", body: (e as Error).message }); }
    finally { setBusy(false); }
  }
  const registered = !!me && me.registered !== false;
  const link = me ? `${origin}/?ref=${me.code}` : "";

  return (
    <div className="pt-6 grid lg:grid-cols-[1fr_400px] gap-6 items-start">
      <div className="space-y-5">
        <div className="card p-5 sm:p-7">
          <div className="eyebrow">Caller program</div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight mt-1">Call a coin. Get paid in the same transaction as the trade.</h1>
          <p className="text-text-2 mt-2 max-w-xl text-sm">Share your link. Every buy and sell that comes through it carries your wallet as the fee receiver, and Raydium&apos;s program pays you {(FEES.callerShareRate / 10_000).toFixed(2)}% of the trade on chain, instantly. No dashboard to claim from, nothing we can withhold.</p>
          <div className="grid sm:grid-cols-3 gap-3 mt-5">
            <Step n="1" t="Register" b="Sign a message with your wallet. Costs nothing, moves nothing." />
            <Step n="2" t="Share" b="Your link works on any coin. Add a mint to call one coin in particular." />
            <Step n="3" t="Earn" b={`${(FEES.callerShareRate / 10_000).toFixed(2)}% of every referred trade lands in your wallet as wrapped SOL.`} />
          </div>
          <div className="hairline my-5" />
          <h2 className="font-display font-semibold">The quality rule</h2>
          <p className="text-sm text-text-2 mt-1">Your link pays on coins whose latest Assay reading is in the <b className="text-text">{TIERS.filter((t) => CALLER_PAY_TIERS.has(t.key)).map((t) => t.label).join(", ")}</b>. Coins in the bottom half still trade, but the share fee stays off, so calling junk earns nothing. This is enforced in the trade panel at the moment the trade is built.</p>
        </div>

        <div className="card">
          <div className="px-4 pt-3 eyebrow">Leaderboard</div>
          <table className="table mt-2"><thead><tr><th>Caller</th><th>Channel</th><th className="text-right">Referred volume</th><th className="text-right">Trades</th><th className="text-right">Coins</th><th className="text-right">Earned</th></tr></thead>
            <tbody>
              {lb?.callers.map((r) => <tr key={r.wallet}><td>{r.handle ? <span className="font-semibold">@{r.handle}</span> : <Address value={r.wallet} />}<span className="kicker ml-2 font-mono">{r.code}</span></td><td className="kicker">{r.channel ?? "–"}</td><td className="num text-right">{fmtSol(r.volume_sol)}</td><td className="num text-right">{r.trades}</td><td className="num text-right">{r.coins}</td><td className="num text-right text-up">{fmtSol((r.volume_sol / 0.98) * (FEES.callerShareRate / 1e6))}</td></tr>)}
              {lb && lb.callers.length === 0 && <tr><td colSpan={6} className="kicker text-center py-6">No callers yet. Be the first.</td></tr>}
            </tbody></table>
        </div>
      </div>

      <aside className="card p-5">
        {!wallet.publicKey ? (
          <>
            {payable === false && (
              <div className="rounded-[10px] border border-amber-dim bg-bg-2 p-3 mb-4 text-sm">
                <div className="font-semibold">One step left: activate payouts</div>
                <p className="text-text-2 mt-1">Your share is paid in wrapped SOL, so your wallet needs a wrapped-SOL account first. It costs about 0.002 SOL once, held as rent in your own account. Until then trades through your link pay no caller share.</p>
                <button className="btn btn-amber mt-3 w-full" disabled={busy} onClick={activate}>{busy ? "Check your wallet…" : "Activate payouts"}</button>
              </div>
            )}
            <div className="eyebrow mb-2">Your link</div>
            <p className="text-sm text-text-2">Connect a wallet to register. The wallet you sign with is the wallet that gets paid.</p>
            <button className="btn btn-amber mt-4 w-full" onClick={() => setVisible(true)}>Connect wallet</button>
          </>
        ) : !registered ? (
          <>
            <div className="eyebrow mb-2">Register {short(wallet.publicKey.toBase58())}</div>
            <label className="label mt-3">Handle (shown on the leaderboard)</label>
            <input className="input" maxLength={32} placeholder="yourname" value={handle} onChange={(e) => setHandle(e.target.value.replace(/[^\w.@-]/g, ""))} />
            <label className="label mt-3">Where you call</label>
            <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}><option value="telegram">Telegram</option><option value="x">X</option><option value="discord">Discord</option><option value="other">Other</option></select>
            <button className="btn btn-amber mt-4 w-full" disabled={busy} onClick={register}>{busy ? "Check your wallet…" : "Sign and register"}</button>
            <p className="kicker mt-2">You will be asked to sign a short message. It is not a transaction.</p>
          </>
        ) : (
          <>
            {payable === false && (
              <div className="rounded-[10px] border border-amber-dim bg-bg-2 p-3 mb-4 text-sm">
                <div className="font-semibold">One step left: activate payouts</div>
                <p className="text-text-2 mt-1">Your share is paid in wrapped SOL, so your wallet needs a wrapped-SOL account first. It costs about 0.002 SOL once, held as rent in your own account. Until then trades through your link pay no caller share.</p>
                <button className="btn btn-amber mt-3 w-full" disabled={busy} onClick={activate}>{busy ? "Check your wallet…" : "Activate payouts"}</button>
              </div>
            )}
            <div className="eyebrow mb-2">Your link</div>
            <div className="rounded-[10px] bg-bg-2 border border-line p-3 font-mono text-sm break-all">{link}</div>
            <button className="btn mt-2 w-full" onClick={() => { void navigator.clipboard?.writeText(link); toast.push({ kind: "ok", title: "Copied" }); }}>Copy link</button>
            <p className="kicker mt-2">For one coin: <span className="font-mono">{origin}/coin/&lt;mint&gt;?ref={me?.code}</span></p>
            <div className="hairline my-4" />
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Stat k="Referred trades" v={String(me?.trades ?? 0)} /><Stat k="Coins" v={String(me?.coins ?? 0)} />
              <Stat k="Referred volume" v={fmtSol(me?.volumeSol ?? 0)} /><Stat k="Earned on chain" v={fmtSol(me?.earnedSol ?? 0)} up />
            </div>
            <p className="kicker mt-3">Earnings arrive as wrapped SOL in your wallet&apos;s WSOL account; unwrap in your wallet any time.</p>
          </>
        )}
      </aside>
    </div>
  );
}
function Step({ n, t, b }: { n: string; t: string; b: string }) { return <div className="rounded-[12px] bg-bg-2 border border-line p-3"><div className="num text-amber-2 font-display font-bold">{n}</div><div className="font-semibold mt-1">{t}</div><div className="kicker mt-1">{b}</div></div>; }
function Stat({ k, v, up }: { k: string; v: string; up?: boolean }) { return <div><div className="kicker">{k}</div><div className={`num font-semibold ${up ? "text-up" : ""}`}>{v}</div></div>; }
