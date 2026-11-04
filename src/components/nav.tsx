"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "./wallet-button";
import { NETWORK } from "@/lib/chain";
import { Logo } from "./logo";

const LINKS = [
  { href: "/", label: "Board" },
  { href: "/create", label: "Launch" },
  { href: "/callers", label: "Callers" },
  { href: "/rewards", label: "Rewards" },
  { href: "/record", label: "Record" },
  { href: "/how-it-works", label: "How it works" },
];

export function Nav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-40 backdrop-blur-md bg-bg/75 border-b border-line">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center gap-4">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <Logo className="w-7 h-7" />
          <span className="font-display font-700 text-[17px] tracking-tight">The Assay</span>
          <span className={`chip ${NETWORK === "devnet" ? "chip-info" : "chip-up"} hidden sm:inline-flex`}>{NETWORK === "devnet" ? "Devnet" : "Mainnet"}</span>
        </Link>
        <nav className="hidden md:flex items-center gap-1 ml-4">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return <Link key={l.href} href={l.href} className="tab" aria-selected={active}>{l.label}</Link>;
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/create" className="btn btn-amber btn-sm hidden sm:inline-flex">+ Launch a coin</Link>
          <WalletButton />
        </div>
      </div>
      <nav className="md:hidden flex gap-1 overflow-x-auto px-3 pb-2 -mt-1">
        {LINKS.map((l) => <Link key={l.href} href={l.href} className="tab shrink-0" aria-selected={l.href === "/" ? path === "/" : path.startsWith(l.href)}>{l.label}</Link>)}
      </nav>
    </header>
  );
}
