"use strict";
/**
 * 過去分の一括取得（バックフィル）。main で1回だけ、手動で実行する（.github/workflows/mtf-backfill.yml）。
 *   ・data/mtf/ に履歴CSVが1つでもあれば、何も取得せず・何も書かずに止まる（上書きしない）
 *   ・全銘柄（mtf/config.js の SYMBOLS）を1つずつ 2024-07-01 から取得する（1銘柄4回前後・全体で40回前後）。1つでも失敗したら何も書かない（やり直せる）
 *   ・全部そろってから、銘柄ごとの履歴CSVと mtf-feed.json / mtf-feed.txt をまとめて置く（あとから銘柄を足すときは add-symbol.js）
 */
const path = require("path");
const { SYMBOLS, BACKFILL_START, DATA_DIR } = require("./config");
const { lastCompletedSessionDate, toJstIso } = require("./lib/ny-time");
const { createClient } = require("./lib/twelvedata");
const { createGuard } = require("./lib/guard");
const { fetchDailyHistory, checkHistory } = require("./lib/history");
const store = require("./lib/store");
const { buildFeed } = require("./lib/feed");

async function runBackfill({
  nowMs = Date.now(), dataDir = DATA_DIR, client, log = console.log,
  start = BACKFILL_START, pageSize, minRows = 400,
} = {}) {
  const existing = store.existingCsvFiles(dataDir);
  if (existing.length) {
    log(`::error::data/mtf/ に履歴CSVが既にあります（${existing.join(", ")}）。上書きを避けるため、何も取得せず・何も書かずに止まりました`);
    return { exitCode: 1, stopped: "exists", existing };
  }
  const asOf = lastCompletedSessionDate(nowMs);
  const nowIso = toJstIso(nowMs);
  const items = [];
  const entries = [];
  for (const sym of SYMBOLS) {
    const h = await fetchDailyHistory(client, sym, { start, cutoffDate: asOf, pageSize, log });
    checkHistory(sym.code, h.rows, { start, minRows });
    log(`[mtf] ${sym.code}: 1時間足${h.hourBars}本 → 日足${h.rows.length}日（${h.rows[0].date} 〜 ${h.rows[h.rows.length - 1].date}）、左端で捨てた日=${h.leftEdgeDropped || "なし"}、週末の足=${h.weekendBars}本`);
    items.push({ code: sym.code, rows: h.rows, updatedAt: nowIso });
    entries.push({ file: path.join("mtf", `ny-daily-${sym.code}.csv`), content: store.toCsv(h.rows) });
  }
  const { json, text } = buildFeed({ asOf, nowMs, items, attempt: 1 });
  entries.push({ file: "mtf-feed.json", content: JSON.stringify(json, null, 2) + "\n" });
  entries.push({ file: "mtf-feed.txt", content: text });
  store.writeAll(dataDir, entries);
  log(`[mtf] 書き込み完了: 履歴CSV${SYMBOLS.length}本 + mtf-feed.json / mtf-feed.txt（基準日 ${asOf}、リクエスト${client.stats.requests}回）`);
  return { exitCode: 0, asOf, requests: client.stats.requests };
}

async function main() {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) { console.error("ERROR: 環境変数 TWELVE_DATA_API_KEY が設定されていません"); process.exit(1); }
  const log = (...a) => console.log(...a);
  // 他の Daily / Intraday の実行と Twelve Data の呼び出しを重ねない
  const guard = createGuard({
    repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, selfRunId: process.env.GITHUB_RUN_ID, log,
  });
  const client = createClient({ apiKey, spacingMs: 3000, maxPerMinute: 30, beforeRequest: guard.waitQuiet, log });
  try {
    // 既にデータがある場合は、待たずにここで止める
    if (store.existingCsvFiles(DATA_DIR).length) { process.exit((await runBackfill({ client, log })).exitCode); }
    await guard.waitStartWindow();
    process.exit((await runBackfill({ client, log })).exitCode);
  } catch (e) {
    console.error(`::error::MTF backfill: ${String(e.message).split(apiKey).join("***")}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { runBackfill };
