"use strict";
/**
 * バックテスト（仕様 6-2）。手動実行だけ（自動では動かさない）。
 *   node scripts/daytrade-backtest.js [--no-fetch] [--window-days=365] [--now=<ISO>] [--data-dir=<dir>] [--no-guard] [--no-risk-feed] [--spacing-ms=3000] [--dry-run]
 *   --dry-run … 何も書かない（H1履歴の保存も、結果の .md / .csv も）。件数だけ表示する
 * 1) H1履歴 data/history/h1-<銘柄>.csv が無い銘柄だけ Twelve Data から取得して保存する（既にあれば再取得しない）。
 *    1分あたり55回を超えないよう、1銘柄ずつ約3秒おき（毎分20回前後、直近60秒で30回まで）。環境変数 TWELVE_DATA_API_KEY。
 *    GitHub Actions 上では、他の Daily / Intraday が動いている間と、その起動分は避ける（mtf/lib/guard.js）。
 * 2) 過去の各設計時刻（設計①②③と、型Bの追加＝毎時 16:00〜21:00）に案を作り、到達・SL/TP1先着を判定して、
 *    data/daytrade/backtest-<日付>.md と .csv に出す。SL下限方式 (a) 現行（10pips未満は不採用）と (b) 10pips下限で広げて採用 の
 *    両方を同じ入力で計算して並べる（ライブの規則は (a) のまま）。
 */
const fs = require("fs");
const path = require("path");
const { parseArgs, repoRoot, dataDir: defaultDataDir } = require("./daytrade/cli");
const { PAIRS } = require("./daytrade/pairs");
const H = require("./daytrade/h1history");
const { runBacktestModes, aggregate, floorBreakdown, planDates } = require("./daytrade/backtest");
const { toCsv, toMarkdown } = require("./daytrade/report");
const { REGIME } = require("./daytrade/histctx");
const { fetchRiskFeed } = require("./daytrade/riskfeed");
const { parseH1 } = require("./daytrade/inputs");
const { createClient } = require("../mtf/lib/twelvedata");
const { createGuard } = require("../mtf/lib/guard");
const store = require("../mtf/lib/store");
const { parseIso, jstIso, jstAt, addDaysJst } = require("./daytrade/jst");

