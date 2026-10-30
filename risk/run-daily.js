"use strict";

/**
 * 取引可否の指標（自前の定義）の更新。仕様は risk/SPEC.md。いまは VIX 順位とイベント警戒。
 *
 *   node risk/run-daily.js               VIX を取得し、イベント警戒を数え直して data/risk.json を更新する（常に取得）
 *   node risk/run-daily.js --if-stale    VIX が最新で、イベント警戒も今日の分なら、何もせず終了（risk.yml の schedule・workflow_run 用）。
 *                                        VIX が最新なら取得せず、イベント警戒だけ数え直す（予定表は手元のファイルなので外部へ接続しない）
 *   node risk/run-daily.js --check-fresh 外部へ接続せず、risk.json が「いま」最新か確かめる（古ければ終了コード1）
 *   --data-dir <dir>                     risk.json を置く場所（既定は data/。PR の試験で実データを取得して見るときに使う）
 *
 * VIX の取得先は Cboe 公式の VIX_History.csv だけ（FRED は使わない。SPEC 2節）。予定表は risk/events.csv。
 * 書くのは data/risk.json だけ。既存の fetch.js・intraday.js・rates/・mtf/ のファイルには触れない。
 */
const fs = require("fs");
const path = require("path");
const cfg = require("./config");
const { parseVixCsv } = require("./lib/parse");
const { vixSnapshot } = require("./lib/calc");
const { isOpen, missingOpenDays, expectedLatest } = require("./lib/calendar");
const { httpGet } = require("./lib/http");
const ev = require("./lib/events");
const view = require("./lib/view");
const { toJstIso, nyWallMs, isoDate } = require("../mtf/lib/ny-time");

const DATA_DIR = path.join(__dirname, "..", "data");
const EVENTS_PATH = path.join(__dirname, "events.csv");
const DAY = 86400000;

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// 内容の比較用（取得の時刻などの毎回変わる項目を除く）。同じ内容なら書き込まず、コミットも作らない
function stable(doc) {
  const c = JSON.parse(JSON.stringify(doc));
  delete c.as_of;
  if (c.vix && c.vix.source) { delete c.vix.source.fetched_at; delete c.vix.source.last_modified; }
  if (c.generation) delete c.generation.run_url;
  return JSON.stringify(c);
}

