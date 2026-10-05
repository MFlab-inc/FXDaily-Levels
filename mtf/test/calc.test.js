"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../lib/calc");
const { mkRows, weekdaysFrom } = require("./helpers");
const { UP, DOWN, FLAT, INSUFFICIENT } = C;

const rowsOf = (closes, start = "2025-01-06", opts) => mkRows(weekdaysFrom(start, closes.length), (i) => closes[i], opts);
const flat = (n, v) => Array(n).fill(v);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// ======================= 2-1 日足 =======================
test("2-1: 50DMA は50本から（49本は Insufficient Data）。200DMA は200本から（199本は Insufficient Data）", () => {
  const d49 = C.dailyStructure(rowsOf(flat(49, 100)));
  assert.equal(d49.dma50, null);
  assert.equal(d49.close_vs_50dma, INSUFFICIENT);
  assert.equal(d49.direction, INSUFFICIENT);
  const d50 = C.dailyStructure(rowsOf(flat(50, 100)));
  assert.equal(d50.dma50, 100);
  assert.equal(d50.dma200, null);
  assert.equal(d50.close_vs_200dma, INSUFFICIENT);
  assert.equal(d50.direction, INSUFFICIENT); // 向きは200本そろうまで出さない
  const d199 = C.dailyStructure(rowsOf(flat(199, 100)));
  assert.equal(d199.dma200, null);
  assert.equal(d199.direction, INSUFFICIENT);
  const d200 = C.dailyStructure(rowsOf(flat(200, 100)));
  assert.equal(d200.dma200, 100);
  assert.notEqual(d200.direction, INSUFFICIENT);
});

test("3-1: 「直近N本」には最新の確定足を含める（最新を除いた平均とは別の値になる）", () => {
  const closes = Array.from({ length: 60 }, (_, i) => i + 1); // 1..60
  const d = C.dailyStructure(rowsOf(closes));
  assert.equal(d.dma50, mean(closes.slice(10, 60))); // 11..60 = 35.5
  assert.equal(d.dma50, 35.5);
  assert.notEqual(d.dma50, mean(closes.slice(9, 59))); // 最新を除いた10..59 = 34.5 ではない
  const c200 = Array.from({ length: 205 }, (_, i) => i + 1);
  const d2 = C.dailyStructure(rowsOf(c200));
  assert.equal(d2.dma200, mean(c200.slice(5))); // 6..205
});

test("2-1: 古い本数は平均に入らない（50本より前の値は無関係）", () => {
  const a = C.dailyStructure(rowsOf([...flat(10, 1000), ...flat(50, 100)]));
  assert.equal(a.dma50, 100);
});

test("2-1/3-2: 終値と50DMAが等しいとき Equal（浮動小数点の誤差があっても）。向きは →", () => {
  const d = C.dailyStructure(rowsOf(flat(200, 1.1))); // 1.1 を足して割ると誤差が出うる
  assert.equal(d.close_vs_50dma, "Equal");
  assert.equal(d.close_vs_200dma, "Equal");
  assert.equal(d.direction, FLAT);
});

test("2-1/3-2: 終値が200DMAとちょうど等しく、50DMAより上のとき → は Equal / Above、向きは →", () => {
  // 199本の合計 S のとき、最新の終値 X = S/199 なら 200DMA == X
  const prior = [...flat(150, 120), ...flat(49, 80)];
  const X = prior.reduce((s, v) => s + v, 0) / 199;
  const d = C.dailyStructure(rowsOf([...prior, X]));
  assert.equal(d.close_vs_200dma, "Equal");
  assert.equal(d.close_vs_50dma, "Above"); // 直近の49本が80で低いので50DMAはXより下
  assert.equal(d.direction, FLAT);
});

