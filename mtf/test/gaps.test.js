"use strict";
// 追加の試験案（変異試験で生き残った変異を殺す）。mtf/test/ に置いて `node --test mtf/test/*.test.js`
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const C = require("../lib/calc");
const store = require("../lib/store");
const { buildFeed } = require("../lib/feed");
const { SYMBOLS, BACKFILL_START } = require("../config");
const { lastCompletedSessionDate } = require("../lib/ny-time");
const { createClient, fetchRange, fetchRecent } = require("../lib/twelvedata");
const { runDaily } = require("../run-daily");
const { checkHistory } = require("../lib/history");
const { mkRows, weekdaysFrom, scenarioRows, scenarioBars, fakeTwelveData, fakeClock, tmpData } = require("./helpers");
const { UP, DOWN, FLAT, INSUFFICIENT } = C;

const rowsOf = (closes, start = "2025-01-06", opts) => mkRows(weekdaysFrom(start, closes.length), (i) => closes[i], opts);
const flat = (n, v) => Array(n).fill(v);
const wk = (i, high, low, close) => ({ key: `w${String(i).padStart(3, "0")}`, end_date: `d${i}`, high, low, close: close ?? (high + low) / 2, days: 5 });
const weeksLinear = (n, close) => Array.from({ length: n }, (_, i) => wk(i, 100 + i, 90 + i, i === n - 1 ? close : undefined));
const mo = (i, high, low, close) => ({ key: `m${String(i).padStart(3, "0")}`, end_date: `e${i}`, high, low, close, days: 20 });
const r = (date, c, extra = {}) => ({ date, open: c, high: c + 1, low: c - 1, close: c, bars: 24, last_bar_ny: "16:00", ...extra });

// ---------- 2-2: 厚みのある雲 ----------
test("2-2: 厚みのある雲 — 雲の中は In Cloud（上限・下限ちょうども In Cloud）。雲の下でも Tenkan>=Kijun なら →", () => {
  // weeksLinear(52): Tenkan=142, Kijun=133.5, SpanA=137.75, SpanB=120.5 → 雲は 120.5〜137.75（厚みあり、Bullish TK）
  const at = (close) => C.weeklyStructure(weeksLinear(52, close));
  assert.deepEqual([at(130).cloud_top, at(130).cloud_bottom, at(130).tenkan_vs_kijun], [137.75, 120.5, "Bullish TK"]);
  for (const c of [130, 137.75, 120.5]) {
    assert.equal(at(c).close_vs_cloud, "In Cloud", String(c));
    assert.equal(at(c).direction, FLAT, String(c));
  }
  assert.deepEqual([at(137.76).close_vs_cloud, at(137.76).direction], ["Above Cloud", UP]);
  assert.deepEqual([at(120.49).close_vs_cloud, at(120.49).direction], ["Below Cloud", FLAT]); // 雲の下だが Bullish TK → ↓にならない
  // 雲の下で Tenkan=Kijun（Neutral TK）→ →
  const neutral = Array.from({ length: 52 }, (_, i) => wk(i, 110, 90, i === 51 ? 99.999 : 100));
  const n = C.weeklyStructure(neutral);
  assert.deepEqual([n.close_vs_cloud, n.tenkan_vs_kijun, n.direction], ["Below Cloud", "Neutral TK", FLAT]);
});

// ---------- 2-3: 月足の向きは「終値と12MMAの大小」と「RANGE_POSITION」の両方が必要 ----------
test("2-3: MONTHLY_DIRECTION — 終値=12MMA（RPが60以上/40以下でも →）。終値と12MMAの向きが RP と食い違うときも →", () => {
  // 直近6か月の高値200（月8）・安値100（月9）。最新月の終値 = closes[11]
  const months = (closes) => closes.map((c, i) => mo(i, i === 8 ? 200 : 150, i === 9 ? 100 : 140, c));
  const eqHigh = C.monthlyStructure(months(flat(12, 160))); // 12MMA=160=終値、RP=60
  assert.deepEqual([eqHigh.mma12, eqHigh.range_position_6m, eqHigh.direction], [160, 60, FLAT]);
  const eqLow = C.monthlyStructure(months(flat(12, 140))); // 12MMA=140=終値、RP=40
  assert.deepEqual([eqLow.mma12, eqLow.range_position_6m, eqLow.direction], [140, 40, FLAT]);
  const belowMma = C.monthlyStructure(months([...flat(11, 190), 160])); // 終値<12MMA(187.5)、RP=60 → ↑にならない
  assert.deepEqual([belowMma.range_position_6m, belowMma.direction], [60, FLAT]);
  const aboveMma = C.monthlyStructure(months([...flat(11, 120), 140])); // 終値>12MMA(121.7)、RP=40 → ↓にならない
  assert.deepEqual([aboveMma.range_position_6m, aboveMma.direction], [40, FLAT]);
});

