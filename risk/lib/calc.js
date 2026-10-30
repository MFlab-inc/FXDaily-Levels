"use strict";

/**
 * 順位の計算（SPEC 3節。自前の定義）。
 *   順位（%）＝ 当日を含む直近 window 個の終値のうち、当日の終値以下の個数 ÷ window × 100（小数第1位に四捨五入）
 * window＝252 では、個数×1000÷252 の端数がちょうど0.5になることはない（63で割り切れる個数だけが整数になる）ため、
 * 四捨五入の方式（偶数丸めなど）による違いは出ない。
 */

function rankAt(values, i, window) {
  if (!Number.isInteger(i) || i < 0 || i >= values.length) throw new RangeError(`位置 ${i} が範囲外です`);
  if (i + 1 < window) return null; // 過去分が足りない
  const latest = values[i];
  let countLe = 0;
  for (let k = i - window + 1; k <= i; k++) if (values[k] <= latest) countLe++;
  return { count_le: countLe, rank_pct: Math.round((countLe * 1000) / window) / 10 };
}

// 古い順の行（{date, close}）から、最新日の順位と、直近 historyDays 日ぶんの日ごとの順位を作る
function vixSnapshot(rows, { window, thresholdPct, historyDays }) {
  const closes = rows.map((r) => r.close);
  const last = rows.length - 1;
  const latest = rankAt(closes, last, window);
  if (!latest) return { error: `終値が${rows.length}日分しかなく、順位に必要な${window}日分に足りません` };
  const history = [];
  for (let i = Math.max(window - 1, rows.length - historyDays); i <= last; i++) {
    const r = rankAt(closes, i, window);
    history.push({ date: rows[i].date, close: round2(rows[i].close), rank_pct: r.rank_pct });
  }
  return {
    date: rows[last].date,
    close: round2(rows[last].close),
    rank_pct: latest.rank_pct,
    count_le: latest.count_le,
    window,
    window_start: rows[last - window + 1].date,
    threshold_pct: thresholdPct,
    over_threshold: latest.rank_pct >= thresholdPct,
    history,
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

module.exports = { rankAt, vixSnapshot };
