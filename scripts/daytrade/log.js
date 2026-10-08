"use strict";
const fs = require("fs");
const path = require("path");
const csv = require("./csvio");

/**
 * data/daytrade/log.csv（仕様 5節・6-1）。追記のみ [Q18]。
 *  design の行 … 設計の案ごと（設計のたびに追記。同じ版の再設計は追記しない）
 *  status の行 … 後から分かった状態（取消（再設計）、採点の結果）。毎時の状態更新は書かない
 *  版の識別: (plan_date, setup, symbol, side, entry_low, entry_high, sl_a, sl_b) の一致
 *  filled_ticket_* は人が埋める。bot は書き換えず、行を足すときに同じ版の直近の行から引き継ぐだけ。
 */
const COLUMNS = [
  "plan_date", "generated_at", "run", "setup", "symbol", "side", "same_direction_group", "entry_low", "entry_high",
  "sl_a", "tp_a", "sl_b", "tp_b", "rr_a", "rr_b", "cost_cap_a",
  "lot_cap_a_701620", "lot_cap_b_701620", "lot_cap_a_702449", "lot_cap_b_702449",
  "expires_at", "reached", "reached_at", "first_hit_a", "first_hit_b", "filled_ticket_701620", "filled_ticket_702449",
];

const keyOf = (r) => [r.plan_date, r.setup, r.symbol, r.side, r.entry_low, r.entry_high, r.sl_a, r.sl_b].join("|");

function parseLog(text) {
  const rows = csv.parse(text);
  if (!rows.length) return [];
  const head = rows[0];
  if (head.join(",") !== COLUMNS.join(",")) throw new Error("log.csv の見出し行が想定と違います");
  return rows.slice(1).filter((r) => r.length > 1 || r[0] !== "").map((r) => Object.fromEntries(COLUMNS.map((c, i) => [c, r[i] ?? ""])));
}

function readLog(dataDir) {
  const p = path.join(dataDir, "daytrade", "log.csv");
  if (!fs.existsSync(p)) return [];
  return parseLog(fs.readFileSync(p, "utf8"));
}

const toLine = (row) => csv.line(COLUMNS.map((c) => row[c]));

// 既存の本文に行を足した全文（ファイルが無ければ見出し付き）。書き込みは呼び出し側が store.writeAll で行う
function appendedText(existingText, newRows) {
  const base = existingText && existingText.length ? existingText.replace(/\n*$/, "\n") : `${COLUMNS.join(",")}\n`;
  return base + newRows.map(toLine).join("\n") + (newRows.length ? "\n" : "");
}

// 版ごとの直近の行
function latestByKey(rows) {
  const m = new Map();
  for (const r of rows) m.set(keyOf(r), r);
  return m;
}

module.exports = { COLUMNS, keyOf, parseLog, readLog, toLine, appendedText, latestByKey };

// plan.js 用: ログ行の配列（または未指定）をそのまま返す（文字列なら解析）
module.exports.readLogLike = (x) => (Array.isArray(x) ? x : typeof x === "string" ? parseLog(x) : []);