// ---------- 4: 使った本数 ----------
test("4: 使った本数 — bars_used は上限（日足200・週足52・月足24）で頭打ち、bars_available は保有本数", () => {
  const d = (n) => C.dailyStructure(rowsOf(flat(n, 100)));
  assert.deepEqual([d(120).bars_used, d(120).bars_available], [120, 120]);
  assert.deepEqual([d(250).bars_used, d(250).bars_available], [200, 250]);
  const w = (n) => C.weeklyStructure(weeksLinear(n, 100));
  assert.deepEqual([w(30).bars_used, w(30).bars_available], [30, 30]);
  assert.deepEqual([w(60).bars_used, w(60).bars_available], [52, 60]);
  const m = (n) => C.monthlyStructure(Array.from({ length: n }, (_, i) => mo(i, 100 + i, 90 + i, 95 + i)));
  assert.deepEqual([m(15).bars_used, m(15).bars_available], [15, 15]);
  assert.deepEqual([m(30).bars_used, m(30).bars_available], [24, 30]);
});

// ---------- 3-7: 金曜の最終足が不明（空）の日は印を付けない ----------
test("3-7: 金曜でも last_bar_ny が空（不明）の日は『16時前』の印を付けない（本数が足りていれば印なし）", () => {
  const rows = [{ date: "2026-10-02", open: 1, high: 1, low: 1, close: 1, bars: 24, last_bar_ny: "" },
                { date: "2026-10-09", open: 1, high: 1, low: 1, close: 1, bars: 24 }];
  assert.deepEqual(C.shortBarDays(rows, 24), []);
});

// ---------- 1-2: mergeRows の境界 ----------
test("1-2: 上書きはちょうど直近3日（既定値も3）。4日前は取り直した値が違っても触らない", () => {
  const existing = [r("2026-09-28", 10), r("2026-09-29", 11), r("2026-09-30", 12), r("2026-10-01", 13), r("2026-10-02", 14)];
  const m = store.mergeRows(existing, [r("2026-09-29", 99), r("2026-09-30", 120)]); // 既定の overwriteLast
  const by = Object.fromEntries(m.rows.map((x) => [x.date, x.close]));
  assert.equal(by["2026-09-29"], 11); // 4日前 → そのまま
  assert.equal(by["2026-09-30"], 120); // 3日前 → 上書き
  assert.equal(m.updated, 1);
});

test("1-2: 値は同じで bars だけ／last_bar_ny だけ違う日も、直近3日なら取り直しで更新する（遅れて入った足）", () => {
  const existing = [r("2026-10-01", 13, { bars: 23 }), r("2026-10-02", 14, { last_bar_ny: "14:00" })];
  const m = store.mergeRows(existing, [r("2026-10-01", 13), r("2026-10-02", 14)], { overwriteLast: 3 });
  assert.equal(m.updated, 2);
  assert.deepEqual(m.rows.map((x) => [x.bars, x.last_bar_ny]), [[24, "16:00"], [24, "16:00"]]);
});

