"use strict";
const { HR, jstAt, addDaysJst } = require("./jst");

/**
 * 型B の東京レンジ（仕様 3節）。日本時間 9:00〜15:00 の H1（開始 9:00〜14:00 の6本）の高値・安値。
 * （daytrade-context.json の sessions_today.tokyo は 09:00〜17:00 なので使わない）
 * 15:00 以降に H1 終値がレンジの外で確定したら、その方向のブレイク。『15:00 以降』= 開始 15:00 以降の足
 * （開始 15:00 の足は 16:00 に確定する。したがって 15:30 の設計ではブレイクは成立し得ない [Q09]）。
 * bars は古い順の確定 H1 {t(開始ms), o,h,l,c}。planDate は計画日（JST）。
 */
function tokyoRange(bars, planDate) {
  const start = jstAt(planDate, "09:00");
  const rangeBars = bars.filter((b) => b.t >= start && b.t < start + 6 * HR);
  // 9:00〜14:00 の6本がそろっているときだけ確定
  const starts = new Set(rangeBars.map((b) => b.t));
  let complete = rangeBars.length === 6;
  for (let k = 0; complete && k < 6; k++) if (!starts.has(start + k * HR)) complete = false;
  if (!complete) return { complete: false, high: null, low: null, breakUp: false, breakDown: false, bars: rangeBars.length };
  const high = Math.max(...rangeBars.map((b) => b.h));
  const low = Math.min(...rangeBars.map((b) => b.l));
  const after = bars.filter((b) => b.t >= start + 6 * HR && b.t < jstAt(addDaysJst(planDate, 1), "03:00"));
  return {
    complete: true, high, low, bars: 6,
    breakUp: after.some((b) => b.c > high),
    breakDown: after.some((b) => b.c < low),
  };
}

module.exports = { tokyoRange };
