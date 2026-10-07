"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../lib/parse");
const H = require("./helpers");

test("parseMilli: 小数第3位まで整数（ミリ%）にする。読めなければ null", () => {
  assert.equal(P.parseMilli("4.79"), 4790);
  assert.equal(P.parseMilli("1.930"), 1930);
  assert.equal(P.parseMilli("1.93"), 1930);
  assert.equal(P.parseMilli("-0.05"), -50);
  assert.equal(P.parseMilli("10"), 10000);
  for (const bad of ["", "-", "N/A", "1.2345", "abc", "1,5"]) assert.equal(P.parseMilli(bad), null, bad);
});

test("財務省CSV（実データ）: 新しい日付が先頭のファイルを古い順にし、2 Yr を読む", () => {
  const rows = H.usRows();
  assert.equal(rows.length, 68);
  assert.equal(rows[0].date, "2026-07-01");
  assert.deepEqual(rows[rows.length - 1], { date: "2026-10-06", milli: 4790 });
  assert.deepEqual(rows.find((r) => r.date === "2026-10-05"), { date: "2026-10-05", milli: 4840 });
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].date < r.date));
});

test("財務省CSV: 列名が想定と違う・日付や値が読めない場合は、黙って捨てずに例外にする", () => {
  assert.throws(() => P.parseTreasuryCsv('Date,"1 Mo","3 Yr"\n10/06/2026,4.0,4.8\n'), /2 Yr/);
  assert.throws(() => P.parseTreasuryCsv('Date,"2 Yr"\n2026-10-06,4.79\n'), /日付/);
  assert.throws(() => P.parseTreasuryCsv('Date,"2 Yr"\n10/06/2026,abc\n'), /2 Yr の値/);
  assert.throws(() => P.parseTreasuryCsv(""), /空/);
  // 空欄・N/A は「値なし」（null）
  const r = P.parseTreasuryCsv('Date,"2 Yr"\n10/06/2026,\n10/05/2026,N/A\n10/02/2026,4.83\n');
  assert.deepEqual(r.map((x) => x.milli), [4830, null, null]);
});

test("財務省XML（実データ）: CSVと同じ日付・同じ値（照合用）", () => {
  const xml = H.usXmlRows(), csv = H.usRows();
  assert.deepEqual(xml, csv);
});

test("財務省XML: entry が無ければ例外", () => {
  assert.throws(() => P.parseTreasuryXml("<feed></feed>"), /entry/);
});

test("国債金利情報（実データ・Shift_JIS）: 和暦を西暦に直し、2年を読む。休日の行は無い・末尾の注意書きは読み飛ばす", () => {
  const month = P.parseMofCsv(P.decodeShiftJis(H.mofMonthBytes()));
  assert.deepEqual(month.map((r) => r.date), ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"]);
  assert.deepEqual(month.map((r) => r.milli), [1939, 1919, 1909, 1930]);
  const all = P.parseMofCsv(P.decodeShiftJis(H.mofAllBytes()));
  assert.equal(all[0].date, "2026-07-01");
  assert.equal(all[all.length - 1].date, "2026-09-30");
  // 9/21〜9/23 は休日で行が無い
  const dates = new Set(all.map((r) => r.date));
  for (const d of ["2026-09-21", "2026-09-22", "2026-09-23"]) assert.ok(!dates.has(d), d);
});

test("国債金利情報: 満期の値が - の日は null。列名や基準日が想定外なら例外", () => {
  const t = "国債金利情報,,,\n基準日,1年,2年,3年\nS49.9.24,10.327,-,8.83\nR8.10.6,1.652,1.930,2.077\n,,,\n※注意書き,,,\n";
  assert.deepEqual(P.parseMofCsv(t), [{ date: "1974-09-24", milli: null }, { date: "2026-10-06", milli: 1930 }]);
  assert.throws(() => P.parseMofCsv("基準日,1年,3年\nR8.10.6,1,2\n"), /2年/);
  assert.throws(() => P.parseMofCsv("基準日,1年,2年\n2026-10-06,1,2\n"), /基準日/);
  assert.throws(() => P.parseMofCsv("a,b\n1,2\n"), /列名/);
});

test("和暦: 昭和・平成・令和、月日は0埋めなし。存在しない日は null", () => {
  assert.equal(P.warekiToIso("R8.10.6"), "2026-10-06");
  assert.equal(P.warekiToIso("R1.5.1"), "2019-05-01");
  assert.equal(P.warekiToIso("H1.1.4"), "1989-01-04");
  assert.equal(P.warekiToIso("S49.9.24"), "1974-09-24");
  assert.equal(P.warekiToIso("R8.2.30"), null);
  assert.equal(P.warekiToIso("X1.1.1"), null);
});

test("Shift_JIS: 別の文字コードのバイト列は例外にする（UTF-8を誤って読んだ場合などに気づく）", () => {
  assert.throws(() => P.decodeShiftJis(Buffer.from([0x81])));
});

test("内閣府の祝日CSV（同梱の祝日表）: 日付の集合にする", () => {
  const h = H.holidays();
  assert.ok(h.has("2026-10-12") && h.has("2026-09-22") && h.has("2027-11-23"));
  assert.ok(!h.has("2026-10-13"));
  assert.throws(() => P.parseCaoHolidays("国民の祝日・休日月日,名称\n"), /日付の行/);
});
