"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { runBackfill } = require("../backfill");
const { createClient } = require("../lib/twelvedata");
const { aggregateHourlyToNyDaily } = require("../lib/daily-bars");
const store = require("../lib/store");
const { SYMBOLS } = require("../config");
const { scenarioRows, scenarioBars, fakeTwelveData, fakeClock, tmpData } = require("./helpers");

const KEY = "SECRETKEY123";
const NOW = Date.UTC(2026, 9, 6, 21, 20, 0); // 基準日 2026-10-06
const START = "2026-01-05"; // 月曜（開始日が完全な日足で残ることを確かめる）

function setup({ failures = {}, pageCap = 5000, bars = null } = {}) {
  const t = tmpData();
  const data = bars || scenarioBars("2025-12-01", "2026-10-07");
  const f = fakeTwelveData(data, { failures, pageCap });
  const clock = fakeClock(NOW);
  const client = createClient({ apiKey: KEY, fetchImpl: f, sleep: clock.sleep, now: clock.now, spacingMs: 100 });
  return { t, f, client, data, run: (over = {}) => runBackfill({ nowMs: NOW, dataDir: t.dataDir, client, log: () => {}, start: START, minRows: 100, ...over }) };
}

test("1-2: バックフィル — 9銘柄の履歴CSVとフィードを置く。開始日の日足は完全な足で残り、基準日までそろう", async () => {
  const s = setup();
  try {
    const r = await s.run({ pageSize: 1000 }); // 1000本ずつ遡る（ページ送りを通す）
    assert.equal(r.exitCode, 0);
    assert.deepEqual(store.existingCsvFiles(s.t.dataDir), SYMBOLS.map((x) => `ny-daily-${x.code}.csv`).sort());
    for (const sym of SYMBOLS) {
      const rows = store.readRows(s.t.dataDir, sym.code);
      const truth = scenarioRows(sym.code, START, "2026-10-06");
      assert.equal(rows[0].date, START, sym.code); // 開始日が左端の欠けた日として捨てられていない
      assert.equal(rows[0].bars, 24);
      assert.equal(rows[rows.length - 1].date, "2026-10-06");
      assert.equal(rows.length, truth.length);
      assert.ok(rows.every((x) => x.bars === 24));
      // 値が日足の真値と一致（ページの継ぎ目で足が落ちたり重複したりしていない）
      rows.forEach((x, i) => {
        assert.equal(x.date, truth[i].date);
        for (const k of ["open", "high", "low", "close"]) assert.ok(Math.abs(x[k] - truth[i][k]) < 1e-5, `${sym.code} ${x.date} ${k}`);
      });
    }
    const feed = JSON.parse(fs.readFileSync(path.join(s.t.dataDir, "mtf-feed.json"), "utf8"));
    assert.equal(feed.status, "ok");
    assert.equal(feed.data_base_date, "2026-10-06");
    assert.ok(s.f.calls.length >= 9 * 3, `ページ送りが行われていない: ${s.f.calls.length}回`);
    assert.ok(s.f.calls.every((c) => c.interval === "1h" && c.timezone === "UTC" && c.outputsize === "1000"));
    assert.deepEqual(fs.readdirSync(s.t.root).filter((n) => n.startsWith(".mtf-tmp-")), []);
  } finally { s.t.cleanup(); }
});

test("ページ送りの有無で結果が変わらない（5000本1回 と 小さいページ）", async () => {
  const a = setup();
  const b = setup();
  try {
    await a.run({ pageSize: 5000 });
    await b.run({ pageSize: 700 });
    for (const sym of SYMBOLS) {
      assert.equal(fs.readFileSync(path.join(a.t.dataDir, "mtf", `ny-daily-${sym.code}.csv`), "utf8"), fs.readFileSync(path.join(b.t.dataDir, "mtf", `ny-daily-${sym.code}.csv`), "utf8"), sym.code);
    }
    assert.ok(a.f.calls.length < b.f.calls.length);
  } finally { a.t.cleanup(); b.t.cleanup(); }
});

test("6-1: 履歴CSVが1つでもあれば、何も取得せず・何も書かずに止まる（上書きしない）", async () => {
  const s = setup();
  try {
    const only = path.join("mtf", "ny-daily-EURUSD.csv");
    store.writeAll(s.t.dataDir, [{ file: only, content: store.toCsv([{ date: "2026-10-01", open: 1, high: 2, low: 0.5, close: 1.5, bars: 24, last_bar_ny: "16:00" }]) }]);
    const before = fs.readFileSync(path.join(s.t.dataDir, only), "utf8");
    const logs = [];
    const r = await s.run({ log: (m) => logs.push(m) });
    assert.equal(r.exitCode, 1);
    assert.equal(r.stopped, "exists");
    assert.equal(s.f.calls.length, 0); // Twelve Data を1回も呼ばない
    assert.equal(fs.readFileSync(path.join(s.t.dataDir, only), "utf8"), before); // 既存は無変更
    assert.deepEqual(fs.readdirSync(s.t.dataDir).sort(), ["mtf"]); // フィードも作らない
    assert.deepEqual(fs.readdirSync(path.join(s.t.dataDir, "mtf")), ["ny-daily-EURUSD.csv"]);
    assert.ok(logs.some((l) => /既にあります/.test(l)));
  } finally { s.t.cleanup(); }
});

