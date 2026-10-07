"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { run } = require("../run-daily");
const H = require("./helpers");

const noSleep = async () => {};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rates-test-"));
const readRates = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "rates.json"), "utf8"));

// URLごとに実データ（fixtures）を返す、差し替え用のfetch。fail に URL の断片 → HTTPステータスを入れると失敗させる
function server({ fail = {}, usCsv, mofMonth } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [frag, status] of Object.entries(fail)) if (url.includes(frag)) return new Response("x", { status });
    if (url.includes("daily-treasury-rates.csv")) return new Response(usCsv ?? H.usCsvText(), { status: 200 });
    if (url.includes("pages/xml")) return new Response(H.usXmlText(), { status: 200 });
    if (url.includes("jgbcm_all.csv")) return new Response(H.mofAllBytes(), { status: 200 });
    if (url.includes("jgbcm.csv")) return new Response(mofMonth ?? H.mofMonthBytes(), { status: 200, headers: { "last-modified": "Tue, 06 Oct 2026 23:30:14 GMT" } });
    if (url.includes("syukujitsu.csv")) return new Response(fs.readFileSync(path.join(H.ROOT, "jp-holidays.csv")), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}
const go = (dir, srv, nowStr, argv = []) => run({ argv, nowMs: H.jst(nowStr), fetchImpl: srv.fetchImpl, sleep: noSleep, dataDir: dir, log: () => {}, env: {} });

test("取得：10/7 10:00 に実行すると、米・日とも10/6まで揃い、金利差 +2.860%pt・5営業日差 −5.4bp・はっきりしない。FREDは使わない", async () => {
  const dir = tmp(), srv = server();
  assert.equal(await go(dir, srv, "2026-10-07 10:00"), 0);
  const r = readRates(dir);
  assert.equal(r.schema, "fxdaily-levels/rates/v1");
  assert.equal(r.as_of, "2026-10-07T10:00:00+09:00");
  assert.equal(r.us2y.value, 4.79); assert.equal(r.jp2y.value, 1.93);
  assert.equal(r.spread.value, 2.86);
  assert.equal(r.change_5d.spread.value_bp, -5.4);
  assert.equal(r.judgment.label, "はっきりしない");
  assert.equal(r.judgment.threshold_bp, 10);
  assert.equal(r.us2y.xml_check.status, "match");
  assert.deepEqual({ status: r.generation.status, complete: r.generation.complete, errors: r.generation.errors }, { status: "ok", complete: true, errors: [] });
  assert.equal(r.calendar_source, "cao_live+bundled");
  assert.match(r.citations.jp, /PDL1\.0/); assert.match(r.citations.us, /米財務省 Daily Treasury Par Yield Curve Rates/);
  assert.ok(srv.calls.length >= 5 && srv.calls.every((u) => !/fred|stlouisfed/i.test(u)), srv.calls.join("\n"));
  assert.ok(srv.calls.some((u) => u.includes("jgbcm_all.csv")), "月初で当月ファイルの行が少ないので、全期間ファイルも取る");
  assert.ok(!fs.existsSync(path.join(dir, "rates.json.tmp")));
});

test("--if-stale：最新で健全なら、外部へ接続せず終了する", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-07 10:00");
  const srv = server();
  assert.equal(await go(dir, srv, "2026-10-07 10:15", ["--if-stale"]), 0);
  assert.equal(srv.calls.length, 0);
});

test("--if-stale：日本の営業日の9:40前（公表前）は、データが無くても外部へ接続せず終了する", async () => {
  const dir = tmp(), srv = server();
  assert.equal(await go(dir, srv, "2026-10-07 09:39", ["--if-stale"]), 0);
  assert.equal(srv.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(dir, "rates.json")));
  // 手動実行（--if-stale なし）は公表前でも取得する
  assert.equal(await go(dir, srv, "2026-10-07 09:39"), 0);
  assert.ok(srv.calls.length > 0);
});

test("--if-stale：翌朝、rates.json が古ければ取得し直す。公表待ち（10:30前）は pending、10:30以降の古いままは partial", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-07 10:00");
  // 10/8 の朝：サーバーのファイルはまだ10/6まで（更新されていない）
  const srv = server();
  assert.equal(await go(dir, srv, "2026-10-08 10:00", ["--if-stale"]), 0);
  assert.ok(srv.calls.length > 0, "古いので取りに行く");
  let r = readRates(dir);
  assert.equal(r.generation.status, "pending");
  assert.equal(r.generation.retry_expected, true);
  assert.equal(r.judgment.label, "判定できません");
  assert.deepEqual(r.generation.errors, []);
  await go(dir, server(), "2026-10-08 10:45", ["--if-stale"]);
  r = readRates(dir);
  assert.equal(r.generation.status, "partial");
  assert.equal(r.judgment.label, "判定できません");
});

