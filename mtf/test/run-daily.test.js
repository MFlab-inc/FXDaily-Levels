"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { runDaily } = require("../run-daily");
const { createClient } = require("../lib/twelvedata");
const store = require("../lib/store");
const { SYMBOLS } = require("../config");
const { scenarioRows, scenarioBars, fakeTwelveData, fakeClock, tmpData } = require("./helpers");

const KEY = "SECRETKEY123";
// 2026-10-06(火) 17:20 EDT = 21:20 UTC。この時点で確定している日は 2026-10-06
const NOW = Date.UTC(2026, 9, 6, 21, 20, 0);
const START = "2026-01-05";

function setup({ histEnd = "2026-10-05", dataEnd = "2026-10-07", failures = {}, only = null, skipCsv = [] } = {}) {
  const t = tmpData();
  // 履歴CSV（バックフィル済みの状態）。dataEnd までの1時間足は「今朝の取得結果」
  for (const s of SYMBOLS) {
    if (skipCsv.includes(s.code)) continue;
    store.writeAll(t.dataDir, [{ file: path.join("mtf", `ny-daily-${s.code}.csv`), content: store.toCsv(scenarioRows(s.code, START, histEnd).map((r) => ({ ...r, last_bar_ny: "16:00" }))) }]);
  }
  const bars = scenarioBars("2026-09-01", dataEnd);
  const f = fakeTwelveData(bars, { failures });
  const clock = fakeClock(NOW);
  const logs = [];
  const client = createClient({ apiKey: KEY, fetchImpl: f, sleep: clock.sleep, now: clock.now, spacingMs: 100 });
  return { t, f, clock, logs, client, run: (over = {}) => runDaily({ nowMs: NOW, dataDir: t.dataDir, client, log: (m) => logs.push(m), ...over }) };
}
const readJson = (t) => JSON.parse(fs.readFileSync(path.join(t.dataDir, "mtf-feed.json"), "utf8"));
const listData = (t) => fs.readdirSync(t.dataDir).sort();

test("6-2: 履歴CSVがまだ無ければ何もしない（Twelve Dataも呼ばず、CSVも作らず、成功で終わる）", async () => {
  const s = setup({ skipCsv: SYMBOLS.map((x) => x.code) });
  try {
    const r = await s.run();
    assert.equal(r.exitCode, 0);
    assert.equal(r.skipped, "no-history");
    assert.equal(s.f.calls.length, 0);
    assert.deepEqual(listData(s.t), ["mtf"].filter((n) => fs.existsSync(path.join(s.t.dataDir, n)))); // mtf/ が空ディレクトリで残っていても可
    assert.deepEqual(store.existingCsvFiles(s.t.dataDir), []);
    assert.ok(!fs.existsSync(path.join(s.t.dataDir, "mtf-feed.json")));
  } finally { s.t.cleanup(); }
});

test("6-2: 毎日の更新 — 最新の確定日を追記し、フィード(json/txt)を作る。形成途中の日(10/7)は入らない", async () => {
  const s = setup();
  try {
    const r = await s.run();
    assert.equal(r.exitCode, 0, JSON.stringify(r));
    for (const sym of SYMBOLS) {
      const rows = store.readRows(s.t.dataDir, sym.code);
      assert.equal(rows[rows.length - 1].date, "2026-10-06", sym.code);
      assert.equal(rows[rows.length - 1].bars, 24);
      assert.ok(!rows.some((x) => x.date > "2026-10-06"));
      assert.equal(rows.length, scenarioRows(sym.code, START, "2026-10-06").length);
    }
    const feed = readJson(s.t);
    assert.equal(feed.status, "ok");
    assert.equal(feed.data_base_date, "2026-10-06");
    assert.equal(feed.as_of, "2026-10-06");
    assert.equal(feed.attempt, 1);
    assert.ok(fs.existsSync(path.join(s.t.dataDir, "mtf-feed.txt")));
    assert.equal(s.f.calls.length, SYMBOLS.length); // 1銘柄1リクエスト
    assert.ok(s.f.calls.every((c) => c.outputsize === "1000" && c.timezone === "UTC" && c.interval === "1h"));
    // data/ には想定したファイルだけ。一時ファイルを data/ にも、その隣にも残さない
    assert.deepEqual(listData(s.t), ["mtf", "mtf-feed.json", "mtf-feed.txt"]);
    assert.deepEqual(fs.readdirSync(s.t.root).filter((n) => n.startsWith(".mtf-tmp-")), []);
    assert.equal(fs.readdirSync(path.join(s.t.dataDir, "mtf")).length, SYMBOLS.length);
  } finally { s.t.cleanup(); }
});

