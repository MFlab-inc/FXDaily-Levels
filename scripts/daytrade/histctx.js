"use strict";
const { HR, jstDate, jstAt, addDaysJst } = require("./jst");
const { atrWilder } = require("./indicators");
const { h1Groups } = require("./levels");
const { tokyoRange } = require("./tokyo");
const { lastCompletedSessionDate } = require("../../mtf/lib/ny-time");
const calc = require("../../mtf/lib/calc");
const { isNyDst } = require("./schedule");
const { planDateOf } = require("./windows");

/**
 * バックテスト用：過去の設計時刻 t に、ライブと同じ形の入力（evaluate の ctx）を再構成する（仕様 6-2）。
 *  現在値 [Q27]    : 直前に確定したH1の終値（t の直前の1時間の足が無ければ、その時刻は設計しない）
 *  当日高安・ADR   : NY17時（JST 6:00／冬7:00）以降の確定足の高安。ADR20 は日足（data/mtf）の直近20セッションの(高値−安値)の平均、
 *                    使用 = 当日高安の幅、残り = max(ADR20 − 使用, 0)（intraday.js と同じ式）
 *  日次レベル      : 日足（data/mtf）の直近に確定したセッションから、fetch.js と同じ式（Pivot=(H+L+C)/3 …）
 *  H1 ATR14・H1群   : t までの確定H1の直近500本（ライブの h1-bars.json と同じ本数）
 *  MTFの向き       : mtf/lib/calc.js の computeStructure（PR #11 の計算定義）で、直近に確定したセッションを基準日に再計算
 *  イベント停止    : 無し（過去のカレンダーが無い。仕様どおり『停止なし』）[Q28]
 */
const H1_WINDOW = 500;
const REGIME = { caution: 50, highvol: 80, extreme: 95 }; // risk-feed の meta.thresholds.regime_percentile と同じ（取得できれば差し替える）
const REGIME_JA = ["平常", "注意", "高ボラ", "異常"];

function upperBound(bars, tEnd) { // 開始+1時間 <= tEnd の足の本数
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t + HR <= tEnd) lo = m + 1; else hi = m; }
  return lo;
}

const round = (v, d) => Number(v.toFixed(d));

function dailyLevelsFrom(row, pair) {
  const P = (row.high + row.low + row.close) / 3;
  const r = row.high - row.low;
  const d = pair.digits;
  return {
    pivot: round(P, d), r1: round(2 * P - row.low, d), s1: round(2 * P - row.high, d),
    r2: round(P + r, d), s2: round(P - r, d), prev_high: round(row.high, d), prev_low: round(row.low, d),
  };
}

