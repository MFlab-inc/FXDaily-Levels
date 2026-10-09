"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const H = require("../h1history");
const { createHistory, dailyLevelsFrom, atrPctSeries, regimeAt } = require("../histctx");
const { runBacktest, runBacktestModes, aggregate, floorBreakdown, obstacleBreakdown, metrics, planDates, SLOT_LABEL, SL_FLOOR_MODES, OBSTACLE_DEFS, BACKTEST_MODES, BASE_MODE, modeKey } = require("../backtest");
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
  assert.ok(stats.adds >= stats.dates * 5 && stats.adds <= stats.dates * 6, `型B追加の出来事は1日5〜6回（夏5・冬6）: ${stats.adds}`);
  assert.deepEqual(Object.keys(stats.skipped), ["直前の1時間の足が無い（休場）"]);
  for (const r of records) {
    assert.ok(["A", "B"].includes(r.setup) && ["A", "B"].includes(r.scheme));
    assert.equal(r.k, r.scheme === "A" ? 0.5 : 1.0);
    assert.ok(["到達", "未到達", "失効後到達"].includes(r.reached));
    assert.ok(r.plan_rr >= 1 && r.sl_pips >= 10);
    assert.equal(r.sl_floor, "reject"); // 既定は現行の規則 (a)
    assert.equal(r.obstacle, "both"); // 障害の定義も既定は現行の規則 (a)
    assert.equal(r.obstacle_changed, false);
    assert.equal(r.sl_floored, false);
    if (r.setup === "B") assert.ok([3, 4].includes(r.slot), `型B は設計③か型B追加だけ（slot=${r.slot}）`); // 設計①②は型Aのみ
    else assert.ok([1, 2, 3].includes(r.slot), `型A は設計①②③だけ（slot=${r.slot}）`);
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

test("report: Markdown に軸・確定した規則・H1履歴の品質が出る。CSV の見出しは固定で、先頭の2列は sl_floor・obstacle", () => {
  const { records, stats, statsByMode } = runBacktestModes({ ...allSynth(), nowMs: NOW, windowDays: 10 });
  const rows = aggregate(records);
  const history = PAIRS.map((p) => ({ code: p.code, bars: 100, first: "2026-08-20", last: "2026-10-08 04:00", gaps: 0, verify: { overlap: 10, mismatch: 0 }, fetched: false }));
  const md = toMarkdown(rows, { nowMs: NOW, window: { first: stats.first, last: stats.last }, stats, statsByMode, floorRows: floorBreakdown(records), obstacleRows: obstacleBreakdown(records), history, regimeSource: "試験", noMtf: ["USDCHF"] });
  for (const s of ["# デイトレプラン バックテスト（実行日 2026-10-08）", "## 方式の比較（全体）: SL下限方式 × 障害の定義", "### SL下限方式 (b) の内訳", "### 障害の定義 (b) の内訳", "### 型B の内訳",
    "## SL下限(a)×障害(a)（詳細）", "## SL下限(b)×障害(a)（詳細）", "## SL下限(a)×障害(b)（詳細）", "## SL下限(b)×障害(b)（詳細）",
    "### SL下限(a)×障害(a) 型A × A案（ATR係数 0.5）", "### SL下限(b)×障害(b) 型B × B案（ATR係数 1.0）", "#### 軸: 銘柄", "#### 軸: 設計日の曜日", "#### 軸: ボラ状態", "#### 軸: 約定時刻(JST)", "#### 軸: 設計の回",
    "**Q25**", "**Q35**", "USDCHF は MTF の日足が無く", "保証ではありません", "`a_reject`", "`b_widen`", "`a_both`", "`b_forward`", "状態更新（型B追加）"]) assert.ok(md.includes(s), s);
  // 古い説明（設計②で型Bを作る）が残っていない。型Bの新しい規則と、追加の定義・重複の扱い・2つの軸の定義が書いてある
  assert.ok(!md.includes("設計②（15:30、型A・型B）"));
  for (const s of ["設計②（15:30、**型Aのみ**）", "Q09", "毎時 16:00〜21:00", "同じ計画日・同じ銘柄・同じ向きの型Bが既にあれば", "夏の21:00", "丸めたあとの SL 幅が 10pips 未満なら『SL幅不足』で不採用", "max(係数×ATR, 10pips)",
    "日次レベル7本＋H1高値群・安値群の両方", "日次レベル7本＋進行方向側の群だけ（売りは安値群、買いは高値群）", "逆側の群（売りの手前にある高値群、買いの手前にある安値群）は障害に数えない", "基準水準（Entry の元）の選び方は変えない", "ライブの規則は SL下限 (a)・障害 (a) のまま"]) assert.ok(md.includes(s), s);
  // 比較表: 型×案ごとに 4方式（SL下限 (a)(b) × 障害 (a)(b)）の行（4×4=16行）。見出しの列は依頼の項目
  const cmp = md.split("## 方式の比較（全体）: SL下限方式 × 障害の定義")[1].split("\n### ")[0].split("\n").filter((l) => l.startsWith("|"));
  assert.equal(cmp.length, 2 + 16);
  assert.equal(cmp[0], "| 型 × 案 | SL下限方式 | 障害の定義 | n | 到達 | 到達率 | TP1 | SL | 時間切れ | 勝率 | 計画RR平均 | 実現R(グロス) | 実現R(コスト込) | pips合計(グロス) | pips合計(コスト込) | 最大連敗 |");
  const first3 = cmp.slice(2).map((l) => l.split(" | ").slice(0, 3).join("|").replace(/^\| /, ""));
  const names = ["型A × A案（ATR係数 0.5）", "型A × B案（ATR係数 1.0）", "型B × A案（ATR係数 0.5）", "型B × B案（ATR係数 1.0）"];
  assert.deepEqual(first3, names.flatMap((n) => ["(a)|(a)", "(b)|(a)", "(a)|(b)", "(b)|(b)"].map((m) => `${n}|${m}`)));
  const csv = toCsv(rows);
  assert.equal(csv.split("\n")[0], CSV_COLUMNS.join(","));
  assert.deepEqual(CSV_COLUMNS.slice(0, 3), ["sl_floor", "obstacle", "setup"]);
  assert.equal(csv.trim().split("\n").length, rows.length + 1);
  assert.deepEqual([...new Set(csv.trim().split("\n").slice(1).map((l) => l.split(",").slice(0, 2).join(",")))], ["a_reject,a_both", "b_widen,a_both", "a_reject,b_forward", "b_widen,b_forward"]);
  assert.throws(() => toMarkdown(rows, { nowMs: NOW, window: { first: "a", last: "b" }, stats, history, regimeSource: "試験", noMtf: [] }), /statsByMode/);
  // 4方式がそろっていなければ作らない
  assert.throws(() => toMarkdown(rows, { nowMs: NOW, window: { first: "a", last: "b" }, stats, statsByMode: { [BASE_MODE]: stats }, history, regimeSource: "試験", noMtf: [] }), /statsByMode/);
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
    assert.ok(md.includes("## 方式の比較（全体）: SL下限方式 × 障害の定義") && md.includes("### SL下限方式 (b) の内訳") && md.includes("### 障害の定義 (b) の内訳"));
    const csv = fs.readFileSync(path.join(dataDir, "daytrade", "backtest-2026-10-08.csv"), "utf8");
    assert.equal(csv.split("\n")[0], CSV_COLUMNS.join(","));
    assert.ok(csv.includes("\na_reject,a_both,") && csv.includes("\nb_widen,a_both,") && csv.includes("\na_reject,b_forward,") && csv.includes("\nb_widen,b_forward,"));
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

// ---- 独立レビューで見つかった不具合の回帰試験 ----
test("h1history: 取得した足は銘柄の桁に丸める（保存した CSV から再実行しても同じ結果になる）", async () => {
  const xau = pairOf("XAUUSD");
  const raw = [{ t: J.parseJstLabel("2026-10-05 10:00"), o: 4000.123456, h: 4001.987654, l: 3999.5, c: 4000.556 }];
  const client = { stats: { requests: 0 }, timeSeries: async () => raw.map((b) => ({ datetime: `${J.jstLabel(b.t)}:00`, open: b.o, high: b.h, low: b.l, close: b.c })) };
  const bars = await H.fetchH1(client, xau, { startLabel: "2026-10-05 00:00:00", nowMs: J.parseJstLabel("2026-10-06 00:00"), pageSize: 5000 });
  assert.deepEqual(bars, [{ t: raw[0].t, o: 4000.12, h: 4001.99, l: 3999.5, c: 4000.56 }]);
  assert.deepEqual(H.parseCsv(H.toCsv(bars, xau)), bars); // 往復で変わらない
});

test("histctx: 前日高安も銘柄の桁に丸める（ライブの daily-levels.json と同じ）", () => {
  const d = dailyLevelsFrom({ high: 1.123456789, low: 1.1, close: 1.11 }, eu);
  assert.equal(d.prev_high, 1.12346);
});

test("fill: 取消時刻をまたぐ足は、取消される版では到達に使わない（足の終わりが取消時刻を超えたら見ない）", () => {
  const { simulate } = require("../fill");
  const D = "2026-10-08";
  const mk = (hm, h, l) => ({ t: J.jstAt(D, hm), o: (h + l) / 2, h, l, c: (h + l) / 2 });
  const cand = { side: "sell", plan_date: D, generated_at_ms: J.jstAt(D, "06:30"), entry_low: 1.104, entry_high: 1.1042, schemes: {} };
  const bars = [mk("07:00", 1.1030, 1.1020), mk("15:00", 1.1045, 1.1035)];
  assert.equal(simulate(cand, bars, { reachUntilMs: J.jstAt(D, "15:30") }).reached, "未到達"); // 15:00〜16:00 の足は 15:30 の取消をまたぐ
  assert.equal(simulate(cand, bars, { reachUntilMs: J.jstAt(D, "16:00") }).reached, "到達"); // 16:00 ちょうどに終わる足は使える
  assert.equal(simulate(cand, bars).reached, "到達");
  // 帯を飛び越えた足（高安が帯と重ならない）は未到達のまま
  assert.equal(simulate(cand, [mk("07:00", 1.1030, 1.1020), mk("08:00", 1.1060, 1.1050)]).reached, "未到達");
});

test("backtest: 同じ基準水準・同じ向きの先の版が約定していれば、後の版は数えない（約定は1日1回まで）", () => {
  const { records, stats } = synthRun();
  const seen = new Map();
  for (const r of records.filter((x) => x.reached === "到達")) {
    const k = [r.plan_date, r.symbol, r.setup, r.scheme, r.side, r.ref].join("|");
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  assert.ok([...seen.values()].every((n) => n === 1), JSON.stringify([...seen].filter(([, n]) => n > 1)));
  assert.ok(Number.isInteger(stats.suppressed));
});

test("backtest: 同じ基準水準・向きの先の版が約定していれば、後の版（帯が少し違う再設計）は数えない／約定していなければ両方数える", () => {
  const D = "2026-10-06";
  const { barsByCode, rowsByCode } = allSynth();
  const quietFrom = J.jstAt(D, "07:00"), quietTo = J.jstAt("2026-10-07", "03:00");
  const withBars = (touch) => ({
    ...barsByCode,
    EURUSD: barsByCode.EURUSD.map((b) => {
      if (b.t < quietFrom || b.t >= quietTo) return b;
      const quiet = { t: b.t, o: 1.0995, h: 1.1010, l: 1.0990, c: 1.0995 };
      return touch && b.t === J.jstAt(D, "10:00") ? { ...quiet, h: 1.1045 } : quiet;
    }),
  });
  // 設計①は帯 1.1040〜1.1042、設計②は同じ基準水準 1.1040 で帯だけ少し違う（ATRが変わった再設計）、設計③は無し
  const res = (band, sl) => ({
    outcome: "candidate", symbol: "EURUSD", setup: "A", side: "sell", ref: { label: "Pivot", price: 1.104 }, band, worst_entry: 1.104,
    pip_value_jpy: 1500, schemes: { A: { pass: true, sl, tp: 1.099, sl_pips: (sl - 1.104) * 1e4, profit_pips: 50, rr: 5 }, B: { pass: false } },
  });
  const stub = (ctx, setup, { slot }) => {
    const none = { outcome: "rejected", symbol: ctx.pair.code, setup, schemes: { A: { pass: false }, B: { pass: false } } };
    return ctx.pair.code === "EURUSD" && setup === "A" && ctx.planDate === D ? (slot === 1 ? res({ low: 1.104, high: 1.1042 }, 1.105) : slot === 2 ? res({ low: 1.104, high: 1.1043 }, 1.1051) : none) : none;
  };
  // ctx に計画日を載せるため、histctx の meta を使わず、設計時刻から決める
  const wrapped = (ctx, setup, info) => stub({ ...ctx, planDate: require("../windows").planDateOf(info.t) }, setup, info);
  const run = (touch) => runBacktest({ barsByCode: withBars(touch), rowsByCode, nowMs: J.parseIso("2026-10-08T12:00:00+09:00"), windowDays: 3, evaluateImpl: wrapped });
  // 設計①の版が 10:00 に約定 → 設計②の同じ基準水準の版は数えない
  let { records, stats } = run(true);
  const rec = records.filter((r) => r.symbol === "EURUSD");
  assert.equal(rec.length, 1);
  assert.equal(rec[0].slot, 1);
  assert.equal(rec[0].reached, "到達");
  assert.equal(stats.suppressed, 1);
  // 約定していなければ、設計①の版は取消(未到達)、設計②の版が新しい版として数えられる（設計③で無くなるので、これも取消(未到達)）
  ({ records, stats } = run(false));
  const rec2 = records.filter((r) => r.symbol === "EURUSD");
  assert.deepEqual(rec2.map((r) => [r.slot, r.reached, r.cancelled_unreached]), [[1, "未到達", true], [2, "未到達", true]]);
  assert.equal(stats.suppressed, 0);
});

// ================= 型B追加（Q09 変更）と SL下限方式 (a)(b) =================
// 評価を差し替えた小さな場面。EURUSD の計画日 D の 07:00〜翌3:00 を『静かな足』（Entry帯に届かない）にして、
// touch で指定した足（"YYYY-MM-DD HH:MM" JST開始）だけ売りの帯（1.1040〜1.1042）に触れさせる。
const DS = "2026-10-06"; // 夏（NYはEDT）の計画日（火）。設計③は 21:00
const DW = "2025-12-02"; // 冬（NYはEST）の計画日（火）。設計③は 22:00、21:00 は型B追加
const NOW_S = J.parseIso("2026-10-08T12:00:00+09:00"); // 窓3日 → 10/5・10/6・10/7
const NOW_W = J.parseIso("2025-12-04T12:00:00+09:00"); // 窓3日 → 12/1・12/2・12/3
const SYN = { summer: allSynth(), winter: allSynth({ h1: { fromLabel: "2025-11-01 00:00", toLabel: "2026-10-08 05:00" } }) };
const NONE = (ctx, setup) => ({ outcome: "rejected", symbol: ctx.pair.code, setup, schemes: { A: { pass: false }, B: { pass: false } } });
const sellCand = (o = {}) => {
  const { sl = 1.105, band = { low: 1.104, high: 1.1042 }, ref = 1.104, floored } = o;
  return {
    outcome: "candidate", symbol: "EURUSD", setup: "B", side: "sell", ref: { label: "東京レンジ安値", price: ref }, band, worst_entry: band.low, pip_value_jpy: 1500,
    schemes: { A: { pass: true, sl, tp: 1.099, sl_pips: 10, profit_pips: 50, rr: 5, ...(floored === undefined ? {} : { sl_floored: floored }) }, B: { pass: false } },
  };
};
const buyCand = () => ({
  outcome: "candidate", symbol: "EURUSD", setup: "B", side: "buy", ref: { label: "東京レンジ高値", price: 1.095 }, band: { low: 1.0948, high: 1.095 }, worst_entry: 1.095, pip_value_jpy: 1500,
  schemes: { A: { pass: true, sl: 1.094, tp: 1.1, sl_pips: 10, profit_pips: 50, rr: 5 }, B: { pass: false } },
});

// rule({hour, slot, t, slFloor, obstacle}) → EURUSD・型B の候補（無ければ null）。touch: { "YYYY-MM-DD HH:MM": 足の上書き }
function runB({ D, rule, touch = {}, season = "summer", modes = false }) {
  const { barsByCode, rowsByCode } = SYN[season];
  const from = J.jstAt(D, "07:00"), to = J.jstAt(J.addDaysJst(D, 1), "03:00");
  const eub = barsByCode.EURUSD.map((b) => {
    if (b.t < from || b.t >= to) return b;
    return { t: b.t, o: 1.0995, h: 1.1010, l: 1.0990, c: 1.0995, ...(touch[J.jstLabel(b.t)] || {}) };
  });
  const calls = [];
  const evaluateImpl = (ctx, setup, info) => {
    const mine = ctx.pair.code === "EURUSD" && J.jstDate(info.t - 3 * J.HR) === D;
    if (mine) calls.push({ setup, slot: info.slot, hm: J.jstLabel(info.t).slice(11), slFloor: info.slFloor, obstacle: info.obstacle });
    const c = mine && setup === "B" ? rule({ hour: J.jstHour(info.t), slot: info.slot, t: info.t, slFloor: info.slFloor, obstacle: info.obstacle }) : null;
    return c || NONE(ctx, setup);
  };
  const args = { barsByCode: { ...barsByCode, EURUSD: eub }, rowsByCode, nowMs: season === "summer" ? NOW_S : NOW_W, windowDays: 3, evaluateImpl };
  const out = modes ? runBacktestModes(args) : runBacktest(args);
  out.calls = calls;
  out.eu = out.records.filter((r) => r.symbol === "EURUSD" && r.setup === "B" && r.plan_date === D);
  return out;
}
const at = (D, hm) => `${D} ${hm}`;

test("型B追加: 評価の回は 設計①②=型Aのみ／設計③=型A・型B／型B追加=型Bのみ。夏は21:00が設計③（追加ではない）、冬は21:00が追加で設計③は22:00", () => {
  const sum = runB({ D: DS, rule: () => null });
  const win = runB({ D: DW, rule: () => null, season: "winter" });
  const byKind = (calls) => calls.reduce((m, c) => { (m[`${c.setup}${c.slot}`] ||= []).push(c.hm); return m; }, {});
  assert.deepEqual(byKind(sum.calls), { A1: ["06:30"], A2: ["15:30"], A3: ["21:00"], B3: ["21:00"], B4: ["16:00", "17:00", "18:00", "19:00", "20:00"] });
  assert.deepEqual(byKind(win.calls), { A1: ["07:30"], A2: ["15:30"], A3: ["22:00"], B3: ["22:00"], B4: ["16:00", "17:00", "18:00", "19:00", "20:00", "21:00"] });
  assert.equal(sum.stats.adds, 3 * 5);
  assert.equal(win.stats.adds, 3 * 6);
  assert.equal(sum.stats.designs, 9);
  assert.equal(win.stats.designs, 9);
});

test("型B追加: 17:00 の追加は slot 4。追加時刻（17:00 の5分後）より前に始まる足では到達せず、次の時間に始まる足から到達する。同じ銘柄・向きの2回目以降は追加しない", () => {
  const rule = ({ hour }) => (hour >= 17 && hour <= 20 ? sellCand() : null); // 17:00 からブレイクが続いて見つかる。設計③(21:00)は無し
  // 16:00 の足は追加より前 → 未到達
  let r = runB({ D: DS, rule, touch: { [at(DS, "16:00")]: { h: 1.1045 } } });
  assert.equal(r.eu.length, 1);
  assert.equal(r.eu[0].slot, 4);
  assert.equal(r.eu[0].reached, "未到達");
  // 17:00 開始の足は追加（17:05）より前に始まる足 → 使わない（ライブの実行は :00 の数分後で、その足は途中から）
  r = runB({ D: DS, rule, touch: { [at(DS, "17:00")]: { h: 1.1045 } } });
  assert.equal(r.eu[0].reached, "未到達");
  // 18:00 開始の足から到達できる
  r = runB({ D: DS, rule, touch: { [at(DS, "18:00")]: { h: 1.1045 } } });
  assert.equal(r.eu.length, 1);
  assert.equal(r.eu[0].reached, "到達");
  assert.equal(r.eu[0].reached_ms, J.jstAt(DS, "18:00"));
  assert.equal(r.eu[0].fill_hour, 18);
  assert.equal(SLOT_LABEL[r.eu[0].slot], "状態更新（型B追加）");
  // 追加は1回だけ（18・19・20時は同じ銘柄・向きが既にあるので追加しない）
  assert.equal(r.stats.bAdded, 1);
  assert.equal(r.stats.bAddDup, 3);
  // 設計①②にも設計③にも型Bの記録はない（slot 4 だけ）
  assert.deepEqual(r.records.filter((x) => x.setup === "B").map((x) => x.slot), [4]);
});

test("型B追加: 同じ銘柄・同じ向きは1日1回（別の版でも追加しない）。向きが違えば別に追加する。設計③に無ければ取消（未到達）", () => {
  const rule = ({ hour }) => (hour === 17 ? sellCand() : hour === 18 ? sellCand({ band: { low: 1.1041, high: 1.1043 }, sl: 1.1051 }) : hour === 19 ? buyCand() : hour === 20 ? sellCand({ sl: 1.1052 }) : null);
  const r = runB({ D: DS, rule });
  assert.equal(r.stats.bAdded, 2); // 売り(17:00)・買い(19:00)
  assert.equal(r.stats.bAddDup, 2); // 売り 18:00・20:00
  assert.equal(r.eu.length, 2);
  assert.deepEqual(r.eu.map((x) => x.side).sort(), ["buy", "sell"]);
  assert.ok(r.eu.every((x) => x.slot === 4 && x.reached === "未到達"));
  // 設計③(21:00)が両方とも出さない → 設計③の時刻に取消（追加は取消さないが、設計③の再設計では取消される）
  assert.ok(r.eu.every((x) => x.cancelled_unreached === true));
  // 取消された版でも、同じ銘柄・向きの型Bは再び追加されない（17:00 の版は設計③で取消されるが、追加は 21:00 より前の出来事だけ）
  assert.equal(r.eu.filter((x) => x.side === "sell").length, 1);
});

test("型B追加: 追加は追加だけ — 後の時刻に評価が空になっても取消さない（設計③の時刻か有効期限まで追跡する）", () => {
  const rule = ({ hour, slot }) => ((hour === 17 && slot === 4) || slot === 3 ? sellCand() : null); // 17:00 だけ候補。設計③は同じ版
  // 18〜20時は候補なし。それでも版は生きていて、19:00 の足で到達できる
  let r = runB({ D: DS, rule, touch: { [at(DS, "19:00")]: { h: 1.1045 } } });
  assert.equal(r.eu.length, 1);
  assert.equal(r.eu[0].slot, 4);
  assert.equal(r.eu[0].reached, "到達");
  assert.equal(r.eu[0].reached_ms, J.jstAt(DS, "19:00"));
  // 設計③が同じ版を出すので継続（取消されず、有効期限まで残る = 『取消・未到達』ではない）
  r = runB({ D: DS, rule });
  assert.equal(r.eu.length, 1);
  assert.equal(r.eu[0].reached, "未到達");
  assert.equal(r.eu[0].cancelled_unreached, false);
  // 21:00 開始の足（設計③の時刻に始まる足）にも、追加した版が継続していれば到達できる
  r = runB({ D: DS, rule, touch: { [at(DS, "21:00")]: { h: 1.1045 } } });
  assert.equal(r.eu.length, 1);
  assert.equal(r.eu[0].reached_ms, J.jstAt(DS, "21:00"));
  assert.equal(r.eu[0].slot, 4);
});

test("設計③と追加された版: 同じ版は継続／違う版は設計③の時刻に取消され新しい版が生まれる／無ければ取消", () => {
  const add = ({ hour, slot }) => (hour === 17 && slot === 4 ? sellCand() : null);
  // 継続: 設計③が同一の版（Entry帯・SL）を出す → 1件のまま、取消ではない
  let r = runB({ D: DS, rule: (c) => add(c) || (c.slot === 3 ? sellCand() : null) });
  assert.deepEqual(r.eu.map((x) => [x.slot, x.cancelled_unreached]), [[4, false]]);
  // 取消: 設計③が違う版（SLが違う）を出す → 追加した版は設計③の時刻に取消(未到達)、設計③で新しい版が生まれる
  const diffRule = (c) => add(c) || (c.slot === 3 ? sellCand({ sl: 1.1051 }) : null);
  r = runB({ D: DS, rule: diffRule });
  assert.deepEqual(r.eu.map((x) => [x.slot, x.reached, x.cancelled_unreached]).sort(), [[3, "未到達", false], [4, "未到達", true]]);
  // 設計③の時刻に始まる足（21:00）は、取消された追加版では使えず（足の終わりが取消時刻を超える）、設計③の版が到達する
  r = runB({ D: DS, rule: diffRule, touch: { [at(DS, "21:00")]: { h: 1.1045 } } });
  const bySlot = Object.fromEntries(r.eu.map((x) => [x.slot, x]));
  assert.equal(bySlot[4].reached, "未到達");
  assert.equal(bySlot[3].reached, "到達");
  assert.equal(bySlot[3].reached_ms, J.jstAt(DS, "21:00"));
  // 取消: 設計③が何も出さない → 追加した版は設計③の時刻に取消(未到達)
  r = runB({ D: DS, rule: add });
  assert.deepEqual(r.eu.map((x) => [x.slot, x.reached, x.cancelled_unreached]), [[4, "未到達", true]]);
  // 設計③の時刻より前に終わる足(20:00〜21:00)には、取消される追加版でも到達できる
  r = runB({ D: DS, rule: add, touch: { [at(DS, "20:00")]: { h: 1.1045 } } });
  assert.deepEqual(r.eu.map((x) => [x.slot, x.reached, x.reached_ms]), [[4, "到達", J.jstAt(DS, "20:00")]]);
});

test("設計③と追加された版: 追加した版が先に約定していれば、同じ基準水準・向きの設計③の版（別のSL）は数えない。約定していなければ両方数える", () => {
  const rule = (c) => (c.hour === 17 && c.slot === 4 ? sellCand() : c.slot === 3 ? sellCand({ sl: 1.1051 }) : null);
  // 20:00 の足で追加版が約定 → 設計③の版（同じ ref）は数えない
  let r = runB({ D: DS, rule, touch: { [at(DS, "20:00")]: { h: 1.1045 } } });
  assert.deepEqual(r.eu.map((x) => [x.slot, x.reached]), [[4, "到達"]]);
  assert.equal(r.stats.suppressed, 1);
  // 約定していなければ、追加版は取消(未到達)、設計③の版が新しく数えられる
  r = runB({ D: DS, rule });
  assert.deepEqual(r.eu.map((x) => [x.slot, x.reached, x.cancelled_unreached]).sort(), [[3, "未到達", false], [4, "未到達", true]]);
  assert.equal(r.stats.suppressed, 0);
  // 基準水準が違えば別の考え（数える）
  const rule2 = (c) => (c.hour === 17 && c.slot === 4 ? sellCand() : c.slot === 3 ? sellCand({ sl: 1.1051, ref: 1.1039 }) : null);
  r = runB({ D: DS, rule: rule2, touch: { [at(DS, "20:00")]: { h: 1.1045 } } });
  assert.equal(r.eu.length, 2);
  assert.equal(r.stats.suppressed, 0);
});

test("冬の計画日: 21:00 は型B追加（slot 4）、設計③は 22:00。21:00 開始の足（22:00に終わる）は取消される追加版も使える／22:00 開始の足は設計③の版", () => {
  const add = (c) => (c.hour === 21 && c.slot === 4 ? sellCand() : c.slot === 3 ? sellCand({ sl: 1.1051 }) : null);
  // 21:00 の追加（21:05 から）は 21:00 開始の足を使えない。次の足は設計③（22:00）の取消にかかる（22:00 開始の足は設計③の版の時間）ので、追加版は到達できず取消になる
  let r = runB({ D: DW, rule: add, season: "winter", touch: { [at(DW, "21:00")]: { h: 1.1045 } } });
  assert.equal(r.eu.find((x) => x.slot === 4).reached, "未到達");
  assert.equal(r.eu.find((x) => x.slot === 4).cancelled_unreached, true);
  r = runB({ D: DW, rule: add, season: "winter", touch: { [at(DW, "22:00")]: { h: 1.1045 } } });
  const bySlot = Object.fromEntries(r.eu.map((x) => [x.slot, x]));
  assert.equal(bySlot[4].reached, "未到達");
  assert.equal(bySlot[4].cancelled_unreached, true);
  assert.equal(bySlot[3].reached_ms, J.jstAt(DW, "22:00"));
  // 夏は 21:00 に追加の機会が無い（21:00 は設計③そのもの）— 21:00 の評価は slot 3 だけ
  const sum = runB({ D: DS, rule: (c) => (c.hour === 21 ? sellCand() : null) });
  assert.deepEqual(sum.calls.filter((c) => c.hm === "21:00").map((c) => `${c.setup}${c.slot}`).sort(), ["A3", "B3"]);
  assert.equal(sum.stats.bAdded, 0);
  assert.equal(sum.eu.length, 1);
  assert.equal(sum.eu[0].slot, 3);
});

test("SL下限方式: evaluateImpl に slFloor が渡り、記録に sl_floor と sl_floored が付く。(a) では出ない案が (b) にだけ現れる", () => {
  // SL下限 (b)・障害 (a) のときだけ候補を出す（SL幅の狭い案を 10pips に広げた想定）
  const rule = ({ hour, slot, slFloor, obstacle }) => (slFloor === "widen" && obstacle === "both" && slot === 4 && hour === 17 ? sellCand({ floored: true }) : null);
  const r = runB({ D: DS, rule, modes: true });
  assert.ok(r.calls.every((c) => (c.slFloor === "reject" || c.slFloor === "widen") && (c.obstacle === "both" || c.obstacle === "forward")));
  for (const m of BACKTEST_MODES) assert.equal(r.calls.filter((c) => c.slFloor === m.slFloor && c.obstacle === m.obstacle).length, r.calls.length / 4); // 同じ評価を4方式で
  assert.equal(r.eu.length, 1);
  assert.equal(r.eu[0].sl_floor, "widen");
  assert.equal(r.eu[0].obstacle, "both");
  assert.equal(r.eu[0].sl_floored, true);
  assert.equal(r.statsByMode[modeKey("reject", "both")].bAdded, 0);
  assert.equal(r.statsByMode[modeKey("widen", "both")].bAdded, 1);
  assert.equal(r.statsByMode[modeKey("widen", "forward")].bAdded, 0);
  assert.deepEqual(r.records.map((x) => x.sl_floor), ["widen"]); // ほかの3方式は空
  // 集計は sl_floor・obstacle で分かれる: 該当の方式の行だけ。CSV の先頭2列は b_widen,a_both
  const rows = aggregate(r.records);
  assert.deepEqual([...new Set(rows.map((x) => `${x.sl_floor}|${x.obstacle}`))], [modeKey("widen", "both")]);
  assert.ok(toCsv(rows).trim().split("\n").slice(1).every((l) => l.startsWith("b_widen,a_both,B,")));
  // SL下限 (b) の内訳（障害の定義ごと）
  const fb = floorBreakdown(r.records);
  assert.deepEqual(fb.map((x) => [x.obstacle, x.setup, x.scheme, x.value.startsWith("10pips下限で広げた案") ? "floored" : "same", x.n]), [["both", "B", "A", "same", 0], ["both", "B", "A", "floored", 1]]);
  // 同じ候補が全方式に出る場合は、同じ記録が sl_floor・obstacle だけ違って4件になる（4方式を別々に数える）
  const all4 = runB({ D: DS, rule: ({ hour, slot }) => (slot === 4 && hour === 17 ? sellCand({ floored: false }) : null), modes: true });
  assert.deepEqual(all4.eu.map((x) => [x.sl_floor, x.obstacle, x.slot, x.sl_floored]), [["reject", "both", 4, false], ["widen", "both", 4, false], ["reject", "forward", 4, false], ["widen", "forward", 4, false]]);
  const rows2 = aggregate(all4.records);
  for (const m of BACKTEST_MODES) assert.equal(rows2.find((x) => x.sl_floor === m.slFloor && x.obstacle === m.obstacle && x.axis === "全体" && x.setup === "B" && x.scheme === "A").n, 1, m.key);
});

test("障害の定義: evaluateImpl に obstacle が渡り、記録に obstacle と obstacle_changed が付く。障害 (b) にだけ現れる案は (b) の記録だけに出る", () => {
  const rule = ({ hour, slot, obstacle }) => (obstacle === "forward" && slot === 4 && hour === 17 ? { ...sellCand(), obstacle_changed: true } : null);
  const r = runB({ D: DS, rule, modes: true });
  assert.equal(r.eu.length, 2); // SL下限 (a)(b) の両方
  assert.deepEqual(r.eu.map((x) => [x.sl_floor, x.obstacle, x.obstacle_changed]), [["reject", "forward", true], ["widen", "forward", true]]);
  assert.deepEqual(r.records.map((x) => x.obstacle), ["forward", "forward"]);
  assert.equal(r.statsByMode[modeKey("reject", "both")].bAdded, 0);
  assert.equal(r.statsByMode[modeKey("reject", "forward")].bAdded, 1);
  const rows = aggregate(r.records);
  assert.deepEqual([...new Set(rows.map((x) => `${x.obstacle}|${x.sl_floor}`))], ["forward|reject", "forward|widen"]);
  assert.ok(toCsv(rows).trim().split("\n").slice(1).every((l) => /^(a_reject|b_widen),b_forward,B,/.test(l)));
  // 障害 (b) の内訳: TP1 が変わった案 / 変わらなかった案（SL下限方式ごと）
  const ob = obstacleBreakdown(r.records);
  assert.deepEqual(ob.map((x) => [x.sl_floor, x.setup, x.scheme, x.value.startsWith("TP1 が変わった案") ? "changed" : "same", x.n]),
    [["reject", "B", "A", "same", 0], ["reject", "B", "A", "changed", 1], ["widen", "B", "A", "same", 0], ["widen", "B", "A", "changed", 1]]);
  // 障害 (a) の記録には obstacle_changed が付かない（false）。obstacleBreakdown は障害 (b) の記録だけを分ける
  const bothOnly = runB({ D: DS, rule: ({ hour, slot, obstacle }) => (obstacle === "both" && slot === 4 && hour === 17 ? sellCand() : null), modes: true });
  assert.ok(bothOnly.records.every((x) => x.obstacle === "both" && x.obstacle_changed === false));
  assert.deepEqual(obstacleBreakdown(bothOnly.records), []);
});

test("runBacktest／aggregate／toCsv: 不正な slFloor・obstacle は受け付けない", () => {
  // evaluateImpl を差し替えて、evaluate() 自身の検証ではなく runBacktest の検証で止まることを確かめる
  const stub = () => ({ outcome: "rejected", schemes: { A: { pass: false }, B: { pass: false } } });
  assert.throws(() => runBacktest({ ...allSynth(), nowMs: NOW, windowDays: 1, slFloor: "wide", evaluateImpl: stub }), /runBacktest: slFloor/);
  assert.throws(() => runBacktest({ ...allSynth(), nowMs: NOW, windowDays: 1, obstacle: "forwards", evaluateImpl: stub }), /runBacktest: obstacle/);
  assert.throws(() => runBacktest({ ...allSynth(), nowMs: NOW, windowDays: 1, obstacle: "", evaluateImpl: stub }), /runBacktest: obstacle/);
  assert.throws(() => runBacktest({ ...allSynth(), nowMs: NOW, windowDays: 1, obstacle: null, evaluateImpl: stub }), /runBacktest: obstacle/);
  assert.throws(() => aggregate([{ sl_floor: "wide", obstacle: "both", setup: "A", scheme: "A" }]), /sl_floor/);
  assert.throws(() => aggregate([{ sl_floor: "reject", obstacle: "fwd", setup: "A", scheme: "A" }]), /obstacle/);
  assert.throws(() => aggregate([{ sl_floor: "reject", setup: "A", scheme: "A" }]), /obstacle/);
  assert.throws(() => toCsv([{ sl_floor: undefined, obstacle: "both" }]), /sl_floor/);
  assert.throws(() => toCsv([{ sl_floor: "reject", obstacle: undefined }]), /obstacle/);
  assert.deepEqual(SL_FLOOR_MODES.map((m) => m.code), ["a_reject", "b_widen"]);
  assert.deepEqual(OBSTACLE_DEFS.map((o) => o.code), ["a_both", "b_forward"]);
  assert.deepEqual(BACKTEST_MODES.map((m) => m.key), ["reject|both", "widen|both", "reject|forward", "widen|forward"]);
  assert.equal(BASE_MODE, "reject|both"); // ライブと同じ方式が先頭
});

test("aggregate: 障害の定義 × SL下限方式 × 型 × ATR係数で分かれ、設計の回の軸に『状態更新（型B追加）』が設計③の次に出る。曜日は月→金の順", () => {
  const all4 = runB({ D: DS, rule: ({ hour, slot, slFloor }) => (slot === 4 && hour === 17 ? sellCand() : slot === 3 && slFloor === "widen" ? sellCand({ sl: 1.1051, floored: true }) : null), modes: true });
  const rows = aggregate(all4.records);
  for (const m of BACKTEST_MODES) {
    const mine = (x) => x.sl_floor === m.slFloor && x.obstacle === m.obstacle && x.setup === "B" && x.scheme === "A";
    const slotRows = rows.filter((x) => mine(x) && x.axis === "設計の回").map((x) => x.value);
    assert.deepEqual(slotRows, m.slFloor === "widen" ? ["設計③", "状態更新（型B追加）"] : ["状態更新（型B追加）"], m.key);
    // 方式ごとの全体 n = その方式の記録の数。どの軸でも足すと全体になる
    const n = all4.records.filter((x) => x.sl_floor === m.slFloor && x.obstacle === m.obstacle && x.setup === "B" && x.scheme === "A").length;
    assert.ok(n > 0, m.key);
    assert.equal(rows.find((x) => mine(x) && x.axis === "全体").n, n, m.key);
    for (const ax of ["銘柄", "設計の回", "設計日の曜日", "ボラ状態", "売買（参考）"]) assert.equal(rows.filter((x) => mine(x) && x.axis === ax).reduce((a, x) => a + x.n, 0), n, `${m.key} ${ax}`);
  }
  // 行の並び: 障害 (a) の SL下限 (a)→(b)、次に障害 (b) の SL下限 (a)→(b)
  const firstIdx = (m) => rows.findIndex((x) => x.sl_floor === m.slFloor && x.obstacle === m.obstacle);
  assert.deepEqual(BACKTEST_MODES.map(firstIdx), [...BACKTEST_MODES.map(firstIdx)].sort((a, b) => a - b));
  assert.ok(BACKTEST_MODES.every((m) => firstIdx(m) >= 0));
  // 曜日の軸は月→金の順
  const real = aggregate(synthRun().records);
  const groups = new Set(real.map((x) => `${x.setup}${x.scheme}`));
  assert.ok(groups.size > 0);
  for (const g of groups) {
    const wk = real.filter((x) => `${x.setup}${x.scheme}` === g && x.axis === "設計日の曜日").map((x) => ["月", "火", "水", "木", "金"].indexOf(x.value));
    assert.deepEqual(wk, [...wk].sort((a, b) => a - b));
  }
});

// ---- 本物の evaluate（差し替えなし）で、ATR が小さい模擬データ: (a) は SL幅不足で落ち、(b) は 10pips に広げて採用 ----
test("SL下限方式 (a)(b): ATRが小さいデータでは、(b) にだけ『広げた案』が現れ、(a) の案は (b) にも同じSLで残る。型B追加も出る（障害の定義ごと）", () => {
  const { barsByCode, rowsByCode } = allSynth({ h1: { wickPct: 0.0001 } });
  const { records, statsByMode } = runBacktestModes({ barsByCode, rowsByCode, nowMs: NOW, windowDays: 10 });
  for (const o of OBSTACLE_DEFS) {
    const a = records.filter((r) => r.sl_floor === "reject" && r.obstacle === o.id), b = records.filter((r) => r.sl_floor === "widen" && r.obstacle === o.id);
    assert.ok(a.length > 0 && b.length > a.length, `${o.id}: a=${a.length} b=${b.length}`);
    assert.ok(a.every((r) => r.sl_pips >= 10 && r.sl_floored === false));
    assert.ok(b.every((r) => r.sl_pips >= 10 - 1e-6));
    const floored = b.filter((r) => r.sl_floored);
    assert.ok(floored.length > 0);
    assert.ok(floored.every((r) => Math.abs(r.sl_pips - 10) < 0.7), "広げた案のSL幅は 10pips 付近（0.5pip丸め・基準水準の位置で最大 +0.5pip）");
    assert.ok(statsByMode[modeKey("widen", o.id)].bAdded >= statsByMode[modeKey("reject", o.id)].bAdded);
    // (a) の案は (b) にも同じ案（同じ日・型・銘柄・向き・基準水準・SL幅）がある。無いものは、(b) で先に約定した同じ考えの版に抑えられた分だけ
    const idea = (r) => [r.plan_date, r.setup, r.scheme, r.symbol, r.side, r.ref].join("|");
    const bKeys = new Set(b.map((r) => `${idea(r)}|${r.sl_pips.toFixed(6)}`));
    const bFilled = new Set(b.filter((r) => r.reached === "到達").map(idea));
    for (const r of a) assert.ok(bKeys.has(`${idea(r)}|${r.sl_pips.toFixed(6)}`) || bFilled.has(idea(r)), `(a) の案が (b) に無い: ${idea(r)}`);
  }
  assert.ok(records.some((r) => r.sl_floor === "widen" && r.obstacle === "both" && r.setup === "B" && r.slot === 4), "型B追加の版が (b) に出る");
  assert.ok(records.every((r) => (r.setup === "B" ? [3, 4].includes(r.slot) : [1, 2, 3].includes(r.slot))));
});

// ---- 未来を見ていないこと（look-ahead） ----
test("histctx: 設計時刻より後の足・基準日より後の日足を壊しても、入力（ctx）は変わらない（設計①②③・型B追加の時刻、型A・型B）", () => {
  const { barsByCode, rowsByCode } = allSynth();
  const base = createHistory({ barsByCode, rowsByCode });
  const dates = ["2026-09-29", "2026-10-01", "2026-10-06"];
  const times = [["06:30", "A"], ["15:30", "A"], ["17:00", "B"], ["19:00", "B"], ["21:00", "B"]];
  let checked = 0;
  for (const d of dates) for (const [hm, setup] of times) {
    const t = J.jstAt(d, hm);
    const a = base.ctxAt(eu, t, setup);
    if (a.skip) continue;
    const prevHourEnd = Math.floor(t / J.HR) * J.HR; // この時刻までに確定した足は、開始+1時間 <= prevHourEnd
    const bad = (v) => v * 3 + 1;
    const corruptBars = Object.fromEntries(Object.entries(barsByCode).map(([c, bars]) => [c, bars.map((b) => (b.t + J.HR > t ? { ...b, o: bad(b.o), h: bad(b.h), l: bad(b.l), c: bad(b.c) } : b))]));
    const corruptRows = Object.fromEntries(Object.entries(rowsByCode).map(([c, rows]) => [c, rows.map((r) => (r.date > a.meta.asOf ? { ...r, open: bad(r.open), high: bad(r.high), low: bad(r.low), close: bad(r.close) } : r))]));
    const b = createHistory({ barsByCode: corruptBars, rowsByCode: corruptRows }).ctxAt(eu, t, setup);
    assert.deepEqual(b, a, `${d} ${hm} ${setup}: 未来のデータで入力が変わった`);
    assert.ok(prevHourEnd <= t);
    checked++;
  }
  assert.ok(checked >= 12, `検査できた時刻が少なすぎる: ${checked}`);
});

test("バックテスト: ある計画日までの記録は、その案の失効（翌3:00）より後の足と、その日より後の日足を壊しても変わらない", () => {
  const { barsByCode, rowsByCode } = allSynth();
  const D = "2026-10-01";
  const cut = J.jstAt(J.addDaysJst(D, 1), "03:00");
  const bad = (v) => v * 3 + 1;
  const corruptBars = Object.fromEntries(Object.entries(barsByCode).map(([c, bars]) => [c, bars.map((b) => (b.t >= cut ? { ...b, o: bad(b.o), h: bad(b.h), l: bad(b.l), c: bad(b.c) } : b))]));
  const corruptRows = Object.fromEntries(Object.entries(rowsByCode).map(([c, rows]) => [c, rows.map((r) => (r.date > D ? { ...r, open: bad(r.open), high: bad(r.high), low: bad(r.low), close: bad(r.close) } : r))]));
  for (const m of BACKTEST_MODES) {
    const a = runBacktest({ barsByCode, rowsByCode, nowMs: NOW, windowDays: 10, slFloor: m.slFloor, obstacle: m.obstacle }).records.filter((r) => r.plan_date <= D);
    const b = runBacktest({ barsByCode: corruptBars, rowsByCode: corruptRows, nowMs: NOW, windowDays: 10, slFloor: m.slFloor, obstacle: m.obstacle }).records.filter((r) => r.plan_date <= D);
    assert.ok(a.length >= 3, `検査する記録が少なすぎる(${m.key}): ${a.length}`);
    assert.deepEqual(b, a, `${m.key}: 失効より後のデータで記録が変わった`);
  }
});

test("CLI: --dry-run は何も書かない（H1履歴も結果の .md / .csv も）。件数だけ表示する", async () => {
  const dataDir = path.join(tmpDir(), "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    writeHistory(dataDir);
    const list = () => fs.readdirSync(dataDir, { recursive: true }).sort().join("\n");
    const before = list();
    const q = quiet();
    await btMain([`--data-dir=${dataDir}`, "--no-risk-feed", "--now=2026-10-08T12:00:00+09:00", "--window-days=10", "--dry-run"], {}, q.io);
    assert.equal(list(), before);
    assert.ok(!fs.existsSync(path.join(dataDir, "daytrade", "backtest-2026-10-08.md")));
    assert.match(q.out.join("\n"), /dry-run/);
  } finally { rm(path.dirname(dataDir)); }
});
