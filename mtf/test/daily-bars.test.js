"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateHourlyToNyDaily } = require("../lib/daily-bars");
const { sessionHourBars, nyToUtcMs } = require("./helpers");
const { isoDatetime, HR } = require("../lib/ny-time");

const row = (date, o, h, l, c, extra = {}) => ({ date, open: o, high: h, low: l, close: c, ...extra });

// 仕様 1-1: NY現地の開始時刻に7時間を足した日付が DATE_NY（NY17時区切り）

test("1-1: 夏時間(EDT)・冬時間(EST)のどちらでも、NY17時で日が切り替わる", () => {
  // 2026-07-14(火)=夏時間、2026-12-15(火)=冬時間
  for (const date of ["2026-07-14", "2026-12-15"]) {
    const bars = sessionHourBars(date, { open: 1, high: 3, low: 0.5, close: 2 });
    const next = sessionHourBars(date.replace(/-(\d\d)$/, (_, d) => "-" + String(+d + 1).padStart(2, "0")), { open: 2, high: 2.5, low: 1.5, close: 2.2 });
    const r = aggregateHourlyToNyDaily([...bars, ...next], { dropLeftEdge: false });
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows[0], { date, open: 1, high: 3, low: 0.5, close: 2, bars: 24, last_bar_ny: "16:00" });
  }
});

test("1-1: 日曜夜(NY17時以降)の足は月曜の日足に入る", () => {
  // 2026-10-05(月)のセッションは 10/4(日)17:00 NY から
  const bars = sessionHourBars("2026-10-05", { open: 1, high: 2, low: 0.5, close: 1.5 });
  const sunEvening = bars[0]; // 日曜17:00 NY
  const r = aggregateHourlyToNyDaily(bars, { dropLeftEdge: false });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].date, "2026-10-05");
  assert.equal(r.rows[0].open, sunEvening.open);
  assert.equal(r.rows[0].bars, 24);
});

test("1-1: 土日の DATE_NY になる足は捨てる（金曜17時以降・土曜・日曜の開場前）", () => {
  const fri = sessionHourBars("2026-10-02", { open: 1, high: 2, low: 0.5, close: 1.5 });
  const weekend = [];
  // 金曜17:00 NY 〜 日曜16:00 NY まで平らな足（実APIが返す週末の足）
  const sat0 = nyToUtcMs(Date.parse("2026-10-02T17:00:00Z"));
  for (let k = 0; k < 47; k++) weekend.push({ datetime: isoDatetime(sat0 + k * HR), open: 9, high: 9, low: 9, close: 9 });
  const mon = sessionHourBars("2026-10-05", { open: 1.5, high: 2, low: 1, close: 1.8 });
  const r = aggregateHourlyToNyDaily([...fri, ...weekend, ...mon], { dropLeftEdge: false });
  assert.deepEqual(r.rows.map((x) => x.date), ["2026-10-02", "2026-10-05"]);
  assert.equal(r.weekendBars, 47);
  assert.equal(r.rows[0].close, 1.5); // 週末の足(9)が金曜の終値を汚さない
  assert.equal(r.rows[1].bars, 24);
});

test("1-1: 始値は最初の足・終値は最後の足・高値安値は最大最小（入力順に依存しない）", () => {
  const bars = sessionHourBars("2026-10-06", { open: 10, high: 15, low: 5, close: 12 });
  const shuffled = [...bars].reverse(); // 新しい順で来ても同じ
  const r = aggregateHourlyToNyDaily(shuffled, { dropLeftEdge: false });
  assert.deepEqual([r.rows[0].open, r.rows[0].high, r.rows[0].low, r.rows[0].close], [10, 15, 5, 12]);
});

test("1-1: 取得範囲の左端の日は途中からしか足が無いので捨てる（9/4の例: 18本しか無い日）", () => {
  const d1 = sessionHourBars("2026-09-04", { open: 1, high: 9, low: 0.1, close: 2, nBars: 24, skipFirst: 6 }); // 18本
  const d2 = sessionHourBars("2026-09-07", { open: 2, high: 3, low: 1, close: 2.5 });
  const dropped = aggregateHourlyToNyDaily([...d1, ...d2]);
  assert.deepEqual(dropped.rows.map((r) => r.date), ["2026-09-07"]);
  assert.equal(dropped.leftEdgeDropped, "2026-09-04");
  const kept = aggregateHourlyToNyDaily([...d1, ...d2], { dropLeftEdge: false });
  assert.equal(kept.rows[0].bars, 18); // 捨てなければ18本で残ってしまう
});

test("1-1: 先頭の足が週末なら、その次の平日は完全な日なので捨てない", () => {
  const sat = { datetime: "2026-10-03 03:00:00", open: 9, high: 9, low: 9, close: 9 };
  const mon = sessionHourBars("2026-10-05", { open: 1, high: 2, low: 0.5, close: 1.5 });
  const r = aggregateHourlyToNyDaily([sat, ...mon]);
  assert.deepEqual(r.rows.map((x) => x.date), ["2026-10-05"]);
  assert.equal(r.leftEdgeDropped, null);
});

test("3-7: 本数の少ない日は補わずに、そのまま本数を持った日足にする（XAUUSDの23本・祝日の短縮など）", () => {
  const a = sessionHourBars("2026-12-23", { open: 1, high: 2, low: 0.5, close: 1.5 });
  const short = sessionHourBars("2026-12-24", { open: 1.5, high: 2, low: 1, close: 1.8, nBars: 7 });
  const c = sessionHourBars("2026-12-25", { open: 1.8, high: 2, low: 1.7, close: 1.9 });
  const r = aggregateHourlyToNyDaily([...a, ...short, ...c]);
  assert.deepEqual(r.rows.map((x) => [x.date, x.bars]), [["2026-12-24", 7], ["2026-12-25", 24]]);
});

test("3-7: 金曜の最終足の開始時刻(NY)を記録する（16:00 より前なら印を付けるための材料）", () => {
  const thu = sessionHourBars("2026-10-01", { open: 1, high: 2, low: 0.5, close: 1.5 });
  const fri = sessionHourBars("2026-10-02", { open: 1.5, high: 2, low: 1, close: 1.8, nBars: 22 }); // 最後の2時間が欠け → 最終足は14:00
  const r = aggregateHourlyToNyDaily([...thu, ...fri], { dropLeftEdge: false });
  assert.equal(r.rows[0].last_bar_ny, "16:00");
  assert.equal(r.rows[1].last_bar_ny, "14:00");
  assert.equal(r.rows[1].bars, 22);
});

test("確定していない日（cutoffDate より後）は含めない・同じ時刻の重複足は1本にまとめる", () => {
  const a = sessionHourBars("2026-10-06", { open: 1, high: 2, low: 0.5, close: 1.5 });
  const b = sessionHourBars("2026-10-07", { open: 1.5, high: 2, low: 1, close: 1.8, nBars: 5 }); // 形成途中
  const dup = [...a, a[3], a[3]];
  const r = aggregateHourlyToNyDaily([...dup, ...b], { dropLeftEdge: false, cutoffDate: "2026-10-06" });
  assert.deepEqual(r.rows.map((x) => [x.date, x.bars]), [["2026-10-06", 24]]);
});