// ---- VIX の取得・計算（SPEC 2〜4節）----
async function fetchVix({ nowMs, fetchImpl, sleep, prevVix }) {
  let fetched, parsed;
  try {
    fetched = await httpGet(cfg.VIX.url, { label: "cboe:VIX_History.csv", fetchImpl, sleep });
  } catch (e) {
    return { error: `VIX：Cboe の VIX_History.csv を取得できませんでした: ${e.message}` };
  }
  try {
    parsed = parseVixCsv(fetched.text);
  } catch (e) {
    return { error: `VIX：Cboe の VIX_History.csv の形式が想定と違います: ${e.message}` };
  }
  const nyToday = isoDate(nyWallMs(nowMs));
  const lastRow = parsed.rows[parsed.rows.length - 1].date;
  if (lastRow > nyToday) return { error: `VIX：最新の行の日付 ${lastRow} が、米東部の今日（${nyToday}）より先です` };
  // 期待する最新日（米東部18:00を過ぎた営業日）より新しい行は、取引時間中の途中の値かもしれないので使わない（SPEC 4節）
  const expected = expectedLatest(nowMs, { readyMin: cfg.READY_ET_MIN, extraClosed: cfg.EXTRA_CLOSED_DATES });
  const unconfirmed = parsed.rows.filter((r) => r.date > expected).map((r) => r.date);
  // NYSE の休場日の行は使わない（SPEC 3節。順位は NYSE の営業日で数える定義。Cboe のファイルには米国の祝日にも行がある）
  const openRows = parsed.rows.filter((r) => r.date <= expected && isOpen(r.date, cfg.EXTRA_CLOSED_DATES));
  const snap = vixSnapshot(openRows, cfg.VIX);
  if (snap.error) return { error: `VIX：${snap.error}` };
  // 配信元から古い版のファイルが返ることがある（2026-10-30、Last-Modified が 01:31→01:10 GMT に戻った）。
  // 前回より古い日付には戻さず、前回の値を残す（SPEC 4節）
  if (prevVix && typeof prevVix.date === "string" && snap.date < prevVix.date) {
    return { keepPrev: `VIX：取得したファイルの最新日（${snap.date}）が前回（${prevVix.date}）より古いため、前回の値を残しました（配信元の古い版の可能性。Last-Modified：${fetched.lastModified ?? "なし"}）` };
  }

  // 確認（止めはしないが、記録して気づけるようにする）
  const warnings = [];
  if (parsed.skipped.length) {
    warnings.push(`VIX：順位に使わない古い行のうち${parsed.skipped.length}行を、形式の問題で飛ばしました（最初の1件：${parsed.skipped[0]}）`);
  }
  const windowDates = openRows.slice(-cfg.VIX.window).map((r) => r.date);
  const gaps = missingOpenDays(windowDates, cfg.EXTRA_CLOSED_DATES);
  if (gaps.length) warnings.push(`VIX：順位の範囲（${snap.window_start}〜${snap.date}）に、開いているはずなのに行が無い日があります：${gaps.join("、")}`);
  // 除いた休場日の行（順位の範囲の期間内）。想定どおりの動きなので警告にはしない
  const excludedClosedDays = parsed.rows.filter((r) => !isOpen(r.date, cfg.EXTRA_CLOSED_DATES) && r.date >= snap.window_start).map((r) => r.date);
  const { history, ...rest } = snap;
  return {
    vix: {
      ...rest,
      excluded_closed_days: excludedClosedDays,
      unconfirmed_rows_ignored: unconfirmed,
      warnings,
      source: { url: cfg.VIX.url, last_modified: fetched.lastModified, fetched_at: toJstIso(nowMs) },
      history,
    },
  };
}

// ---- イベント警戒（SPEC 5節。外部へは接続しない）----
function computeEvent(nowMs, eventsText) {
  try {
    const rows = ev.parseEventsCsv(eventsText);
    const event = ev.eventLevel(rows, nowMs, { calendarSha: ev.sha256(eventsText) });
    const warnings = [];
    if (event.reason) warnings.push(`イベント警戒：${event.reason}`);
    const left = Date.parse(event.calendar.coverage_until_jst) - nowMs;
    if (left < cfg.EVENT.coverageWarnDays * DAY) {
      warnings.push(`イベント警戒：予定表（risk/events.csv）が ${event.calendar.coverage_until_jst} で終わります。各公式サイトの次の年の日程で更新してください`);
    }
    return { event: { ...event, warnings } };
  } catch (e) {
    return {
      event: { level: "unknown", base_jst: ev.toJstIso(ev.baseMsOf(nowMs)), reason: `予定表を読めません: ${e.message}`, warnings: [] },
      error: `イベント警戒：予定表（risk/events.csv）を読めません: ${e.message}`,
    };
  }
}