// ---------- 4/3-6: 出力の丸めを桁数まで厳密に ----------
test("3-6/4: 丸めの桁数 — 平均・一目は価格の桁数+1桁、価格は桁数、位置は2桁（JSON と テキストの両方、USDJPY=3桁・EURUSD=5桁）", () => {
  const NOW = Date.UTC(2026, 9, 6, 21, 25, 0);
  const cases = [
    { code: "USDJPY", base: 100, delta: 0.0617284, spread: 0.5, dg: 3 },
    { code: "EURUSD", base: 1.1, delta: 0.00617284, spread: 0.005, dg: 5 },
  ];
  for (const k of cases) {
    const dates = weekdaysFrom("2025-01-06", 230);
    const last = k.base + k.delta;
    const rows = mkRows(dates, (i) => (i === 229 ? last : k.base), { spread: k.spread });
    const { json, text } = buildFeed({ asOf: dates[229], nowMs: NOW, items: [{ code: k.code, rows, updatedAt: "x" }] });
    const d = json.symbols.find((x) => x.symbol === k.code).daily;
    const dma50 = (49 * k.base + last) / 50, dma200 = (199 * k.base + last) / 200;
    const lo = k.base - k.spread, hi = last + k.spread;
    const rp = ((last - lo) / (hi - lo)) * 100;
    const R = (x, n) => Number(x.toFixed(n));
    assert.equal(d.dma50, R(dma50, k.dg + 1), `${k.code} 50DMA`);
    assert.equal(d.dma200, R(dma200, k.dg + 1), `${k.code} 200DMA`);
    assert.equal(d.close, R(last, k.dg), `${k.code} close`);
    assert.equal(d.high_20d, R(hi, k.dg), `${k.code} 20D_HIGH`);
    assert.equal(d.low_20d, R(lo, k.dg), `${k.code} 20D_LOW`);
    assert.equal(d.range_position_20d, R(rp, 2), `${k.code} RP`);
    // 桁が落ちていないこと（丸めで最後の桁が 0 になっていない値を使っている）
    assert.notEqual(d.dma50, R(dma50, k.dg), `${k.code}: 50DMA が桁数のまま（+1桁になっていない）`);
    assert.notEqual(d.close, R(last, k.dg - 1), `${k.code}: 価格が桁数-1`);
    assert.notEqual(d.range_position_20d, R(rp, 1), `${k.code}: 位置が1桁`);
    // テキスト（GPTが読む側）も同じ桁数
    const line = (name) => text.split("\n").find((l) => l.startsWith(name));
    assert.ok(line("DAILY:").includes(` 50DMA=${dma50.toFixed(k.dg + 1)} `), `${k.code} text 50DMA: ${line("DAILY:")}`);
    assert.ok(line("DAILY:").includes(` 200DMA=${dma200.toFixed(k.dg + 1)} `), `${k.code} text 200DMA`);
    assert.ok(line("DAILY:").includes(` close=${last.toFixed(k.dg)} `), `${k.code} text close`);
    assert.ok(line("DAILY:").includes(` 20D_RANGE_POSITION=${rp.toFixed(2)} `), `${k.code} text RP`);
  }
});

// ---------- 1-1/3-7: 銘柄ごとの標準本数・桁数 ----------
test("1-1/3-7: 標準本数は FX 9銘柄（NZDUSD を含む）が24本・XAUUSD が23本。桁数は USDJPY/EURJPY 3・XAUUSD 2・他5。取得開始日は 2024-07-01", () => {
  assert.deepEqual(Object.fromEntries(SYMBOLS.map((s) => [s.code, s.standardBars])),
    { USDJPY: 24, EURUSD: 24, GBPUSD: 24, AUDUSD: 24, EURJPY: 24, EURGBP: 24, USDCAD: 24, XAUUSD: 23, USDCHF: 24, NZDUSD: 24 });
  assert.deepEqual(Object.fromEntries(SYMBOLS.map((s) => [s.code, s.digits])),
    { USDJPY: 3, EURUSD: 5, GBPUSD: 5, AUDUSD: 5, EURJPY: 3, EURGBP: 5, USDCAD: 5, XAUUSD: 2, USDCHF: 5, NZDUSD: 5 });
  assert.equal(BACKFILL_START, "2024-07-01");
});

test("3-7: フィード上でも、23本の日は FX 銘柄では『本数不足』、XAUUSD では印なし（XAUUSD の22本は印あり）", () => {
  const ASOF = "2026-10-06", NOW = Date.UTC(2026, 9, 6, 21, 25, 0);
  const items = SYMBOLS.map((s) => ({
    code: s.code, updatedAt: "x",
    rows: scenarioRows(s.code, "2026-08-03", ASOF, { bars: (d) => (s.code === "XAUUSD" ? (d === "2026-09-02" ? 22 : 23) : d === "2026-09-02" ? 23 : 24) }),
  }));
  const { json } = buildFeed({ asOf: ASOF, nowMs: NOW, items });
  for (const s of json.symbols) {
    assert.deepEqual(s.short_bar_days.map((x) => [x.date, x.bars, x.standard]), [["2026-09-02", s.symbol === "XAUUSD" ? 22 : 23, s.symbol === "XAUUSD" ? 23 : 24]], s.symbol);
  }
});