test("6-2: その日の分を作成済みなら何もしない（2回目はTwelve Dataを呼ばず、ファイルも変えない）", async () => {
  const s = setup();
  try {
    await s.run();
    const before = fs.readFileSync(path.join(s.t.dataDir, "mtf-feed.json"), "utf8");
    const callsBefore = s.f.calls.length;
    const r2 = await s.run({ nowMs: NOW + 3600000 }); // 1時間後（同じ基準日）
    assert.equal(r2.skipped, "done");
    assert.equal(s.f.calls.length, callsBefore);
    assert.equal(fs.readFileSync(path.join(s.t.dataDir, "mtf-feed.json"), "utf8"), before);
    // 翌日の基準日になれば、また作る
    const bars = scenarioBars("2026-09-01", "2026-10-08");
    const f2 = fakeTwelveData(bars);
    const clock = fakeClock(NOW);
    const c2 = createClient({ apiKey: KEY, fetchImpl: f2, sleep: clock.sleep, now: clock.now, spacingMs: 100 });
    const r3 = await runDaily({ nowMs: Date.UTC(2026, 9, 7, 21, 20), dataDir: s.t.dataDir, client: c2, log: () => {} });
    assert.equal(r3.exitCode, 0);
    assert.equal(readJson(s.t).data_base_date, "2026-10-07");
    assert.equal(f2.calls.length, SYMBOLS.length);
  } finally { s.t.cleanup(); }
});

test("1-2: 直近3日は取り直して上書きする（昨日の足が本数不足で保存されていても、翌日の更新で直る）", async () => {
  const s = setup();
  try {
    // 10/5 の保存値を「23本・終値が少し違う」状態にしておく
    for (const sym of SYMBOLS) {
      const rows = store.readRows(s.t.dataDir, sym.code).map((r) => (r.date === "2026-10-05" ? { ...r, bars: 23, close: r.close + 0.01 } : r));
      fs.writeFileSync(path.join(s.t.dataDir, "mtf", `ny-daily-${sym.code}.csv`), store.toCsv(rows));
    }
    await s.run();
    const rows = store.readRows(s.t.dataDir, "EURUSD");
    const d = rows.find((r) => r.date === "2026-10-05");
    assert.equal(d.bars, 24);
    const truth = scenarioRows("EURUSD", START, "2026-10-05").pop(); // 取り直した値（保存時の +0.01 のずれが消える）
    assert.equal(truth.date, "2026-10-05");
    assert.ok(Math.abs(d.close - truth.close) < 1e-5, `${d.close} vs ${truth.close}`);
  } finally { s.t.cleanup(); }
});

test("1-2: 直近3日より古い保存値は、取り直しで変わっても上書きしない", async () => {
  const s = setup();
  try {
    for (const sym of SYMBOLS) {
      const rows = store.readRows(s.t.dataDir, sym.code).map((r) => (r.date === "2026-09-15" ? { ...r, close: 12345 } : r));
      fs.writeFileSync(path.join(s.t.dataDir, "mtf", `ny-daily-${sym.code}.csv`), store.toCsv(rows));
    }
    await s.run();
    assert.equal(store.readRows(s.t.dataDir, "USDJPY").find((r) => r.date === "2026-09-15").close, 12345);
  } finally { s.t.cleanup(); }
});

