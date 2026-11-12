import Link from "next/link";
import { Logo } from "./logo";
import { NETWORK } from "@/lib/chain";

export function Footer() {
  return (
    <footer className="border-t border-line mt-10">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-8 grid gap-6 md:grid-cols-[1.4fr_1fr_1fr_1fr] text-sm">
        <div>
          <div className="flex items-center gap-2 mb-2"><Logo className="w-6 h-6" /><span className="font-display font-semibold">The Assay</span></div>
          <p className="text-text-2 max-w-sm">Coins are graded live in their first minutes whenever a complete reading can be made. Every reading is hash-chained before the outcome is known. Every fee is a program rule, not a promise.</p>
          <p className="text-muted mt-3 text-xs">Running on Solana {NETWORK}. Trading memecoins is risky; most go to zero. Readings are rankings, not advice.</p>
          <p className="text-muted mt-2 text-xs"><Link className="hover:text-text underline" href="/terms">Terms, risks and privacy</Link></p>
        </div>
        <div><div className="eyebrow mb-2">Trade</div><ul className="space-y-1.5 text-text-2"><li><Link className="hover:text-text" href="/">Board</Link></li><li><Link className="hover:text-text" href="/create">Launch a coin</Link></li><li><Link className="hover:text-text" href="/rewards">Holder rewards</Link></li></ul></div>
        <div><div className="eyebrow mb-2">Earn</div><ul className="space-y-1.5 text-text-2"><li><Link className="hover:text-text" href="/callers">Caller program</Link></li><li><Link className="hover:text-text" href="/how-it-works#creators">Creator fees</Link></li></ul></div>
        <div><div className="eyebrow mb-2">Proof</div><ul className="space-y-1.5 text-text-2"><li><Link className="hover:text-text" href="/record">The record</Link></li><li><Link className="hover:text-text" href="/how-it-works">How it works</Link></li><li><a className="hover:text-text" href="/api/record" target="_blank" rel="noreferrer">API</a></li></ul></div>
      </div>
    </footer>
  );
}
