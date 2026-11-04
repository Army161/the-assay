import type { Metadata } from "next";
import { CoinView } from "@/components/coin-view";
import { getDb } from "@/lib/db";
import { isPubkey } from "@/lib/http";
import { tierLabel } from "@/lib/grade/assay";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ mint: string }> }): Promise<Metadata> {
  const { mint } = await params;
  if (!isPubkey(mint)) return { title: "Coin" };
  const c = await (await getDb()).one<{ name: string; symbol: string; description: string | null; image: string | null; latest_tier: string | null; mcap_sol: number }>(
    "select name, symbol, description, image, latest_tier, mcap_sol from coins where mint = $1", [mint]).catch(() => null);
  if (!c) return { title: "Coin" };
  const title = `${c.name} (${c.symbol})`;
  const description = `${tierLabel(c.latest_tier)} on The Assay · ${Number(c.mcap_sol).toFixed(2)} SOL market cap. ${c.description ?? ""}`.slice(0, 200);
  return { title, description, openGraph: { title, description, images: c.image ? [c.image] : undefined }, twitter: { card: c.image ? "summary_large_image" : "summary", title, description } };
}

export default async function CoinPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  if (!isPubkey(mint)) return <div className="pt-10 card p-8 text-center">That is not a Solana mint address.</div>;
  return <CoinView mint={mint} />;
}