test("6-1: 1銘柄でも失敗したら何も書かない（やり直せる）。直したあとの再実行は成功する", async () => {
  const failures = { "XAU/USD": { kind: "401", times: 1 } };
  const s = setup({ failures });
  try {
    await assert.rejects(s.run({ pageSize: 1000 }), /XAU\/USD/);
    assert.deepEqual(fs.readdirSync(s.t.dataDir), []); // CSVもフィードも置かれない
    assert.deepEqual(fs.readdirSync(s.t.root).filter((n) => n.startsWith(".mtf-tmp-")), []);
    const r = await s.run({ pageSize: 1000 }); // 失敗は1回きりの設定
    assert.equal(r.exitCode, 0);
    assert.equal(store.existingCsvFiles(s.t.dataDir).length, SYMBOLS.length);
  } finally { s.t.cleanup(); }
});

test("取得が範囲の先頭に届かない（古い側が欠ける）・日数が少なすぎる場合は書かずに失敗", async () => {
  // 先頭が 2026-03-02 から始まるデータ（開始日 2026-01-05 に届かない）
  const s = setup({ bars: scenarioBars("2026-03-02", "2026-10-07") });
  try {
    await assert.rejects(s.run(), /届いていません/);
    assert.deepEqual(fs.readdirSync(s.t.dataDir), []);
    await assert.rejects(s.run({ start: "2026-03-02", minRows: 5000 }), /日足が\d+日分しか/);
    assert.deepEqual(fs.readdirSync(s.t.dataDir), []);
  } finally { s.t.cleanup(); }
});

test("1-1: 週末の足（実APIが返す平らな足）や、本数の少ない日（祝日の短縮）が混ざっていても、規則どおりに日足になる", async () => {
  const bars = scenarioBars("2025-12-01", "2026-10-07", { bars: (d) => (d === "2026-04-03" ? 18 : 24) });
  // 週末の足を足す（金曜17時NY〜日曜17時NY の48本、値は9999 の平ら）
  const { nyToUtcMs } = require("./helpers");
  const { isoDatetime, HR, addDays, dowIso } = require("../lib/ny-time");
  for (const td of Object.keys(bars)) {
    for (let d = "2026-01-02"; d <= "2026-10-02"; d = addDays(d, 1)) {
      if (dowIso(d) !== 5) continue;
      const t0 = nyToUtcMs(Date.parse(`${d}T17:00:00Z`));
      for (let k = 0; k < 47; k++) bars[td].push({ datetime: isoDatetime(t0 + k * HR), open: 9999, high: 9999, low: 9999, close: 9999 });
    }
  }
  const s = setup({ bars });
  try {
    await s.run({ pageSize: 1500 });
    const rows = store.readRows(s.t.dataDir, "USDJPY");
    assert.ok(rows.every((r) => r.close < 9000), "週末の足が日足に混ざっている");
    assert.equal(rows.find((r) => r.date === "2026-04-03").bars, 18); // 補わずそのまま
    assert.equal(rows.length, scenarioRows("USDJPY", START, "2026-10-06").length);
    const feed = JSON.parse(fs.readFileSync(path.join(s.t.dataDir, "mtf-feed.json"), "utf8"));
    assert.deepEqual(feed.symbols[0].short_bar_days.map((x) => [x.date, x.bars]), [["2026-04-03", 18]]);
  } finally { s.t.cleanup(); }
});

test("APIキーはログ・ファイルに出ない。リクエスト数が見積もり内（5000本×4回前後・9銘柄で約40回）", async () => {
  const s = setup({ failures: { "EUR/USD": { kind: "throw", times: 1 } } });
  try {
    const logs = [];
    await s.run({ pageSize: 1500, log: (m) => logs.push(m) });
    const all = [logs.join("\n"), ...fs.readdirSync(s.t.dataDir).filter((f) => fs.statSync(path.join(s.t.dataDir, f)).isFile()).map((f) => fs.readFileSync(path.join(s.t.dataDir, f), "utf8"))];
    assert.ok(!all.join("\n").includes(KEY));
    assert.ok(s.client.stats.requests <= 9 * 6 + 2);
  } finally { s.t.cleanup(); }
});
