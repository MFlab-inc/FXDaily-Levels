"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const H = require("../h1history");
const { createHistory, dailyLevelsFrom, atrPctSeries, regimeAt } = require("../histctx");
const { runBacktest, aggregate, metrics, planDates } = require("../backtest");
const { toCsv, toMarkdown, CSV_COLUMNS } = require("../report");
const { main: btMain } = require("../../daytrade-backtest");
const store = require("../../../mtf/lib/store");
const { pairOf, PAIRS } = require("../pairs");
const { allSynth, synthH1, synthDaily } = require("./bt-data");
const { tmpDir, rm, toH1Json } = require("./helpers");
const J = require("../jst");

const NOW = J.parseIso("2026-10-08T12:00:00+09:00");
const eu = pairOf("EURUSD");

// ---- H1履歴のCSV ----
test("h1history: 1行目にタイムゾーン、2行目が見出し。往復でき、時刻の基準が無いファイルは読まない", () => {
  const bars = synthH1(eu, { fromLabel: "2026-10-05 10:00", toLabel: "2026-10-05 14:00" });
  const text = H.toCsv(bars, eu);
  const lines = text.split("\n");
  assert.equal(lines[0], "# timezone=Asia/Tokyo");
  assert.equal(lines[1], "time_jst,o,h,l,c");
  assert.match(lines[2], /^2026-10-05 10:00,/);
  assert.deepEqual(H.parseCsv(text), bars);
  assert.throws(() => H.parseCsv(lines.slice(1).join("\n")), /1行目/);
  assert.throws(() => H.parseCsv(`${lines[0]}\nwrong\n`), /見出し/);
  assert.throws(() => H.parseCsv(`${lines[0]}\n${lines[1]}\n2026-10-05 10:00,1,2,3\n`), /読めません/);
  assert.throws(() => H.parseCsv(`${lines[0]}\n${lines[1]}\n2026-10-05 11:00,1,2,0.5,1\n2026-10-05 10:00,1,2,0.5,1\n`), /昇順/);
});

test("h1history: FXの休場帯（金17:00NY〜日17:00NY）の足は含めない（夏時間・冬時間とも）", () => {
  // 夏: 金17:00 NY(EDT) = 土 06:00 JST。冬: 金17:00 NY(EST) = 土 07:00 JST
  const t = (s) => J.parseJstLabel(s);
  assert.equal(H.isFxClosedMs(t("2026-10-10 05:00")), false);
  assert.equal(H.isFxClosedMs(t("2026-10-10 06:00")), true);
  assert.equal(H.isFxClosedMs(t("2026-10-12 05:00")), true);
  assert.equal(H.isFxClosedMs(t("2026-10-12 06:00")), false);
  assert.equal(H.isFxClosedMs(t("2026-12-12 06:00")), false);
  assert.equal(H.isFxClosedMs(t("2026-12-12 07:00")), true);
  assert.equal(H.isFxClosedMs(t("2026-12-14 06:00")), true);
  assert.equal(H.isFxClosedMs(t("2026-12-14 07:00")), false);
});

// Twelve Data を模したクライアント。start_date / end_date / outputsize を守り、新しい順に返す。timezone の指定を記録する
function fakeClient(allBars, { shiftHours = 0, onCall = () => {} } = {}) {
  const calls = [];
  const label = (ms) => J.jstLabel(ms + shiftHours * J.HR) + ":00";
  const rows = allBars.map((b) => ({ datetime: label(b.t), open: b.o, high: b.h, low: b.l, close: b.c }));
  return {
    calls, stats: { requests: 0 },
    timeSeries: async (p) => {
      calls.push(p); onCall(p);
      const out = rows.filter((r) => (!p.start_date || r.datetime >= p.start_date) && (!p.end_date || r.datetime <= p.end_date))
        .sort((a, b) => (a.datetime < b.datetime ? 1 : -1)).slice(0, Number(p.outputsize));
      return out;
    },
  };
}

