"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { runAddSymbol } = require("../add-symbol");
const { createClient } = require("../lib/twelvedata");
const store = require("../lib/store");
const { buildFeed } = require("../lib/feed");
const { SYMBOLS } = require("../config");
const { scenarioRows, scenarioBars, fakeTwelveData, fakeClock, tmpData } = require("./helpers");

/**
 * 銘柄の追加（mtf/add-symbol.js）: その銘柄だけ1回取得して履歴CSVを作り、フィードを作り直す。ほかの銘柄は取得しない・書き換えない。
 * 前提の状態 = 『NZDUSD を足す前の main』: 既存9銘柄の履歴CSVと、9銘柄のフィード（前回の更新時刻つき）。
 */
const KEY = "SECRETKEY123";
const NEW = "NZDUSD";
const NOW = Date.UTC(2026, 9, 6, 21, 20, 0); // 基準日 2026-10-06
const START = "2026-01-05";
const OLD = SYMBOLS.filter((s) => s.code !== NEW);
const PREV_UPDATED = "2026-10-07T06:20:00+09:00";

function setup({ failures = {}, bars = null, prevFeed = true, prevAsOf = "2026-10-06", skipCsv = [], withNew = false } = {}) {
  const t = tmpData();
  const items = [];
  const entries = [];
  for (const s of SYMBOLS) {
    if (s.code === NEW && !withNew) continue;
    if (skipCsv.includes(s.code)) continue;
    const rows = scenarioRows(s.code, "2025-12-01", "2026-10-06");
    entries.push({ file: path.join("mtf", `ny-daily-${s.code}.csv`), content: store.toCsv(rows) });
    items.push({ code: s.code, rows, updatedAt: PREV_UPDATED });
  }
  if (prevFeed) {
    const { json, text } = buildFeed({ asOf: prevAsOf, nowMs: NOW - 3600000, items, attempt: 3 });
    json.symbols = json.symbols.filter((x) => x.symbol !== NEW); // 追加前のフィードは9銘柄
    entries.push({ file: "mtf-feed.json", content: JSON.stringify(json, null, 2) + "\n" }, { file: "mtf-feed.txt", content: text });
  }
  store.writeAll(t.dataDir, entries);
  const data = bars || scenarioBars("2025-12-01", "2026-10-07");
  const f = fakeTwelveData(data, { failures });
  const clock = fakeClock(NOW);
  const client = createClient({ apiKey: KEY, fetchImpl: f, sleep: clock.sleep, now: clock.now, spacingMs: 100 });
  return { t, f, client, run: (over = {}) => runAddSymbol({ code: NEW, nowMs: NOW, dataDir: t.dataDir, client, log: () => {}, start: START, minRows: 100, ...over }) };
}
const readAll = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8"); } };
  walk(dir);
  return out;
};

test("NZDUSD を足す: その銘柄だけ取得して履歴CSVを作る。ほかの銘柄は取得も書き換えもしない", async () => {
  const s = setup();
  try {
    const before = readAll(s.t.dataDir);
    const r = await s.run({ pageSize: 1000 });
    assert.equal(r.exitCode, 0);
    // 取得は NZD/USD だけ（ページ送りで数回）
    assert.ok(s.f.calls.length >= 3);
    assert.ok(s.f.calls.every((c) => c.symbol === "NZD/USD" && c.interval === "1h" && c.timezone === "UTC"));
    // 新しい履歴CSVの中身は日足の真値と一致。左端の開始日は完全な足
    const rows = store.readRows(s.t.dataDir, NEW);
    const truth = scenarioRows(NEW, START, "2026-10-06");
    assert.equal(rows[0].date, START);
    assert.equal(rows.length, truth.length);
    rows.forEach((x, i) => { assert.equal(x.date, truth[i].date); for (const k of ["open", "high", "low", "close"]) assert.ok(Math.abs(x[k] - truth[i][k]) < 1e-5, `${x.date} ${k}`); });
    // ほかの履歴CSVは1バイトも変わらない
    const after = readAll(s.t.dataDir);
    for (const o of OLD) assert.equal(after[path.join("mtf", `ny-daily-${o.code}.csv`)], before[path.join("mtf", `ny-daily-${o.code}.csv`)], o.code);
    assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), path.join("mtf", `ny-daily-${NEW}.csv`)].sort());
    assert.deepEqual(fs.readdirSync(s.t.root).filter((n) => n.startsWith(".mtf-tmp-")), []);
  } finally { s.t.cleanup(); }
});

