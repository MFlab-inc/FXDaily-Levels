"use strict";
/**
 * MTF判定フィードの毎日の更新（daily.yml の中、`node fetch.js` の後・コミットの前に実行する）。
 *   ・各銘柄の1時間足を直近1000本（1リクエスト）取って日足にし、確定日までを履歴CSVに追記する。
 *     既存の直近3日は取り直した値で上書きする。
 *   ・履歴CSV（data/mtf/ny-daily-<銘柄>.csv）が無い銘柄は取り込まない。CSVを作るのは過去分の取得（backfill.js）だけ
 *     （毎日の手順が不完全なCSVを先に作ると、過去分の取得が「データあり」で止まってしまうため）。
 *   ・その日の分を作成済みなら何もしない（daily.yml は1日に何度も起動する）。未完了のときの再試行は、前回から20分以上空け、同じ基準日につき最大8回。
 *     再試行では、完了済みの銘柄は取り直さない。手順全体に時間制限（170秒）を持たせ、超えた銘柄は失敗として記録する（価格フィードのコミットを巻き込まない）。
 *   ・fetch.js の結果・data/daily-levels.json には一切触れない。失敗は終了コード1で知らせる（daily.yml 側は continue-on-error）。
 *   ・ファイルは全部できてから data/ に置く（途中で止まっても中途半端なファイルを残さない）。
 */
const fs = require("fs");
const path = require("path");
const { SYMBOLS, DATA_DIR } = require("./config");
const { lastCompletedSessionDate, toJstIso } = require("./lib/ny-time");
const { aggregateHourlyToNyDaily } = require("./lib/daily-bars");
const { createClient, fetchRecent } = require("./lib/twelvedata");
const store = require("./lib/store");
const { buildFeed } = require("./lib/feed");

const FETCH_BARS = 1000; // 約40日分。1リクエスト（1クレジット）
const MAX_ATTEMPTS_PER_DAY = 8;       // 同じ基準日で未完了のときの作成回数の上限
const COOLDOWN_MS = 20 * 60 * 1000;   // 未完了の再試行の最短間隔（daily.yml は15分ごとに起動するので、30分で回数を使い切らないようにする）
const DEADLINE_MS = 170 * 1000;       // 手順全体の時間制限（通常は30秒前後）。価格フィードのコミットを巻き込まないため

function readPrevFeed(dataDir) {
  const p = path.join(dataDir, "mtf-feed.json");
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j && typeof j === "object" && Array.isArray(j.symbols) ? j : null; // 形が違うものは無いものとして作り直す
  } catch { return null; }
}

