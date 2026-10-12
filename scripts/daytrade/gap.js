"use strict";
const { expiresAtMs } = require("./windows");
const { parseIso } = require("./jst");
const L = require("./log");

/**
 * 未到達の案が Entry 帯まであと何pipsだったか。設計時刻から有効期限までの H1 足の高安で測る。
 *   売り: 帯の下端 − その間の高値の最大（足りなかった上昇）／ 買い: その間の安値の最小 − 帯の上端（足りなかった下落）
 * 足が無い（期間に1本も無い）ときは null。数字は log.csv の行と h1-bars.json の足だけから出す（推定しない）。
 * 採点の行（run=status）は generated_at を採点時刻で上書きしているので、設計時刻は同じ版の直近の設計の行から取る（designRowOf）。
 */
function designRowOf(logRows, v) {
  let found = null;
  for (const r of logRows) if ((r.run === "design" || r.run === "design-b") && L.keyOf(r) === v) found = r;
  return found;
}

function entryGapPips(designRow, bars, pair) {
  if (!designRow || !pair || !Array.isArray(bars)) return null;
  const from = parseIso(designRow.generated_at);
  const low = Number(designRow.entry_low), high = Number(designRow.entry_high);
  if (!Number.isFinite(from) || !Number.isFinite(low) || !Number.isFinite(high)) return null;
  const until = expiresAtMs(designRow.plan_date);
  const w = bars.filter((b) => b.t >= from && b.t < until);
  if (!w.length) return null;
  const gap = designRow.side === "sell" ? low - Math.max(...w.map((b) => b.h)) : Math.min(...w.map((b) => b.l)) - high;
  return Number((Math.max(0, gap) / pair.pip).toFixed(1));
}

module.exports = { designRowOf, entryGapPips };
