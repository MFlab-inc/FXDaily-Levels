"use strict";
const fs = require("fs");
const path = require("path");
const csv = require("./csvio");

/**
 * data/daytrade/log.csv（仕様 5節・6-1）。追記のみ [Q18]。
 *  design の行 … 設計の案ごと（設計のたびに追記。同じ版の再設計は追記しない）
 *  design-b の行 … 状態更新（JST 16:00〜21:59）で追加した型B（Q09）。設計と同じ扱いで採点される
 *  status の行 … 後から分かった状態（取消（再設計）、採点の結果）。毎時の状態更新そのものは書かない（型Bの追加だけ design-b として書く）
 *  版の識別: (plan_date, setup, symbol, side, entry_low, entry_high, sl_a, sl_b) の一致
 *  口座は A（デイトレ専用）・B（スイング＋デイトレ）のラベルで表す（口座番号・資金は公開されるファイルに置かない）。
 *  filled_ticket_* は人が埋める。bot は書き換えず、行を足すときに同じ版の直近の行から引き継ぐだけ。
 */
// 損益の列（PNL_COLUMNS）を足す前の見出し（27列）。これで書かれた log.csv は読める。行は書き換えず、次に追記するときに見出し行だけを新しい形にする（足した列は旧行では空）
const LEGACY_COLUMNS = [
  "plan_date", "generated_at", "run", "setup", "symbol", "side", "same_direction_group", "entry_low", "entry_high",
  "sl_a", "tp_a", "sl_b", "tp_b", "rr_a", "rr_b", "cost_cap_a",
  "lot_cap_a_A", "lot_cap_b_A", "lot_cap_a_B", "lot_cap_b_B",
  "expires_at", "reached", "reached_at", "first_hit_a", "first_hit_b", "filled_ticket_A", "filled_ticket_B",
];
// 末尾の6列は採点の行（reached=到達／取消(到達後)）だけに入る案ごとの損益（週次の集計用）。exit=決済の価格、pips=最悪Entry 基準・コスト0、r=pips÷SL幅。円の金額は書かない
const PNL_COLUMNS = ["exit_a", "exit_b", "pips_a", "pips_b", "r_a", "r_b"];
const COLUMNS = [...LEGACY_COLUMNS, ...PNL_COLUMNS];
// 並行記録 data/daytrade/shadow-log.csv（SL下限 (b) の参考の案。発注の対象外）。列は log.csv と同じで、先頭に variant を足す
const SHADOW_VARIANT = "sl_floor_b";
const SHADOW_COLUMNS = ["variant", ...COLUMNS];
const LEGACY_OF = new Map([[COLUMNS, LEGACY_COLUMNS]]);

// 価格の列は数として正規化して比べる（表計算ソフトを通して 1.10400 が 1.104 になっても、同じ版として扱う）
const normNum = (v) => { if (v === "" || v === undefined || v === null) return ""; const n = Number(v); return Number.isFinite(n) ? String(n) : String(v); };
const keyOf = (r) => [r.plan_date, r.setup, r.symbol, r.side, normNum(r.entry_low), normNum(r.entry_high), normNum(r.sl_a), normNum(r.sl_b)].join("|");

// columns は log.csv（既定）または shadow-log.csv（SHADOW_COLUMNS）の列。見出しが古い形（LEGACY）でも読める（足りない列は空）
function parseLog(text, columns = COLUMNS) {
  const rows = csv.parse(text);
  if (!rows.length) return [];
  const head = rows[0].join(",");
  const legacy = LEGACY_OF.get(columns);
  if (head !== columns.join(",") && !(legacy && head === legacy.join(","))) throw new Error(`${columns === COLUMNS ? "log.csv" : "shadow-log.csv"} の見出し行が想定と違います`);
  return rows.slice(1).filter((r) => r.length > 1 || r[0] !== "").map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ""])));
}

function readLog(dataDir) {
  const p = path.join(dataDir, "daytrade", "log.csv");
  if (!fs.existsSync(p)) return [];
  return parseLog(fs.readFileSync(p, "utf8"));
}
function readShadowLog(dataDir) {
  const p = path.join(dataDir, "daytrade", "shadow-log.csv");
  if (!fs.existsSync(p)) return [];
  return parseLog(fs.readFileSync(p, "utf8"), SHADOW_COLUMNS);
}

const toLine = (row, columns = COLUMNS) => csv.line(columns.map((c) => row[c]));

// 既存の本文に行を足した全文（ファイルが無ければ見出し付き）。書き込みは呼び出し側が store.writeAll で行う。
// 見出しが古い形（LEGACY）なら、見出し行だけを新しい形にする（既存の行は書き換えない）
function appendedText(existingText, newRows, columns = COLUMNS) {
  let base = existingText && existingText.length ? existingText.replace(/\n*$/, "\n") : `${columns.join(",")}\n`;
  const legacy = LEGACY_OF.get(columns);
  if (legacy) {
    // 先頭行だけを見る。表計算ソフトを通したファイル（BOM・CRLF）でも、元の BOM と改行はそのまま残して見出しの文字だけ差し替える
    const m = /^(\uFEFF?)([^\r\n]*)(\r?\n)/.exec(base);
    if (m && m[2] === legacy.join(",")) base = `${m[1]}${columns.join(",")}${m[3]}${base.slice(m[0].length)}`;
  }
  return base + newRows.map((r) => toLine(r, columns)).join("\n") + (newRows.length ? "\n" : "");
}

// 版ごとの直近の行
function latestByKey(rows) {
  const m = new Map();
  for (const r of rows) m.set(keyOf(r), r);
  return m;
}

module.exports = { COLUMNS, LEGACY_COLUMNS, PNL_COLUMNS, SHADOW_COLUMNS, SHADOW_VARIANT, keyOf, parseLog, readLog, readShadowLog, toLine, appendedText, latestByKey };

// plan.js 用: ログ行の配列（または未指定）をそのまま返す（文字列なら解析）
module.exports.readLogLike = (x, columns = COLUMNS) => (Array.isArray(x) ? x : typeof x === "string" ? parseLog(x, columns) : []);
