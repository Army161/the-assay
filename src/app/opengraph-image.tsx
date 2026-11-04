// Share card for the site. Coin pages use the coin's own image.
import { ImageResponse } from "next/og";

export const alt = "The Assay: every coin is read before you buy";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OG() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "linear-gradient(135deg, #07090d 0%, #0f131a 60%, #1a1408 100%)", color: "#e8e6df", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: "#f2a93b", display: "flex", alignItems: "center", justifyContent: "center", color: "#07090d", fontSize: 34, fontWeight: 800 }}>A</div>
          <div style={{ fontSize: 34, fontWeight: 700 }}>The Assay</div>
          <div style={{ marginLeft: "auto", fontSize: 22, color: "#9a978f" }}>Solana · Raydium LaunchLab</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 68, fontWeight: 800, lineHeight: 1.05, letterSpacing: -1.5 }}>Every coin is read before you buy.</div>
          <div style={{ fontSize: 34, color: "#ffc96b" }}>Every reading is sealed before anyone knows how it ends.</div>
        </div>
        <div style={{ display: "flex", gap: 36, fontSize: 24, color: "#9a978f" }}>
          <span>Graded at 0, 1 and 5 minutes</span><span>·</span><span>Callers paid on chain</span><span>·</span><span>Holder rewards</span>
        </div>
      </div>
    ),
    size,
  );
}
