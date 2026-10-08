"use strict";

/**
 * 日米2年金利フィード（data/rates.json）の更新。仕様は rates/SPEC.md。
 *
 *   node rates/run-daily.js              取得して data/rates.json を更新する（手動実行・常に取得）
 *   node rates/run-daily.js --if-stale   公表前、または既に最新で健全なら、取得せずに終了（rates.yml の schedule・workflow_run・外部cron用）
 *   node rates/run-daily.js --check-fresh  外部へ接続せず、rates.json が「いま」最新か確かめる（健全なら0、古ければ1）
 *
 * 米国：米財務省 Daily Treasury Par Yield Curve Rates のCSV（一次）。同じ財務省のXMLと照合する。FREDは使わない。
 * 日本：財務省 国債金利情報（jgbcm.csv ＋ 必要なときだけ jgbcm_all.csv）。
 * 既存の fetch.js・intraday.js・daily-levels.json には触れない。
 */
const fs = require("fs");
const path = require("path");
const cfg = require("./config");
const parse = require("./lib/parse");
const cal = require("./lib/calendar");
const { httpGet } = require("./lib/http");
const { buildSnapshot } = require("./lib/snapshot");
const view = require("./lib/view");
const { toJstIso, nyWallMs, isoDate } = require("../mtf/lib/ny-time");

const DATA_DIR = path.join(__dirname, "..", "data");
const HOLIDAYS_PATH = path.join(__dirname, "jp-holidays.csv");

