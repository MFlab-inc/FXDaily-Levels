"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const store = require("../lib/store");
const { tmpData } = require("./helpers");

const r = (date, c, extra = {}) => ({ date, open: c, high: c + 1, low: c - 1, close: c, bars: 24, last_bar_ny: "16:00", ...extra });

test("CSV: 書き出して読み戻すと同じ（見出し・列数・bars・金曜の最終足）", () => {
  const rows = [r("2026-10-01", 1.12345), r("2026-10-02", 157.874, { bars: 22, last_bar_ny: "14:00" })];
  const text = store.toCsv(rows);
  assert.equal(text.split("\n")[0], "date_ny,open,high,low,close,bars,last_bar_ny");
  assert.deepEqual(store.parseCsv(text), rows);
});

test("CSV: 壊れたファイルは黙って空扱いにせず例外（見出し違い・列数違い・数値でない・日付が昇順でない）", () => {
  const H = store.HEADER;
  assert.throws(() => store.parseCsv("x,y\n"), /見出し/);
  assert.throws(() => store.parseCsv(`${H}\n2026-10-01,1,2,0,1,24\n`), /列数/);
  assert.throws(() => store.parseCsv(`${H}\n2026-10-01,1,abc,0,1,24,16:00\n`), /数値/);
  assert.throws(() => store.parseCsv(`${H}\n2026-10-01,1,2,0,,24,16:00\n`), /数値/);
  assert.throws(() => store.parseCsv(`${H}\n2026-10-01,1,2,0,1,0,16:00\n`), /bars/);
  assert.throws(() => store.parseCsv(`${H}\n2026-10-02,1,2,0,1,24,16:00\n2026-10-01,1,2,0,1,24,16:00\n`), /昇順/);
  assert.throws(() => store.parseCsv(`${H}\n2026-10-01,1,2,0,1,24,16:00\n2026-10-01,1,2,0,1,24,16:00\n`), /重複|昇順/);
  assert.throws(() => store.parseCsv(`${H}\n10/1,1,2,0,1,24,16:00\n`), /日付/);
});

test("1-2: 追記 — 最新の確定日を足す。既存の直近3日は取り直した値で上書き、それより古い日は触らない", () => {
  const existing = [r("2026-09-28", 10), r("2026-09-29", 11), r("2026-09-30", 12), r("2026-10-01", 13), r("2026-10-02", 14)];
  const fetched = [
    r("2026-09-28", 99), // 古い（直近3日の外）→ 上書きしない
    r("2026-09-30", 120), r("2026-10-01", 130), r("2026-10-02", 140), // 直近3日 → 上書き
    r("2026-10-05", 15), // 新しい日 → 追記
  ];
  const m = store.mergeRows(existing, fetched, { overwriteLast: 3 });
  assert.deepEqual(m.rows.map((x) => [x.date, x.close]), [
    ["2026-09-28", 10], ["2026-09-29", 11], ["2026-09-30", 120], ["2026-10-01", 130], ["2026-10-02", 140], ["2026-10-05", 15],
  ]);
  assert.equal(m.added, 1);
  assert.equal(m.updated, 3);
});

test("1-2: 追記 — 取りこぼした日（穴）は埋める。履歴の先頭より古い日は足さない。同じ値なら更新扱いにしない", () => {
  const existing = [r("2026-09-28", 10), r("2026-09-30", 12), r("2026-10-01", 13)]; // 9/29 が無い
  const fetched = [r("2026-09-25", 9), r("2026-09-29", 11), r("2026-09-30", 12), r("2026-10-01", 13)];
  const m = store.mergeRows(existing, fetched);
  assert.deepEqual(m.rows.map((x) => x.date), ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
  assert.equal(m.added, 1); // 9/29 のみ（9/25 は先頭より古いので足さない）
  assert.equal(m.updated, 0); // 値が同じなので更新なし
});

test("保存: 全ファイルを書き終えてから所定の場所へ置く。途中で失敗したら data/ に何も残らない", () => {
  const t = tmpData();
  try {
    const ok = store.writeAll(t.dataDir, [
      { file: path.join("mtf", "a.csv"), content: "a" },
      { file: "feed.txt", content: "f" },
    ]);
    assert.equal(ok.length, 2);
    assert.equal(fs.readFileSync(path.join(t.dataDir, "mtf", "a.csv"), "utf8"), "a");
    // 一時フォルダは data/ の外に作られ、終わったら消える
    assert.deepEqual(fs.readdirSync(t.root).filter((n) => n.startsWith(".mtf-tmp-")), []);
    assert.deepEqual(fs.readdirSync(t.dataDir).sort(), ["feed.txt", "mtf"]);
    // 失敗: 内容が文字列でない（writeFileSync が例外）→ 他のファイルも置かれない
    const t2 = tmpData();
    assert.throws(() => store.writeAll(t2.dataDir, [
      { file: "good.txt", content: "x" },
      { file: "bad.txt", content: { not: "string" } },
    ]));
    assert.deepEqual(fs.readdirSync(t2.dataDir), []);
    assert.deepEqual(fs.readdirSync(t2.root).filter((n) => n.startsWith(".mtf-tmp-")), []);
    t2.cleanup();
  } finally { t.cleanup(); }
});

test("existingCsvFiles / readRows: 無ければ空・null", () => {
  const t = tmpData();
  try {
    assert.deepEqual(store.existingCsvFiles(t.dataDir), []);
    assert.equal(store.readRows(t.dataDir, "USDJPY"), null);
    store.writeAll(t.dataDir, [{ file: path.join("mtf", "ny-daily-USDJPY.csv"), content: store.toCsv([r("2026-10-01", 1)]) }]);
    assert.deepEqual(store.existingCsvFiles(t.dataDir), ["ny-daily-USDJPY.csv"]);
    assert.equal(store.readRows(t.dataDir, "USDJPY").length, 1);
  } finally { t.cleanup(); }
});
