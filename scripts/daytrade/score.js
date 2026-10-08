"use strict";
const { jstIso, parseIso } = require("./jst");
const { expiresAtMs } = require("./windows");
const { simulate, coversExpiry } = require("./fill");
const L = require("./log");
const { pairOf } = require("./pairs");

/**
 * 採点（仕様 6-1）。06:30 の設計①の前に daytrade-score.js が動かす。
 *  対象 [Q21]: 有効期限（翌3:00）を過ぎて、まだ採点も取消もされていないすべての案（金曜の案は月曜に採点される）。
 *  必要な H1 足が有効期限まで届いていないときは採点を保留し、『未到達』と確定させない（次の実行で再試行）。
 *  判定は fill.js（バックテストと共通）。結果は run=status の新しい行として追記（旧行は変えない）[Q18]。
 *  イベント停止は、過去のカレンダーが無いので採点には反映しない。
 */
const num = (v) => (v === "" || v === undefined || v === null ? null : Number(v));

function candFromRow(row) {
  const side = row.side;
  const sch = {};
  if (row.sl_a !== "" && row.tp_a !== "") sch.A = { sl: num(row.sl_a), tp: num(row.tp_a) };
  if (row.sl_b !== "" && row.tp_b !== "") sch.B = { sl: num(row.sl_b), tp: num(row.tp_b) };
  return {
    side, plan_date: row.plan_date, generated_at_ms: parseIso(row.generated_at),
    entry_low: num(row.entry_low), entry_high: num(row.entry_high), schemes: sch,
  };
}

// barsByCode: { 'XAUUSD': [{t,o,h,l,c}] }。nowMs より前に有効期限が来た未採点の案を採点して、追記する行を返す
function scoreRows({ rows, barsByCode, nowMs }) {
  const latest = L.latestByKey(rows);
  const newRows = [];
  const held = [];
  for (const row of latest.values()) {
    if (row.run !== "design") continue; // 直近の行が status（採点済み・取消済み）なら対象外
    if (expiresAtMs(row.plan_date) > nowMs) continue; // まだ有効期限前
    const bars = barsByCode[row.symbol] || [];
    if (!coversExpiry(bars, row.plan_date)) { held.push({ key: L.keyOf(row), reason: "H1足が有効期限まで届いていません" }); continue; }
    const cand = candFromRow(row);
    if (!Number.isFinite(cand.generated_at_ms) || !Number.isFinite(cand.entry_low) || !Number.isFinite(cand.entry_high)) { held.push({ key: L.keyOf(row), reason: "行の値が読めません" }); continue; }
    const r = simulate(cand, bars);
    newRows.push({
      ...row, run: "status", generated_at: jstIso(nowMs),
      reached: r.reached, reached_at: r.reached_at ? jstIso(r.reached_at) : "",
      first_hit_a: r.reached === "到達" && r.schemes.A ? r.schemes.A.first_hit : "",
      first_hit_b: r.reached === "到達" && r.schemes.B ? r.schemes.B.first_hit : "",
    });
  }
  return { newRows, held };
}

/**
 * 出力の6項目目: 直近に採点された計画日（今日より前）の結果。版ごとの直近の行から数える。
 */
function previousDaySummary(rows, beforePlanDate) {
  const latest = [...L.latestByKey(rows).values()].filter((r) => r.plan_date < beforePlanDate);
  const scored = latest.filter((r) => r.run === "status" && r.reached);
  if (!scored.length) return null;
  const date = scored.reduce((m, r) => (r.plan_date > m ? r.plan_date : m), "");
  const day = latest.filter((r) => r.plan_date === date);
  const items = day.map((r) => ({
    setup: r.setup, symbol: r.symbol, side: r.side, reached: r.reached || "未採点", reached_at: r.reached_at || null,
    first_hit_a: r.first_hit_a || null, first_hit_b: r.first_hit_b || null,
  }));
  const count = (f) => items.filter(f).length;
  return {
    plan_date: date, n: items.length,
    reached: count((i) => i.reached === "到達"), not_reached: count((i) => i.reached === "未到達"),
    after_expiry: count((i) => i.reached === "失効後到達"), cancelled: count((i) => i.reached === "取消(再設計)"),
    unscored: count((i) => i.reached === "未採点"),
    a: { tp1: count((i) => i.first_hit_a === "TP1"), sl: count((i) => i.first_hit_a === "SL"), open: count((i) => i.first_hit_a === "未決") },
    b: { tp1: count((i) => i.first_hit_b === "TP1"), sl: count((i) => i.first_hit_b === "SL"), open: count((i) => i.first_hit_b === "未決") },
    items,
  };
}

module.exports = { candFromRow, scoreRows, previousDaySummary, pairOf };
