"use client";
/** Axis prices with folded zeros, GMGN style: 0.000000589 -> 0.0₆589 (Unicode subscripts, since axis labels are plain text). */
const SUB = "₀₁₂₃₄₅₆₇₈₉";
export function axisPrice(p: number) {
  if (!Number.isFinite(p) || p <= 0) return "0";
  if (p >= 0.01) return p.toPrecision(4).replace(/\.?0+$/, "");
  const m = /^0\.(0+)(\d+)/.exec(p.toFixed(18));
  if (!m) return p.toExponential(2);
  const zeros = String(m[1].length).split("").map((d) => SUB[Number(d)]).join("");
  return `0.0${zeros}${m[2].slice(0, 4).replace(/0+$/, "") || "0"}`;
}
import { useEffect, useRef } from "react";
import { createChart, CandlestickSeries, HistogramSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

export function Chart({ candles, height = 320 }: { candles: Candle[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{ c: ISeriesApi<"Candlestick">; v: ISeriesApi<"Histogram"> } | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ch = createChart(ref.current, {
      height, autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#8b93a1", fontFamily: "var(--font-jetbrains), ui-monospace, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "rgba(232,230,223,0.05)" }, horzLines: { color: "rgba(232,230,223,0.05)" } },
      rightPriceScale: { borderColor: "rgba(232,230,223,0.1)", scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderColor: "rgba(232,230,223,0.1)", timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "rgba(242,169,59,.4)", labelBackgroundColor: "#1b2230" }, horzLine: { color: "rgba(242,169,59,.4)", labelBackgroundColor: "#1b2230" } },
      localization: { priceFormatter: axisPrice },
    });
    const c = ch.addSeries(CandlestickSeries, { upColor: "#35c86f", downColor: "#ef5350", borderVisible: false, wickUpColor: "#35c86f", wickDownColor: "#ef5350", priceFormat: { type: "price", precision: 12, minMove: 1e-12 } });
    const v = ch.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", color: "rgba(242,169,59,.35)" });
    ch.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = ch; series.current = { c, v };
    return () => { ch.remove(); chart.current = null; series.current = null; };
  }, [height]);
  useEffect(() => {
    if (!series.current) return;
    series.current.c.setData(candles.map((k) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
    series.current.v.setData(candles.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume, color: k.close >= k.open ? "rgba(53,200,111,.35)" : "rgba(239,83,80,.35)" })));
    chart.current?.timeScale().fitContent();
  }, [candles]);
  return <div ref={ref} className="w-full" style={{ height }} />;
}
