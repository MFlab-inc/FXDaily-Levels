"use strict";
/**
 * 採点（仕様 6-1）。06:30 の設計①の前に動かす。有効期限（翌3:00）を過ぎた未採点の案を data/h1-bars.json で判定し、
 * data/daytrade/log.csv に run=status の行を追記する（旧行は変えない）。必要なH1足が届いていなければ保留。
 *   ・到達してから取消された版（reached=取消(到達後)）も、有効期限まで SL/TP1 を追って採点する
 *   ・取消(再設計) の版は、H1 足で取消の時刻までの到達を判定し直す（取消の時に足が届いていなかった分と、過去分の移行）。到達していれば 取消(到達後) の行を足す
 *   ・並行記録 data/daytrade/shadow-log.csv（SL下限 (b) の参考の案）も、同じ規則で別に採点する
 *   node scripts/daytrade-score.js [--now=<ISO>] [--data-dir=<dir>] [--dry-run]
 */
const fs = require("fs");
const path = require("path");
const { parseArgs, repoRoot, dataDir: defaultDataDir } = require("./daytrade/cli");
const { readJson, parseH1 } = require("./daytrade/inputs");
const { scoreRows } = require("./daytrade/score");
const { parseIso, jstLabel } = require("./daytrade/jst");
const L = require("./daytrade/log");
const store = require("../mtf/lib/store");

const hm = (ms) => (Number.isFinite(ms) ? jstLabel(ms).slice(5) : "—");
const SIDE = { sell: "売り", buy: "買い" };
// 書いた行の説明（実行ログ・dry-run 用）。先着の時刻は log.csv には残さないので、ここに出す
function describe(d) {
  const r = d.row;
  const hits = ["A", "B"].filter((n) => d.sim?.schemes?.[n]).map((n) => { const x = d.sim.schemes[n]; return `${n}案 ${x.first_hit}${x.hit_at ? ` ${hm(x.hit_at)}${x.same_bar ? "(TP1も同じ足)" : ""}` : ""}`; });
  const label = { score: "採点", "score-cancelled": "取消(到達後)の採点", "migrate-scored": "移行（取消(到達後)・採点）", "migrate-pending": "移行（取消(到達後)・採点はこれから）" }[d.kind];
  return `${label}: ${r.plan_date} 型${r.setup} ${r.symbol} ${SIDE[r.side] ?? r.side} Entry ${r.entry_low}〜${r.entry_high} → ${r.reached}${r.reached_at ? ` ${hm(parseIso(r.reached_at))}` : ""}${d.kind === "migrate-pending" || r.reached === "未到達" ? "" : ` ／ ${hits.join("、")}`}`;
}

// 1つのログ（log.csv または shadow-log.csv）を採点する。書くべき内容を返す（書き込みは呼び出し側）
function scoreFile({ dataDir, file, columns, label, h1, nowMs, io }) {
  const logPath = path.join(dataDir, "daytrade", file);
  if (!fs.existsSync(logPath)) { io.log(`[score] ${file} がありません。${label}採点する案はありません`); return { newRows: [], held: [], text: null }; }
  const logText = fs.readFileSync(logPath, "utf8");
  const rows = L.parseLog(logText, columns);
  const { newRows, held, details } = scoreRows({ rows, barsByCode: parseH1(h1), nowMs });
  for (const h of held) io.log(`[score] ${label}保留: ${h.key ?? ""} ${h.reason}`);
  for (const d of details) io.log(`[score] ${label}${describe(d)}`);
  io.log(`[score] ${label}採点 ${newRows.length}件 / 保留 ${held.length}件`);
  return { newRows, held, details, text: newRows.length ? L.appendedText(logText, newRows, columns) : null };
}

function main(argv = process.argv.slice(2), io = { log: console.log }) {
  const args = parseArgs(argv);
  const nowMs = args.now ? parseIso(args.now) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`--now が読めません: ${args.now}`);
  const dataDir = args["data-dir"] ? path.resolve(args["data-dir"]) : defaultDataDir;
  const logPath = path.join(dataDir, "daytrade", "log.csv");
  const h1 = readJson(path.join(dataDir, "h1-bars.json"));
  if (!fs.existsSync(logPath) && !fs.existsSync(path.join(dataDir, "daytrade", "shadow-log.csv"))) { io.log("[score] log.csv がありません。採点する案はありません"); return { newRows: [], held: [] }; }
  if (!h1.value) { io.log(`[score] ${h1.problem}。採点を保留します`); return { newRows: [], held: [{ reason: h1.problem }] }; }
  const live = scoreFile({ dataDir, file: "log.csv", columns: L.COLUMNS, label: "", h1: h1.value, nowMs, io });
  // 並行記録の採点は、壊れていてもライブの採点を止めない
  let shadow = { newRows: [], held: [], text: null };
  try { shadow = scoreFile({ dataDir, file: "shadow-log.csv", columns: L.SHADOW_COLUMNS, label: "[並行記録] ", h1: h1.value, nowMs, io }); }
  catch (e) { io.log(`[score] [並行記録] shadow-log.csv を採点できません（${String(e.message || e).slice(0, 160)}）`); }
  if (!args["dry-run"]) {
    const entries = [];
    if (live.text) entries.push({ file: path.join("daytrade", "log.csv"), content: live.text });
    if (shadow.text) entries.push({ file: path.join("daytrade", "shadow-log.csv"), content: shadow.text });
    if (entries.length) store.writeAll(dataDir, entries);
  }
  return { newRows: live.newRows, held: live.held, shadow: { newRows: shadow.newRows, held: shadow.held } };
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`::error::daytrade-score: ${e.stack || e.message}`); process.exit(1); }
}
module.exports = { main, describe };
