"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const cal = require("../lib/calendar");
const cfg = require("../config");
const H = require("./helpers");
const { addDays } = require("../../mtf/lib/ny-time");

const lines = (name) => new Set(H.fixtureText(name).split("\n").filter(Boolean));
const US_DATES = lines("us-dates-2023-2026.txt");   // 財務省CSVにある日（2023-01-02〜2026-10-06、941日）
const JP_DATES = lines("jp-dates-2023-2026.txt");   // 財務省の国債金利情報で2年に値がある日（918日）
const holidays = H.holidays();
const days = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };

test("日本の営業日: 規則（土日・祝日・12/31・1/1〜1/3）が、2023-01〜2026-10 の財務省の全行と一致する", () => {
  assert.equal(JP_DATES.size, 918);
  const wrong = days("2023-01-01", "2026-10-06").filter((d) => cal.isJpBusinessDay(d, holidays) !== JP_DATES.has(d));
  assert.deepEqual(wrong, []);
});

test("米国の営業日: 休場と決めた日にデータは無く、開と決めた日にはデータがある。不確かな日は開閉どちらもありうる", () => {
  const uncertain = [];
  for (const d of days("2023-01-01", "2026-10-06")) {
    const c = cal.usClosure(d);
    if (c === "closed") assert.ok(!US_DATES.has(d), `休場のはずの ${d} にデータがある`);
    else if (c === "open") assert.ok(US_DATES.has(d), `開のはずの ${d} にデータが無い`);
    else uncertain.push([d, US_DATES.has(d)]);
  }
  // 規則だけでは決まらない日。実際の開閉（2023-04-07・2023-11-10・2026-04-03は開、2024-03-29・2025-04-18・2026-07-03は閉）
  assert.deepEqual(uncertain, [
    ["2023-04-07", true], ["2023-11-10", true], ["2024-03-29", false], ["2025-04-18", false],
    ["2026-04-03", true], ["2026-07-03", false],
  ]);
});

test("祝日表にその年が無いときは、日本の営業日を決められず例外（祝日表の更新が必要）", () => {
  assert.throws(() => cal.isJpBusinessDay("2028-01-04", holidays), cal.CalendarError);
  assert.throws(() => cal.isJpBusinessDay("2021-12-24", holidays), /2021年/);
});

const jstAt = H.jst;
const READY = cfg.JP_READY_JST_MIN;

test("日2年の最新のはずの日: 公表（翌営業日の9:40以降）を数える", () => {
  const e = (s) => cal.expectedJpLatest(jstAt(s), holidays, READY);
  assert.equal(e("2026-10-07 10:00"), "2026-10-06"); // 水曜の朝。10/6分が公表済み
  assert.equal(e("2026-10-07 09:39"), "2026-10-05"); // 公表前は、1つ前
  assert.equal(e("2026-10-05 10:00"), "2026-10-02"); // 月曜。金曜分
  assert.equal(e("2026-10-10 12:00"), "2026-10-08"); // 土曜。金曜の朝に木曜分が出たところまで
  assert.equal(e("2026-10-12 10:00"), "2026-10-08"); // 月曜の祝日（スポーツの日）。10/9分は10/13に公表
  assert.equal(e("2026-10-13 09:45"), "2026-10-09"); // 祝日明け
  assert.equal(e("2026-01-05 10:00"), "2025-12-30"); // 年始。12/31・1/1〜1/3 は営業日でない
});

const usAt = (s, present = []) => cal.expectedUsLatest(jstAt(s), new Set(present), {
  readyMin: cfg.US_READY_ET_MIN, uncertainClosedAfterHours: cfg.UNCERTAIN_US_CLOSED_AFTER_HOURS,
});

test("米2年の最新のはずの日: 米東部18:30以降なら現地の今日、前なら前日。休場は飛ばす", () => {
  assert.equal(usAt("2026-10-07 09:45"), "2026-10-06");  // 米東部 10/6 20:45
  assert.equal(usAt("2026-10-07 05:00"), "2026-10-05");  // 米東部 10/6 16:00。まだ10/6分は出ていない
  assert.equal(usAt("2026-10-12 09:45"), "2026-10-09");  // 米東部 日曜の夜 → 金曜
  assert.equal(usAt("2026-10-13 09:45"), "2026-10-09");  // 米東部 月曜(コロンブス・デー)の夜 → 金曜
  assert.equal(usAt("2026-11-27 09:45"), "2026-11-25");  // 感謝祭(11/26)の翌朝(日本) → 11/25
});

test("不確かな日（聖金曜）: 行が無いまま24時間が過ぎたら休場、行があれば開、直後は待つ", () => {
  // 2024-03-29（聖金曜。実際は閉）
  assert.equal(usAt("2024-03-30 09:00"), "2024-03-29");                // 米東部 金曜 20:00。まだ待つ
  assert.equal(usAt("2024-04-01 09:45"), "2024-03-28");                // 日曜の夜。行が無いまま約50時間 → 休場
  assert.equal(usAt("2024-04-01 09:45", ["2024-03-29"]), "2024-03-29"); // 行があれば開いていた
});

test("履歴の穴: 開いているはずの日に行が無ければ検出する（休場・不確かな日は穴にしない）", () => {
  const us = H.usRows().map((r) => r.date);
  assert.deepEqual(cal.missingBusinessDays(us, (d) => cal.usClosure(d) === "open"), []);
  const jp = [...JP_DATES].filter((d) => d >= "2026-07-01").sort();
  assert.deepEqual(cal.missingBusinessDays(jp, (d) => cal.isJpBusinessDay(d, holidays)), []);
  const hole = jp.filter((d) => d !== "2026-09-30");
  assert.deepEqual(cal.missingBusinessDays(hole, (d) => cal.isJpBusinessDay(d, holidays)), ["2026-09-30"]);
});

test("復活祭の計算", () => {
  assert.equal(cal.easterSunday(2024), "2024-03-31");
  assert.equal(cal.easterSunday(2025), "2025-04-20");
  assert.equal(cal.easterSunday(2026), "2026-04-05");
});