test("2-1: 向き — 両方より上=↑ / 両方より下=↓ / それ以外=→", () => {
  // 上昇: 終値が両方の平均より上
  const up = C.dailyStructure(rowsOf([...flat(199, 100), 110]));
  assert.deepEqual([up.close_vs_50dma, up.close_vs_200dma, up.direction], ["Above", "Above", UP]);
  const down = C.dailyStructure(rowsOf([...flat(199, 100), 90]));
  assert.deepEqual([down.close_vs_50dma, down.close_vs_200dma, down.direction], ["Below", "Below", DOWN]);
  // 50DMAの上・200DMAの下: 昔高くて直近は低め→上がった（50日平均は低く、200日平均は高い）
  const mixed = C.dailyStructure(rowsOf([...flat(150, 200), ...flat(49, 100), 150]));
  assert.equal(mixed.close_vs_50dma, "Above");
  assert.equal(mixed.close_vs_200dma, "Below");
  assert.equal(mixed.direction, FLAT);
  // 50DMAの下・200DMAの上
  const mixed2 = C.dailyStructure(rowsOf([...flat(150, 50), ...flat(49, 200), 120]));
  assert.equal(mixed2.close_vs_50dma, "Below");
  assert.equal(mixed2.close_vs_200dma, "Above");
  assert.equal(mixed2.direction, FLAT);
});

test("2-1: 20D_HIGH/LOW は当日を含む直近20営業日。19本では出さない。21本前の値は入らない", () => {
  const dates = weekdaysFrom("2025-01-06", 25);
  const rows = dates.map((date, i) => ({ date, open: 10, high: 10 + i, low: 10 - i, close: 10, bars: 24 }));
  // 20本目まで(i=0..19)では i=19 が最大・最小の更新者
  const d = C.dailyStructure(rows.slice(0, 20));
  assert.equal(d.high_20d, 29);
  assert.equal(d.low_20d, -9);
  // 25本のとき直近20本は i=5..24: 高値の最小は 15、最大は 34。i=0..4 の値は入らない
  const d25 = C.dailyStructure(rows);
  assert.equal(d25.high_20d, 34);
  assert.equal(d25.low_20d, -14);
  // 最新日が最大を更新するとき、当日を含む
  const spike = rows.map((r, i) => (i === 24 ? { ...r, high: 500 } : r));
  assert.equal(C.dailyStructure(spike).high_20d, 500);
  // 当日の1日前に最大があって、21本前になると落ちる
  const old = rows.map((r, i) => (i === 4 ? { ...r, high: 900 } : r));
  assert.equal(C.dailyStructure(old).high_20d, 34); // i=4 は直近20本(i=5..24)の外
  assert.equal(C.dailyStructure(old.slice(0, 24)).high_20d, 900); // 24本目まででは i=4 が直近20本(i=4..23)の内
  const d19 = C.dailyStructure(rows.slice(0, 19));
  assert.equal(d19.high_20d, null);
  assert.equal(d19.range_position_20d, null);
});

test("2-1: 20D_RANGE_POSITION = (終値−安値)÷(高値−安値)×100。分母が0なら50", () => {
  const dates = weekdaysFrom("2025-01-06", 20);
  const rows = dates.map((date, i) => ({ date, open: 100, high: 110, low: 90, close: i === 19 ? 105 : 100, bars: 24 }));
  assert.equal(C.dailyStructure(rows).range_position_20d, 75); // (105-90)/(110-90)*100
  const atHigh = rows.map((r, i) => (i === 19 ? { ...r, close: 110 } : r));
  assert.equal(C.dailyStructure(atHigh).range_position_20d, 100);
  const atLow = rows.map((r, i) => (i === 19 ? { ...r, close: 90 } : r));
  assert.equal(C.dailyStructure(atLow).range_position_20d, 0);
  const zero = dates.map((date) => ({ date, open: 1.1, high: 1.1, low: 1.1, close: 1.1, bars: 24 }));
  assert.equal(C.dailyStructure(zero).range_position_20d, 50); // 高値==安値（分母0）
});

// ======================= 2-2 週足 =======================
const wk = (i, high, low, close) => ({ key: `w${String(i).padStart(3, "0")}`, end_date: `d${i}`, high, low, close: close ?? (high + low) / 2, days: 5 });
const weeksLinear = (n, close) => Array.from({ length: n }, (_, i) => wk(i, 100 + i, 90 + i, i === n - 1 ? close : undefined));