// ---------- 2-5: 基準日（直近に確定した日） ----------
test("2-5: 基準日 — 土日・月曜朝は金曜まで戻す。NY17:00ちょうどで当日が確定、16:59までは前日（EDT/EST）", () => {
  const edt = (d, h, m) => Date.UTC(2026, 9, d, h + 4, m); // 2026年10月（EDT = UTC-4）
  assert.equal(lastCompletedSessionDate(edt(2, 16, 59)), "2026-10-01"); // 金 16:59
  assert.equal(lastCompletedSessionDate(edt(2, 17, 0)), "2026-10-02"); // 金 17:00
  assert.equal(lastCompletedSessionDate(edt(3, 12, 0)), "2026-10-02"); // 土
  assert.equal(lastCompletedSessionDate(edt(4, 12, 0)), "2026-10-02"); // 日
  assert.equal(lastCompletedSessionDate(edt(4, 17, 30)), "2026-10-02"); // 日曜17:30（月曜のセッションの途中）
  assert.equal(lastCompletedSessionDate(edt(5, 10, 0)), "2026-10-02"); // 月曜朝
  assert.equal(lastCompletedSessionDate(edt(5, 16, 59)), "2026-10-02");
  assert.equal(lastCompletedSessionDate(edt(5, 17, 0)), "2026-10-05");
  const est = (d, h, m) => Date.UTC(2026, 11, d, h + 5, m); // 2026年12月（EST = UTC-5）
  assert.equal(lastCompletedSessionDate(est(7, 16, 59)), "2026-12-04");
  assert.equal(lastCompletedSessionDate(est(7, 17, 0)), "2026-12-07");
});

// ---------- twelvedata ----------
const KEY = "SECRETKEY123";
const mkBars = (n, start = Date.UTC(2026, 0, 1)) => Array.from({ length: n }, (_, i) => ({ datetime: new Date(start + i * 3600000).toISOString().replace("T", " ").slice(0, 19), open: 1, high: 2, low: 0.5, close: 1.5 }));
const mk = (fetchImpl, clock, extra = {}) => createClient({ apiKey: KEY, fetchImpl, sleep: clock.sleep, now: clock.now, spacingMs: 1000, ...extra });

test("取得: ちょうど maxPages ページで範囲の先頭に届くなら成功（例外にしない）", async () => {
  const bars = mkBars(300);
  const f = fakeTwelveData({ X: bars }, { pageCap: 100 });
  const got = await fetchRange(mk(f, fakeClock()), "X", bars[0].datetime, { pageSize: 100, maxPages: 3 });
  assert.equal(got.length, 300);
  assert.equal(f.calls.length, 3);
});

test("再試行: 429 の待ちは『次の暦の分の頭＋1秒』ちょうど（毎回、現在の秒に応じて変わる）", async () => {
  const f = fakeTwelveData({ X: mkBars(5) }, { failures: { X: { kind: "429-body", times: 2 } } });
  const clock = fakeClock(Date.UTC(2026, 9, 6, 21, 10, 40)); // 40秒 → 21秒待つ。その後 21:11:01 → 次は60秒
  await fetchRecent(mk(f, clock), "X", 5);
  assert.deepEqual(clock.slept, [21000, 60000]);
});

