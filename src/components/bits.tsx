"use client";
import { useState } from "react";
import { EXPLORER } from "@/lib/chain";
import { short, fmtPrice } from "@/lib/format";

const TIER_CLASS: Record<string, string> = { top1: "chip-amber glow-amber", top10: "chip-amber", top25: "chip-up", upper_half: "chip-info", bottom_half: "chip-muted" };
export function TierChip({ tier, label, checkpoint, size = "sm" }: { tier: string | null; label: string; checkpoint?: string | null; size?: "sm" | "md" }) {
  const cls = tier ? TIER_CLASS[tier] ?? "chip-muted" : "chip-muted";
  const cp = checkpoint === "launch" ? "at launch" : checkpoint === "m1" ? "at 1m" : checkpoint === "m5" ? "at 5m" : "";
  return (
    <span className={`chip ${cls} ${size === "md" ? "text-[0.8rem] px-2.5 py-1" : ""}`} title="The Assay reading: percentile among the trailing hour of launches">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1h6l-.8 5.2A2.3 2.3 0 0 1 5 8.5a2.3 2.3 0 0 1-2.2-2.3L2 1z" fill="currentColor" opacity=".9" /></svg>
      {label}{cp && <span className="opacity-70 font-normal">· {cp}</span>}
    </span>
  );
}

export function Progress({ value, done }: { value: number; done?: boolean }) {
  const v = Math.max(0, Math.min(1, value));
  return <div className={`progress ${done ? "done" : ""}`} role="progressbar" aria-valuenow={Math.round(v * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${v * 100}%` }} /></div>;
}

export function CoinImage({ src, alt, size = 48, className = "" }: { src: string | null; alt: string; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const hue = [...alt].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  if (!src || broken) {
    return (
      <div className={`shrink-0 rounded-xl flex items-center justify-center font-display font-bold text-text/90 ${className}`} style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${hue} 35% 22%), hsl(${(hue + 40) % 360} 30% 12%))`, fontSize: size * 0.36 }} aria-hidden="true">
        {alt.slice(0, 2).toUpperCase()}
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={`shrink-0 rounded-xl object-cover bg-surface-3 ${className}`} style={{ width: size, height: size }} />;
}

export function Address({ value, kind = "address", n = 4, className = "" }: { value: string; kind?: "tx" | "address"; n?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-xs ${className}`}>
      <a href={EXPLORER(value, kind)} target="_blank" rel="noreferrer" className="text-text-2 hover:text-amber-2" title={value}>{short(value, n)}</a>
      <button className="text-muted hover:text-text" title="Copy" onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }} aria-label="Copy address">
        {copied ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M5 13l4 4L19 7" /></svg> : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>}
      </button>
    </span>
  );
}

export function Price({ value, className = "" }: { value: number; className?: string }) {
  const p = fmtPrice(value);
  return <span className={`num ${className}`}>{p.text}{p.sub && <><sub className="text-[0.7em] opacity-80">{p.sub.zeros}</sub>{p.sub.digits}</>}</span>;
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return <div className="card p-10 text-center"><div className="font-display text-lg">{title}</div>{body && <p className="text-text-2 mt-1 text-sm">{body}</p>}</div>;
}