const mergeRows = (...lists) => {
  const m = new Map();
  for (const rows of lists) for (const r of rows) m.set(r.date, r);
  return [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
};

function loadBundledHolidays() {
  return parse.parseCaoHolidays(parse.decodeShiftJis(fs.readFileSync(HOLIDAYS_PATH)));
}

// 同梱の祝日表（rates/jp-holidays.csv）が、今年と来年をカバーしていなければ、更新を促す警告（GitHub Actions の注釈）
function holidayCoverageWarning(holidays, today) {
  const need = Number(today.slice(0, 4)) + 1;
  const years = new Set([...holidays].map((d) => Number(d.slice(0, 4))));
  return years.has(need) ? null
    : `::warning title=祝日表の更新が必要::rates/jp-holidays.csv に${need}年がありません。内閣府の祝日CSVで更新してください（${need + 1}年に入ると日本の営業日を決められず、判定できません になります）`;
}

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// ---- 取得 ----
async function fetchUs({ nowMs, get, log }) {
  const fetchedAt = toJstIso(nowMs);
  try {
    // 米国の値の年は米東部の年（日本時間の年が先に変わっても、新しい年の行は米東部の年が変わるまで出ない）
    const year = Number(isoDate(nyWallMs(nowMs)).slice(0, 4));
    let rows = [];
    // 年初は、その年の最初の行がまだ無く、財務省は本文が空のHTTP 200で返す。その年は空として扱う
    const csvOf = async (y) => parse.parseTreasuryCsv((await get(cfg.URLS.treasuryCsv(y), `treasury:csv:${y}`)).bytes.toString("utf8"), { allowEmpty: true });
    rows = await csvOf(year);
    // 年初は、その年の行が少なく5営業日前まで届かない。前の年も取る
    if (rows.length < cfg.US_YEAR_MIN_ROWS) rows = mergeRows(await csvOf(year - 1), rows);
    if (!rows.length) throw new Error("財務省CSV: データ行がありません");
    // 同じ財務省のXMLで照合する（取れなくても、CSVの値の採用は止めない。照合は「未実施」と記録する）
    let xml;
    try {
      xml = { rows: parse.parseTreasuryXml((await get(cfg.URLS.treasuryXml(year), `treasury:xml:${year}`)).bytes.toString("utf8")) };
    } catch (e) { xml = { error: e.message }; log(`  XML照合は未実施: ${e.message}`); }
    return { rows, xml, fetchedAt };
  } catch (e) {
    return { error: `米財務省CSVの取得・解析に失敗: ${e.message}` };
  }
}

async function fetchJp({ nowMs, get, log }) {
  const fetchedAt = toJstIso(nowMs);
  try {
    const month = await get(cfg.URLS.mofMonth, "mof:jgbcm.csv");
    let rows = parse.parseMofCsv(parse.decodeShiftJis(month.bytes));
    // 月初は当月ファイルの行が少なく、5営業日前まで届かない。全期間ファイルで補う
    const need = rows.filter((r) => r.milli !== null).length < cfg.MOF_MONTH_MIN_ROWS;
    let partial = null;
    if (need) {
      log("  日2年: 当月ファイルの行が少ないため、全期間ファイルを取得します");
      try {
        const all = await get(cfg.URLS.mofAll, "mof:jgbcm_all.csv", { timeoutMs: cfg.HTTP.largeTimeoutMs });
        rows = mergeRows(parse.parseMofCsv(parse.decodeShiftJis(all.bytes)), rows);
      } catch (e) {
        // 当月ファイルだけで5営業日差まで足りるなら続行できる。足りなければ判定できません（snapshot.js が記録する）
        partial = `全期間ファイルを取得できませんでした: ${e.message}`;
        log(`  ${partial}`);
      }
    }
    return { rows, lastModified: month.lastModified, fetchedAt, partial };
  } catch (e) {
    return { error: `財務省の国債金利情報の取得・解析に失敗: ${e.message}` };
  }
}

// 内閣府の祝日CSV（最新の祝日表）。取れなければ、同梱の祝日表（rates/jp-holidays.csv）だけを使う
async function loadHolidays({ get, log }) {
  const bundled = loadBundledHolidays();
  try {
    const live = parse.parseCaoHolidays(parse.decodeShiftJis((await get(cfg.URLS.caoHolidays, "cao:holidays")).bytes));
    return { holidays: new Set([...bundled, ...live]), source: "cao_live+bundled" };
  } catch (e) {
    log(`  祝日表: 内閣府CSVを取得できないため、同梱の祝日表を使います（${e.message}）`);
    return { holidays: bundled, source: "bundled" };
  }
}

// 内容の比較用（取得の時刻などの毎回変わる項目を除く）。同じ内容なら書き込まず、コミットも作らない
function stable(doc) {
  const c = JSON.parse(JSON.stringify(doc));
  delete c.as_of;
  delete c.calendar_source;
  if (c.us2y) delete c.us2y.fetched_at;
  if (c.jp2y) delete c.jp2y.fetched_at;
  if (c.generation) delete c.generation.run_url;
  return JSON.stringify(c);
}

async function run({
  argv = process.argv.slice(2), nowMs = Date.now(), fetchImpl, sleep, dataDir = DATA_DIR,
  log = console.log, env = process.env, bundledOnly = false,
} = {}) {
  const ifStale = argv.includes("--if-stale"), checkFresh = argv.includes("--check-fresh");
  const ratesPath = path.join(dataDir, "rates.json");
  const prev = readJson(ratesPath);
  const get = (url, label, opts = {}) => httpGet(url, { label, fetchImpl, sleep, ...opts });

  // ---- 外部へ接続しない確認 ----
  if (checkFresh) {
    const warn = holidayCoverageWarning(loadBundledHolidays(), cal.jstParts(nowMs).date);
    if (warn) log(warn);
    const r = view.evaluate(prev, nowMs, loadBundledHolidays());
    log(`${r.state === "ok" ? "OK" : r.state === "pending" ? "PENDING" : "STALE"}: ${r.reasons.join("／") || "米・日とも最新"}`);
    return r.state === "stale" ? 1 : 0;
  }

  const { date: today, min } = cal.jstParts(nowMs);
  const bundled = loadBundledHolidays();
  if (ifStale) {
    // 日2年の公表（翌営業日の午前9時30分頃）の前は、取りに行かない
    try {
      if (cal.isJpBusinessDay(today, bundled) && min < cfg.JP_READY_JST_MIN) {
        log("公表前（日本の営業日の9:40より前）のためスキップ。外部へは接続していません");
        return 0;
      }
    } catch (e) { if (!(e instanceof cal.CalendarError)) throw e; }
    const r = view.evaluate(prev, nowMs, bundled);
    if (r.state === "ok") { log("既に最新のためスキップ。外部へは接続していません"); return 0; }
    log(`取得が必要（${r.reasons.join("／")}）`);
  }

  const { holidays, source: calendarSource } = bundledOnly
    ? { holidays: bundled, source: "bundled" } : await loadHolidays({ get, log });
  const [us, jp] = await Promise.all([
    fetchUs({ nowMs, get, log }),
    fetchJp({ nowMs, get, log }),
  ]);
  if (us.error) log(`NG: ${us.error}`);
  if (jp.error) log(`NG: ${jp.error}`);
  if (us.error && jp.error) {
    log("米・日ともに取得できなかったため、rates.json は更新しません（前回の内容のまま。古ければ --check-fresh が赤くします）");
    return 1;
  }

  const snap = buildSnapshot({ nowMs, holidays, prev, us, jp });
  let pendingWindow = false;
  try { pendingWindow = cal.isJpBusinessDay(today, holidays) && min < cfg.PENDING_UNTIL_JST_MIN; } catch (e) { if (!(e instanceof cal.CalendarError)) throw e; }
  const status = snap.errors.length ? "partial" : snap.notFresh ? (pendingWindow ? "pending" : "partial") : "ok";
  const jstHour = Math.floor(min / 60);
  const retryExpected = status !== "ok" && jstHour < cfg.SAME_DAY_RETRY_UNTIL_JST_HOUR;
  const doc = {
    schema: view.SCHEMA,
    as_of: toJstIso(nowMs),
    timezone: "Asia/Tokyo",
    us2y: snap.us2y, jp2y: snap.jp2y, spread: snap.spread, change_5d: snap.change_5d,
    judgment: snap.judgment,
    generation: {
      status, complete: status === "ok", errors: snap.errors,
      retry_expected: retryExpected,
      retry_note: retryExpected
        ? `同日中に rates.yml の再試行cronが残っている（JST ${cfg.SAME_DAY_RETRY_UNTIL_JST_HOUR}時頃まで）。次の実行で自動的に再取得される`
        : "同日中の自動再試行は残っていない。復旧は翌営業日の定期実行、または rates.yml の手動実行(workflow_dispatch)",
      run_url: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    },
    calendar_source: calendarSource,
    citations: cfg.CITATIONS,
    notes: [
      "観測の時刻が違う：日本は東京、米国は米東部（約13時間のずれ）。同じ暦日どうしを並べている。",
      "判定は金利差の5営業日差の機械的な分類で、トレード判定ではない。",
    ],
  };

  if (prev && stable(prev) === stable(doc)) {
    log("内容に変化がないため、rates.json は書き換えません");
    return 0;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${ratesPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  fs.renameSync(tmp, ratesPath);
  log(`保存完了: ${ratesPath}（status=${status}、判定=${doc.judgment.label}）`);
  return 0;
}

module.exports = { run, stable, loadBundledHolidays, holidayCoverageWarning };

if (require.main === module) {
  run().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e); process.exitCode = 1; });
}
