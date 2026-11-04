"use client";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { short } from "@/lib/format";

export function WalletButton({ className = "" }: { className?: string }) {
  const { publicKey, disconnect, connecting, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  if (publicKey) {
    return (
      <button className={`btn btn-sm font-mono ${className}`} onClick={() => void disconnect()} title="Disconnect">
        {wallet?.adapter.icon && <img src={wallet.adapter.icon} alt="" className="w-4 h-4 rounded" />}
        {short(publicKey.toBase58())}
      </button>
    );
  }
  return <button className={`btn btn-sm ${className}`} onClick={() => setVisible(true)} disabled={connecting}>{connecting ? "Connecting…" : "Connect wallet"}</button>;
}
