"use strict";
const { jstHour, jstAt } = require("./jst");

/**
 * 型B の追加時刻（Q09 の確定した規則）。型B は設計② では作らず、状態更新（run=status）の中で、
 * JST 16:00〜21:59 の実行で『東京レンジをMTFの向きにブレイクし、戻っていない』銘柄を新規に設計して追加する（log.csv の run=design-b）。
 * 15:00 開始の足は 16:00 に確定するので、追加は 16:00 から。21:00 の実行まで（21時台の実行まで）で打ち切る。
 * バックテストでは、毎時00分（16:00〜21:00）の状態更新として再現する。ライブとバックテストで同じ定義を使う。
 */
const B_ADD_FROM_HOUR = 16;
const B_ADD_TO_HOUR = 22; // 排他（22:00 以降は追加しない）

const isBAddTime = (ms) => { const h = jstHour(ms); return h >= B_ADD_FROM_HOUR && h < B_ADD_TO_HOUR; };

// 計画日の毎時00分（16:00〜21:00）の epoch(ms)
function bAddTimes(planDate) {
  const out = [];
  for (let h = B_ADD_FROM_HOUR; h < B_ADD_TO_HOUR; h++) out.push(jstAt(planDate, `${String(h).padStart(2, "0")}:00`));
  return out;
}

module.exports = { B_ADD_FROM_HOUR, B_ADD_TO_HOUR, isBAddTime, bAddTimes };