test("6-2: 一部の銘柄が失敗 — 他は更新、失敗銘柄のCSVは変えない、終了コード1、フィードに error と前回の updated_at を残す", async () => {
  const s = setup({ failures: { "EUR/GBP": { kind: "500", times: 99 } } });
  try {
    // 前回のフィードがある状態にする（基準日は昨日）
    await s.run({ nowMs: Date.UTC(2026, 9, 5, 21, 20) }); // 基準日 10/5 で全銘柄成功させる…ただし失敗設定があるので EURGBP は失敗
    const prevFeed = readJson(s.t);
    assert.equal(prevFeed.status, "partial");
    const eurgbpBefore = fs.readFileSync(path.join(s.t.dataDir, "mtf", "ny-daily-EURGBP.csv"), "utf8");
    const r = await s.run(); // 基準日 10/6
    assert.equal(r.exitCode, 1);
    assert.match(r.failures[0], /EURGBP/);
    assert.equal(fs.readFileSync(path.join(s.t.dataDir, "mtf", "ny-daily-EURGBP.csv"), "utf8"), eurgbpBefore);
    const feed = readJson(s.t);
    const e = feed.symbols.find((x) => x.symbol === "EURGBP");
    assert.equal(e.status, "error");
    assert.ok(e.error.length > 0);
    assert.equal(e.updated_at, prevFeed.symbols.find((x) => x.symbol === "EURGBP").updated_at); // 失敗した銘柄の更新時刻は進めない
    assert.equal(feed.symbols.find((x) => x.symbol === "USDJPY").status, "ok");
    assert.equal(feed.data_base_date < "2026-10-06", true); // 古い銘柄があるので基準日は最新にならない
    assert.equal(feed.status, "partial");
    assert.ok(s.logs.some((l) => /::error::MTF: EURGBP/.test(l)));
  } finally { s.t.cleanup(); }
});

test("6-2: 未完了のときの再試行は、前回から20分以上空け、同じ基準日につき最大8回（以降は何もしない）", async () => {
  const s = setup({ failures: { "EUR/GBP": { kind: "500", times: 9999 } } });
  try {
    const seq = [];
    let callsAfterFirst = 0;
    // 0分・10分(クールダウン中)・25分・50分・75分… と進める
    const offsets = [0, 10, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250];
    for (const m of offsets) {
      const before = s.f.calls.length;
      const r = await s.run({ nowMs: NOW + m * 60000 });
      seq.push([m, r.skipped || "ran", s.f.calls.length - before]);
      if (m === 0) callsAfterFirst = s.f.calls.length;
    }
    assert.deepEqual(seq.map((x) => x[1]), ["ran", "cooldown", "ran", "ran", "ran", "ran", "ran", "ran", "ran", "attempts-exhausted", "attempts-exhausted", "attempts-exhausted"]);
    assert.equal(readJson(s.t).attempt, 8);
    // 2回目以降は、完了済みの銘柄を取り直さず、失敗した EURGBP の1回分（再試行を含む）だけ
    assert.equal(seq[0][2] >= 9, true);
    assert.ok(s.f.calls.slice(callsAfterFirst).every((c) => c.symbol === "EUR/GBP"), "完了済みの銘柄を取り直している");
    assert.equal(seq[1][2], 0); // クールダウン中はAPIを呼ばない
    assert.equal(seq[9][2], 0); // 上限後もAPIを呼ばない
  } finally { s.t.cleanup(); }
});

test("6-2: 最後の足が未着の日足（NY16時台の足が無い）は完了扱いにせず、後の実行で取り直して完了する", async () => {
  const s = setup();
  try {
    // 10/6 の最後の1時間足(NY 16:00)だけが無い1時間足
    const all = scenarioBars("2026-09-01", "2026-10-07");
    for (const td of Object.keys(all)) all[td] = all[td].filter((b) => b.datetime !== "2026-10-06 20:00:00");
    const f1 = fakeTwelveData(all);
    const clock = fakeClock(NOW);
    const c1 = createClient({ apiKey: KEY, fetchImpl: f1, sleep: clock.sleep, now: clock.now, spacingMs: 100 });
    const r1 = await runDaily({ nowMs: NOW, dataDir: s.t.dataDir, client: c1, log: () => {} });
    assert.equal(r1.exitCode, 0);
    assert.equal(r1.stale.length, SYMBOLS.length);
    const feed1 = readJson(s.t);
    assert.equal(feed1.status, "partial");
    assert.equal(feed1.symbols[0].status, "stale");
    assert.match(feed1.symbols[0].status_note, /最終の1時間足.*15:00/);
    // 提供元が最後の足を出した後の実行（20分以上後）
    const r2 = await s.run({ nowMs: NOW + 25 * 60000 });
    assert.equal(r2.exitCode, 0);
    assert.deepEqual(r2.stale, []);
    const feed2 = readJson(s.t);
    assert.equal(feed2.status, "ok");
    assert.equal(feed2.symbols[0].status, "ok");
    assert.equal(store.readRows(s.t.dataDir, "USDJPY").pop().bars, 24); // 取り直しで24本に
    assert.equal((await s.run({ nowMs: NOW + 60 * 60000 })).skipped, "done");
  } finally { s.t.cleanup(); }
});