test("フィード: NZDUSD の行が末尾に出る。既存9銘柄の項目は、前回のフィードと1つも変わらない（updated_at も同じ）", async () => {
  const s = setup();
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(s.t.dataDir, "mtf-feed.json"), "utf8"));
    assert.equal(prev.symbols.length, 9);
    await s.run({ pageSize: 1000 });
    const feed = JSON.parse(fs.readFileSync(path.join(s.t.dataDir, "mtf-feed.json"), "utf8"));
    assert.equal(feed.symbols.length, 10);
    assert.deepEqual(feed.symbols.map((x) => x.symbol), [...prev.symbols.map((x) => x.symbol), NEW]);
    // 既存の銘柄ごとの項目（向き・各足の値・履歴・欠測・updated_at）が、前回と完全に同じ
    for (const p of prev.symbols) assert.deepEqual(feed.symbols.find((x) => x.symbol === p.symbol), p, p.symbol);
    const nz = feed.symbols.find((x) => x.symbol === NEW);
    assert.equal(nz.status, "ok");
    assert.equal(nz.source, "twelvedata:NZD/USD");
    assert.equal(nz.data_date, "2026-10-06");
    assert.equal(nz.updated_at, "2026-10-07T06:20:00+09:00"); // NOW（UTC 10/6 21:20）のJST
    for (const k of ["monthly", "weekly", "daily"]) assert.ok(nz[k] && nz[k].direction, k);
    // ファイル全体の項目: 全銘柄そろって ok。基準日・版は同じ。attempt は前回のまま（基準日が同じとき）
    assert.equal(feed.status, "ok");
    assert.equal(feed.coverage, "10/10銘柄が基準日(2026-10-06)まで更新済み");
    assert.equal(feed.as_of, prev.as_of);
    assert.equal(feed.data_base_date, prev.data_base_date);
    assert.equal(feed.version, prev.version);
    assert.equal(feed.attempt, 3);
    // テキスト: 既存銘柄の見出しの並びはそのまま、NZDUSD が最後
    const text = fs.readFileSync(path.join(s.t.dataDir, "mtf-feed.txt"), "utf8");
    const heads = [...text.matchAll(/^## (\w+)$/gm)].map((m) => m[1]);
    assert.deepEqual(heads, [...prev.symbols.map((x) => x.symbol), NEW]);
    assert.match(text, /## NZDUSD\nsource: twelvedata:NZD\/USD/);
    assert.match(text, /status: ok（10\/10銘柄が基準日\(2026-10-06\)まで更新済み）/);
  } finally { s.t.cleanup(); }
});

test("前回のフィードの基準日が違うときは attempt を 1 に戻す。既存銘柄の updated_at は前回のまま。前回のフィードが無くても作れる", async () => {
  const a = setup({ prevAsOf: "2026-10-05" });
  const b = setup({ prevFeed: false });
  try {
    await a.run({ pageSize: 1000 });
    const fa = JSON.parse(fs.readFileSync(path.join(a.t.dataDir, "mtf-feed.json"), "utf8"));
    assert.equal(fa.attempt, 1);
    assert.equal(fa.as_of, "2026-10-06");
    assert.equal(fa.symbols.find((x) => x.symbol === "USDJPY").updated_at, PREV_UPDATED);
    await b.run({ pageSize: 1000 });
    const fb = JSON.parse(fs.readFileSync(path.join(b.t.dataDir, "mtf-feed.json"), "utf8"));
    assert.equal(fb.symbols.length, 10);
    assert.equal(fb.symbols.find((x) => x.symbol === "USDJPY").updated_at, null); // 前回が無ければ不明
    assert.equal(fb.symbols.find((x) => x.symbol === NEW).status, "ok");
  } finally { a.t.cleanup(); b.t.cleanup(); }
});