async function runDaily({ nowMs = Date.now(), dataDir = DATA_DIR, client, log = console.log } = {}) {
  const asOf = lastCompletedSessionDate(nowMs);
  const prev = readPrevFeed(dataDir);

  const have = store.existingCsvFiles(dataDir);
  if (!have.length) {
    log(`[mtf] 履歴CSV（${path.join("data", "mtf")}）がまだありません。過去分の取得（MTF Backfill）が済むまで何もしません`);
    return { exitCode: 0, skipped: "no-history", asOf };
  }

  if (prev && prev.as_of === asOf) {
    const prevSyms = prev.symbols;
    const complete = prev.status === "ok" && prevSyms.length === SYMBOLS.length && prevSyms.every((s) => s.status === "ok");
    const attempts = Number(prev.attempt) || 1;
    if (complete) {
      log(`[mtf] 基準日 ${asOf} の分は作成済みです（${prev.generated_at}）。何もしません`);
      return { exitCode: 0, skipped: "done", asOf };
    }
    if (attempts >= MAX_ATTEMPTS_PER_DAY) {
      log(`[mtf] 基準日 ${asOf} は ${attempts} 回試行済みで未完了のままです（${prev.coverage}）。これ以上は再試行しません`);
      return { exitCode: 0, skipped: "attempts-exhausted", asOf };
    }
    const since = nowMs - Date.parse(prev.generated_at);
    if (Number.isFinite(since) && since >= 0 && since < COOLDOWN_MS) {
      log(`[mtf] 基準日 ${asOf} は未完了ですが、前回の作成（${prev.generated_at}）から${Math.round(since / 60000)}分しか経っていないので、次回に回します`);
      return { exitCode: 0, skipped: "cooldown", asOf };
    }
  }
  const attempt = prev && prev.as_of === asOf ? (Number(prev.attempt) || 1) + 1 : 1;

  const updatedAtPrev = new Map((prev?.symbols || []).map((s) => [s.symbol, s.updated_at]));
  // 同じ基準日の再試行では、前回までに完了した銘柄は取り直さない（クレジットを使わない）
  const alreadyOk = new Set(prev && prev.as_of === asOf ? prev.symbols.filter((s) => s.status === "ok").map((s) => s.symbol) : []);
  const nowIso = toJstIso(nowMs);
  const items = [];
  const entries = [];
  const failures = [];
  for (const sym of SYMBOLS) {
    const item = { code: sym.code, rows: null, updatedAt: updatedAtPrev.get(sym.code) || null, error: null };
    items.push(item);
    let existing;
    try { existing = store.readRows(dataDir, sym.code); }
    catch (e) { item.error = e.message; failures.push(`${sym.code}: ${e.message}`); continue; }
    if (!existing) {
      item.error = "履歴CSVがありません（過去分の取得が未実施）";
      failures.push(`${sym.code}: ${item.error}`);
      continue;
    }
    if (!existing.length) {
      item.error = "履歴CSVが空です（見出し行だけ）";
      failures.push(`${sym.code}: ${item.error}`);
      continue;
    }
    item.rows = existing;
    if (alreadyOk.has(sym.code)) { log(`[mtf] ${sym.code}: 前回までに完了済みのため取り直しません`); continue; }
    try {
      const bars = await fetchRecent(client, sym.td, FETCH_BARS);
      const agg = aggregateHourlyToNyDaily(bars, { dropLeftEdge: true, cutoffDate: asOf });
      if (!agg.rows.length) throw new Error("取得した足から確定日足を作れませんでした");
      const merged = store.mergeRows(existing, agg.rows, { overwriteLast: 3 });
      item.rows = merged.rows;
      item.updatedAt = nowIso;
      if (merged.added || merged.updated) {
        entries.push({ file: path.join("mtf", `ny-daily-${sym.code}.csv`), content: store.toCsv(merged.rows) });
      }
      log(`[mtf] ${sym.code}: 取得${bars.length}本 → 日足${agg.rows.length}日 / 追加${merged.added}日・上書き${merged.updated}日`);
    } catch (e) {
      item.error = e.message;
      failures.push(`${sym.code}: ${e.message}`);
      log(`[mtf] ${sym.code}: 失敗 ${e.message}`);
    }
  }

  const { json, text } = buildFeed({ asOf, nowMs, items, attempt });
  entries.push({ file: "mtf-feed.json", content: JSON.stringify(json, null, 2) + "\n" });
  entries.push({ file: "mtf-feed.txt", content: text });
  store.writeAll(dataDir, entries);
  log(`[mtf] 書き込み: ${entries.map((e) => e.file).join(", ")} / ${json.coverage} / リクエスト${client.stats.requests}回`);

  // 取得は成功したが基準日の日足が揃っていない銘柄（足の公開の遅れ・休場など）。次回以降の実行で取り直す
  const stale = json.symbols.filter((s) => s.status === "stale");
  for (const s of stale) log(`::warning::MTF: ${s.symbol}: ${s.status_note}`);
  if (failures.length) {
    for (const f of failures) log(`::error::MTF: ${f}`);
    return { exitCode: 1, asOf, failures, stale: stale.map((s) => s.symbol) };
  }
  return { exitCode: 0, asOf, stale: stale.map((s) => s.symbol) };
}

async function main() {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) { console.error("ERROR: 環境変数 TWELVE_DATA_API_KEY が設定されていません"); process.exit(1); }
  const client = createClient({ apiKey, spacingMs: 2500, maxPerMinute: 30, deadlineAt: Date.now() + DEADLINE_MS, log: console.log });
  try {
    const r = await runDaily({ client });
    process.exit(r.exitCode);
  } catch (e) {
    console.error(`::error::MTF: ${String(e.message).split(apiKey).join("***")}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { runDaily, FETCH_BARS, MAX_ATTEMPTS_PER_DAY, COOLDOWN_MS, DEADLINE_MS };
