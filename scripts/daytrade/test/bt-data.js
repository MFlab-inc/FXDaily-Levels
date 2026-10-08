"use strict";
const { PAIRS } = require("../pairs");
const { isFxClosedMs } = require("../h1history");
const J = require("../jst");
const { addDays, isWeekday } = require("../../../mtf/lib/ny-time");

/**
 * バックテストの試験用の模擬データ（乱数なし。決まった式で作る）。
 *  日足(NY17時区切り): 平日だけ。終値は一定の傾き＋小さな波で、最後の日の終値が p0。傾きの向きで MTF が 3/3 そろう。
 *  H1(JST開始): FXの休場帯を除く連続。価格は p0 のまわりを 36時間周期でゆっくり往復。
 */
const P0 = { USDJPY: 150, EURUSD: 1.1, GBPUSD: 1.3, AUDUSD: 0.66, NZDUSD: 0.6, USDCAD: 1.35, USDCHF: 0.88, EURJPY: 160, EURGBP: 0.85, XAUUSD: 2000 };
const DRIFT = { USDJPY: 0.0004, EURUSD: -0.0004, GBPUSD: -0.0004, AUDUSD: 0.0004, NZDUSD: 0.0004, USDCAD: -0.0004, USDCHF: 0.0004, EURJPY: 0.0004, EURGBP: -0.0004, XAUUSD: 0.0004 };

function weekdaysEnding(endDate, n) {
  const out = [];
  for (let d = endDate; out.length < n; d = addDays(d, -1)) if (isWeekday(d)) out.unshift(d);
  return out;
}

function synthDaily(pair, { endDate = "2026-10-07", n = 700 } = {}) {
  const p0 = P0[pair.code], dr = DRIFT[pair.code];
  const round = (v) => Number(v.toFixed(pair.digits));
  return weekdaysEnding(endDate, n).map((date, i) => {
    const c = p0 * (1 + dr * (i - (n - 1)) + 0.002 * Math.sin(i / 3));
    const half = p0 * 0.006;
    return { date, open: round(c - p0 * 0.0005), high: round(c + half), low: round(c - half), close: round(c), bars: 24, last_bar_ny: "16:00" };
  });
}

function synthH1(pair, { fromLabel = "2026-08-20 00:00", toLabel = "2026-10-08 05:00" } = {}) {
  const p0 = P0[pair.code];
  const round = (v) => Number(v.toFixed(pair.digits));
  const price = (t) => p0 * (1 + 0.003 * Math.sin((2 * Math.PI * (t / J.HR)) / 36));
  const bars = [];
  for (let t = J.parseJstLabel(fromLabel); t <= J.parseJstLabel(toLabel); t += J.HR) {
    if (isFxClosedMs(t)) continue;
    const o = price(t), c = price(t + J.HR);
    const wick = p0 * 0.0010;
    bars.push({ t, o: round(o), h: round(Math.max(o, c) + wick), l: round(Math.min(o, c) - wick), c: round(c) });
  }
  return bars;
}

function allSynth(opts = {}) {
  const barsByCode = {}, rowsByCode = {};
  for (const pair of PAIRS) { barsByCode[pair.code] = synthH1(pair, opts.h1); rowsByCode[pair.code] = synthDaily(pair, opts.daily); }
  return { barsByCode, rowsByCode };
}

module.exports = { P0, DRIFT, synthDaily, synthH1, allSynth, weekdaysEnding };
