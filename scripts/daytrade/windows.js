"use strict";
const { MIN, HR, DAY, jstDate, jstHour, jstDow, jstAt, addDaysJst } = require("./jst");

/**
 * 計画日・有効期限・新規不可の時間帯（仕様 2-3）。時刻はすべて JST 固定（夏冬時間の影響を受けない）。
 *  plan_date = JST で「現在−3時間」の日付（06:30〜翌02:59 が同じ計画日）[Q13]
 *  有効期限 = 計画日の翌日 03:00。新規は翌日 01:00 まで（01:00 ちょうどは不可）。9時台と土曜 00:00 以降は新規なし。
 */
const planDateOf = (ms) => jstDate(ms - 3 * HR);
const expiresAtMs = (planDate) => jstAt(addDaysJst(planDate, 1), "03:00");
const newEntryCutoffMs = (planDate) => jstAt(addDaysJst(planDate, 1), "01:00");

// 時刻 t（足の開始時刻・または現在時刻）に新規を出せるか。理由の文字列 or null（出せる）
function noNewEntryReason(ms, planDate) {
  if (ms >= expiresAtMs(planDate)) return "失効";
  if (ms >= newEntryCutoffMs(planDate)) return "翌1:00以降";
  if (jstDow(ms) === 6) return "土曜0:00以降";
  if (jstHour(ms) === 9) return "9時台";
  return null;
}

module.exports = { MIN, HR, DAY, planDateOf, expiresAtMs, newEntryCutoffMs, noNewEntryReason };