test("h1history: fetchH1 は timezone=Asia/Tokyo で取得し、ページ送りでつなぎ、確定足だけ・休場帯なしで返す", async () => {
  const all = synthH1(eu, { fromLabel: "2026-10-01 00:00", toLabel: "2026-10-08 20:00" });
  const client = fakeClient(all);
  const now = J.parseJstLabel("2026-10-08 15:30"); // 15:00 開始の足はまだ確定していない
  const bars = await H.fetchH1(client, eu, { startLabel: "2026-10-01 00:00:00", nowMs: now, pageSize: 50 });
  assert.ok(client.calls.length >= 3, "複数ページ");
  assert.ok(client.calls.every((c) => c.timezone === "Asia/Tokyo" && c.interval === "1h"));
  assert.equal(J.jstLabel(bars.at(-1).t), "2026-10-08 14:00");
  assert.ok(bars.every((b) => !H.isFxClosedMs(b.t)));
  const expected = all.filter((b) => b.t + J.HR <= now);
  assert.deepEqual(bars.map((b) => b.t), expected.map((b) => b.t));
  assert.deepEqual(bars[10], expected[10]);
});

test("h1history: ページの継ぎ目で足が抜けると失敗する（end_date の解釈ずれの検出）", async () => {
  const all = synthH1(eu, { fromLabel: "2026-10-01 00:00", toLabel: "2026-10-04 20:00" });
  const holes = all.filter((b) => !(b.t >= J.parseJstLabel("2026-10-02 10:00") && b.t < J.parseJstLabel("2026-10-02 18:00")));
  // 欠けた8時間を『ページの境目』に重ねるため、小さいページで取る
  await assert.rejects(() => H.fetchH1(fakeClient(holes), eu, { startLabel: "2026-10-01 00:00:00", nowMs: J.parseJstLabel("2026-10-08 00:00"), pageSize: 1 + holes.filter((b) => b.t > J.parseJstLabel("2026-10-02 18:00")).length }), /抜けています/);
});

test("h1history: h1-bars.json（ライブ）との重なりを突き合わせ、時刻の解釈ずれを見つける", () => {
  const bars = synthH1(eu, { fromLabel: "2026-10-05 00:00", toLabel: "2026-10-07 23:00" });
  assert.deepEqual(H.verifyAgainstLive(bars, bars, eu), { overlap: bars.length, mismatch: 0, sample: [] });
  // 9時間ずらした（UTCとして読んだ）足は、同じ時刻で別の値になる
  const shifted = bars.map((b) => ({ ...b, t: b.t + 9 * J.HR }));
  const v = H.verifyAgainstLive(shifted, bars, eu);
  assert.ok(v.overlap > 0 && v.mismatch > v.overlap * 0.5);
  assert.equal(v.sample.length, 3);
  assert.deepEqual(H.verifyAgainstLive(bars, [], eu), { overlap: 0, mismatch: 0, sample: [] });
  assert.equal(H.gapReport(bars).length, 0);
});

// ---- 設計時刻の入力の再構成 ----
test("histctx: 日次レベルの式は fetch.js と同じ（Pivot=(H+L+C)/3、R1=2P−L、S1=2P−H、R2=P+(H−L)、S2=P−(H−L)）", () => {
  const d = dailyLevelsFrom({ high: 1.12, low: 1.10, close: 1.11 }, eu);
  assert.equal(d.pivot, 1.11);
  assert.equal(d.r1, 1.12);
  assert.equal(d.s1, 1.1);
  assert.equal(d.r2, 1.13);
  assert.equal(d.s2, 1.09);
  assert.equal(d.prev_high, 1.12);
  assert.equal(d.prev_low, 1.1);
});

