"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { create } from "@/lib/client/trade";
import { useToast } from "./toast";
import { CoinImage } from "./bits";
import { FEES, LAUNCH, NETWORK, MAINNET_OPEN, EXPLORER } from "@/lib/chain";
import { fmtSol } from "@/lib/format";

const REWARD_OPTIONS = [
  { bps: 0, title: "No holder reward", body: "Plain SPL token. Lowest friction; trades on every venue." },
  { bps: 100, title: "1% to holders", body: "Token-2022 transfer fee. Every transfer feeds the reward pool; paid out in SOL." },
  { bps: 200, title: "2% to holders", body: "Same, twice the rate. Best for coins built to be held." },
];

export function CreateForm() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const toast = useToast();
  const router = useRouter();
  const [f, setF] = useState({ name: "", symbol: "", description: "", website: "", twitter: "", telegram: "", discord: "", holderRewardBps: 100, initialBuySol: "0.1" });
  const [image, setImage] = useState<{ url: string; preview: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [step, setStep] = useState<"idle" | "metadata" | "wallet" | "confirming" | "done">("idle");
  const fileRef = useRef<HTMLInputElement>(null);
  const closed = NETWORK === "mainnet" && !MAINNET_OPEN;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.push({ kind: "err", title: "Image is larger than 2 MB" }); return; }
    setUploading(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "upload failed");
      setImage({ url: j.url, preview: URL.createObjectURL(file) });
    } catch (e) { toast.push({ kind: "err", title: "Upload failed", body: (e as Error).message }); }
    finally { setUploading(false); }
  }

  const initial = Number(f.initialBuySol) || 0;
  const valid = f.name.trim().length >= 1 && /^[A-Za-z0-9]{1,10}$/.test(f.symbol.trim()) && !!image;

  async function launch() {
    if (!wallet.publicKey) { setVisible(true); return; }
    if (!valid || !image) return;
    try {
      setStep("metadata");
      const r = await fetch("/api/metadata", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...f, symbol: f.symbol.trim().toUpperCase(), image: image.url, holderRewardBps: f.holderRewardBps }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "metadata failed");
      setStep("wallet");
      const res = await create(connection, wallet, { name: f.name.trim(), symbol: f.symbol.trim().toUpperCase(), uri: j.uri, holderRewardBps: f.holderRewardBps, initialBuySol: initial });
      setStep("done");
      toast.push({ kind: "ok", title: `${f.symbol.toUpperCase()} is live`, body: "The board picks it up within a minute.", href: EXPLORER(res.txIds[0]) });
      router.push(`/coin/${res.mint}`);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      toast.push({ kind: "err", title: "Launch failed", body: /User rejected/i.test(msg) ? "You cancelled in the wallet." : msg.slice(0, 300) });
      setStep("idle");
    }
  }

  return (
    <div className="pt-6 grid lg:grid-cols-[1fr_360px] gap-6 items-start">
      <div className="card p-5 sm:p-7">
        <div className="eyebrow">Launch a coin</div>
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight mt-1">Fair launch on the curve. No presale, no allocation, no admin.</h1>
        <p className="text-text-2 mt-2 text-sm max-w-xl">Your coin starts on Raydium LaunchLab&apos;s bonding curve through The Assay. When {fmtSol(LAUNCH.totalFundRaisingSol)} has been raised it graduates to a Raydium pool with the liquidity 80% burned and 20% locked. You earn {(FEES.creatorFeeRate / 10_000).toFixed(2)}% of every curve trade, claimable any time.</p>

        <div className="grid sm:grid-cols-[140px_1fr] gap-5 mt-6">
          <div>
            <label className="label">Image</label>
            <button type="button" className="w-[140px] h-[140px] rounded-2xl border border-dashed border-line-2 hover:border-amber/60 flex items-center justify-center overflow-hidden bg-bg-2 relative" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {image ? <img src={image.preview} alt="" className="w-full h-full object-cover" /> : <span className="kicker text-center px-3">{uploading ? "Uploading…" : "PNG, JPG, GIF or WebP\nup to 2 MB"}</span>}
            </button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
          <div className="space-y-4">
            <div className="grid sm:grid-cols-[1fr_140px] gap-3">
              <div><label className="label">Name</label><input className="input" maxLength={32} placeholder="Dog Wif Hat" value={f.name} onChange={set("name")} /></div>
              <div><label className="label">Ticker</label><input className="input uppercase" maxLength={10} placeholder="DWH" value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value.replace(/[^A-Za-z0-9]/g, "") })} /></div>
            </div>
            <div><label className="label">Description</label><textarea className="input min-h-[84px]" maxLength={500} placeholder="One or two lines. What is it, why now." value={f.description} onChange={set("description")} /></div>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3 mt-4">
          {(["website", "twitter", "telegram", "discord"] as const).map((k) => <div key={k}><label className="label">{k}</label><input className="input" maxLength={120} placeholder={k === "website" ? "https://" : k === "twitter" ? "https://x.com/…" : k === "telegram" ? "https://t.me/…" : "https://discord.gg/…"} value={f[k]} onChange={set(k)} /></div>)}
        </div>

        <div className="mt-6"><label className="label">Holder reward</label>
          <div className="grid sm:grid-cols-3 gap-2">
            {REWARD_OPTIONS.map((o) => (
              <button key={o.bps} type="button" onClick={() => setF({ ...f, holderRewardBps: o.bps })} className={`text-left rounded-[12px] border p-3 transition ${f.holderRewardBps === o.bps ? "border-amber/60 bg-amber-dim" : "border-line hover:border-line-2 bg-bg-2"}`} aria-pressed={f.holderRewardBps === o.bps}>
                <div className="font-semibold text-sm">{o.title}</div><div className="kicker mt-1">{o.body}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 grid sm:grid-cols-[200px_1fr] gap-4 items-end">
          <div><label className="label">Your first buy (optional)</label><div className="relative"><input className="input num pr-12" inputMode="decimal" value={f.initialBuySol} onChange={(e) => setF({ ...f, initialBuySol: e.target.value.replace(/[^\d.]/g, "") })} /><span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-text-2">SOL</span></div></div>
          <p className="kicker">Bought in the creation transaction, at the opening price, before anyone else can. The Assay shows the dev buy percentage on the card, so buyers see it.</p>
        </div>

        <div className="mt-7 flex items-center gap-3 flex-wrap">
          <button className="btn btn-amber py-3 px-6 text-base" disabled={closed || step !== "idle" || (!!wallet.publicKey && !valid)} onClick={launch}>
            {closed ? "Mainnet opens after launch" : !wallet.publicKey ? "Connect wallet to launch" : step === "idle" ? "Launch coin" : step === "metadata" ? "Preparing metadata…" : step === "wallet" ? "Confirm in wallet…" : "Launching…"}
          </button>
          <span className="kicker">Network cost about 0.015 SOL for the coin&apos;s accounts. Creating is free; an optional first buy pays the normal trade fees like any buy.</span>
        </div>
      </div>

      <aside className="space-y-4">
        <div className="card p-4">
          <div className="eyebrow mb-2">Preview</div>
          <div className="flex gap-3 items-center">
            {image ? <img src={image.preview} alt="" className="w-14 h-14 rounded-xl object-cover" /> : <CoinImage src={null} alt={f.symbol || "?"} size={56} />}
            <div className="min-w-0"><div className="font-display font-semibold truncate">{f.name || "Your coin"} <span className="text-muted font-sans">{f.symbol.toUpperCase()}</span></div><div className="kicker">{f.holderRewardBps ? `Holders earn ${f.holderRewardBps / 100}%` : "No holder reward"}{initial > 0 ? ` · dev buys ${initial} SOL` : ""}</div></div>
          </div>
        </div>
        <div className="card p-4 text-sm space-y-2">
          <div className="eyebrow mb-1">What you get</div>
          <Row k="Creator fee, every curve trade" v={`${(FEES.creatorFeeRate / 10_000).toFixed(2)}%`} />
          <Row k="Supply" v="1,000,000,000" />
          <Row k="Sold on the curve" v="793.1M (79.3%)" />
          <Row k="Graduates at" v={fmtSol(LAUNCH.totalFundRaisingSol)} />
          <Row k="Liquidity at graduation" v="80% burned · 20% locked" />
          <Row k="Mint / freeze authority" v="none, by the program" />
          <Row k="Your Assay reading" v="sealed at 0, 1 and 5 min" />
        </div>
        <div className="card p-4 text-xs text-text-2">
          <div className="eyebrow mb-1">Honest by construction</div>
          The creation transaction is signed by your wallet and executed by Raydium&apos;s LaunchLab program. The Assay never holds your coin, your SOL, or any authority over the mint. Fees are rules in the platform config on chain, readable by anyone.
        </div>
      </aside>
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) { return <div className="flex justify-between gap-3"><span className="text-text-2">{k}</span><span className="num text-right shrink-0 whitespace-nowrap">{v}</span></div>; }