test("2-2: 一目均衡表の値（9週・26週・52週）の計算 — 先行スパンは未来にずらさない", () => {
  const w = C.weeklyStructure(weeksLinear(52, 150));
  assert.equal(w.tenkan, ((100 + 51) + (90 + 43)) / 2); // 直近9週 i=43..51
  assert.equal(w.kijun, ((100 + 51) + (90 + 26)) / 2); // 直近26週 i=26..51
  assert.equal(w.span_a, (w.tenkan + w.kijun) / 2);
  assert.equal(w.span_b, ((100 + 51) + 90) / 2); // 52週 i=0..51
  assert.equal(w.cloud_top, Math.max(w.span_a, w.span_b));
  assert.equal(w.cloud_bottom, Math.min(w.span_a, w.span_b));
  assert.equal(w.high_20w, 100 + 51);
  assert.equal(w.low_20w, 90 + 32);
  assert.equal(w.close_vs_cloud, "Above Cloud");
  assert.equal(w.tenkan_vs_kijun, "Bullish TK");
  assert.equal(w.direction, UP);
});

test("2-2: 本数の境界 — 8週/9週・25週/26週・51週/52週・19週/20週", () => {
  const at = (n) => C.weeklyStructure(weeksLinear(n, 100));
  assert.equal(at(8).tenkan, null);
  assert.notEqual(at(9).tenkan, null);
  assert.equal(at(25).kijun, null);
  assert.equal(at(25).tenkan_vs_kijun, INSUFFICIENT);
  assert.notEqual(at(26).kijun, null);
  assert.equal(at(26).span_a !== null, true);
  assert.equal(at(26).span_b, null);
  assert.equal(at(26).close_vs_cloud, INSUFFICIENT);
  assert.equal(at(51).span_b, null);
  assert.equal(at(51).direction, INSUFFICIENT);
  assert.equal(at(52).span_b !== null, true);
  assert.notEqual(at(52).direction, INSUFFICIENT);
  assert.equal(at(19).high_20w, null);
  assert.notEqual(at(20).high_20w, null);
});

test("2-2: 終値が雲の上限・下限にちょうど等しいときは In Cloud。TenkanとKijunが等しいと Neutral TK で向きは →", () => {
  // 全週が同じ高安 → Tenkan=Kijun=A=B
  const flatWeeks = (close) => Array.from({ length: 52 }, (_, i) => wk(i, 110, 90, i === 51 ? close : 100));
  const eqTop = C.weeklyStructure(flatWeeks(100)); // 雲 = 100（上限=下限）
  assert.equal(eqTop.cloud_top, 100);
  assert.equal(eqTop.close_vs_cloud, "In Cloud");
  assert.equal(eqTop.tenkan_vs_kijun, "Neutral TK");
  assert.equal(eqTop.direction, FLAT);
  assert.equal(C.weeklyStructure(flatWeeks(100.001)).close_vs_cloud, "Above Cloud");
  assert.equal(C.weeklyStructure(flatWeeks(99.999)).close_vs_cloud, "Below Cloud");
  // 上抜けしていても Tenkan=Kijun なら → （「かつ Tenkan>Kijun」を満たさない）
  assert.equal(C.weeklyStructure(flatWeeks(105)).direction, FLAT);
});

test("2-2: 雲の上でも Tenkan<Kijun なら →。雲の下で Tenkan<Kijun なら ↓", () => {
  // 52週: 古い側が高く、最近が安い → 下降。最後に急反発して Tenkan>Kijun にはならない
  const down = Array.from({ length: 52 }, (_, i) => wk(i, 200 - i, 190 - i, 100));
  const d = C.weeklyStructure(down.map((w, i) => (i === 51 ? { ...w, close: 100 } : w)));
  assert.equal(d.tenkan_vs_kijun, "Bearish TK");
  assert.equal(d.close_vs_cloud, "Below Cloud");
  assert.equal(d.direction, DOWN);
  // 雲の上にいるが Bearish TK: 直近9週だけが下がって、26週平均より Tenkan が低い
  const mixed = Array.from({ length: 52 }, (_, i) => (i >= 43 ? wk(i, 150, 100, 130) : wk(i, 200, 150, 175)));
  const m = C.weeklyStructure(mixed.map((w, i) => (i === 51 ? { ...w, close: 400 } : w)));
  assert.equal(m.tenkan_vs_kijun, "Bearish TK");
  assert.equal(m.close_vs_cloud, "Above Cloud");
  assert.equal(m.direction, FLAT);
});