// 日足の ATR14（Wilder）÷終値 の系列とパーセンタイル（過去250営業日）。risk-feed の regime の近似 [Q29]
function atrPctSeries(rows) {
  const out = new Array(rows.length).fill(null);
  if (rows.length < 16) return out;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const h = rows[i].high, l = rows[i].low, pc = rows[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  out[14] = (atr / rows[14].close) * 100;
  for (let i = 14; i < trs.length; i++) {
    atr = (atr * 13 + trs[i]) / 14;
    out[i + 1] = (atr / rows[i + 1].close) * 100;
  }
  return out;
}
function regimeAt(series, idx, th = REGIME) {
  if (idx < 14 || series[idx] === null) return "不明";
  const win = series.slice(Math.max(0, idx - 249), idx + 1).filter((x) => x !== null);
  if (win.length < 30) return "不明";
  const p = (win.filter((x) => x <= series[idx]).length / win.length) * 100;
  return p >= th.extreme ? REGIME_JA[3] : p >= th.highvol ? REGIME_JA[2] : p >= th.caution ? REGIME_JA[1] : REGIME_JA[0];
}

function createHistory({ barsByCode, rowsByCode, thresholds = REGIME }) {
  const structMemo = new Map();
  const seriesMemo = new Map();
  const structure = (code, asOf) => {
    const k = `${code}|${asOf}`;
    if (!structMemo.has(k)) {
      const rows = rowsByCode[code];
      structMemo.set(k, rows ? calc.computeStructure(rows, { asOf }) : null);
    }
    return structMemo.get(k);
  };
  const series = (code) => {
    if (!seriesMemo.has(code)) seriesMemo.set(code, atrPctSeries(rowsByCode[code] || []));
    return seriesMemo.get(code);
  };

  // 設計時刻 tMs の入力。作れないときは { skip: 理由 }
  function ctxAt(pair, tMs, setup) {
    const bars = barsByCode[pair.code];
    if (!bars) return { skip: "H1履歴なし" };
    const asOf = lastCompletedSessionDate(tMs);
    const planDate = planDateOf(tMs);
    const end = upperBound(bars, tMs);
    if (end < 30) return { skip: "H1足が足りない" };
    const lastBar = bars[end - 1];
    const prevHour = Math.floor(tMs / HR) * HR - HR;
    if (lastBar.t !== prevHour) return { skip: "直前の1時間の足が無い（休場）" };
    const confirmed = bars.slice(Math.max(0, end - H1_WINDOW), end);
    const atr = atrWilder(confirmed);
    if (!atr) return { skip: "ATRを計算できない" };

    const rows = rowsByCode[pair.code];
    const row = rows ? rows.find((r) => r.date === asOf) : null;
    const dailyOk = Boolean(row);
    const idx = rows ? rows.findIndex((r) => r.date === asOf) : -1;
    const last20 = rows && idx >= 19 ? rows.slice(idx - 19, idx + 1) : null;
    const adr20 = last20 ? last20.reduce((s, r) => s + (r.high - r.low), 0) / 20 : null;
    // 当日（NY17時以降）の高安
    const boundaryH = isNyDst(tMs) ? 6 : 7;
    let start = jstAt(jstDate(tMs), `${String(boundaryH).padStart(2, "0")}:00`);
    if (start > tMs) start = jstAt(addDaysJst(jstDate(tMs), -1), `${String(boundaryH).padStart(2, "0")}:00`);
    let hi = null, lo = null;
    for (let i = confirmed.length - 1; i >= 0 && confirmed[i].t >= start; i--) {
      hi = hi === null ? confirmed[i].h : Math.max(hi, confirmed[i].h);
      lo = lo === null ? confirmed[i].l : Math.min(lo, confirmed[i].l);
    }
    const used = hi === null ? 0 : hi - lo;
    const adr = adr20 === null ? null : { used_pct: (used / adr20) * 100, remaining: Math.max(adr20 - used, 0) };

    // MTF（PR #11 の計算定義）。基準日の日足が最後の行で、最後の1時間足がNY16時台でなければ『ok』
    const st = structure(pair.code, asOf);
    let mtfJson = { status: "partial", data_base_date: null, symbols: [] };
    if (st && st.daily.date === asOf && row && !calc.lastBarNot16(row)) {
      mtfJson = {
        status: "ok", data_base_date: asOf,
        symbols: [{ symbol: pair.code, alignment_score: st.alignment_score, monthly: { direction: st.monthly?.direction }, weekly: { direction: st.weekly?.direction }, daily: { direction: st.daily.direction } }],
      };
    }
    const priceOf = (c) => {
      const b = barsByCode[c];
      if (!b) return undefined;
      const e = upperBound(b, tMs);
      return e > 0 && b[e - 1].t === prevHour ? b[e - 1].c : undefined;
    };
    return {
      ctx: {
        pair, price: lastBar.c, atr,
        adr, daily: dailyOk ? dailyLevelsFrom(row, pair) : null,
        groups: h1Groups(confirmed, atr), mtfJson,
        tokyo: setup === "B" ? tokyoRange(confirmed, planDate) : null,
        rates: { USDJPY: priceOf("USDJPY"), USDCAD: priceOf("USDCAD"), USDCHF: priceOf("USDCHF"), GBPUSD: priceOf("GBPUSD") },
        accounts: {}, riskPct: null,
      },
      meta: { asOf, planDate, vol: regimeAt(series(pair.code), idx, thresholds), dailyOk },
    };
  }
  return { ctxAt, structure };
}

module.exports = { H1_WINDOW, REGIME, REGIME_JA, createHistory, dailyLevelsFrom, atrPctSeries, regimeAt, upperBound };
