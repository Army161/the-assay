"use client";
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { Buffer } from "buffer";
import { RPC_URL } from "@/lib/chain";
import { ToastProvider } from "./toast";

if (typeof window !== "undefined" && !(window as unknown as { Buffer?: unknown }).Buffer) (window as unknown as { Buffer: unknown }).Buffer = Buffer;

/** Wallets register themselves through the Wallet Standard (Phantom, Solflare, Backpack, ...); no adapter list needed. */
export function Providers({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <ToastProvider>{children}</ToastProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