test("3-8/2-2: 週のまとめ方 — キーはその週の金曜日、月をまたぐ週（8/31(月)〜9/4(金)）は1つの週", () => {
  const rows = mkRows(["2026-08-28", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07"], (i) => 100 + i);
  const weeks = C.buildWeeks(rows);
  assert.deepEqual(weeks.map((w) => [w.key, w.end_date, w.days]), [
    ["2026-08-28", "2026-08-28", 1],
    ["2026-09-04", "2026-09-04", 5],
    ["2026-09-11", "2026-09-07", 1],
  ]);
  const wk2 = weeks[1];
  assert.equal(wk2.close, 105); // 最後の営業日(9/4)の終値
  assert.equal(wk2.high, 105.5);
  assert.equal(wk2.low, 100.5); // 8/31 の安値（月をまたいで同じ週に入る）
  // 月のほうは暦の月で別々にまとめる（8/31 は8月、9/1〜 は9月）
  const months = C.buildMonths(rows);
  assert.deepEqual(months.map((m) => [m.key, m.days, m.end_date]), [["2026-08", 2, "2026-08-31"], ["2026-09", 5, "2026-09-07"]]);
});

test("2-2: 金曜に足が無い週（祝日）の WEEK_END_DATE は、データのある最後の営業日", () => {
  const rows = mkRows(["2026-12-21", "2026-12-22", "2026-12-23", "2026-12-24"], (i) => 100 + i); // 12/25(金)なし
  const [w] = C.buildWeeks(rows);
  assert.equal(w.key, "2026-12-25");
  assert.equal(w.end_date, "2026-12-24");
  assert.equal(w.close, 103);
});

// ======================= 2-3 月足 =======================
const mo = (i, high, low, close) => ({ key: `m${String(i).padStart(3, "0")}`, end_date: `e${i}`, high, low, close, days: 20 });

test("3-4: 月の確定は、その月の最後の平日(月〜金)の終了時。月末が週末なら直前の金曜", () => {
  assert.equal(C.lastWeekdayOfMonth("2026-10"), "2026-10-30"); // 10/31 は土曜
  assert.equal(C.lastWeekdayOfMonth("2026-05"), "2026-05-29"); // 5/31 は日曜
  assert.equal(C.lastWeekdayOfMonth("2026-08"), "2026-08-31"); // 月曜
  assert.equal(C.lastWeekdayOfMonth("2026-09"), "2026-09-30"); // 水曜
  assert.equal(C.lastWeekdayOfMonth("2024-02"), "2024-02-29"); // うるう年
  assert.equal(C.lastWeekdayOfMonth("2026-12"), "2026-12-31");
});

// 月足の確定判定を、日足から通して確かめるための行（2026-06-01 から 2026-10-30 まで）
const octRows = () => mkRows(weekdaysFrom("2026-06-01", 110).filter((d) => d <= "2026-10-30"), (i) => 100 + i);

test("3-4/2-5: 月末が週末のとき（10/31(土)）、10/29 までは10月は未確定、10/30(金)の終値で確定", () => {
  const rows = octRows();
  const at = (asOf) => C.computeStructure(rows, { asOf }).monthly;
  assert.equal(at("2026-10-29").month, "2026-09"); // 10月はまだ形成途中(MTD)
  assert.equal(at("2026-10-30").month, "2026-10");
  assert.equal(at("2026-10-30").date, "2026-10-30");
});

test("3-4: 9/30(水)の終値で9月が確定。9/29までは8月が最新の確定月（5-1の 9/25→8月、10/2→9月）", () => {
  const rows = mkRows(weekdaysFrom("2026-06-01", 200), (i) => 100 + i);
  const at = (asOf) => C.computeStructure(rows, { asOf }).monthly;
  assert.equal(at("2026-09-25").month, "2026-08");
  assert.equal(at("2026-09-29").month, "2026-08");
  assert.equal(at("2026-09-30").month, "2026-09");
  assert.equal(at("2026-10-02").month, "2026-09");
});

test("3-4: 月末の最後の平日に足が無くても（欠測）、その日を過ぎれば確定。MONTH_END_DATE はデータのある最後の営業日", () => {
  const rows = mkRows(weekdaysFrom("2026-06-01", 110).filter((d) => d <= "2026-10-29"), (i) => 100 + i); // 10/30 の足なし
  const m = C.computeStructure(rows, { asOf: "2026-10-30" }).monthly;
  assert.equal(m.month, "2026-10");
  assert.equal(m.date, "2026-10-29");
});

test("2-3: 12MMA・24MMA・6M の範囲、本数の境界とDATA_STATUS（11/12/23/24か月）", () => {
  const months = (n) => Array.from({ length: n }, (_, i) => mo(i, 100 + i, 90 + i, 95 + i));
  const s11 = C.monthlyStructure(months(11));
  assert.equal(s11.data_status, "Insufficient Data");
  assert.equal(s11.mma12, null);
  assert.equal(s11.direction, INSUFFICIENT);
  const s12 = C.monthlyStructure(months(12));
  assert.equal(s12.data_status, "Partial (no 24MMA)");
  assert.equal(s12.mma12, mean(Array.from({ length: 12 }, (_, i) => 95 + i)));
  assert.equal(s12.mma24, null);
  assert.notEqual(s12.direction, INSUFFICIENT);
  const s23 = C.monthlyStructure(months(23));
  assert.equal(s23.data_status, "Partial (no 24MMA)");
  assert.equal(s23.mma24, null);
  const s24 = C.monthlyStructure(months(24));
  assert.equal(s24.data_status, "OK");
  assert.equal(s24.mma24, mean(Array.from({ length: 24 }, (_, i) => 95 + i)));
  assert.equal(s24.mma12, mean(Array.from({ length: 12 }, (_, i) => 95 + 12 + i))); // 直近12か月（最新を含む）
  // 6M: 直近6か月の高安（最新を含み、7か月前は含まない）
  assert.equal(s24.high_6m, 100 + 23);
  assert.equal(s24.low_6m, 90 + 18);
  assert.equal(s24.key_support, s24.low_6m);
  assert.equal(s24.key_resistance, s24.high_6m);
  assert.equal(C.monthlyStructure(months(5)).high_6m, null);
  assert.notEqual(C.monthlyStructure(months(6)).high_6m, null);
});

// 直近6か月の高安が 100〜200、12MMA が小さくなる月足（最新の終値 = close）
function monthsWithClose(close, { low = 100, high = 200 } = {}) {
  const ms = Array.from({ length: 12 }, (_, i) => mo(i, 150, 140, 120));
  ms[8] = mo(8, high, 150, 120);
  ms[9] = mo(9, 150, low, 120);
  ms[11] = mo(11, 150, 140, close);
  return ms;
}

test("2-3: MONTHLY_DIRECTION — RANGE_POSITION が60ちょうど/59.99、40ちょうど/40.01 の境界", () => {
  const dir = (close) => C.monthlyStructure(monthsWithClose(close));
  const up60 = dir(160); // RP = 60 ちょうど、終値 > 12MMA
  assert.equal(up60.range_position_6m, 60);
  assert.equal(up60.direction, UP);
  assert.equal(dir(159.99).direction, FLAT);
  // 終値 < 12MMA で RP が ≤ 40
  const down = (close) => {
    const ms = Array.from({ length: 12 }, (_, i) => mo(i, 150, 140, 180)); // 12MMA が高い
    ms[8] = mo(8, 200, 150, 180);
    ms[9] = mo(9, 150, 100, 180);
    ms[11] = mo(11, 150, 140, close);
    return C.monthlyStructure(ms);
  };
  assert.equal(down(140).range_position_6m, 40);
  assert.equal(down(140).direction, DOWN); // 40ちょうどは ↓
  assert.equal(down(140.01).direction, FLAT);
  assert.equal(down(100).direction, DOWN);
});

test("2-3/3-6: RANGE_POSITION が小数で60ちょうど（浮動小数点の誤差があっても ↑）", () => {
  // (1.16-1.10)/(1.20-1.10)*100 は 60 にならない（59.99999999999996 など）
  const raw = ((1.16 - 1.1) / (1.2 - 1.1)) * 100;
  assert.notEqual(raw, 60);
  const ms = Array.from({ length: 12 }, (_, i) => mo(i, 1.15, 1.12, 1.1));
  ms[8] = mo(8, 1.2, 1.12, 1.1); // 6か月の高値 1.2
  ms[9] = mo(9, 1.15, 1.1, 1.1); // 6か月の安値 1.1
  ms[11] = mo(11, 1.15, 1.12, 1.16); // 終値 1.16（12MMA は約1.105）
  const s = C.monthlyStructure(ms);
  assert.ok(Math.abs(s.range_position_6m - 60) < 1e-9);
  assert.equal(s.direction, UP);
  // 同じ構成で下側（40ちょうど）: 終値 1.14 かつ 12MMA を高くする
  const dn = Array.from({ length: 12 }, (_, i) => mo(i, 1.15, 1.12, 1.19));
  dn[8] = mo(8, 1.2, 1.12, 1.19);
  dn[9] = mo(9, 1.15, 1.1, 1.19);
  dn[11] = mo(11, 1.15, 1.12, 1.14);
  const d = C.monthlyStructure(dn);
  assert.ok(Math.abs(d.range_position_6m - 40) < 1e-9);
  assert.equal(d.direction, DOWN);
});

test("2-3: 終値が 12MMA とちょうど等しいときは →（RANGE_POSITION が高くても）", () => {
  const ms = Array.from({ length: 12 }, (_, i) => mo(i, 200, 100, 150));
  ms[11] = mo(11, 200, 100, 150); // 全て150 → 12MMA = 150 = 終値、RP = 50
  const s = C.monthlyStructure(ms);
  assert.equal(s.mma12, 150);
  assert.equal(s.direction, FLAT);
  const ms2 = ms.map((m, i) => (i === 11 ? { ...m, close: 200 } : { ...m, close: 150 }));
  // 12MMA = (11*150+200)/12 = 154.166.. → 終値200 > 12MMA、RP=100 → ↑
  assert.equal(C.monthlyStructure(ms2).direction, UP);
});

test("3-3: 6M_RANGE_POSITION の分母が0（6か月の高値=安値）なら50、向きは →", () => {
  const ms = Array.from({ length: 12 }, (_, i) => mo(i, 1.1, 1.1, 1.1));
  const s = C.monthlyStructure(ms);
  assert.equal(s.range_position_6m, 50);
  assert.equal(s.direction, FLAT); // 終値 = 12MMA でもあり、RP=50 で ↑↓ の条件を満たさない
});

// ======================= 2-4 組み合わせ =======================
test("3-5: ALIGNMENT_SCORE — ↑と↓だけを数え、→は数えない", () => {
  const A = C.alignmentScore;
  assert.equal(A(DOWN, FLAT, DOWN), "2/3 Down");
  assert.equal(A(FLAT, FLAT, DOWN), "1/3 Down");
  assert.equal(A(UP, FLAT, DOWN), "Mixed");
  assert.equal(A(UP, UP, UP), "3/3 Up");
  assert.equal(A(DOWN, DOWN, DOWN), "3/3 Down");
  assert.equal(A(FLAT, FLAT, FLAT), "0/3");
  assert.equal(A(UP, DOWN, FLAT), "Mixed");
  assert.equal(A(UP, UP, DOWN), "2/3 Up");
  assert.equal(A(DOWN, UP, DOWN), "2/3 Down");
  assert.equal(A(FLAT, UP, FLAT), "1/3 Up");
  assert.equal(A(INSUFFICIENT, UP, UP), INSUFFICIENT);
});

test("2-4: SWING_STATUS — 3×3×3=27通り（月・週・日）", () => {
  const D = [UP, DOWN, FLAT];
  const expect = (m, w, d) => {
    if (m === UP && w === UP && d === UP) return "Swing Main Candidate";
    if (m === DOWN && w === DOWN && d === DOWN) return "Swing Main Candidate";
    if (w === d && w !== FLAT && m !== w && m !== FLAT) return "Counter-trend Caution";
    if (w === d && w !== FLAT) return "Conditional Swing Candidate"; // 月が →
    if ((m === w && m !== FLAT) || (m === d && m !== FLAT)) return "Conditional Swing Candidate";
    return "No Swing / Excluded";
  };
  let n = 0;
  for (const m of D) for (const w of D) for (const d of D) {
    assert.equal(C.swingStatus(m, w, d), expect(m, w, d), `${m}${w}${d}`);
    n++;
  }
  assert.equal(n, 27);
  // 5-1 の期待値（10/2時点）
  assert.equal(C.swingStatus(FLAT, FLAT, DOWN), "No Swing / Excluded"); // USDJPY, AUDUSD
  assert.equal(C.swingStatus(DOWN, DOWN, DOWN), "Swing Main Candidate"); // EURUSD, EURJPY
  assert.equal(C.swingStatus(DOWN, FLAT, DOWN), "Conditional Swing Candidate"); // GBPUSD
  // 個別: 週・日が↓↓で月が↑ → Counter-trend Caution、月が→ → Conditional
  assert.equal(C.swingStatus(UP, DOWN, DOWN), "Counter-trend Caution");
  assert.equal(C.swingStatus(DOWN, UP, UP), "Counter-trend Caution");
  assert.equal(C.swingStatus(FLAT, DOWN, DOWN), "Conditional Swing Candidate");
  assert.equal(C.swingStatus(UP, UP, DOWN), "Conditional Swing Candidate"); // 月と週が一致
  assert.equal(C.swingStatus(UP, DOWN, UP), "Conditional Swing Candidate"); // 月と日が一致
  assert.equal(C.swingStatus(UP, DOWN, FLAT), "No Swing / Excluded");
});

test("2-4: どれかの向きが本数不足なら SWING_STATUS は Insufficient Data（他の条件より先に当てはめる）", () => {
  assert.equal(C.swingStatus(INSUFFICIENT, UP, UP), "Insufficient Data");
  assert.equal(C.swingStatus(UP, INSUFFICIENT, UP), "Insufficient Data");
  assert.equal(C.swingStatus(DOWN, DOWN, INSUFFICIENT), "Insufficient Data");
});

// ======================= 2-5 確定足だけで判定 =======================
test("2-5: 具体例 — 2026-09-30(水) 時点の週足は 9/25 の週、10/2(金) 時点は 10/2 の週", () => {
  const rows = mkRows(weekdaysFrom("2025-01-06", 500).filter((d) => d <= "2026-10-02"), (i) => 100 + i);
  const w930 = C.computeStructure(rows, { asOf: "2026-09-30" }).weekly;
  assert.equal(w930.week_key, "2026-09-25");
  const w1002 = C.computeStructure(rows, { asOf: "2026-10-02" }).weekly;
  assert.equal(w1002.week_key, "2026-10-02");
  assert.equal(w1002.date, "2026-10-02");
  // 日足は asOf までの最新、asOf より後の行は無視する
  assert.equal(C.computeStructure(rows, { asOf: "2026-09-30" }).daily.date, "2026-09-30");
});

test("2-5: 金曜(2026-12-25)が休場で足が無い週でも、基準日が金曜なら確定扱い。WEEK_END_DATE は木曜", () => {
  const rows = mkRows(weekdaysFrom("2026-06-01", 200).filter((d) => d <= "2026-12-24"), (i) => 100 + i);
  const r = C.computeStructure(rows, { asOf: "2026-12-25" });
  assert.equal(r.weekly.week_key, "2026-12-25");
  assert.equal(r.weekly.date, "2026-12-24");
  // 基準日が木曜のままなら、金曜がまだ来ていないので1つ前の週
  const r2 = C.computeStructure(rows, { asOf: "2026-12-24" });
  assert.equal(r2.weekly.week_key, "2026-12-18");
});

// ======================= 履歴・欠測・本数 =======================
test("4: 直近10営業日の履歴（各日時点の50DMA・200DMA・向き・CLOSE_vs_50DMA）", () => {
  const rows = rowsOf(Array.from({ length: 260 }, (_, i) => 100 + i * 0.1));
  const h = C.dailyHistory(rows, 10);
  assert.equal(h.length, 10);
  assert.equal(h[9].date, rows[259].date);
  // 各日の値は、その日までの行だけで計算した値と一致（未来の行を使わない）
  const at = C.dailyStructure(rows.slice(0, 255));
  assert.equal(h[4].dma50, at.dma50);
  assert.equal(h[4].direction, at.direction);
  assert.equal(C.dailyHistory(rows.slice(0, 4), 10).length, 4);
  assert.equal(C.dailyHistory(rows.slice(0, 40), 10)[9].dma50, null);
});

test("1: 欠測 — 平日で足が無い日だけを列挙（土日は欠測ではない）。0や前日値で埋めない", () => {
  const all = weekdaysFrom("2026-09-21", 10); // 9/21(月)〜10/2(金)
  const rows = mkRows(all.filter((d) => d !== "2026-09-24" && d !== "2026-10-01"), (i) => 100 + i);
  assert.deepEqual(C.missingWeekdays(rows), ["2026-09-24", "2026-10-01"]);
  assert.deepEqual(C.missingWeekdays(rows.filter((r) => r.date !== "2026-10-02"), "2026-10-02"), ["2026-09-24", "2026-10-01", "2026-10-02"]); // 末尾の欠け（基準日まで）
  assert.deepEqual(C.missingWeekdays(mkRows(all, (i) => i)), []);
  assert.deepEqual(C.missingWeekdays([]), []);
  // 欠測の日を埋めずに計算する: 50日平均は「ある日だけ」の50本
  const sparse = rowsOf(Array.from({ length: 60 }, (_, i) => i + 1)).filter((_, i) => i !== 55);
  assert.equal(sparse.length, 59);
  assert.equal(C.dailyStructure(sparse).dma50, mean(sparse.slice(9).map((r) => r.close)));
});

test("3-7: 本数の少ない日に印を付ける — FX は24本、XAUUSD は23本が標準。補わない", () => {
  const dates = ["2026-10-05", "2026-10-06", "2026-10-07"]; // 月火水
  const rows = mkRows(dates, () => 100).map((r, i) => ({ ...r, bars: [24, 23, 7][i] }));
  const fx = C.shortBarDays(rows, 24);
  assert.deepEqual(fx.map((x) => [x.date, x.bars]), [["2026-10-06", 23], ["2026-10-07", 7]]);
  const xau = C.shortBarDays(rows, 23);
  assert.deepEqual(xau.map((x) => [x.date, x.bars]), [["2026-10-07", 7]]);
  assert.equal(C.shortBarDays(mkRows(dates, () => 1, { bars: 22 }), 23).length, 3);
});

test("3-7: 金曜の日足で最後の1時間足がNY16時台より前に始まっていれば、本数が足りていても印を付ける", () => {
  const rows = [
    { date: "2026-10-01", open: 1, high: 1, low: 1, close: 1, bars: 24, last_bar_ny: "15:00" }, // 木曜は対象外
    { date: "2026-10-02", open: 1, high: 1, low: 1, close: 1, bars: 24, last_bar_ny: "15:00" }, // 金曜・16時前
    { date: "2026-10-09", open: 1, high: 1, low: 1, close: 1, bars: 24, last_bar_ny: "16:00" }, // 金曜・16時台 → 正常
    { date: "2026-10-16", open: 1, high: 1, low: 1, close: 1, bars: 22, last_bar_ny: "14:00" }, // 本数も不足
  ];
  const s = C.shortBarDays(rows, 24);
  assert.deepEqual(s.map((x) => [x.date, x.reasons]), [
    ["2026-10-02", ["friday_last_bar_before_16"]],
    ["2026-10-16", ["bars", "friday_last_bar_before_16"]],
  ]);
});

test("計算: 履歴が空なら null。基準日より後の行は使わない", () => {
  assert.equal(C.computeStructure([]), null);
  assert.equal(C.computeStructure(rowsOf([1, 2, 3]), { asOf: "2000-01-01" }), null);
});
