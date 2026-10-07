"use strict";

/**
 * 取得したファイルの読み取り（SPEC 2節）。
 * 利回りは「0.001%を1とする整数（ミリ%）」で持つ（例 4.79 → 4790、1.930 → 1930）。
 * 小数のまま足し引きすると、境界ちょうど（±10bp）の判定がずれることがあるため。
 * 形式が想定と違うときは、黙って捨てずに例外にする（形式変更に気づけるように）。
 */

// 表示（"4.79" など）→ ミリ%。小数第3位まで。読めなければ null
function parseMilli(s) {
  const m = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(String(s).trim());
  if (!m) return null;
  const v = Number(m[2]) * 1000 + Number((m[3] || "").padEnd(3, "0"));
  return m[1] === "-" ? -v : v;
}

function isRealDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

// 引用符つきのCSV1行を分ける（財務省CSVの列名は引用符つき）
function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const sortUnique = (rows) => {
  const byDate = new Map();
  for (const r of rows) byDate.set(r.date, r);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};

// ---- 米財務省 Daily Treasury Par Yield Curve Rates（CSV）----
// 返り値: [{ date: "YYYY-MM-DD", milli: number|null }]（古い順）。milli が null＝その日の2年が空欄
// allowEmpty：行が無い年（年初で、その年の最初の行がまだ無い。財務省は本文が空のHTTP 200で返す）を空の配列にする
function parseTreasuryCsv(text, { allowEmpty = false } = {}) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) { if (allowEmpty) return []; throw new Error("財務省CSV: 中身が空です"); }
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const iDate = header.indexOf("Date"), i2 = header.indexOf("2 Yr");
  if (iDate < 0 || i2 < 0) throw new Error("財務省CSV: 列名に Date または 2 Yr がありません（形式が変わった可能性）");
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((c[iDate] || "").trim());
    if (!m || !isRealDate(+m[3], +m[1], +m[2])) throw new Error(`財務省CSV: 日付の形式が想定外です: ${JSON.stringify(c[iDate])}`);
    const raw = (c[i2] || "").trim();
    let milli = null;
    if (raw !== "" && raw !== "N/A") {
      milli = parseMilli(raw);
      if (milli === null) throw new Error(`財務省CSV: 2 Yr の値が読めません（${m[0]}）: ${JSON.stringify(raw)}`);
    }
    rows.push({ date: isoOf(+m[3], +m[1], +m[2]), milli });
  }
  if (!rows.length) { if (allowEmpty) return []; throw new Error("財務省CSV: データ行がありません"); }
  return sortUnique(rows);
}

// ---- 米財務省 同じデータのXML（照合用。Atomフィード、1日1エントリ）----
function parseTreasuryXml(text) {
  const entries = String(text).match(/<entry>[\s\S]*?<\/entry>/g) || [];
  if (!entries.length) throw new Error("財務省XML: entry がありません（形式が変わった可能性）");
  const rows = [];
  for (const e of entries) {
    const d = /<d:NEW_DATE[^>]*>(\d{4})-(\d{2})-(\d{2})T/.exec(e);
    if (!d || !isRealDate(+d[1], +d[2], +d[3])) throw new Error("財務省XML: NEW_DATE が読めません");
    const v = /<d:BC_2YEAR(?:\s[^>]*)?>([^<]*)<\/d:BC_2YEAR>/.exec(e);
    const raw = v ? v[1].trim() : "";
    let milli = null;
    if (raw !== "") {
      milli = parseMilli(raw);
      if (milli === null) throw new Error(`財務省XML: BC_2YEAR の値が読めません: ${JSON.stringify(raw)}`);
    }
    rows.push({ date: isoOf(+d[1], +d[2], +d[3]), milli });
  }
  return sortUnique(rows);
}

// ---- 財務省（日本）国債金利情報 ----
// 文字コードは Shift_JIS（CP932）。不正な並びがあれば例外（UTF-8などを誤って読んだ場合に気づく）
function decodeShiftJis(bytes) {
  return new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
}

// 和暦（略号）→ ISO日付。S=昭和 H=平成 R=令和。月日は0埋めなし（例 R8.10.6、H1.1.4）
const ERA_BASE = { S: 1925, H: 1988, R: 2018 };
function warekiToIso(s) {
  const m = /^([SHR])(\d{1,2})\.(\d{1,2})\.(\d{1,2})$/.exec(String(s).trim());
  if (!m) return null;
  const y = ERA_BASE[m[1]] + Number(m[2]);
  return isRealDate(y, +m[3], +m[4]) ? isoOf(y, +m[3], +m[4]) : null;
}

// 返り値: [{ date, milli|null }]（古い順）。値が "-" の日は milli=null。休日の行は無い。
// 末尾の空のカンマ行・「※…」の注意書き行は読み飛ばす。
function parseMofCsv(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  let col = -1, hdrAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].split(",");
    if (c[0].trim() === "基準日") { col = c.findIndex((x) => x.trim() === "2年"); hdrAt = i; break; }
  }
  if (hdrAt < 0 || col < 0) throw new Error("財務省国債金利情報: 列名の行（基準日・2年）が見つかりません（形式が変わった可能性）");
  const rows = [];
  for (const line of lines.slice(hdrAt + 1)) {
    const c = line.split(",");
    const head = (c[0] || "").trim();
    if (head === "" || head.startsWith("※")) continue;
    const date = warekiToIso(head);
    if (!date) throw new Error(`財務省国債金利情報: 基準日の形式が想定外です: ${JSON.stringify(head)}`);
    const raw = (c[col] || "").trim();
    let milli = null;
    if (raw !== "" && raw !== "-") {
      milli = parseMilli(raw);
      if (milli === null) throw new Error(`財務省国債金利情報: 2年の値が読めません（${head}）: ${JSON.stringify(raw)}`);
    }
    rows.push({ date, milli });
  }
  return sortUnique(rows);
}

// ---- 内閣府 国民の祝日（CSV。Shift_JIS）→ 日付の集合 ----
function parseCaoHolidays(text) {
  const out = new Set();
  for (const line of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2}),/.exec(line.trim());
    if (m && isRealDate(+m[1], +m[2], +m[3])) out.add(isoOf(+m[1], +m[2], +m[3]));
  }
  if (!out.size) throw new Error("内閣府の祝日CSV: 日付の行がありません（形式が変わった可能性）");
  return out;
}

module.exports = {
  parseMilli, splitCsvLine, parseTreasuryCsv, parseTreasuryXml,
  decodeShiftJis, warekiToIso, parseMofCsv, parseCaoHolidays,
};