test("6-2: 再試行で失敗した銘柄だけを取り直す（完了済みの銘柄はAPIを呼ばない）", async () => {
  const failures = { "EUR/GBP": { kind: "500", times: 99 } };
  const s = setup({ failures });
  try {
    await s.run();
    const n1 = s.f.calls.length;
    failures["EUR/GBP"].times = 0; // 復旧
    const r = await s.run({ nowMs: NOW + 30 * 60000 });
    assert.equal(r.exitCode, 0);
    const added = s.f.calls.slice(n1);
    assert.equal(added.length, 1);
    assert.equal(added[0].symbol, "EUR/GBP");
    assert.equal(readJson(s.t).status, "ok");
  } finally { s.t.cleanup(); }
});

test("6-2: 手順全体の時間制限 — 超えた銘柄は失敗として記録し、それでもファイルは書いて、試行回数も数える", async () => {
  const s = setup();
  try {
    const clock = fakeClock(NOW);
    const client = createClient({ apiKey: KEY, fetchImpl: s.f, sleep: clock.sleep, now: clock.now, spacingMs: 2500, deadlineAt: NOW + 6000 });
    const r = await runDaily({ nowMs: NOW, dataDir: s.t.dataDir, client, log: (m) => s.logs.push(m) });
    assert.equal(r.exitCode, 1);
    assert.ok(r.failures.length >= 5, `時間切れの銘柄が少ない: ${r.failures.length}`);
    assert.match(r.failures[r.failures.length - 1], /時間切れ/);
    const feed = readJson(s.t);
    assert.equal(feed.attempt, 1);
    assert.equal(feed.status, "partial");
    assert.ok(s.f.calls.length <= 4, `時間制限後もAPIを呼んでいる: ${s.f.calls.length}`);
    assert.ok(feed.symbols.some((x) => x.status === "ok")); // 間に合った銘柄は更新される
  } finally { s.t.cleanup(); }
});

test("堅牢性: 見出し行だけの履歴CSVは『空』として銘柄のエラーにする。形の違う前回フィードは無いものとして作り直す", async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.t.dataDir, "mtf", "ny-daily-AUDUSD.csv"), store.HEADER + "\n");
    fs.writeFileSync(path.join(s.t.dataDir, "mtf-feed.json"), JSON.stringify({ as_of: "2026-10-06", status: "ok", symbols: { not: "an array" } }));
    const r = await s.run();
    assert.equal(r.exitCode, 1);
    assert.match(r.failures.join("\n"), /AUDUSD: 履歴CSVが空/);
    assert.equal(readJson(s.t).symbols.find((x) => x.symbol === "AUDUSD").status, "error");
    assert.equal(readJson(s.t).symbols.find((x) => x.symbol === "USDJPY").status, "ok");
  } finally { s.t.cleanup(); }
});

test("6-2: 履歴CSVが無い銘柄は取り込まない・CSVを作らない（作ると過去分の取得が『データあり』で止まるため）", async () => {
  const s = setup({ skipCsv: ["XAUUSD"] });
  try {
    const r = await s.run();
    assert.equal(r.exitCode, 1);
    assert.ok(!fs.existsSync(path.join(s.t.dataDir, "mtf", "ny-daily-XAUUSD.csv")));
    assert.equal(s.f.calls.filter((c) => c.symbol === "XAU/USD").length, 0);
    assert.equal(readJson(s.t).symbols.find((x) => x.symbol === "XAUUSD").status, "error");
    assert.equal(store.existingCsvFiles(s.t.dataDir).length, SYMBOLS.length - 1);
  } finally { s.t.cleanup(); }
});

