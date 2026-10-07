"use strict";

/**
 * 金利差・5営業日差・判定の計算（SPEC 3〜4節）。すべて整数（ミリ%＝0.001%）で行う。
 *   1bp ＝ 0.01% ＝ 10ミリ%。境界ちょうど（±10bp ＝ ±100ミリ%）を、丸めの誤差なしで判定するため。
 */
const { LABELS } = require("../config");

const BP = 10; // 1bp のミリ%

const valued = (rows) => rows.filter((r) => r.milli !== null);

// 米2年 − 日2年。両方に値がある日だけ（古い順）
function spreadSeries(usRows, jpRows) {
  const jp = new Map(valued(jpRows).map((r) => [r.date, r.milli]));
  return valued(usRows).filter((r) => jp.has(r.date)).map((r) => ({ date: r.date, milli: r.milli - jp.get(r.date) }));
}

// その系列で値がある日を数え、n個前の日との差。足りなければ null
function changeOver(series, n) {
  if (series.length < n + 1) return null;
  const last = series[series.length - 1], base = series[series.length - 1 - n];
  return { date: last.date, milli: last.milli, baseDate: base.date, baseMilli: base.milli, deltaMilli: last.milli - base.milli };
}

// 5営業日差（ミリ%）→ 判定。−しきい値以下＝円高方向、＋しきい値以上＝円安方向（境界を含む）、その間＝はっきりしない
function classify(deltaMilli, thresholdBp) {
  const t = Math.round(thresholdBp * BP); // しきい値が小数でも、ミリ%の整数にして比べる
  if (deltaMilli <= -t) return LABELS.yen_strong;
  if (deltaMilli >= t) return LABELS.yen_weak;
  return LABELS.unclear;
}

// ミリ% → 表示用（"+2.860" "4.79"）。digits は小数の桁（最大3）。整数だけで作り、浮動小数の丸めを使わない
function fmtMilli(milli, digits, signed = false) {
  const a = Math.abs(milli);
  const frac = String(a % 1000).padStart(3, "0").slice(0, digits);
  const text = `${Math.floor(a / 1000)}${digits > 0 ? "." + frac : ""}`;
  // 表示した桁がすべて0なら、符号を付けない（"-0.00" を出さない）
  const sign = /[1-9]/.test(text) ? (milli < 0 ? "-" : signed ? "+" : "") : "";
  return sign + text;
}
// ミリ%の差 → bp（小数第1位）。例 -54 → -5.4
const toBp = (deltaMilli) => {
  const v = Math.round(deltaMilli) / BP;
  return Object.is(v, -0) ? 0 : v;
};
const fmtBp = (deltaMilli) => { const v = toBp(deltaMilli); return `${v > 0 ? "+" : ""}${v.toFixed(1)}bp`; };
const milliToNumber = (milli) => milli / 1000; // JSON用（4790 → 4.79）

module.exports = { BP, valued, spreadSeries, changeOver, classify, fmtMilli, toBp, fmtBp, milliToNumber };
