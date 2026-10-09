"use strict";
/**
 * 採点（仕様 6-1）。06:30 の設計①の前に動かす。有効期限（翌3:00）を過ぎた未採点の案を data/h1-bars.json で判定し、
 * data/daytrade/log.csv に run=status の行を追記する（旧行は変えない）。必要なH1足が届いていなければ保留。
 *   node scripts/daytrade-score.js [--now=<ISO>] [--data-dir=<dir>] [--dry-run]
 */
const fs = require("fs");
const path = require("path");
const { parseArgs, repoRoot, dataDir: defaultDataDir } = require("./daytrade/cli");
const { readJson, parseH1 } = require("./daytrade/inputs");
const { scoreRows } = require("./daytrade/score");
const { parseIso } = require("./daytrade/jst");
const L = require("./daytrade/log");
const store = require("../mtf/lib/store");

function main(argv = process.argv.slice(2), io = { log: console.log }) {
  const args = parseArgs(argv);
  const nowMs = args.now ? parseIso(args.now) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`--now が読めません: ${args.now}`);
  const dataDir = args["data-dir"] ? path.resolve(args["data-dir"]) : defaultDataDir;
  const logPath = path.join(dataDir, "daytrade", "log.csv");
  if (!fs.existsSync(logPath)) { io.log("[score] log.csv がありません。採点する案はありません"); return { newRows: [], held: [] }; }
  const logText = fs.readFileSync(logPath, "utf8");
  const rows = L.parseLog(logText);
  const h1 = readJson(path.join(dataDir, "h1-bars.json"));
  if (!h1.value) { io.log(`[score] ${h1.problem}。採点を保留します`); return { newRows: [], held: [{ reason: h1.problem }] }; }
  const { newRows, held } = scoreRows({ rows, barsByCode: parseH1(h1.value), nowMs });
  for (const h of held) io.log(`[score] 保留: ${h.key ?? ""} ${h.reason}`);
  if (newRows.length && !args["dry-run"]) store.writeAll(dataDir, [{ file: path.join("daytrade", "log.csv"), content: L.appendedText(logText, newRows) }]);
  io.log(`[score] 採点 ${newRows.length}件 / 保留 ${held.length}件`);
  return { newRows, held };
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`::error::daytrade-score: ${e.stack || e.message}`); process.exit(1); }
}
module.exports = { main };