// ---------- run-daily ----------
const NOW = Date.UTC(2026, 9, 6, 21, 20, 0); // 基準日 2026-10-06
const START = "2026-01-05";
function setup({ histEnd = "2026-10-05", dataEnd = "2026-10-07", failures = {} } = {}) {
  const t = tmpData();
  for (const s of SYMBOLS) store.writeAll(t.dataDir, [{ file: path.join("mtf", `ny-daily-${s.code}.csv`), content: store.toCsv(scenarioRows(s.code, START, histEnd).map((x) => ({ ...x, last_bar_ny: "16:00" }))) }]);
  const f = fakeTwelveData(scenarioBars("2026-09-01", dataEnd), { failures });
  const clock = fakeClock(NOW);
  const client = createClient({ apiKey: KEY, fetchImpl: f, sleep: clock.sleep, now: clock.now, spacingMs: 100 });
  return { t, f, clock, client, run: (over = {}) => runDaily({ nowMs: NOW, dataDir: t.dataDir, client, log: () => {}, ...over }) };
}
const tweakCsv = (s, dates, fn) => {
  for (const sym of SYMBOLS) {
    const rows = store.readRows(s.t.dataDir, sym.code).map((x) => (dates.includes(x.date) ? fn(x) : x));
    fs.writeFileSync(path.join(s.t.dataDir, "mtf", `ny-daily-${sym.code}.csv`), store.toCsv(rows));
  }
};
const closeOn = (s, code, date) => store.readRows(s.t.dataDir, code).find((x) => x.date === date).close;

test("1-2: 毎日の更新の上書きは既存の直近ちょうど3日（10/5・10/2・10/1）。4日前(9/30)の保存値は変えない", async () => {
  const s = setup();
  try {
    tweakCsv(s, ["2026-09-30", "2026-10-01"], (x) => ({ ...x, close: x.close + 1 }));
    await s.run();
    for (const sym of SYMBOLS) {
      const truth = Object.fromEntries(scenarioRows(sym.code, START, "2026-10-06").map((x) => [x.date, x.close]));
      assert.ok(Math.abs(closeOn(s, sym.code, "2026-10-01") - truth["2026-10-01"]) < 1e-5, `${sym.code} 3日前は取り直す`);
      assert.ok(Math.abs(closeOn(s, sym.code, "2026-09-30") - (truth["2026-09-30"] + 1)) < 1e-5, `${sym.code} 4日前は触らない`);
    }
  } finally { s.t.cleanup(); }
});

test("1-2: 新しい日が無く値の更新だけのときも履歴CSVを書き戻す（基準日の足がまだ無い日）", async () => {
  const s = setup({ dataEnd: "2026-10-05" });
  try {
    tweakCsv(s, ["2026-10-05"], (x) => ({ ...x, close: x.close + 1 }));
    await s.run();
    for (const sym of SYMBOLS) {
      const truth = scenarioRows(sym.code, START, "2026-10-05").pop().close;
      assert.ok(Math.abs(closeOn(s, sym.code, "2026-10-05") - truth) < 1e-5, sym.code);
    }
  } finally { s.t.cleanup(); }
});

test("6-2: 取得した足から確定日足を1日も作れない銘柄は error（終了コード1）。履歴CSVは変えない。他の銘柄は更新", async () => {
  const s = setup();
  try {
    const bars = scenarioBars("2026-09-01", "2026-10-07");
    bars["EUR/GBP"] = bars["EUR/GBP"].slice(-5); // 1セッション分の途中の足だけ → 左端の日として捨てられ日足が0日
    const f = fakeTwelveData(bars);
    const clock = fakeClock(NOW);
    const client = createClient({ apiKey: KEY, fetchImpl: f, sleep: clock.sleep, now: clock.now, spacingMs: 100 });
    const before = fs.readFileSync(path.join(s.t.dataDir, "mtf", "ny-daily-EURGBP.csv"), "utf8");
    const res = await s.run({ client });
    assert.equal(res.exitCode, 1);
    assert.match(res.failures[0], /EURGBP/);
    assert.equal(fs.readFileSync(path.join(s.t.dataDir, "mtf", "ny-daily-EURGBP.csv"), "utf8"), before);
    const feed = JSON.parse(fs.readFileSync(path.join(s.t.dataDir, "mtf-feed.json"), "utf8"));
    assert.equal(feed.symbols.find((x) => x.symbol === "EURGBP").status, "error");
    assert.equal(feed.symbols.find((x) => x.symbol === "USDJPY").status, "ok");
  } finally { s.t.cleanup(); }
});

