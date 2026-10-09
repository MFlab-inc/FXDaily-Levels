"use strict";
/**
 * 銘柄の追加（その銘柄だけ、過去分の日足を1回取得して履歴CSVを作る）。
 *   node mtf/add-symbol.js NZDUSD
 * mtf/backfill.js は『履歴CSVが1つでもあれば止まる』ので、あとから銘柄を足すときはこちらを使う。
 *   ・対象は mtf/config.js の SYMBOLS にある銘柄（先に足しておく）。その銘柄の履歴CSVが既にあれば、何も取得せず・何も書かずに止まる（上書きしない）
 *   ・ほかの銘柄は取得しない。履歴CSV（data/mtf/）から読むだけで、書き換えない。1つでも無い（空）なら、何も取得せず・何も書かずに止まる
 *   ・取得はその銘柄の1時間足 2024-07-01〜（4回前後）。1つでも失敗したら何も書かない（やり直せる）
 *   ・成功したら、その銘柄の履歴CSV 1本と mtf-feed.json / mtf-feed.txt をまとめて置く。
 *     フィードの既存の銘柄は、前回のフィードの updated_at・attempt のまま（値を変えない。基準日が同じとき）
 */
const fs = require("fs");
const path = require("path");
const { SYMBOLS, BACKFILL_START, DATA_DIR } = require("./config");
const { lastCompletedSessionDate, toJstIso } = require("./lib/ny-time");
const { createClient } = require("./lib/twelvedata");
const { createGuard } = require("./lib/guard");
const { fetchDailyHistory, checkHistory } = require("./lib/history");
const store = require("./lib/store");
const { buildFeed } = require("./lib/feed");

function readPrevFeed(dataDir) {
  const p = path.join(dataDir, "mtf-feed.json");
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j && typeof j === "object" && Array.isArray(j.symbols) ? j : null;
  } catch { return null; }
}

async function runAddSymbol({
  code, nowMs = Date.now(), dataDir = DATA_DIR, client, log = console.log,
  start = BACKFILL_START, pageSize, minRows = 400,
} = {}) {
  const sym = SYMBOLS.find((s) => s.code === code);
  if (!sym) {
    log(`::error::${code} は mtf/config.js の SYMBOLS にありません（先に足してください）。何も取得せず・何も書かずに止まりました`);
    return { exitCode: 1, stopped: "unknown-symbol" };
  }
  const file = `ny-daily-${code}.csv`;
  if (store.existingCsvFiles(dataDir).includes(file)) {
    log(`::error::data/mtf/${file} が既にあります。上書きを避けるため、何も取得せず・何も書かずに止まりました`);
    return { exitCode: 1, stopped: "exists" };
  }
  // ほかの銘柄は履歴CSVから読むだけ（取得しない）。欠けていれば、フィードを欠けた形で出さないために止まる
  const others = [];
  for (const s of SYMBOLS) {
    if (s.code === code) continue;
    const rows = store.readRows(dataDir, s.code);
    if (!rows || !rows.length) {
      log(`::error::${s.code} の履歴CSVがありません（または空です）。フィードを作れないので、何も取得せず・何も書かずに止まりました`);
      return { exitCode: 1, stopped: "missing-others", missing: s.code };
    }
    others.push({ code: s.code, rows });
  }

  const asOf = lastCompletedSessionDate(nowMs);
  const h = await fetchDailyHistory(client, sym, { start, cutoffDate: asOf, pageSize, log });
  checkHistory(sym.code, h.rows, { start, minRows });
  log(`[mtf] ${sym.code}: 1時間足${h.hourBars}本 → 日足${h.rows.length}日（${h.rows[0].date} 〜 ${h.rows[h.rows.length - 1].date}）、左端で捨てた日=${h.leftEdgeDropped || "なし"}、週末の足=${h.weekendBars}本`);

  const prev = readPrevFeed(dataDir);
  const sameDay = prev && prev.as_of === asOf;
  const updatedAtPrev = new Map((prev?.symbols || []).map((s) => [s.symbol, s.updated_at]));
  const items = others.map((o) => ({ code: o.code, rows: o.rows, updatedAt: updatedAtPrev.get(o.code) || null }));
  items.push({ code: sym.code, rows: h.rows, updatedAt: toJstIso(nowMs) });
  const { json, text } = buildFeed({ asOf, nowMs, items, attempt: sameDay ? (Number(prev.attempt) || 1) : 1 });
  store.writeAll(dataDir, [
    { file: path.join("mtf", file), content: store.toCsv(h.rows) },
    { file: "mtf-feed.json", content: JSON.stringify(json, null, 2) + "\n" },
    { file: "mtf-feed.txt", content: text },
  ]);
  log(`[mtf] 書き込み完了: ${file} + mtf-feed.json / mtf-feed.txt（基準日 ${asOf}、${json.coverage}、リクエスト${client.stats.requests}回）`);
  return { exitCode: 0, asOf, requests: client.stats.requests };
}

async function main() {
  const code = process.argv[2];
  if (!code) { console.error("使い方: node mtf/add-symbol.js <銘柄コード（例: NZDUSD）>"); process.exit(1); }
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) { console.error("ERROR: 環境変数 TWELVE_DATA_API_KEY が設定されていません"); process.exit(1); }
  const log = (...a) => console.log(...a);
  // 他の Daily / Intraday の実行と Twelve Data の呼び出しを重ねない（GitHub Actions 上だけ。トークンが無ければ待たない）
  const guard = process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY
    ? createGuard({ repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, selfRunId: process.env.GITHUB_RUN_ID, log })
    : null;
  const client = createClient({ apiKey, spacingMs: 3000, maxPerMinute: 30, beforeRequest: guard ? guard.waitQuiet : null, log });
  try {
    // 履歴CSVが既にあるなどで止まる場合は、待たずにここで止める
    const sym = SYMBOLS.find((s) => s.code === code);
    if (!sym || store.existingCsvFiles(DATA_DIR).includes(`ny-daily-${code}.csv`)) process.exit((await runAddSymbol({ code, client, log })).exitCode);
    if (guard) await guard.waitStartWindow();
    process.exit((await runAddSymbol({ code, client, log })).exitCode);
  } catch (e) {
    console.error(`::error::MTF add-symbol: ${String(e.message).split(apiKey).join("***")}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { runAddSymbol };