async function main(argv = process.argv.slice(2), env = process.env, io = { log: console.log }) {
  const args = parseArgs(argv);
  const nowMs = args.now ? parseIso(args.now) : Date.now();
  const dataDir = args["data-dir"] ? path.resolve(args["data-dir"]) : defaultDataDir;
  const windowDays = args["window-days"] ? Number(args["window-days"]) : 365;
  const spacingMs = args["spacing-ms"] !== undefined ? Number(args["spacing-ms"]) : 3000; // 試験用に短縮できる。上限（直近60秒で30回）は maxPerMinute が守る
  if (!Number.isFinite(nowMs) || !Number.isInteger(windowDays) || windowDays < 1 || !Number.isFinite(spacingMs) || spacingMs < 0) throw new Error("--now / --window-days / --spacing-ms が読めません");
  const dates = planDates(nowMs, windowDays);
  const startLabel = `${addDaysJst(dates[0], -3)} 00:00:00`; // 窓の3日前から（ATR・群のウォームアップ）[Q35]

  // 1) H1履歴（無い銘柄だけ取得）
  const have = new Set(H.existingCodes(dataDir));
  const missing = PAIRS.filter((p) => !have.has(p.code));
  const fetched = new Map();
  if (missing.length && !args["no-fetch"]) {
    const apiKey = env.TWELVE_DATA_API_KEY;
    if (!apiKey) throw new Error("H1履歴が無い銘柄があり、環境変数 TWELVE_DATA_API_KEY がありません");
    let guard = null;
    if (!args["no-guard"] && env.GITHUB_TOKEN && env.GITHUB_REPOSITORY) {
      guard = createGuard({ repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, selfRunId: env.GITHUB_RUN_ID, log: io.log, watchNames: ["Daily FX Data", "Intraday Snapshot", "MTF Backfill"] });
      await guard.waitStartWindow();
    }
    const client = createClient({ apiKey, spacingMs, maxPerMinute: 30, beforeRequest: guard ? guard.waitQuiet : null, log: io.log });
    const live = parseH1(JSON.parse(fs.readFileSync(path.join(dataDir, "h1-bars.json"), "utf8")));
    for (const pair of missing) {
      const bars = await H.fetchH1(client, pair, { startLabel, nowMs, log: io.log });
      if (!bars.length || bars[0].t > jstAt(dates[0], "00:00")) throw new Error(`${pair.code}: 取得したH1が窓の先頭（${dates[0]}）に届いていません`);
      const v = H.verifyAgainstLive(bars, live[pair.code] || [], pair);
      if (v.overlap >= 100 && v.mismatch / v.overlap > 0.01) throw new Error(`${pair.code}: h1-bars.json との重なり${v.overlap}本のうち${v.mismatch}本が不一致です（時刻の解釈がずれている疑い）: ${JSON.stringify(v.sample)}`);
      io.log(`[backtest] ${pair.code}: ${bars.length}本（${jstIso(bars[0].t).slice(0, 16)}〜）、h1-bars.json との重なり ${v.overlap}本中 不一致 ${v.mismatch}`);
      fetched.set(pair.code, { bars, verify: v });
    }
    // 全銘柄そろってから置く（途中で失敗したら何も書かない）
    if (!args["dry-run"]) {
      store.writeAll(dataDir, [...fetched].map(([code, x]) => ({ file: path.join("history", `h1-${code}.csv`), content: H.toCsv(x.bars, PAIRS.find((p) => p.code === code)) })));
      io.log(`[backtest] H1履歴を保存: ${[...fetched.keys()].join(", ")}（リクエスト ${client.stats.requests}回）`);
    }
  } else if (missing.length) throw new Error(`H1履歴が無い銘柄があります（${missing.map((p) => p.code).join(",")}）。--no-fetch を外してください`);

  // 2) 読み込み
  const barsByCode = {}, history = [];
  for (const pair of PAIRS) {
    const bars = fetched.get(pair.code)?.bars || H.readH1(dataDir, pair.code);
    barsByCode[pair.code] = bars;
    history.push({ code: pair.code, bars: bars.length, first: jstIso(bars[0].t).slice(0, 10), last: jstIso(bars[bars.length - 1].t).slice(0, 16).replace("T", " "), gaps: H.gapReport(bars).length, verify: fetched.get(pair.code)?.verify ?? null, fetched: fetched.has(pair.code) });
  }
  const rowsByCode = {}, noMtf = [];
  for (const pair of PAIRS) {
    const rows = store.readRows(dataDir, pair.code);
    if (rows && rows.length) rowsByCode[pair.code] = rows; else noMtf.push(pair.code);
  }

  // 3) ボラ状態の閾値（risk-feed の meta.thresholds。取れなければ同じ数値の既定値）
  let thresholds = REGIME, regimeSource = "risk-feed の取得に失敗したため、同じ数値の既定値（50／80／95）を使用";
  if (!args["no-risk-feed"]) {
    try {
      const res = await fetch(`https://mflab-inc.github.io/EA-Risk-Monitor/data/risk-feed.json?nocache=${Math.floor(nowMs / 1000)}`, { signal: AbortSignal.timeout(15000) });
      const th = (await res.json())?.meta?.thresholds?.regime_percentile;
      if (th && Number.isFinite(th.caution) && Number.isFinite(th.highvol) && Number.isFinite(th.extreme)) {
        thresholds = { caution: th.caution, highvol: th.highvol, extreme: th.extreme };
        regimeSource = `risk-feed の meta.thresholds.regime_percentile（${th.caution}／${th.highvol}／${th.extreme}）。日足（data/mtf）のATR14÷終値の過去250営業日パーセンタイルで再計算した近似で、risk-feed の実値ではない`;
      }
    } catch { /* 既定値のまま */ }
  }

  // 4) 実行・出力
  const { records, stats, statsByMode } = runBacktestModes({ barsByCode, rowsByCode, nowMs, windowDays, thresholds });
  const rows = aggregate(records);
  const day = jstIso(nowMs).slice(0, 10);
  const md = toMarkdown(rows, { nowMs, window: { first: stats.first, last: stats.last }, stats, statsByMode, floorRows: floorBreakdown(records), history, regimeSource, noMtf });
  if (!args["dry-run"]) {
    store.writeAll(dataDir, [
      { file: path.join("daytrade", `backtest-${day}.md`), content: md },
      { file: path.join("daytrade", `backtest-${day}.csv`), content: toCsv(rows) },
    ]);
  }
  io.log(`[backtest] 完了${args["dry-run"] ? "（--dry-run: 何も書いていません）" : ""}: 案 ${records.length}件（SL下限方式 (a)(b) の合計。A案・B案を別に数える）、設計 ${stats.designs}回、型B追加の出来事 ${stats.adds}回、評価 ${stats.evaluations}件（1方式あたり）${args["dry-run"] ? "" : ` → data/daytrade/backtest-${day}.md / .csv`}`);
  return { records, rows, stats, statsByMode };
}

if (require.main === module) {
  main().catch((e) => { console.error(`::error::daytrade-backtest: ${String(e.stack || e.message).split(process.env.TWELVE_DATA_API_KEY || "\u0000").join("***")}`); process.exit(1); });
}
module.exports = { main };