test("1-1: 毎日の更新でも、取得範囲の左端の日（途中からしか足が無い）は取り込まない — 履歴の穴を途中の日足（18本）で埋めない", async () => {
  const s = setup();
  try {
    // 履歴CSVから 9/1 を抜く（穴）。取得データの左端は 9/1 の途中（先頭6本が無い＝18本）
    for (const sym of SYMBOLS) {
      const rows = store.readRows(s.t.dataDir, sym.code).filter((x) => x.date !== "2026-09-01");
      fs.writeFileSync(path.join(s.t.dataDir, "mtf", `ny-daily-${sym.code}.csv`), store.toCsv(rows));
    }
    const bars = scenarioBars("2026-09-01", "2026-10-07");
    for (const td of Object.keys(bars)) bars[td] = bars[td].slice(6);
    const clock = fakeClock(NOW);
    const client = createClient({ apiKey: KEY, fetchImpl: fakeTwelveData(bars), sleep: clock.sleep, now: clock.now, spacingMs: 100 });
    await s.run({ client });
    for (const sym of SYMBOLS) {
      assert.ok(!store.readRows(s.t.dataDir, sym.code).some((x) => x.date === "2026-09-01"), `${sym.code}: 途中の日足が入った`);
    }
  } finally { s.t.cleanup(); }
});

test("6-2: 試行回数は基準日ごとに数える — 翌日の最初の実行は attempt=1（前日の回数を引き継がない）", async () => {
  const s = setup();
  try {
    await s.run(); // 基準日 10/6、attempt=1 で完了
    const clock = fakeClock(NOW);
    const c2 = createClient({ apiKey: KEY, fetchImpl: fakeTwelveData(scenarioBars("2026-09-01", "2026-10-08")), sleep: clock.sleep, now: clock.now, spacingMs: 100 });
    await runDaily({ nowMs: Date.UTC(2026, 9, 7, 21, 20), dataDir: s.t.dataDir, client: c2, log: () => {} });
    const feed = JSON.parse(fs.readFileSync(path.join(s.t.dataDir, "mtf-feed.json"), "utf8"));
    assert.equal(feed.as_of, "2026-10-07");
    assert.equal(feed.attempt, 1);
  } finally { s.t.cleanup(); }
});

test("3-2/3-6: EPS は本物の差を潰さない — 5桁通貨の最小に近い差（50DMAとの差 2e-7）でも Above/Below を判定する", () => {
  const below = flat(50, 1.1); below[48] = 1.10001; // 50DMA = 1.1000002、終値 1.1 は 2e-7 だけ下
  assert.equal(C.dailyStructure(rowsOf(below)).close_vs_50dma, "Below");
  const above = flat(50, 1.10001); above[10] = 1.1; // 50DMA = 1.1000098、終値 1.10001 は 2e-7 だけ上
  assert.equal(C.dailyStructure(rowsOf(above)).close_vs_50dma, "Above");
});

test("6-1: 取得の点検の境界 — 日数は minRows ちょうどで通り1日足りないと失敗。最古の日足は開始日+7日まで許容、+8日で失敗", () => {
  const mkR = (n, first) => Array.from({ length: n }, () => ({ date: first }));
  const o = { start: "2026-01-05", minRows: 10 };
  assert.doesNotThrow(() => checkHistory("X", mkR(10, "2026-01-05"), o));
  assert.throws(() => checkHistory("X", mkR(9, "2026-01-05"), o), /日足が9日/);
  assert.doesNotThrow(() => checkHistory("X", mkR(10, "2026-01-12"), o));
  assert.throws(() => checkHistory("X", mkR(10, "2026-01-13"), o), /届いていません/);
});

test("再試行: 既定の最大試行回数は4回（5xx が続くとちょうど4回呼んで諦める）", async () => {
  const f = fakeTwelveData({ X: mkBars(5) }, { failures: { X: { kind: "500", times: 99 } } });
  await assert.rejects(fetchRecent(mk(f, fakeClock()), "X", 5), /サーバーエラー/);
  assert.equal(f.calls.length, 4);
});