test("その銘柄の履歴CSVが既にあれば、何も取得せず・何も書かずに止まる（上書きしない）", async () => {
  const s = setup({ withNew: true });
  try {
    const before = readAll(s.t.dataDir);
    const logs = [];
    const r = await s.run({ log: (m) => logs.push(m) });
    assert.equal(r.exitCode, 1);
    assert.equal(r.stopped, "exists");
    assert.equal(s.f.calls.length, 0);
    assert.deepEqual(readAll(s.t.dataDir), before);
    assert.ok(logs.some((l) => /既にあります/.test(l)));
  } finally { s.t.cleanup(); }
});

test("ほかの銘柄の履歴CSVが1つでも欠けていれば、何も取得せず・何も書かずに止まる（フィードを欠けた形で出さない）", async () => {
  const s = setup({ skipCsv: ["XAUUSD"] });
  try {
    const before = readAll(s.t.dataDir);
    const logs = [];
    const r = await s.run({ log: (m) => logs.push(m) });
    assert.equal(r.exitCode, 1);
    assert.equal(r.stopped, "missing-others");
    assert.equal(r.missing, "XAUUSD");
    assert.equal(s.f.calls.length, 0);
    assert.deepEqual(readAll(s.t.dataDir), before);
    assert.ok(logs.some((l) => /XAUUSD の履歴CSVがありません/.test(l)));
  } finally { s.t.cleanup(); }
});

test("config.js に無い銘柄は、何も取得せず・何も書かずに止まる", async () => {
  const s = setup();
  try {
    const before = readAll(s.t.dataDir);
    const r = await s.run({ code: "AUDNZD" });
    assert.equal(r.exitCode, 1);
    assert.equal(r.stopped, "unknown-symbol");
    assert.equal(s.f.calls.length, 0);
    assert.deepEqual(readAll(s.t.dataDir), before);
  } finally { s.t.cleanup(); }
});

test("取得に失敗したら何も書かない（やり直せる）。直したあとの再実行は成功する。APIキーはログにもファイルにも出ない", async () => {
  const s = setup({ failures: { "NZD/USD": { kind: "401", times: 1 } } });
  try {
    const before = readAll(s.t.dataDir);
    const logs = [];
    await assert.rejects(s.run({ pageSize: 1000, log: (m) => logs.push(String(m)) }), /NZD\/USD/);
    assert.deepEqual(readAll(s.t.dataDir), before);
    assert.deepEqual(fs.readdirSync(s.t.root).filter((n) => n.startsWith(".mtf-tmp-")), []);
    const r = await s.run({ pageSize: 1000, log: (m) => logs.push(String(m)) });
    assert.equal(r.exitCode, 0);
    assert.ok(!logs.join("\n").includes(KEY));
    for (const text of Object.values(readAll(s.t.dataDir))) assert.ok(!text.includes(KEY));
  } finally { s.t.cleanup(); }
});

test("取得が開始日に届かない／日数が少なすぎる場合は、書かずに失敗する", async () => {
  const late = scenarioBars("2026-03-02", "2026-10-07"); // 開始日 2026-01-05 に届かない
  const s = setup({ bars: late });
  try {
    const before = readAll(s.t.dataDir);
    await assert.rejects(s.run({ pageSize: 1000 }), /NZDUSD/);
    assert.deepEqual(readAll(s.t.dataDir), before);
    await assert.rejects(s.run({ pageSize: 1000, start: "2026-03-02", minRows: 10000 }), /日足が\d+日分しか作れませんでした/);
    assert.deepEqual(readAll(s.t.dataDir), before);
  } finally { s.t.cleanup(); }
});
