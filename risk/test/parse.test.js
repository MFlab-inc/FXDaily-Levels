"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseVixCsv, ParseError } = require("../lib/parse");
const H = require("./helpers");

test("Cboe の形（DATE,OPEN,HIGH,LOW,CLOSE・MM/DD/YYYY・小数6桁）を読む。2026-10-30 に公式のリンクで見た先頭の行", () => {
  const text = "DATE,OPEN,HIGH,LOW,CLOSE\n01/02/1990,17.240000,17.240000,17.240000,17.240000\n01/03/1990,18.190000,18.190000,18.190000,18.190000\n";
  const { rows, skipped } = parseVixCsv(text);
  assert.deepEqual(rows, [{ date: "1990-01-02", close: 17.24 }, { date: "1990-01-03", close: 18.19 }]);
  assert.deepEqual(skipped, []);
});

test("BOM・CRLF・末尾の空行を許す。並びが逆でも古い順に並べ直す", () => {
  const text = "﻿DATE,OPEN,HIGH,LOW,CLOSE\r\n10/29/2026,1,1,1,17.120000\r\n10/28/2026,1,1,1,18.000000\r\n\r\n";
  const { rows } = parseVixCsv(text);
  assert.deepEqual(rows.map((r) => r.date), ["2026-10-28", "2026-10-29"]);
});

test("見出しに DATE・CLOSE が無ければ失敗", () => {
  assert.throws(() => parseVixCsv("Date,Open,High,Low,Price\n10/29/2026,1,1,1,1\n"), ParseError);
  assert.throws(() => parseVixCsv(""), /空/);
});

test("新しい側（末尾の strictTail 行）の不備は失敗：日付の形・存在しない日・数値でない・範囲外・列の数・重複", () => {
  const head = "DATE,OPEN,HIGH,LOW,CLOSE\n";
  const bad = [
    ["2026-10-29,1,1,1,17", /MM\/DD\/YYYY/],
    ["02/30/2026,1,1,1,17", /存在しない日付/],
    ["10/29/2026,1,1,1,", /数値ではありません/],
    ["10/29/2026,1,1,1,-1", /数値ではありません/],
    ["10/29/2026,1,1,1,0.000000", /範囲/],
    ["10/29/2026,1,1,1,250", /範囲/],
    ["10/29/2026,1,1,17", /列の数/],
  ];
  for (const [line, re] of bad) assert.throws(() => parseVixCsv(head + line + "\n"), re, line);
  assert.throws(() => parseVixCsv(head + "10/29/2026,1,1,1,17\n10/29/2026,1,1,1,18\n"), /重複/);
});

test("古い側の不備は、その行を飛ばして記録する（毎日の更新を止めない）。新しい側は厳しく見る", () => {
  const rows = H.syntheticRows("2024-01-02", "2026-10-29");
  const lines = H.toCboeCsv(rows).trim().split("\n");
  lines.splice(1, 0, "01/02/1990,17.24,17.24,17.24,n/a"); // 先頭（最も古い）に壊れた行
  const r = parseVixCsv(lines.join("\n"), { strictTail: 400 });
  assert.equal(r.rows.length, rows.length);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /2行目/);
  // 同じ壊れ方でも、末尾400行の中なら失敗
  const lines2 = H.toCboeCsv(rows).trim().split("\n");
  lines2.splice(lines2.length - 10, 0, "01/02/1990,17.24,17.24,17.24,n/a");
  assert.throws(() => parseVixCsv(lines2.join("\n"), { strictTail: 400 }), ParseError);
});