test("6-2: 取得は成功したが基準日の足が未公開（最新が前日）の銘柄 — 警告のみ・status=stale・次回の実行で再試行", async () => {
  const s = setup({ dataEnd: "2026-10-05" }); // 10/6 の足がまだ無い
  try {
    const r = await s.run();
    assert.equal(r.exitCode, 0);
    assert.equal(r.stale.length, SYMBOLS.length);
    const feed = readJson(s.t);
    assert.equal(feed.status, "partial");
    assert.equal(feed.data_base_date, "2026-10-05");
    assert.ok(s.logs.some((l) => /::warning::MTF: USDJPY/.test(l)));
    const callsBefore = s.f.calls.length;
    assert.equal((await s.run({ nowMs: NOW + 600000 })).skipped, "cooldown"); // 20分未満は見送り
    const r2 = await s.run({ nowMs: NOW + 25 * 60000 });
    assert.equal(r2.skipped, undefined); // 完了していないので、20分以上空ければ再試行する
    assert.ok(s.f.calls.length > callsBefore);
  } finally { s.t.cleanup(); }
});

test("基準日: 冬時間(EST)は NY17時=22:00 UTC。21:20 UTC(NY16:20)はまだ前日の分、22:20 UTC で当日分", async () => {
  const s = setup({ histEnd: "2026-12-07", dataEnd: "2026-12-09" });
  try {
    const bars = scenarioBars("2026-11-01", "2026-12-09");
    const f = fakeTwelveData(bars);
    const clock = fakeClock();
    const client = createClient({ apiKey: KEY, fetchImpl: f, sleep: clock.sleep, now: clock.now, spacingMs: 100 });
    // CSV を12/7 までに作り直す
    for (const sym of SYMBOLS) fs.writeFileSync(path.join(s.t.dataDir, "mtf", `ny-daily-${sym.code}.csv`), store.toCsv(scenarioRows(sym.code, START, "2026-12-07").map((r) => ({ ...r, last_bar_ny: "16:00" }))));
    const r1 = await runDaily({ nowMs: Date.UTC(2026, 11, 8, 21, 20), dataDir: s.t.dataDir, client, log: () => {} }); // 火曜 16:20 EST
    assert.equal(r1.asOf, "2026-12-07");
    const r2 = await runDaily({ nowMs: Date.UTC(2026, 11, 8, 22, 20), dataDir: s.t.dataDir, client, log: () => {} }); // 17:20 EST
    assert.equal(r2.asOf, "2026-12-08");
    assert.equal(readJson(s.t).data_base_date, "2026-12-08");
  } finally { s.t.cleanup(); }
});

test("APIキーはログ・フィード・CSVのどこにも出ない", async () => {
  const s = setup({ failures: { "EUR/USD": { kind: "throw", times: 99 }, "GBP/USD": { kind: "401", times: 99 } } });
  try {
    await s.run();
    const all = [s.logs.join("\n")];
    for (const f of fs.readdirSync(s.t.dataDir)) {
      const p = path.join(s.t.dataDir, f);
      if (fs.statSync(p).isFile()) all.push(fs.readFileSync(p, "utf8"));
    }
    assert.ok(!all.join("\n").includes(KEY));
  } finally { s.t.cleanup(); }
});

test("daily.yml の他の出力には触れない: data/ の既存ファイル（daily-levels.json など）は変更されない", async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.t.dataDir, "daily-levels.json"), '{"a":1}');
    fs.writeFileSync(path.join(s.t.dataDir, "gpt-feed.txt"), "feed");
    await s.run();
    assert.equal(fs.readFileSync(path.join(s.t.dataDir, "daily-levels.json"), "utf8"), '{"a":1}');
    assert.equal(fs.readFileSync(path.join(s.t.dataDir, "gpt-feed.txt"), "utf8"), "feed");
  } finally { s.t.cleanup(); }
});
