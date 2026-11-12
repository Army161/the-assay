"use client";
// Shown to a coin's creator only: their unclaimed creator fees (from all their coins) and a button to claim them.
import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { claimCreatorFees, unclaimedCreatorFees } from "@/lib/client/trade";
import { EXPLORER } from "@/lib/chain";
import { fmtSol } from "@/lib/format";
import { useToast } from "./toast";

export function CreatorFees({ creator }: { creator: string }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const [lamports, setLamports] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = wallet.publicKey?.toBase58() === creator;

  useEffect(() => {
    if (!mine || !wallet.publicKey) return;
    let live = true;
    const load = () => unclaimedCreatorFees(connection, wallet.publicKey!).then((v) => live && setLamports(v)).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, [mine, wallet.publicKey, connection]);

  if (!mine) return null;
  const claim = async () => {
    setBusy(true);
    try {
      const sig = await claimCreatorFees(connection, wallet);
      toast.push({ kind: "ok", title: "Creator fees claimed", body: `${fmtSol((lamports ?? 0) / 1e9)} sent to your wallet as wrapped SOL`, href: EXPLORER(sig) });
      setLamports(0);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.push({ kind: "err", title: "Claim failed", body: /User rejected/i.test(msg) ? "You cancelled in the wallet." : msg.slice(0, 240) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card p-4">
      <div className="eyebrow">Your creator fees</div>
      <p className="text-sm text-text-2 mt-1">Fees from every coin you launched here, waiting to be claimed.</p>
      <div className="flex items-center justify-between mt-2">
        <span className="num font-semibold">{lamports === null ? "…" : fmtSol(lamports / 1e9)}</span>
        <button className="btn btn-amber" disabled={busy || !lamports} onClick={claim}>{busy ? "Claiming…" : "Claim"}</button>
      </div>
    </div>
  );
}