test("histctx: 設計時刻の入力 — 現在値は直前に確定したH1の終値、休場の時刻は作らない、MTFは日足から再計算", () => {
  const { barsByCode, rowsByCode } = allSynth();
  const h = createHistory({ barsByCode, rowsByCode });
  const t = J.jstAt("2026-10-05", "15:30");
  const r = h.ctxAt(eu, t, "A");
  assert.equal(r.skip, undefined);
  const prev = barsByCode.EURUSD.find((b) => b.t === J.jstAt("2026-10-05", "14:00"));
  assert.equal(r.ctx.price, prev.c);
  assert.equal(r.meta.asOf, "2026-10-02"); // 月曜 15:30 JST = NY 月曜 02:30 → 直近の確定セッションは金曜
  assert.equal(r.meta.planDate, "2026-10-05");
  assert.equal(r.ctx.mtfJson.status, "ok");
  assert.equal(r.ctx.mtfJson.symbols[0].alignment_score, "3/3 Down");
  assert.ok(r.ctx.atr > 0);
  assert.equal(r.ctx.tokyo, null);
  assert.equal(h.ctxAt(eu, t, "B").ctx.tokyo.complete, true);
  assert.equal(h.ctxAt(eu, J.jstAt("2026-10-05", "06:30"), "A").skip, "直前の1時間の足が無い（休場）"); // 月曜朝は 05:00 開始の足が休場
  assert.equal(h.ctxAt({ ...eu, code: "NOPE" }, t, "A").skip, "H1履歴なし");
  // 日足の無い日は日次レベルなし（案を作らない）
  const sparse = { ...rowsByCode, EURUSD: rowsByCode.EURUSD.filter((x) => x.date !== "2026-10-02") };
  assert.equal(createHistory({ barsByCode, rowsByCode: sparse }).ctxAt(eu, t, "A").ctx.daily, null);
});

test("histctx: ボラ状態（日足ATR14÷終値の過去250営業日パーセンタイル）— 最新が最大なら『異常』、平坦なら『平常』、足りなければ『不明』", () => {
  const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, high: 1 + f(i), low: 1 - f(i), close: 1 }));
  const rising = atrPctSeries(mk(120, (i) => 0.001 * (i + 1)));
  assert.equal(regimeAt(rising, 119), "異常");
  const flat = atrPctSeries(mk(120, () => 0.01));
  assert.equal(regimeAt(flat, 119), "異常"); // 同値は『以下』に数えるので最新も100%点 — 平坦な系列は区別できない
  const falling = atrPctSeries(mk(120, (i) => 0.001 * (120 - i)));
  assert.equal(regimeAt(falling, 119), "平常");
  assert.equal(regimeAt(atrPctSeries(mk(10, () => 0.01)), 9), "不明");
});