test("米・日ともに取得できない：rates.json を作らない／更新しない。終了コード1", async () => {
  const dir = tmp();
  const srv = server({ fail: { "treasury.gov": 500, "mof.go.jp": 500 } });
  assert.equal(await go(dir, srv, "2026-10-07 10:00"), 1);
  assert.ok(!fs.existsSync(path.join(dir, "rates.json")));
  // 前回のファイルがあれば、そのまま残す
  await go(dir, server(), "2026-10-07 10:00");
  const before = fs.readFileSync(path.join(dir, "rates.json"), "utf8");
  assert.equal(await go(dir, srv, "2026-10-08 10:45"), 1);
  assert.equal(fs.readFileSync(path.join(dir, "rates.json"), "utf8"), before);
});

test("米だけ取得できない：前回の米2年を stale で残し、日は更新する。判定は判定できません。status=partial", async () => {
  const dir = tmp();
  await go(dir, server({ usCsv: H.usCsvText().replace(/^10\/06\/2026.*\n/m, "") }), "2026-10-06 10:00"); // 10/6 朝の状態：米は10/5まで
  // 10/7 10:00：米財務省が503
  const srv = server({ fail: { "treasury.gov": 503 } });
  assert.equal(await go(dir, srv, "2026-10-07 10:00"), 0);
  const r = readRates(dir);
  assert.equal(r.us2y.stale, true);
  assert.equal(r.us2y.date, "2026-10-05");
  assert.equal(r.jp2y.date, "2026-10-06"); assert.equal(r.jp2y.stale, false);
  assert.equal(r.judgment.label, "判定できません");
  assert.equal(r.generation.status, "partial");
  assert.match(r.generation.errors[0], /us2y: 米財務省CSVの取得・解析に失敗/);
});

test("財務省のXMLだけ取得できない：CSVを採用し、照合は「未実施」と記録する", async () => {
  const dir = tmp();
  await go(dir, server({ fail: { "pages/xml": 500 } }), "2026-10-07 10:00");
  const r = readRates(dir);
  assert.equal(r.us2y.xml_check.status, "unavailable");
  assert.equal(r.generation.status, "ok");
  assert.equal(r.judgment.label, "はっきりしない");
});

test("内閣府の祝日CSVを取得できない：同梱の祝日表で続行する", async () => {
  const dir = tmp();
  await go(dir, server({ fail: { "syukujitsu.csv": 500 } }), "2026-10-07 10:00");
  const r = readRates(dir);
  assert.equal(r.calendar_source, "bundled");
  assert.equal(r.judgment.label, "はっきりしない");
});

test("内容が変わらない再取得では rates.json を書き換えない（コミットを増やさない）", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-07 10:00");
  const before = fs.readFileSync(path.join(dir, "rates.json"), "utf8");
  assert.equal(await go(dir, server(), "2026-10-07 10:20"), 0);
  assert.equal(fs.readFileSync(path.join(dir, "rates.json"), "utf8"), before);
  assert.equal(readRates(dir).as_of, "2026-10-07T10:00:00+09:00");
});

test("形式が変わったファイル（財務省CSVの列名変更）は、取得の失敗として扱う（黙って採用しない）", async () => {
  const dir = tmp();
  const srv = server({ usCsv: H.usCsvText().replace('"2 Yr"', '"2 Year"') });
  assert.equal(await go(dir, srv, "2026-10-07 10:00"), 0);
  const r = readRates(dir);
  assert.equal(r.us2y, null);
  assert.match(r.generation.errors[0], /us2y: 米財務省CSVの取得・解析に失敗: 財務省CSV: 列名に Date または 2 Yr がありません/);
  assert.equal(r.judgment.label, "判定できません");
});

test("--check-fresh：最新なら0、公表待ちなら0、古ければ1（外部へ接続しない）", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-07 10:00");
  const srv = server();
  assert.equal(await go(dir, srv, "2026-10-07 12:00", ["--check-fresh"]), 0);
  assert.equal(await go(dir, srv, "2026-10-08 10:10", ["--check-fresh"]), 0);  // 10/8 の公表待ち（10:30前）
  assert.equal(await go(dir, srv, "2026-10-08 10:40", ["--check-fresh"]), 1);  // 10:30を過ぎても古い
  assert.equal(await go(tmp(), srv, "2026-10-08 10:40", ["--check-fresh"]), 1); // rates.json が無い
  assert.equal(srv.calls.length, 0);
});
