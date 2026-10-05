"use strict";
/**
 * 【一時的】MTF判定フィードの試験運転（仕様 5-0）。PRのブランチ上でだけ実行し、マージ前に取り除く。
 * 9銘柄を 2024-07-01 から取得し（メモリ上のみ・ファイルもコミットも作らない）、
 * 9/25・9/30(参考)・10/2 時点の判定を、仕様 5-1・5-2 の値と比べる表と、データ品質の一覧をログに出す。
 *   Twelve Data: 1銘柄ずつ約3秒おき（1分あたり20回前後、直近60秒で30回まで）。
 *   他の Daily / Intraday の実行中・起動分(:00 :02 :15 :17 :20 :30 :32 :45 :47 :50)は避ける。APIキーは出さない。
 */
const { SYMBOLS, BACKFILL_START, VERSION } = require("./config");
const { lastCompletedSessionDate, toJstIso, addDays } = require("./lib/ny-time");
const { createClient } = require("./lib/twelvedata");
const { createGuard, inTriggerMinute } = require("./lib/guard");
const { fetchDailyHistory, checkHistory } = require("./lib/history");
const calc = require("./lib/calc");
const { buildFeed } = require("./lib/feed");

const API_KEY = process.env.TWELVE_DATA_API_KEY || "";
if (!API_KEY) { console.log("ERROR: TWELVE_DATA_API_KEY が未設定です（APIは呼んでいません）"); process.exit(1); }
if (Intl.DateTimeFormat().resolvedOptions().timeZone !== "UTC") { console.log("ERROR: 実行環境のタイムゾーンがUTCではないため中止します（APIは呼んでいません）"); process.exit(1); }
const scrub = (s) => String(s).split(API_KEY).join("***").replace(/apikey=[^&\s"']+/gi, "apikey=***");
const out = (...a) => console.log(scrub(a.join(" ")));

const AS_OFS = [
  { date: "2026-09-25", label: "9/25時点（月=8月・週日=9/25）" },
  { date: "2026-09-30", label: "9/30時点（参考。3-4により9月が確定）" },
  { date: "2026-10-02", label: "10/2時点（月=9月・週日=10/2）" },
];
// 仕様 5-1（月・週・日）
const EXPECT_DIR = {
  "2026-09-25": { USDJPY: "→→↓", EURUSD: "→↓↓", GBPUSD: "↑→↓", AUDUSD: "↑→→", EURJPY: "↑↓↓" },
  "2026-10-02": { USDJPY: "→→↓", EURUSD: "↓↓↓", GBPUSD: "↓→↓", AUDUSD: "→→↓", EURJPY: "↓↓↓" },
};
const EXPECT_COMBO = {
  USDJPY: ["1/3 Down", "No Swing / Excluded"], EURUSD: ["3/3 Down", "Swing Main Candidate"], GBPUSD: ["2/3 Down", "Conditional Swing Candidate"],
  AUDUSD: ["1/3 Down", "No Swing / Excluded"], EURJPY: ["3/3 Down", "Swing Main Candidate"],
};
// 仕様 5-2
const EXPECT_NUM = {
  USDJPY: { close: 157.874, dma50: 158.05742, dma200: 158.50708 },
  EURUSD: { close: 1.12524, dma50: 1.152659, dma200: 1.1609524 },
  GBPUSD: { close: 1.32405, dma50: 1.3453124, dma200: 1.3445891 },
  AUDUSD: { close: 0.69574, dma50: 0.7091202, dma200: 0.7030704 },
  EURJPY: { close: 177.629, dma50: 182.18144, dma200: 183.993885 },
};
const ARTICLE_50 = [["2026-10-01", "EURUSD", 1.15290], ["2026-10-01", "EURJPY", 182.355], ["2026-09-30", "EURUSD", 1.15317], ["2026-09-30", "EURJPY", 182.529]];
const DIGITS = Object.fromEntries(SYMBOLS.map((s) => [s.code, s.digits]));
const f = (x, d) => (x === null || x === undefined ? "-" : x.toFixed(d));
const sgn = (x, d) => (x === null || x === undefined ? "-" : (x >= 0 ? "+" : "") + x.toFixed(d));

async function main() {
  const nowMs = Date.now();
  const cutoff = lastCompletedSessionDate(nowMs);
  out(`# MTF 試験運転 開始 ${toJstIso(nowMs)} / 取得 ${BACKFILL_START} 〜 ${cutoff}（確定日） / ${VERSION}`);
  const guard = createGuard({ repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, selfRunId: process.env.GITHUB_RUN_ID, log: out, watchNames: ["Daily FX Data", "Intraday Snapshot", "MTF Backfill"] });

  // 呼び出し時刻の記録（1分あたりの回数・起動分との重なりの確認用）
  const stamps = [];
  const rec = (...a) => { stamps.push(Date.now()); return fetch(...a); };
  const client = createClient({ apiKey: API_KEY, fetchImpl: rec, spacingMs: 3000, maxPerMinute: 30, beforeRequest: guard.waitQuiet, log: out });

  await guard.waitStartWindow();
  out(`# 開始 ${new Date().toISOString()}`);

  const data = {};
  const hist = [];
  for (const sym of SYMBOLS) {
    const h = await fetchDailyHistory(client, sym, { start: BACKFILL_START, cutoffDate: cutoff, log: out });
    checkHistory(sym.code, h.rows, { start: BACKFILL_START, minRows: 400 });
    data[sym.code] = h.rows;
    hist.push({ code: sym.code, hourBars: h.hourBars, weekendBars: h.weekendBars, left: h.leftEdgeDropped, rows: h.rows.length, first: h.rows[0].date, last: h.rows[h.rows.length - 1].date });
  }

  // ---------------- リクエストの状況 ----------------
  const perMin = new Map();
  for (const t of stamps) { const k = new Date(t).toISOString().slice(0, 16); perMin.set(k, (perMin.get(k) || 0) + 1); }
  let maxSliding = 0;
  for (let i = 0; i < stamps.length; i++) maxSliding = Math.max(maxSliding, stamps.filter((t) => t > stamps[i] - 60000 && t <= stamps[i]).length);
  const hitTrigger = [...perMin.keys()].filter((k) => inTriggerMinute(Date.parse(k + ":00Z")));
  out("");
  out("## 0. リクエストの状況");
  out(`リクエスト合計 ${client.stats.requests} 回（再試行 ${client.stats.retries}・429 ${client.stats.rateLimited}）。暦の1分あたり最大 ${Math.max(...perMin.values())} 回 / 直近60秒の最大 ${maxSliding} 回（上限の目安 40）`);
  out(`使った分(UTC): ${[...perMin.entries()].map(([k, v]) => `${k.slice(11)}×${v}`).join(" ")}`);
  out(`daily/intraday の起動分(:00 :02 :15 :17 :20 :30 :32 :45 :47 :50)に当たった分: ${hitTrigger.length ? hitTrigger.join(", ") : "なし"}`);

  // ---------------- 取得の概要 ----------------
  out("");
  out("## 1. 取得の概要（銘柄 / 1時間足の本数 / うち週末で捨てた足 / 左端で捨てた日 / 日足の日数 / 最初〜最後）");
  for (const h of hist) out(`${h.code}: 1時間足 ${h.hourBars}本 / 週末の足 ${h.weekendBars}本 / 左端で捨てた日 ${h.left || "なし"} / 日足 ${h.rows}日 / ${h.first} 〜 ${h.last}`);

  // ---------------- 判定 ----------------
  const res = {};
  for (const a of AS_OFS) { res[a.date] = {}; for (const s of SYMBOLS) res[a.date][s.code] = calc.computeStructure(data[s.code], { asOf: a.date }); }

  out("");
  out("## 2. 向きの比較（仕様 5-1）: 月・週・日");
  let mismatches = 0, compared = 0;
  for (const a of AS_OFS) {
    out(`### ${a.label}`);
    for (const s of SYMBOLS) {
      const r = res[a.date][s.code];
      const got = `${r.monthly.direction}${r.weekly.direction}${r.daily.direction}`;
      const exp = (EXPECT_DIR[a.date] || {})[s.code];
      let mark = "（期待値なし）";
      if (exp) { compared++; if (exp === got) mark = "一致 ✓"; else { mark = "不一致 ✗"; mismatches++; } }
      const combo = a.date === "2026-10-02" && EXPECT_COMBO[s.code] ? EXPECT_COMBO[s.code] : null;
      const comboMark = combo ? ((combo[0] === r.alignment_score && combo[1] === r.swing_status) ? "一致 ✓" : "不一致 ✗") : "";
      out(`${s.code.padEnd(7)} 計算 ${got}  期待 ${exp || "-"}  ${mark}  | ${r.alignment_score} / ${r.swing_status}${combo ? `  （期待 ${combo[0]} / ${combo[1]} ${comboMark}）` : ""}`);
    }
  }
  out(`向きの照合: ${compared}件中 ${compared - mismatches}件一致、${mismatches}件不一致`);

  out("");
  out("## 3. 判定の余裕（向きの根拠。一致しない場合の検討用）");
  for (const a of AS_OFS) {
    out(`### ${a.label}`);
    for (const s of SYMBOLS) {
      const r = res[a.date][s.code], d = DIGITS[s.code] + 1;
      const m = r.monthly, w = r.weekly, dd = r.daily;
      out(`${s.code.padEnd(7)} 月[${m.date} ${m.direction}] 終値${f(m.close, d)} 12MMA ${f(m.mma12, d)}(差${sgn(m.close - m.mma12, d)}) 6M ${f(m.low_6m, d)}〜${f(m.high_6m, d)} RP ${f(m.range_position_6m, 2)}(60/40との差 ${sgn(m.range_position_6m - 60, 2)}/${sgn(m.range_position_6m - 40, 2)}) ${m.data_status} ${m.bars_available}か月`);
      out(`${"".padEnd(7)} 週[${w.date} ${w.direction}] 終値${f(w.close, d)} 雲 ${f(w.cloud_bottom, d)}〜${f(w.cloud_top, d)} (${w.close_vs_cloud}; 上限との差${sgn(w.close - w.cloud_top, d)} 下限との差${sgn(w.close - w.cloud_bottom, d)}) T${f(w.tenkan, d)} K${f(w.kijun, d)} (${w.tenkan_vs_kijun}; T-K ${sgn(w.tenkan - w.kijun, d)}) ${w.bars_available}週`);
      out(`${"".padEnd(7)} 日[${dd.date} ${dd.direction}] 終値${f(dd.close, d)} 50DMA ${f(dd.dma50, d)}(差${sgn(dd.close - dd.dma50, d)}) 200DMA ${f(dd.dma200, d)}(差${sgn(dd.close - dd.dma200, d)}) ${dd.bars_available}日`);
    }
  }

  out("");
  out("## 4. 日足の数値の比較（仕様 5-2）: 10/2 時点、資料の値との差（ここの『差』= 計算 − 資料）");
  const r1002 = res["2026-10-02"];
  for (const code of Object.keys(EXPECT_NUM)) {
    const e = EXPECT_NUM[code], d = r1002[code].daily, dg = DIGITS[code] + 1;
    out(`${code.padEnd(7)} 終値 計算${f(d.close, dg)} 資料${e.close} 差${sgn(d.close - e.close, dg)} | 50DMA 計算${f(d.dma50, dg + 1)} 資料${e.dma50} 差${sgn(d.dma50 - e.dma50, dg + 1)} | 200DMA 計算${f(d.dma200, dg + 1)} 資料${e.dma200} 差${sgn(d.dma200 - e.dma200, dg + 1)}`);
  }
  out("記事の50DMA（EURUSD・EURJPY）:");
  for (const [date, code, art] of ARTICLE_50) {
    const rows = data[code].filter((r) => r.date <= date);
    const s = calc.dailyStructure(rows), dg = DIGITS[code] + 1;
    out(`${date} ${code.padEnd(7)} 計算${f(s.dma50, dg + 1)} 記事${art} 差${sgn(s.dma50 - art, dg + 1)}（終値 ${f(s.close, dg)}）`);
  }

  out("");
  out("## 5. 参考: 『直近N本』の数え方の比較（3-1。最新を含む=仕様 / 最新を除く / 1日ずらし）。差は資料(記事)の値との差");
  const variant = (rows, n, skip) => { const w = rows.slice(rows.length - n - skip, rows.length - skip); return w.reduce((s, r) => s + r.close, 0) / n; };
  for (const code of Object.keys(EXPECT_NUM)) {
    const rows = data[code].filter((r) => r.date <= "2026-10-02"), e = EXPECT_NUM[code], dg = DIGITS[code] + 2;
    out(`${code.padEnd(7)} 50DMA 含む${sgn(variant(rows, 50, 0) - e.dma50, dg)} 除く${sgn(variant(rows, 50, 1) - e.dma50, dg)} / 200DMA 含む${sgn(variant(rows, 200, 0) - e.dma200, dg)} 除く${sgn(variant(rows, 200, 1) - e.dma200, dg)}`);
  }
  for (const [date, code, art] of ARTICLE_50) {
    const rows = data[code].filter((r) => r.date <= date), dg = DIGITS[code] + 2;
    out(`${date} ${code.padEnd(7)} 記事50DMAとの差: 含む${sgn(variant(rows, 50, 0) - art, dg)} 除く${sgn(variant(rows, 50, 1) - art, dg)}`);
  }

  out("");
  out("## 6. データ品質（取得した期間 " + BACKFILL_START + " 〜 の日足）");
  for (const s of SYMBOLS) {
    const rows = data[s.code];
    const shortDays = calc.shortBarDays(rows, s.standardBars);
    const fridayEarly = shortDays.filter((x) => x.reasons.includes("friday_last_bar_before_16"));
    const barsShort = shortDays.filter((x) => x.reasons.includes("bars"));
    const over = rows.filter((r) => r.bars > s.standardBars);
    const missing = calc.missingWeekdays(rows, cutoff);
    const hist2 = {}; for (const r of rows) hist2[r.bars] = (hist2[r.bars] || 0) + 1;
    out(`### ${s.code}（標準 ${s.standardBars}本）`);
    out(`  本数の分布: ${Object.entries(hist2).sort((a, b) => b[0] - a[0]).map(([b, c]) => `${b}本×${c}日`).join(", ")}`);
    out(`  金曜の最後の足が標準どおりでない週（最終足がNY16時前）: ${fridayEarly.length ? fridayEarly.map((x) => `${x.date}(最終足${x.last_bar_ny},${x.bars}本)`).join(", ") : "なし"}`);
    out(`  本数が標準より少ない日: ${barsShort.length ? barsShort.map((x) => `${x.date}(${x.bars}本)`).join(", ") : "なし"}`);
    out(`  本数が標準より多い日: ${over.length ? over.map((x) => `${x.date}(${x.bars}本)`).join(", ") : "なし"}`);
    out(`  平日なのに日足が無い日: ${missing.length ? missing.join(", ") : "なし"}`);
  }

  out("");
  out("## 7. 実際に出力されるフィード（基準日 " + cutoff + "）");
  const items = SYMBOLS.map((s) => ({ code: s.code, rows: data[s.code], updatedAt: toJstIso(nowMs) }));
  const { text } = buildFeed({ asOf: cutoff, nowMs, items });
  out(text);
  out("# 試験運転 終了（ファイルは作成・コミットしていません）");
}

main().catch((e) => { out(`FATAL: ${e.stack || e.message}`); process.exit(1); });