// ---- バックテスト本体 ----
test("planDates: 実行日の前日から数えて window-days 日分のうち、完了した平日だけ", () => {
  assert.deepEqual(planDates(NOW, 10), ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"]);
  assert.equal(planDates(NOW, 1)[0], "2026-10-07");
});

const synthRun = (opts = {}) => {
  const { barsByCode, rowsByCode } = allSynth();
  return runBacktest({ barsByCode, rowsByCode, nowMs: NOW, windowDays: 10, ...opts });
};

test("backtest: 記録の整合 — A案(0.5)/B案(1.0)を別に数え、TP1 は利益・SL は損失、コスト込みは閾値を引く", () => {
  const { records, stats } = synthRun();
  assert.ok(records.length > 10, `records=${records.length}`);
  assert.equal(stats.designs, stats.dates * 3);
  assert.deepEqual(Object.keys(stats.skipped), ["直前の1時間の足が無い（休場）"]);
  for (const r of records) {
    assert.ok(["A", "B"].includes(r.setup) && ["A", "B"].includes(r.scheme));
    assert.equal(r.k, r.scheme === "A" ? 0.5 : 1.0);
    assert.ok(["到達", "未到達", "失効後到達"].includes(r.reached));
    assert.ok(r.plan_rr >= 1 && r.sl_pips >= 10);
    if (r.setup === "B") assert.notEqual(r.slot, 1); // 設計①は型Aのみ
    if (r.reached !== "到達") { assert.equal(r.first_hit, undefined); continue; }
    assert.ok(["TP1", "SL", "未決"].includes(r.first_hit));
    assert.ok(Math.abs(r.pips_net - (r.pips_gross - r.cost_pips)) < 1e-9);
    assert.ok(Math.abs(r.r_net - r.pips_net / r.sl_pips) < 1e-9);
    assert.ok([1.2, 1.6].includes(r.cost_pips));
    if (r.first_hit === "TP1") assert.ok(Math.abs(r.pips_gross - r.profit_pips) < 1e-6);
    if (r.first_hit === "SL") assert.ok(r.pips_gross <= -r.sl_pips + 1e-6);
  }
  // 同じ版は継続して1件（二重に数えない）: 同じ (計画日, 型, 案, 銘柄, 向き) の記録は同じEntry帯・SLを持たない限り重ならない
  const keys = records.map((r) => [r.plan_date, r.setup, r.scheme, r.symbol, r.side, r.sl_pips, r.profit_pips].join("|"));
  assert.equal(new Set(keys).size, keys.length);
});

test("backtest: 集計 — 軸ごとの n を足すと全体になる。勝率=TP1÷到達、実現Rは到達した案の平均", () => {
  const { records } = synthRun();
  const rows = aggregate(records);
  for (const setup of ["A", "B"]) for (const scheme of ["A", "B"]) {
    const sel = (axis) => rows.filter((r) => r.setup === setup && r.scheme === scheme && r.axis === axis);
    const total = sel("全体");
    const n = records.filter((r) => r.setup === setup && r.scheme === scheme).length;
    assert.equal(total.length, n ? 1 : 0);
    if (!n) continue;
    assert.equal(total[0].n, n);
    for (const ax of ["銘柄", "設計の回", "設計日の曜日", "ボラ状態", "売買（参考）"]) assert.equal(sel(ax).reduce((s, r) => s + r.n, 0), n, ax);
    const fills = sel("約定時刻(JST)").reduce((s, r) => s + r.n, 0);
    assert.equal(fills, total[0].reached);
    assert.equal(total[0].atr_coef, scheme === "A" ? 0.5 : 1.0);
    if (total[0].reached) assert.ok(Math.abs(total[0].win_rate - total[0].tp1 / total[0].reached) < 1e-12);
  }
});

test("backtest: metrics の手計算（勝率・実現R・pips・最大連敗・時間切れ）", () => {
  const f = (o) => ({ reached: "到達", first_hit: "TP1", plan_rr: 2, r_gross: 2, r_net: 1.8, pips_gross: 20, pips_net: 18, exit_ms: 0, same_bar: false, gap: false, yen_net_1lot: 1000, ...o });
  const recs = [
    f({ exit_ms: 1 }), f({ first_hit: "SL", r_gross: -1, r_net: -1.12, pips_gross: -10, pips_net: -12, exit_ms: 2, same_bar: true }),
    f({ first_hit: "SL", r_gross: -1, r_net: -1.12, pips_gross: -10, pips_net: -12, exit_ms: 3, gap: true }),
    f({ first_hit: "未決", r_gross: 0.1, r_net: -0.1, pips_gross: 1, pips_net: -1, exit_ms: 4 }),
    f({ exit_ms: 5 }), { reached: "未到達", plan_rr: 2, cancelled_unreached: true }, { reached: "失効後到達", plan_rr: 2 },
  ];
  const m = metrics(recs);
  assert.equal(m.n, 7);
  assert.equal(m.reached, 5);
  assert.equal(m.tp1, 2);
  assert.equal(m.sl, 2);
  assert.equal(m.timeout, 1);
  assert.ok(Math.abs(m.win_rate - 0.4) < 1e-12);
  assert.ok(Math.abs(m.reach_rate - 5 / 7) < 1e-12);
  assert.equal(m.max_loss_streak, 3); // SL, SL, 時間切れ(−1pips) が連続
  assert.equal(m.same_bar, 1);
  assert.equal(m.gap, 1);
  assert.equal(m.after_expiry, 1);
  assert.equal(m.cancelled_unreached, 1);
  assert.ok(Math.abs(m.pips_gross_sum - (20 - 10 - 10 + 1 + 20)) < 1e-12);
  assert.ok(Math.abs(m.pips_net_sum - (18 - 12 - 12 - 1 + 18)) < 1e-12);
  assert.equal(metrics([]).win_rate, null);
});

test("report: Markdown に軸・仮置きの規則・H1履歴の品質が出る。CSV の見出しは固定", () => {
  const { records, stats } = synthRun();
  const rows = aggregate(records);
  const history = PAIRS.map((p) => ({ code: p.code, bars: 100, first: "2026-08-20", last: "2026-10-08 04:00", gaps: 0, verify: { overlap: 10, mismatch: 0 }, fetched: false }));
  const md = toMarkdown(rows, { nowMs: NOW, window: { first: stats.first, last: stats.last }, stats, history, regimeSource: "試験", noMtf: ["USDCHF"] });
  for (const s of ["# デイトレプラン バックテスト（実行日 2026-10-08）", "## 型A × A案（ATR係数 0.5）", "## 型B × B案（ATR係数 1.0）", "### 軸: 銘柄", "### 軸: 設計日の曜日", "### 軸: ボラ状態", "### 軸: 約定時刻(JST)", "**Q25**", "**Q35**", "USDCHF は MTF の日足が無く", "保証ではありません"]) assert.ok(md.includes(s), s);
  const csv = toCsv(rows);
  assert.equal(csv.split("\n")[0], CSV_COLUMNS.join(","));
  assert.equal(csv.trim().split("\n").length, rows.length + 1);
});

// ---- CLI ----
function writeHistory(dataDir, { skip = [] } = {}) {
  const { barsByCode, rowsByCode } = allSynth();
  const entries = [];
  for (const pair of PAIRS) {
    if (!skip.includes(pair.code)) entries.push({ file: path.join("history", `h1-${pair.code}.csv`), content: H.toCsv(barsByCode[pair.code], pair) });
    entries.push({ file: path.join("mtf", `ny-daily-${pair.code}.csv`), content: store.toCsv(rowsByCode[pair.code]) });
  }
  store.writeAll(dataDir, entries);
  const live = Object.fromEntries(PAIRS.map((p) => [p.code, barsByCode[p.code].slice(-500)]));
  fs.writeFileSync(path.join(dataDir, "h1-bars.json"), JSON.stringify({ as_of: "2026-10-08T05:00:00+09:00", pairs: toH1Json(live) }));
  return { barsByCode };
}
const quiet = () => { const out = []; return { out, io: { log: (m) => out.push(String(m)) } }; };

test("CLI: H1履歴がすべてあれば取得せず（APIキー不要）、md と csv を書く。既存ファイルは変えない", async () => {
  const dataDir = path.join(tmpDir(), "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    writeHistory(dataDir);
    const before = fs.readFileSync(path.join(dataDir, "history", "h1-EURUSD.csv"), "utf8");
    const q = quiet();
    const origFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => { fetched++; throw new Error("通信しないはず"); };
    try { await btMain([`--data-dir=${dataDir}`, "--no-risk-feed", `--now=2026-10-08T12:00:00+09:00`, "--window-days=10"], {}, q.io); } finally { globalThis.fetch = origFetch; }
    assert.equal(fetched, 0);
    assert.equal(fs.readFileSync(path.join(dataDir, "history", "h1-EURUSD.csv"), "utf8"), before);
    const md = fs.readFileSync(path.join(dataDir, "daytrade", "backtest-2026-10-08.md"), "utf8");
    assert.match(md, /^# デイトレプラン バックテスト/);
    assert.ok(fs.existsSync(path.join(dataDir, "daytrade", "backtest-2026-10-08.csv")));
    assert.match(q.out.join("\n"), /完了/);
  } finally { rm(path.dirname(dataDir)); }
});

test("CLI: 無い銘柄だけ Twelve Data から（timezone=Asia/Tokyo）取得して保存。1回だけで、APIキーは出力に出さない", async () => {
  const dataDir = path.join(tmpDir(), "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const { barsByCode } = writeHistory(dataDir, { skip: ["EURUSD", "XAUUSD"] });
    const calls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      const p = Object.fromEntries(u.searchParams);
      calls.push(p);
      const code = PAIRS.find((x) => x.td === p.symbol).code;
      const rows = barsByCode[code].map((b) => ({ datetime: `${J.jstLabel(b.t)}:00`, open: String(b.o), high: String(b.h), low: String(b.l), close: String(b.c) }))
        .filter((r) => (!p.start_date || r.datetime >= p.start_date) && (!p.end_date || r.datetime <= p.end_date))
        .sort((a, b) => (a.datetime < b.datetime ? 1 : -1)).slice(0, Number(p.outputsize));
      return new Response(JSON.stringify({ status: "ok", values: rows }), { status: 200 });
    };
    const q = quiet();
    try {
      await btMain([`--data-dir=${dataDir}`, "--no-risk-feed", "--now=2026-10-08T12:00:00+09:00", "--window-days=10", "--spacing-ms=0"], { TWELVE_DATA_API_KEY: "SECRET-KEY-123" }, q.io);
      assert.deepEqual([...new Set(calls.map((c) => c.symbol))].sort(), ["EUR/USD", "XAU/USD"]);
      assert.ok(calls.every((c) => c.timezone === "Asia/Tokyo" && c.apikey === "SECRET-KEY-123"));
      assert.ok(calls.length <= 8);
      const csv = fs.readFileSync(path.join(dataDir, "history", "h1-EURUSD.csv"), "utf8");
      assert.equal(csv.split("\n")[0], "# timezone=Asia/Tokyo");
      assert.ok(H.parseCsv(csv).length > 100); // 窓の3日前から
      assert.ok(!q.out.join("\n").includes("SECRET-KEY-123"));
      // 二度目は取得しない（既にあるので）
      calls.length = 0;
      await btMain([`--data-dir=${dataDir}`, "--no-risk-feed", "--now=2026-10-08T12:00:00+09:00", "--window-days=10", "--spacing-ms=0"], { TWELVE_DATA_API_KEY: "SECRET-KEY-123" }, quiet().io);
      assert.equal(calls.length, 0);
    } finally { globalThis.fetch = origFetch; }
  } finally { rm(path.dirname(dataDir)); }
});

test("CLI: 時刻の解釈がずれた取得結果（UTC表記）は h1-bars.json との照合で失敗し、何も書かない", async () => {
  const dataDir = path.join(tmpDir(), "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const { barsByCode } = writeHistory(dataDir, { skip: ["EURUSD"] });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const p = Object.fromEntries(new URL(url).searchParams);
      const rows = barsByCode.EURUSD.map((b) => ({ datetime: `${J.jstLabel(b.t - 9 * J.HR)}:00`, open: String(b.o), high: String(b.h), low: String(b.l), close: String(b.c) }))
        .filter((r) => (!p.start_date || r.datetime >= p.start_date) && (!p.end_date || r.datetime <= p.end_date))
        .sort((a, b) => (a.datetime < b.datetime ? 1 : -1)).slice(0, Number(p.outputsize));
      return new Response(JSON.stringify({ status: "ok", values: rows }), { status: 200 });
    };
    try {
      await assert.rejects(() => btMain([`--data-dir=${dataDir}`, "--no-risk-feed", "--now=2026-10-08T12:00:00+09:00", "--window-days=10", "--spacing-ms=0"], { TWELVE_DATA_API_KEY: "k" }, quiet().io), /不一致|届いていません/);
    } finally { globalThis.fetch = origFetch; }
    assert.equal(fs.existsSync(path.join(dataDir, "history", "h1-EURUSD.csv")), false);
    assert.equal(fs.existsSync(path.join(dataDir, "daytrade")), false);
  } finally { rm(path.dirname(dataDir)); }
});

test("CLI: 取得が必要なのに APIキーが無い／--no-fetch なら、取得せずに失敗する", async () => {
  const dataDir = path.join(tmpDir(), "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    writeHistory(dataDir, { skip: ["EURUSD"] });
    const args = [`--data-dir=${dataDir}`, "--no-risk-feed", "--now=2026-10-08T12:00:00+09:00", "--window-days=10"];
    await assert.rejects(() => btMain(args, {}, quiet().io), /TWELVE_DATA_API_KEY/);
    await assert.rejects(() => btMain([...args, "--no-fetch"], {}, quiet().io), /EURUSD/);
    await assert.rejects(() => btMain(["--window-days=0"], {}, quiet().io), /window-days/);
  } finally { rm(path.dirname(dataDir)); }
});
