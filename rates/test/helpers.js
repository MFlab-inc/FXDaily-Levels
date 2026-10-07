"use strict";
const fs = require("fs");
const path = require("path");
const parse = require("../lib/parse");

const FIX = path.join(__dirname, "fixtures");
const ROOT = path.join(__dirname, "..");

const fixtureBytes = (name) => fs.readFileSync(path.join(FIX, name));
const fixtureText = (name) => fixtureBytes(name).toString("utf8");

// 実データ（2026-07-01〜2026-10-06）を実ファイルと同じ形で切り出したもの
const usCsvText = () => fixtureText("ust-2026-tail.csv");
const usXmlText = () => fixtureText("ust-2026-tail.xml");
const mofAllBytes = () => fixtureBytes("mof-all-tail.csv");       // Shift_JIS（R8.7.1〜R8.9.30）
const mofMonthBytes = () => fixtureBytes("mof-month-202610.csv"); // Shift_JIS（令和8年10月分。10/1〜10/6）
const holidays = () => parse.parseCaoHolidays(parse.decodeShiftJis(fs.readFileSync(path.join(ROOT, "jp-holidays.csv"))));

const usRows = () => parse.parseTreasuryCsv(usCsvText());
const usXmlRows = () => parse.parseTreasuryXml(usXmlText());
const jpRows = () => {
  const m = new Map();
  for (const r of [...parse.parseMofCsv(parse.decodeShiftJis(mofAllBytes())), ...parse.parseMofCsv(parse.decodeShiftJis(mofMonthBytes()))]) m.set(r.date, r);
  return [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
};

// 日本時間の日時（"2026-10-07 10:00"）→ UTCミリ秒
const jst = (s) => Date.parse(`${s.replace(" ", "T")}:00+09:00`);

module.exports = { FIX, ROOT, fixtureBytes, fixtureText, usCsvText, usXmlText, mofAllBytes, mofMonthBytes, holidays, usRows, usXmlRows, jpRows, jst };