async function run({
  argv = process.argv.slice(2), nowMs = Date.now(), fetchImpl, sleep, dataDir = DATA_DIR, eventsPath = EVENTS_PATH,
  log = console.log, env = process.env,
} = {}) {
  const ifStale = argv.includes("--if-stale"), checkFresh = argv.includes("--check-fresh");
  const riskPath = path.join(dataDir, "risk.json");
  const prev = readJson(riskPath);
  const vixState = view.evaluateVix(prev, nowMs);

  // ---- 外部へ接続しない確認 ----
  if (checkFresh) {
    const e = view.evaluateEvent(prev, nowMs);
    const label = { ok: "OK", pending: "PENDING", stale: "STALE" };
    log(`${label[vixState.state]}: ${vixState.reasons.join("／") || `VIX は ${prev.vix.date} まで（最新）`}`);
    log(`${label[e.state]}: ${e.reasons.join("／") || `イベント警戒は ${prev.event.base_jst} 基準（今日の分）`}`);
    return vixState.state === "stale" || e.state === "stale" ? 1 : 0;
  }

  const { event, error: eventError } = computeEvent(nowMs, fs.readFileSync(eventsPath, "utf8"));
  // 前回の記録に失敗が残っているときは、スキップせずに作り直す（失敗の記録が、その日のうち残り続けないように）
  const prevErrors = prev && prev.generation && Array.isArray(prev.generation.errors) ? prev.generation.errors : [];
  if (ifStale && vixState.state === "ok" && prevErrors.length === 0 && prev.event && JSON.stringify(prev.event) === JSON.stringify(event)) {
    log("VIX は最新、イベント警戒も今日の分のためスキップ。外部へは接続していません");
    return 0;
  }

  const errors = [], fetchNotes = [];
  let vix = prev && prev.schema === view.SCHEMA ? prev.vix ?? null : null;
  if (!ifStale || vixState.state !== "ok") {
    if (ifStale) log(`VIX の取得が必要（${vixState.reasons.join("／")}）`);
    const r = await fetchVix({ nowMs, fetchImpl, sleep, prevVix: vix });
    if (r.error) { errors.push(r.error); log(`NG: ${r.error}（VIX は前回の値のまま）`); }
    else if (r.keepPrev) { fetchNotes.push(r.keepPrev); log(r.keepPrev); }
    else vix = r.vix;
  }
  if (eventError) { errors.push(eventError); log(`NG: ${eventError}`); }
  const warnings = [...(vix && vix.warnings ? vix.warnings : []), ...fetchNotes, ...event.warnings];

  const doc = {
    schema: view.SCHEMA,
    as_of: toJstIso(nowMs),
    timezone: "Asia/Tokyo",
    vix,
    event,
    generation: {
      status: errors.length ? "error" : warnings.length ? "warning" : "ok",
      errors,
      warnings,
      run_url: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    },
    citations: cfg.CITATIONS,
    notes: [
      `VIX の順位（rank_pct）は、当日を含む直近${cfg.VIX.window}営業日の終値のうち、当日の終値以下だった日の割合（%）。自前の定義（risk/SPEC.md 3節）。`,
      "VIX の date は米国の営業日（VIX の終値の日）。日本時間では翌朝にあたる。",
      `イベント警戒は、日本時間のその日の${cfg.EVENT.baseJstHour}:00から${cfg.EVENT.windowDays}日以内に発表される最重要の予定（risk/events.csv）が${cfg.EVENT.highCount}件以上で High、それ未満で Normal。自前の定義（risk/SPEC.md 5節）。`,
      `VIX の threshold_pct（${cfg.VIX.thresholdPct}）は swing-flow の SPEC 3-6 の基準を写したもの。記事の取引可否の判定は swing-flow 側で行う。`,
    ],
  };

  if (prev && stable(prev) === stable(doc)) {
    log(`内容に変化がないため、risk.json は書き換えません（VIX ${vix ? vix.date : "なし"}・イベント警戒 ${event.level}）`);
    return errors.length ? 1 : 0;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${riskPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  fs.renameSync(tmp, riskPath);
  log(`保存完了: ${riskPath}（VIX ${vix ? `${vix.date} 順位 ${vix.rank_pct}%` : "なし"}、イベント警戒 ${event.level}（${event.count ?? "-"}件）、status=${doc.generation.status}）`);
  for (const w of warnings) log(`::warning title=取引可否の指標の確認::${w}`);
  return errors.length ? 1 : 0;
}

module.exports = { run, stable, computeEvent };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--data-dir");
  if (i >= 0 && !argv[i + 1]) { console.error("--data-dir の後に場所を書いてください"); process.exit(2); }
  const dataDir = i >= 0 ? path.resolve(argv[i + 1]) : DATA_DIR;
  run({ argv, dataDir }).then((code) => { process.exitCode = code; }).catch((e) => { console.error(e); process.exitCode = 1; });
}
