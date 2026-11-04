import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { RefCatcher } from "@/components/ref-catcher";
import { siteUrl } from "@/lib/files";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-grotesk", display: "swap", weight: ["500", "600", "700"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap", weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: "The Assay", template: "%s · The Assay" },
  description: "A Solana launchpad where every coin is graded before you buy, callers are paid on-chain, and holders earn on every transfer.",
  openGraph: { siteName: "The Assay", type: "website" },
  twitter: { card: "summary_large_image" },
  icons: { icon: "/icon.svg" },
};
export const viewport: Viewport = { themeColor: "#07090d", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${grotesk.variable} ${mono.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        <Providers>
          <RefCatcher />
          <Nav />
          <main className="flex-1 w-full max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 pb-16">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
