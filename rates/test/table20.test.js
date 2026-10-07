"use strict";
/**
 * 調査（2026-10-07）の「直近20営業日の表」を、フィードの計算で再現できることの確認。
 * 表の出所：swing-flow の out/rates_survey_20261007.md「しきい値別の判定（直近20営業日）」。
 * 列：日付, 米2年, 日2年, 金利差, 米2年5日差(bp), 日2年5日差(bp), 金利差5日差(bp), 5bpの判定, 10bpの判定, 15bpの判定
 * 判定の規則：金利差の5営業日差が −しきい値bp 以下なら円高方向、+しきい値bp 以上なら円安方向、その間ははっきりしない。
 * 元になる実データは rates/test/fixtures/（米財務省CSV・XML、財務省の国債金利情報、いずれも実ファイルから切り出し）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSnapshot } = require("../lib/snapshot");
const C = require("../lib/calc");
const cal = require("../lib/calendar");
const H = require("./helpers");
const { addDays } = require("../../mtf/lib/ny-time");

const EXPECTED = [
  ["2026-09-03", "4.34", "1.850", "+2.490", "+14.0", "+15.4", "-1.4", "はっきりしない", "はっきりしない", "はっきりしない"],
  ["2026-09-04", "4.37", "1.830", "+2.540", "+3.0", "+11.1", "-8.1", "円高方向", "はっきりしない", "はっきりしない"],
  ["2026-09-08", "4.39", "1.848", "+2.542", "+5.0", "+4.6", "-5.5", "円高方向", "はっきりしない", "はっきりしない"],
  ["2026-09-09", "4.43", "1.833", "+2.597", "+4.0", "-2.1", "+0.9", "はっきりしない", "はっきりしない", "はっきりしない"],
  ["2026-09-10", "4.56", "1.823", "+2.737", "+17.0", "-2.7", "+20.1", "円安方向", "円安方向", "円安方向"],
  ["2026-09-11", "4.63", "1.844", "+2.786", "+29.0", "+1.4", "+29.6", "円安方向", "円安方向", "円安方向"],
  ["2026-09-14", "4.65", "1.841", "+2.809", "+28.0", "-1.1", "+26.9", "円安方向", "円安方向", "円安方向"],
  ["2026-09-15", "4.67", "1.861", "+2.809", "+28.0", "+1.3", "+26.7", "円安方向", "円安方向", "円安方向"],
  ["2026-09-16", "4.74", "1.852", "+2.888", "+31.0", "+1.9", "+29.1", "円安方向", "円安方向", "円安方向"],
  ["2026-09-17", "4.67", "1.868", "+2.802", "+11.0", "+4.5", "+6.5", "円安方向", "はっきりしない", "はっきりしない"],
  ["2026-09-18", "4.76", "1.849", "+2.911", "+13.0", "+0.5", "+12.5", "円安方向", "円安方向", "はっきりしない"],
  ["2026-09-24", "4.87", "1.912", "+2.958", "+20.0", "+7.1", "+14.9", "円安方向", "円安方向", "はっきりしない"],
  ["2026-09-25", "4.81", "1.948", "+2.862", "+5.0", "+8.7", "+5.3", "円安方向", "はっきりしない", "はっきりしない"],
  ["2026-09-28", "4.92", "1.981", "+2.939", "+16.0", "+12.9", "+5.1", "円安方向", "はっきりしない", "はっきりしない"],
  ["2026-09-29", "4.89", "1.976", "+2.914", "+18.0", "+10.8", "+11.2", "円安方向", "円安方向", "はっきりしない"],
  ["2026-09-30", "4.88", "1.952", "+2.928", "+3.0", "+10.3", "+1.7", "はっきりしない", "はっきりしない", "はっきりしない"],
  ["2026-10-01", "4.78", "1.939", "+2.841", "-9.0", "+2.7", "-11.7", "円高方向", "円高方向", "はっきりしない"],
  ["2026-10-02", "4.83", "1.919", "+2.911", "+2.0", "-2.9", "+4.9", "はっきりしない", "はっきりしない", "はっきりしない"],
  ["2026-10-05", "4.84", "1.909", "+2.931", "-8.0", "-7.2", "-0.8", "はっきりしない", "はっきりしない", "はっきりしない"],
  ["2026-10-06", "4.79", "1.930", "+2.860", "-10.0", "-4.6", "-5.4", "円高方向", "はっきりしない", "はっきりしない"],
];

const holidays = H.holidays();
const us = H.usRows(), usXml = H.usXmlRows(), jp = H.jpRows();
const fmt = (m, digits, signed) => C.fmtMilli(m, digits, signed);

// 日付 D の値が「最新」になる時点：D の次の日本の営業日の10:00（日2年は翌営業日9:30頃に公表）
const nextJpBusinessDay = (d) => {
  let n = addDays(d, 1);
  while (!cal.isJpBusinessDay(n, holidays)) n = addDays(n, 1);
  return n;
};

test("表の20日ぶん：金利差・5営業日差・判定（5/10/15bp）が、計算（calc）で表と一致する", () => {
  const sp = C.spreadSeries(us, jp);
  for (const [date, us2, jp2, spread, u5, j5, s5, l5, l10, l15] of EXPECTED) {
    const upto = (rows) => rows.filter((r) => r.date <= date);
    const series = upto(sp);
    assert.equal(series[series.length - 1].date, date, `${date} は金利差の営業日`);
    assert.equal(fmt(C.valued(us).find((r) => r.date === date).milli, 2), us2, `${date} 米2年`);
    assert.equal(fmt(C.valued(jp).find((r) => r.date === date).milli, 3), jp2, `${date} 日2年`);
    assert.equal(fmt(series[series.length - 1].milli, 3, true), spread, `${date} 金利差`);
    const bp = (c) => C.fmtBp(c.deltaMilli).replace("bp", "");
    assert.equal(bp(C.changeOver(C.valued(upto(us)), 5)), u5, `${date} 米2年の5日差`);
    assert.equal(bp(C.changeOver(C.valued(upto(jp)), 5)), j5, `${date} 日2年の5日差`);
    const c = C.changeOver(series, 5);
    assert.equal(bp(c), s5, `${date} 金利差の5日差`);
    assert.deepEqual([5, 10, 15].map((t) => C.classify(c.deltaMilli, t)), [l5, l10, l15], `${date} 判定`);
  }
});

test("表の20日ぶん：フィードの計算（buildSnapshot）が、10bpの列と一致する（その日の翌営業日の朝の時点で作ったとして）", () => {
  const { jst } = H;
  for (const [date, , , spread, , , s5, , l10] of EXPECTED) {
    const next = nextJpBusinessDay(date);
    const nowMs = jst(`${next} 10:00`);
    const nyDateLimit = addDays(next, -1); // その時点の米東部の日付（前日の夜）
    const snap = buildSnapshot({
      nowMs, holidays, prev: null,
      us: { rows: us.filter((r) => r.date <= nyDateLimit), xml: { rows: usXml.filter((r) => r.date <= nyDateLimit) }, fetchedAt: "t" },
      jp: { rows: jp.filter((r) => r.date <= date), lastModified: null, fetchedAt: "t" },
    });
    assert.deepEqual(snap.errors, [], `${date} 取得・照合の問題なし`);
    assert.equal(snap.judgment.available, true, `${date} 判定できる状態（${snap.judgment.reason}）`);
    assert.equal(snap.judgment.label, l10, `${date} 10bpの判定`);
    assert.equal(snap.judgment.threshold_bp, 10);
    assert.equal(snap.spread.date, date);
    assert.equal(snap.spread.value, Number(spread), `${date} 金利差`);
    assert.equal(snap.change_5d.spread.value_bp, Number(s5), `${date} 金利差の5日差`);
    assert.equal(snap.judgment.basis.value_bp, Number(s5));
  }
});

test("表の境界の例：10/1 は −11.7bp で円高方向、10/6 は −10.0bp（米2年）、9/28 の金利差は +5.1bp", () => {
  const row = (d) => EXPECTED.find((r) => r[0] === d);
  assert.equal(row("2026-10-01")[8], "円高方向");
  assert.equal(row("2026-10-06")[4], "-10.0");
  assert.equal(row("2026-09-28")[6], "+5.1");
  assert.equal(row("2026-09-28")[7], "円安方向"); // 5bpでは円安方向
  assert.equal(row("2026-09-28")[8], "はっきりしない"); // 10bpでははっきりしない
});
