"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFeed } = require("../lib/feed");
const { SYMBOLS, VERSION } = require("../config");
const { scenarioRows, mkRows, weekdaysFrom } = require("./helpers");

const NOW = Date.UTC(2026, 9, 6, 21, 25, 0); // 2026-10-07 06:25 JST
const ASOF = "2026-10-06";
const itemsAll = (over = {}) => SYMBOLS.map((s) => ({ code: s.code, rows: scenarioRows(s.code, "2024-07-01", ASOF), updatedAt: "2026-10-07T06:25:00+09:00", ...(over[s.code] || {}) }));

test("4: ファイル全体の項目 — 生成日時(JST)・基準日・版・日足の区切り・WTD/MTD除外", () => {
  const { json, text } = buildFeed({ asOf: ASOF, nowMs: NOW, items: itemsAll() });
  assert.equal(json.generated_at, "2026-10-07T06:25:00+09:00");
  assert.equal(json.data_base_date, ASOF);
  assert.equal(json.version, "MTF-1.0（Block② MTF_Structure_Module.xlsx の Methodology 準拠）");
  assert.equal(json.version, VERSION);
  assert.equal(json.daily_boundary, "ニューヨーク時間17時");
  assert.match(json.excluded, /WTD／MTD/);
  assert.equal(json.status, "ok");
  assert.equal(json.symbols.length, 9);
  assert.deepEqual(json.symbols.map((s) => s.symbol), ["USDJPY", "EURUSD", "GBPUSD", "AUDUSD", "EURJPY", "EURGBP", "USDCAD", "XAUUSD", "USDCHF"]);
  // テキストの先頭
  const head = text.split("\n").slice(0, 8).join("\n");
  assert.match(head, /generated_at: 2026-10-07T06:25:00\+09:00/);
  assert.match(head, /data_base_date: 2026-10-06/);
  assert.match(head, /version: MTF-1\.0（Block② MTF_Structure_Module\.xlsx の Methodology 準拠）/);
  assert.match(head, /daily_boundary: ニューヨーク時間17時/);
  assert.match(head, /excluded: .*WTD／MTD/);
  // 形成途中の足を示す項目は無い
  assert.ok(!/"(wtd|mtd)/i.test(JSON.stringify(json)));
});

test("4: 銘柄ごとの項目 — 共通・月足・週足・日足・組み合わせ・履歴10日・欠測・本数（確定足のみ）", () => {
  const { json } = buildFeed({ asOf: ASOF, nowMs: NOW, items: itemsAll() });
  const s = json.symbols.find((x) => x.symbol === "USDCHF");
  assert.equal(s.source, "twelvedata:USD/CHF");
  assert.ok(s.price_type.length > 0);
  assert.equal(s.updated_at, "2026-10-07T06:25:00+09:00");
  for (const k of ["date", "direction", "close", "mma12", "mma24", "high_6m", "low_6m", "range_position_6m", "data_status", "bars_used"]) assert.ok(k in s.monthly, `monthly.${k}`);
  for (const k of ["date", "direction", "close", "tenkan", "kijun", "span_a", "span_b", "cloud_top", "cloud_bottom", "close_vs_cloud", "tenkan_vs_kijun", "bars_used"]) assert.ok(k in s.weekly, `weekly.${k}`);
  for (const k of ["date", "direction", "close", "dma50", "dma200", "close_vs_50dma", "close_vs_200dma", "high_20d", "low_20d", "bars_used"]) assert.ok(k in s.daily, `daily.${k}`);
  assert.ok(s.alignment_score);
  assert.ok(s.swing_status);
  assert.equal(s.history.length, 10);
  assert.deepEqual(Object.keys(s.history[0]), ["date", "close", "dma50", "dma200", "direction", "close_vs_50dma"]);
  assert.equal(s.history[9].date, ASOF);
  assert.deepEqual(s.missing_dates, []);
  assert.deepEqual(s.short_bar_days, []);
  // 確定足: 日足は基準日、週足は金曜(9/25)、月足は9月(9/30)
  assert.equal(s.daily.date, "2026-10-06");
  assert.equal(s.weekly.date, "2026-10-02"); // 最新の確定週 = 10/2 の週（10/6 は火曜で形成途中の週は出さない）
  assert.equal(s.monthly.date, "2026-09-30");
});

test("2-5: 形成途中の週・月は使わない（10/6(火)時点の週足は10/2の週、月足は9月）", () => {
  const { json } = buildFeed({ asOf: "2026-10-06", nowMs: NOW, items: itemsAll() });
  for (const s of json.symbols) {
    assert.equal(s.weekly.date, "2026-10-02");
    assert.equal(s.monthly.date, "2026-09-30");
  }
});

test("3-6: 出力の丸め — 移動平均・一目均衡表は価格の桁数+1桁、価格は桁数、位置は小数2桁。判定は丸める前の値", () => {
  const { json } = buildFeed({ asOf: ASOF, nowMs: NOW, items: itemsAll() });
  const decimals = (x) => (Number.isInteger(x) ? 0 : String(x).split(".")[1].length);
  for (const sym of SYMBOLS) {
    const s = json.symbols.find((x) => x.symbol === sym.code);
    const avg = [s.daily.dma50, s.daily.dma200, s.monthly.mma12, s.monthly.mma24, s.weekly.tenkan, s.weekly.kijun, s.weekly.span_a, s.weekly.span_b, s.weekly.cloud_top, s.weekly.cloud_bottom];
    for (const v of avg) assert.ok(decimals(v) <= sym.digits + 1, `${sym.code} 平均系 ${v}`);
    for (const v of [s.daily.close, s.daily.high_20d, s.weekly.close, s.monthly.high_6m]) assert.ok(decimals(v) <= sym.digits, `${sym.code} 価格 ${v}`);
    for (const v of [s.monthly.range_position_6m, s.daily.range_position_20d]) assert.ok(decimals(v) <= 2);
  }
  // 丸めると終値と同じに見えても、向きは丸める前の値で決まる:
  //   USDJPY(3桁)。49本が100.000、1本だけ100.001、最新が100.000 → 50DMA=100.00002 で終値が下。4桁に丸めると100.0000で同じに見える
  const dates = weekdaysFrom("2025-01-06", 230);
  const rows = mkRows(dates, (i) => (i === 228 ? 100.001 : 100));
  const { json: j2 } = buildFeed({ asOf: dates[229], nowMs: NOW, items: [{ code: "USDJPY", rows, updatedAt: "x" }] });
  const u = j2.symbols[0];
  assert.equal(u.daily.dma50, 100.0000);
  assert.equal(u.daily.close, 100);
  assert.equal(u.daily.close_vs_50dma, "Below"); // 丸め後は等しく見えるが、本当は 100.00002 > 100
  assert.equal(u.daily.close_vs_200dma, "Below");
  assert.equal(u.daily.direction, "↓");
});

test("4: 24MMA は無ければ空（null）。月足が12か月に満たなければ Insufficient Data", () => {
  const rows = scenarioRows("USDJPY", "2025-10-01", ASOF); // 約12か月
  const { json, text } = buildFeed({ asOf: ASOF, nowMs: NOW, items: [{ code: "USDJPY", rows, updatedAt: "x" }] });
  const s = json.symbols[0];
  assert.equal(s.monthly.mma24, null);
  assert.equal(s.monthly.data_status, "Partial (no 24MMA)");
  assert.match(text, /24MMA= 6M_HIGH/); // テキストでも空欄
  const few = scenarioRows("USDJPY", "2026-04-01", ASOF);
  const f = buildFeed({ asOf: ASOF, nowMs: NOW, items: [{ code: "USDJPY", rows: few, updatedAt: "x" }] }).json.symbols[0];
  assert.equal(f.monthly.data_status, "Insufficient Data");
  assert.equal(f.monthly.direction, "Insufficient Data");
  assert.equal(f.swing_status, "Insufficient Data");
  assert.equal(f.daily.dma200, null);
});

test("4/1: 欠測・本数の少ない日の一覧（無ければ『なし』）", () => {
  const withGaps = scenarioRows("EURUSD", "2026-08-03", ASOF, { skip: ["2026-09-09"], bars: (d) => (d === "2026-09-04" ? 7 : 24) });
  const { json, text } = buildFeed({ asOf: ASOF, nowMs: NOW, items: [{ code: "EURUSD", rows: withGaps, updatedAt: "x" }, { code: "XAUUSD", rows: scenarioRows("XAUUSD", "2026-08-03", ASOF, { bars: () => 23 }), updatedAt: "x" }] });
  const e = json.symbols.find((s) => s.symbol === "EURUSD");
  assert.deepEqual(e.missing_dates, ["2026-09-09"]);
  assert.deepEqual(e.short_bar_days.map((x) => [x.date, x.bars]), [["2026-09-04", 7]]);
  const x = json.symbols.find((s) => s.symbol === "XAUUSD");
  assert.deepEqual(x.short_bar_days, []); // XAUUSD は23本が標準
  assert.match(text, /MISSING_DATES.*: 2026-09-09/);
  // v1.1: 本数が少ないだけ（最後の足は16時台）の日は、テキストには件数だけ。日付は JSON
  assert.match(text, /SHORT_BAR_DAYS[^\n]*最後の1時間足がNY16時台でない日=なし \/ それ以外の本数の少ない日=1日/);
  assert.ok(!/SHORT_BAR_DAYS[^\n]*2026-09-04/.test(text));
  assert.match(text, /MISSING_DATES[^\n]*: なし/);
});

test("鮮度: 基準日に届かない銘柄は status=stale、data_base_date は最も古い日付。履歴が無い銘柄は status=error", () => {
  const items = itemsAll({
    EURGBP: { rows: scenarioRows("EURGBP", "2024-07-01", "2026-10-05") }, // 10/6 が無い
    USDCAD: { rows: null, error: "履歴CSVがありません" },
    XAUUSD: { error: "429" }, // 取得に失敗したが、これまでの履歴で計算は出す
  });
  const { json, text } = buildFeed({ asOf: ASOF, nowMs: NOW, items, attempt: 2 });
  const by = Object.fromEntries(json.symbols.map((s) => [s.symbol, s]));
  assert.equal(by.EURGBP.status, "stale");
  assert.equal(by.EURGBP.data_date, "2026-10-05");
  assert.equal(by.USDCAD.status, "error");
  assert.equal(by.USDCAD.daily, undefined);
  assert.equal(by.XAUUSD.status, "error");
  assert.equal(by.XAUUSD.error, "429");
  assert.ok(by.XAUUSD.daily);
  assert.equal(json.data_base_date, "2026-10-05");
  assert.equal(json.status, "partial");
  assert.equal(json.attempt, 2);
  assert.match(json.coverage, /6\/9/);
  assert.match(text, /status: partial/);
  assert.match(text, /## USDCAD[\s\S]*?status: error（履歴CSVがありません）/);
});

test("堅牢性: 基準日以前の日足が無い銘柄でも他の銘柄は出力される（その銘柄は status=error）", () => {
  const items = itemsAll({ USDJPY: { rows: scenarioRows("USDJPY", "2026-10-01", "2026-10-06") } });
  const { json } = buildFeed({ asOf: "2026-09-01", nowMs: NOW, items });
  assert.equal(json.symbols[0].status, "error");
  assert.match(json.symbols[0].error, /日足がありません/);
  assert.equal(json.symbols.length, 9);
});

test("堅牢性: 確定した月足・週足がまだ無い場合も、キーは残して null、テキストに NaN/undefined は出ない。updated_at が無ければ「なし」", () => {
  const rows = scenarioRows("EURUSD", "2026-10-05", "2026-10-06"); // 週も月もまだ確定していない
  const { json, text } = buildFeed({ asOf: "2026-10-06", nowMs: NOW, items: [{ code: "EURUSD", rows, updatedAt: null }] });
  const s = json.symbols.find((x) => x.symbol === "EURUSD");
  assert.equal(s.monthly.date, null);
  assert.equal(s.monthly.mma12, null);
  assert.equal(s.weekly.cloud_top, null);
  assert.equal(s.weekly.close_vs_cloud, "Insufficient Data");
  assert.equal(s.swing_status, "Insufficient Data");
  assert.match(text, /updated_at: なし/);
  assert.ok(!/NaN|undefined|null/.test(text));
});

test("3-7: 判定に使う終値の日の最後の1時間足が16時台でないとき、その行にも印を付ける（本数が少ないだけの日は付けない）", () => {
  const rows = scenarioRows("EURUSD", "2024-07-01", ASOF, { bars: (d) => (d === "2026-10-06" ? 22 : d === "2026-10-02" ? 20 : d === "2026-09-30" ? 18 : 24) })
    .map((r) => (r.date === "2026-10-06" ? { ...r, last_bar_ny: "15:00" } : r.date === "2026-10-02" ? { ...r, last_bar_ny: "14:00" } : r)); // 火曜・金曜の最終足が早い。9/30(水)は本数不足だけ
  const { json, text } = buildFeed({ asOf: ASOF, nowMs: NOW, items: [{ code: "EURUSD", rows, updatedAt: "x" }] });
  const s = json.symbols.find((x) => x.symbol === "EURUSD");
  // JSON は今のまま、どの理由でも印を付ける
  assert.deepEqual([s.daily.close_day_short_bars.date, s.daily.close_day_short_bars.bars], ["2026-10-06", 22]);
  assert.equal(s.weekly.close_day_short_bars.date, "2026-10-02");
  assert.ok(s.weekly.close_day_short_bars.reasons.includes("last_bar_not_16"));
  assert.deepEqual([s.monthly.close_day_short_bars.date, s.monthly.close_day_short_bars.reasons], ["2026-09-30", ["bars"]]);
  // テキストの行内: 最後の足が16時台でない日だけ（火曜の日足・金曜の週足）。月足(本数不足だけ)には付けない
  assert.match(text, /DAILY: [^\n]*※最後の1時間足がNY15:00開始（終値がNY17時の値になっていない。22\/24本）/);
  assert.match(text, /WEEKLY: [^\n]*※最後の1時間足がNY14:00開始/);
  assert.ok(!/MONTHLY: [^\n]*※/.test(text));
  // 正常な日には印が付かない
  const ok = buildFeed({ asOf: ASOF, nowMs: NOW, items: itemsAll() }).json.symbols.find((x) => x.symbol === "EURUSD");
  assert.equal(ok.daily.close_day_short_bars, null);
});

test("4: 見出しに、日付がNY17時区切りの日付であること・凡例を載せる。足りない値は - 、24MMAだけは仕様どおり空", () => {
  const rows = scenarioRows("USDJPY", "2025-10-01", ASOF);
  const { text } = buildFeed({ asOf: ASOF, nowMs: NOW, items: [{ code: "USDJPY", rows, updatedAt: "x" }] });
  assert.match(text, /dates: .*DATE_NY.*generated_at だけが日本時間/);
  assert.match(text, /legend: /);
  assert.match(text, /24MMA= 6M_HIGH/); // 空
  const few = buildFeed({ asOf: ASOF, nowMs: NOW, items: [{ code: "USDJPY", rows: scenarioRows("USDJPY", "2026-04-01", ASOF), updatedAt: "x" }] }).text;
  assert.match(few, /12MMA=- 24MMA= /);
  assert.match(few, /50DMA=\d/);
  assert.match(few, /200DMA=-/);
});