// ---------- 再試行の間隔（クールダウン）・時間制限・継ぎ目の確認・最終足の判定 ----------
test("6-2: 未完了の再試行の間隔 — 前回から20分未満は見送り、ちょうど20分で再試行。前回の作成時刻が未来（時計のずれ）でも止まらない", async () => {
  const s = setup({ failures: { "EUR/GBP": { kind: "500", times: 9999 } } });
  try {
    const run = (ms) => s.run({ nowMs: ms });
    assert.equal((await run(NOW)).skipped, undefined); // 1回目（EURGBP は失敗）
    assert.equal((await run(NOW + 20 * 60000 - 1000)).skipped, "cooldown"); // 19分59秒
    assert.equal((await run(NOW + 20 * 60000)).skipped, undefined); // ちょうど20分 → 再試行する
    // 前回(generated_at = NOW+20分)より前の時刻で実行されても（時計のずれ）、見送りにしない
    assert.equal((await run(NOW + 15 * 60000)).skipped, undefined);
  } finally { s.t.cleanup(); }
});

test("4/6-2: 最終足が空（不明）の基準日の日足は『最終足が未着』扱いにしない（status=ok）", () => {
  const dates = weekdaysFrom("2025-01-06", 230);
  const rows = mkRows(dates, (i) => 100 + i * 0.01, { lastBar: "" });
  const { json } = buildFeed({ asOf: dates[229], nowMs: Date.UTC(2026, 9, 6, 21, 25, 0), items: [{ code: "USDJPY", rows, updatedAt: "x" }] });
  assert.equal(json.symbols.find((x) => x.symbol === "USDJPY").status, "ok");
});

test("取得: ページの継ぎ目の欠け検出の境界 — 3時間は通し4時間で例外、39時間で例外・40時間は通す（休日・週末の継ぎ目）", async () => {
  const seam = async (g) => {
    // ページサイズ2: 1ページ目 = 最新の2本、2ページ目の最新の足は1ページ目の最古から g 時間前
    const t0 = Date.UTC(2026, 0, 5);
    const bars = [0, 1, 1 + g, 2 + g].map((h) => mkBars(1, t0 + h * 3600000)[0]);
    const f = fakeTwelveData({ X: bars }, { pageCap: 2 });
    return fetchRange(mk(f, fakeClock()), "X", bars[0].datetime, { pageSize: 2 });
  };
  assert.equal((await seam(1)).length, 4);
  assert.equal((await seam(3)).length, 4);
  await assert.rejects(seam(4), /継ぎ目で 4 時間/);
  await assert.rejects(seam(39), /継ぎ目で 39 時間/);
  assert.equal((await seam(40)).length, 4);
});

test("時間制限(deadlineAt): 期限ちょうどで呼ばない。待つと期限を超える再試行は待たずに、その時点のエラーで失敗にする", async () => {
  const clock = fakeClock(Date.UTC(2026, 9, 6, 21, 10, 40));
  const f0 = fakeTwelveData({ X: mkBars(5) });
  await assert.rejects(fetchRecent(mk(f0, clock, { deadlineAt: clock.t }), "X", 5), /時間切れ/);
  assert.equal(f0.calls.length, 0);
  // 429: 1回目の待ち 21秒（期限の30秒以内）→ 2回目の待ちは60秒で期限を超えるので待たずに 429 で失敗
  const f = fakeTwelveData({ X: mkBars(5) }, { failures: { X: { kind: "429-body", times: 99 } } });
  const c2 = fakeClock(Date.UTC(2026, 9, 6, 21, 10, 40));
  await assert.rejects(fetchRecent(mk(f, c2, { deadlineAt: c2.t + 30000 }), "X", 5), /レート制限\(429\)/);
  assert.deepEqual(c2.slept, [21000]);
  assert.equal(f.calls.length, 2);
});

test("時間制限(deadlineAt): 1回の通信の待ち時間も残り時間までに縮める（応答が来ないAPIで期限を大きく超えない）", { timeout: 30000 }, async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const c = createClient({ apiKey: KEY, fetchImpl: hang, maxAttempts: 1, timeoutMs: 60000, deadlineAt: Date.now() + 1500 });
  const t0 = Date.now();
  const keepAlive = setInterval(() => {}, 100); // AbortSignal.timeout のタイマーは unref されるので、イベントループを生かしておく
  try {
    await assert.rejects(fetchRecent(c, "X", 5), /通信失敗/);
  } finally { clearInterval(keepAlive); }
  assert.ok(Date.now() - t0 < 10000, `${Date.now() - t0}ms かかった（60秒の待ちのまま）`);
});
