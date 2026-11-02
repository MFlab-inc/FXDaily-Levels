"use strict";

/**
 * 試し運転の指標（SPEC 10節。記事にはまだ使わない）。2026-11-02 ユーザー決定：
 *   ② MOVE の代わり … 米国債の金利の「実際の値動きの大きさ」（米財務省の金利表から自前で計算）
 *   ③ HY OAS は当面 GPT の値のまま（代わりの候補は試算の結果、使わないことにした。SPEC 10-2）
 * ここにあるのはネットワークに接続しない純関数だけ（読み取り・計算）。取得は run-daily.js。
 */
const { parseMilli, splitCsvLine } = require("../../rates/lib/parse");
const { rankAt } = require("./calc");

class TrialError extends Error {}

function isRealDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// ---------- 米財務省 Daily Treasury Par Yield Curve Rates（CSV） ----------
// 返り値：古い順の [{ date, bp: { "2 Yr": 479, ... } }]。値は bp（0.01%＝1）の整数。空欄・N/A は null
function parseParYieldCsv(text, tenors, { allowEmpty = false } = {}) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) { if (allowEmpty) return []; throw new TrialError("財務省CSV: 中身が空です"); }
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const iDate = header.indexOf("Date");
  const idx = tenors.map((t) => header.indexOf(t));
  if (iDate < 0 || idx.some((i) => i < 0)) {
    throw new TrialError(`財務省CSV: 列名に Date・${tenors.join("・")} のどれかがありません（形式が変わった可能性）`);
  }
  const rows = new Map();
  lines.slice(1).forEach((line, k) => {
    const c = splitCsvLine(line);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((c[iDate] || "").trim());
    if (!m || !isRealDate(+m[3], +m[1], +m[2])) throw new TrialError(`財務省CSV: ${k + 2}行目の日付の形式が想定外です`);
    const bp = {};
    tenors.forEach((t, j) => {
      const raw = (c[idx[j]] || "").trim();
      if (raw === "" || raw === "N/A") { bp[t] = null; return; }
      const milli = parseMilli(raw);
      if (milli === null || milli % 10 !== 0) throw new TrialError(`財務省CSV: ${k + 2}行目の ${t} の値が読めません`);
      bp[t] = milli / 10;
    });
    rows.set(`${m[3]}-${m[1]}-${m[2]}`, bp);
  });
  if (!rows.size) { if (allowEmpty) return []; throw new TrialError("財務省CSV: データ行がありません"); }
  return [...rows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, bp]) => ({ date, bp }));
}

// 実際の値動きの大きさ（自前の定義）：
//   各年限の金利の1日の変化（bp）を、直近 lookback 日分ならべた二乗平均平方根（RMS）。それを年限で単純平均する。
//   4つの年限すべてに値がある日だけを使う（前の日も、4つすべてに値がある日を数える）。
// 返り値：古い順の [{ date, value }]（value は bp。丸めない）
function realizedVolSeries(rows, tenors, lookback) {
  const ok = rows.filter((r) => tenors.every((t) => Number.isInteger(r.bp[t])));
  const out = [];
  for (let i = lookback; i < ok.length; i++) {
    let sum = 0;
    for (const t of tenors) {
      let ss = 0;
      for (let j = i - lookback + 1; j <= i; j++) {
        const d = ok[j].bp[t] - ok[j - 1].bp[t];
        ss += d * d;
      }
      sum += Math.sqrt(ss / lookback);
    }
    out.push({ date: ok[i].date, value: sum / tenors.length });
  }
  return out;
}

// 系列（古い順の {date, value}）の最新の順位と、直近 historyN 個の日ごとの順位
function rankSnapshot(series, { window, thresholdPct, historyN, keepValue }) {
  const values = series.map((s) => s.value);
  const last = series.length - 1;
  if (last < 0) return { error: "値がありません" };
  const latest = rankAt(values, last, window);
  if (!latest) return { error: `値が${series.length}個しかなく、順位に必要な${window}個に足りません` };
  const history = [];
  for (let i = Math.max(window - 1, series.length - historyN); i <= last; i++) {
    const h = { date: series[i].date, rank_pct: rankAt(values, i, window).rank_pct };
    if (keepValue) h.value = round2(series[i].value);
    history.push(h);
  }
  const snap = {
    date: series[last].date,
    rank_pct: latest.rank_pct,
    count_le: latest.count_le,
    window,
    window_start: series[last - window + 1].date,
    threshold_pct: thresholdPct,
    over_threshold: latest.rank_pct >= thresholdPct,
    history,
  };
  if (keepValue) snap.value = round2(series[last].value);
  return snap;
}
const round2 = (x) => Math.round(x * 100) / 100;

module.exports = { TrialError, parseParYieldCsv, realizedVolSeries, rankSnapshot };
