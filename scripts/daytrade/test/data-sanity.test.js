"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

/**
 * コミット済みの価格データの健全性。データ提供元（Twelve Data）には、1本だけ高値・安値が桁違いの足が入ることがある
 * （NZDUSD の 2026-04-30 03:00 JST の1時間足は、高値が 1.71632 で届いた。始値 0.58395・終値 0.58251）。
 * そのまま使うと、日足の高値・一目均衡表・ATR・H1の群が壊れる。補正した値が戻らないこと、ほかに同じ足が無いことを確かめる。
 */
const DATA = path.join(__dirname, "..", "..", "..", "data");

test("H1履歴（data/history）: 高値が始値・終値より20%以上高い足、安値が20%以上低い足は無い", () => {
  const files = fs.readdirSync(path.join(DATA, "history")).filter((f) => /^h1-.*\.csv$/.test(f));
  assert.ok(files.length >= 10);
  const bad = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(DATA, "history", f), "utf8").split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("time_jst")) continue;
      const [t, o, h, l, c] = line.split(",");
      const [O, H, L, C] = [o, h, l, c].map(Number);
      if (H > Math.max(O, C) * 1.2 || L < Math.min(O, C) * 0.8) bad.push(`${f} ${t}: o=${o} h=${h} l=${l} c=${c}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("NZDUSD: MTF の日足 2026-04-29 の高値は補正済み（H1の足から作り直した値 0.58916。提供元の異常値 1.71632 ではない）。日足の1日の幅は10%未満", () => {
  const rows = fs.readFileSync(path.join(DATA, "mtf", "ny-daily-NZDUSD.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  const day = rows.find((r) => r[0] === "2026-04-29");
  assert.deepEqual(day, ["2026-04-29", "0.58853", "0.58916", "0.58165", "0.5829", "24", "16:00"]);
  assert.deepEqual(rows.filter((r) => Number(r[2]) / Number(r[3]) > 1.1).map((r) => r[0]), []);
  // H1履歴の同じ日（NY 2026-04-29 = JST 04-29 06:00〜04-30 05:00 の24本）から作った日足と、補正後の日足が一致する
  const h1 = fs.readFileSync(path.join(DATA, "history", "h1-NZDUSD.csv"), "utf8").split("\n").filter((l) => /^2026-04-(29 (0[6-9]|1\d|2\d)|30 0[0-5]):00,/.test(l)).map((l) => l.split(","));
  assert.equal(h1.length, 24);
  assert.equal(Number(h1[0][1]), Number(day[1]));
  assert.equal(Number(h1[23][4]), Number(day[4]));
  assert.equal(Math.max(...h1.map((b) => Number(b[2]))), Number(day[2]));
  assert.equal(Math.min(...h1.map((b) => Number(b[3]))), Number(day[3]));
});
