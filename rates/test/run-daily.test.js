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

test("retry_note：status と時刻に合った文言になる（14時以降も workflow_run による再取得は続きうる）", async () => {
  // 健全（ok）：再試行は不要
  const okDir = tmp();
  await go(okDir, server(), "2026-10-07 10:00");
  let r = readRates(okDir);
  assert.equal(r.generation.status, "ok");
  assert.equal(r.generation.retry_expected, false);
  assert.match(r.generation.retry_note, /再試行は不要/);
  assert.doesNotMatch(r.generation.retry_note, /残っていない/);
  // 10:45 でも古いまま（partial）で JST 14時前：schedule の再試行も workflow_run も残っている
  const dir = tmp();
  await go(dir, server(), "2026-10-07 10:00");
  await go(dir, server(), "2026-10-08 10:45", ["--if-stale"]);
  r = readRates(dir);
  assert.equal(r.generation.status, "partial");
  assert.equal(r.generation.retry_expected, true);
  assert.match(r.generation.retry_note, /再試行が残っている/);
  assert.match(r.generation.retry_note, /完了のたびの起動もある/);
  // 同じく古いまま JST 14時以降：schedule の再試行は終わったが、workflow_run による再取得は続きうる
  await go(dir, server(), "2026-10-08 14:30", ["--if-stale"]);
  r = readRates(dir);
  assert.equal(r.generation.status, "partial");
  assert.equal(r.generation.retry_expected, false);
  assert.match(r.generation.retry_note, /schedule による同日中の再試行は終わっている/);
  assert.match(r.generation.retry_note, /workflow_run/);
  assert.doesNotMatch(r.generation.retry_note, /自動の再試行は残っていない/, "「自動の再試行は無い」とは言い切らない");
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

// ---- 年初（年をまたぐ）：2027年のCSVは、最初の行が出るまで本文が空のHTTP 200で返る ----
const cal = require("../lib/calendar");
const { addDays } = require("../../mtf/lib/ny-time");
const holidays = H.holidays();
const days = (from, to, isOpen) => { const o = []; for (let d = from; d <= to; d = addDays(d, 1)) if (isOpen(d)) o.push(d); return o; };
const mmddyyyy = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const usCsv = (dates) => `Date,"2 Yr"\n${[...dates].reverse().map((d, i) => `${mmddyyyy(d)},${(4 + (dates.length - 1 - i) * 0.01).toFixed(2)}`).join("\n")}\n`;
// 当月ファイル（Shift_JIS）：実ファイルの先頭2行（タイトル・列名）に、ASCIIの行を足す
const mofBytes = (jpDates) => {
  const head = H.mofMonthBytes();
  const lines = []; let at = 0;
  for (let n = 0; n < 2; n++) { const i = head.indexOf(0x0a, at); lines.push(head.subarray(at, i + 1)); at = i + 1; }
  const wareki = (d) => `R${Number(d.slice(0, 4)) - 2018}.${Number(d.slice(5, 7))}.${Number(d.slice(8, 10))}`;
  const rows = jpDates.map((d, i) => `${wareki(d)},1.0,${(1.5 + i * 0.002).toFixed(3)},2.0,2.1,2.2,2.3,2.4,2.5,2.6,2.7,2.8,2.9,3.0,3.1,3.2\r\n`).join("");
  return Buffer.concat([...lines, Buffer.from(rows)]);
};
const isUsOpen = (d) => cal.usClosure(d) === "open";
const isJpOpen = (d) => cal.isJpBusinessDay(d, holidays);
function yearEndServer({ csv2027 = "" } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/2027/all")) return new Response(csv2027, { status: 200 });                 // 2027年：行が無く、本文が空
    if (url.includes("daily-treasury-rates.csv")) return new Response(usCsv(days("2026-01-02", "2026-12-31", isUsOpen)), { status: 200 });
    if (url.includes("pages/xml")) return new Response("", { status: 200 });                       // XMLも空（照合は未実施になる）
    if (url.includes("jgbcm_all.csv")) return new Response("", { status: 500 });
    if (url.includes("jgbcm.csv")) return new Response(mofBytes(days("2026-12-01", "2026-12-30", isJpOpen)), { status: 200 });
    if (url.includes("syukujitsu.csv")) return new Response(fs.readFileSync(path.join(H.ROOT, "jp-holidays.csv")), { status: 200 });
    return new Response("", { status: 404 });
  };
  return { fetchImpl, calls };
}

test("年初：2027年のCSVが空本文でも、前年のCSVで取得できる（1/4 月曜の朝。米は12/31、日は12/30が最新）", async () => {
  const dir = tmp(), srv = yearEndServer();
  assert.equal(await go(dir, srv, "2027-01-04 10:00"), 0);
  const r = readRates(dir);
  assert.deepEqual(r.generation.errors, []);
  assert.equal(r.us2y.date, "2026-12-31"); assert.equal(r.jp2y.date, "2026-12-30");
  assert.equal(r.us2y.fresh, true); assert.equal(r.jp2y.fresh, true);
  assert.equal(r.judgment.available, true, r.judgment.reason);
  assert.equal(r.generation.status, "ok");
  assert.ok(srv.calls.some((u) => u.includes("/2026/all")) && srv.calls.some((u) => u.includes("/2027/all")));
});

test("年初：元日（1/1 金曜）の朝（日本）は、米東部がまだ12/31なので、2026年のCSVだけで足りる（2027年のCSVは取らない）", async () => {
  const dir = tmp(), srv = yearEndServer();
  await go(dir, srv, "2027-01-01 10:00");
  const r = readRates(dir);
  assert.deepEqual(r.generation.errors, []);
  assert.equal(r.us2y.date, "2026-12-31");
  assert.ok(!srv.calls.some((u) => u.includes("/2027/all")));
});

test("年初：2027年のCSVに1行（1/4）だけあるとき（1/5 火曜の朝）は、前年と合わせて5営業日差まで出す", async () => {
  const dir = tmp();
  const srv = yearEndServer({ csv2027: usCsv(["2027-01-04"]) });
  await go(dir, srv, "2027-01-05 10:00");
  const r = readRates(dir);
  assert.equal(r.us2y.date, "2027-01-04");
  assert.equal(r.change_5d.us.base_date, "2026-12-24");     // 5営業日前（12/25は休場）
  assert.deepEqual(r.generation.errors.filter((e) => e.startsWith("us2y")), []);
});

test("全体で1行も無ければ（年初の2つの年とも空）、取得の失敗として扱う", async () => {
  const dir = tmp();
  const fetchImpl = async (url) => (url.includes("daily-treasury-rates.csv") ? new Response("", { status: 200 }) : new Response("", { status: 500 }));
  assert.equal(await run({ argv: [], nowMs: H.jst("2027-01-04 10:00"), fetchImpl, sleep: noSleep, dataDir: dir, log: () => {}, env: {} }), 1);
});

test("全期間ファイルを取得できず当月の行が足りないとき：判定できません。取得の問題（partial）として記録する", async () => {
  const dir = tmp();
  await go(dir, server({ fail: { "jgbcm_all.csv": 503 } }), "2026-10-07 10:00");
  const r = readRates(dir);
  assert.equal(r.judgment.label, "判定できません");
  assert.equal(r.generation.status, "partial");
  assert.match(r.generation.errors.join("\n"), /jp2y: 全期間ファイルを取得できませんでした/);
});

test("内閣府の祝日CSVの取得の成否（calendar_source）だけが違う再取得では、rates.json を書き換えない", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-07 10:00");
  const before = fs.readFileSync(path.join(dir, "rates.json"), "utf8");
  assert.equal(readRates(dir).calendar_source, "cao_live+bundled");
  await go(dir, server({ fail: { "syukujitsu.csv": 500 } }), "2026-10-07 10:20");
  assert.equal(fs.readFileSync(path.join(dir, "rates.json"), "utf8"), before);
});

test("境界：--if-stale は 9:40 ちょうどから取得する（9:39 は公表前でスキップ）", async () => {
  const early = server(), on = server();
  await go(tmp(), early, "2026-10-07 09:39", ["--if-stale"]);
  await go(tmp(), on, "2026-10-07 09:40", ["--if-stale"]);
  assert.equal(early.calls.length, 0);
  assert.ok(on.calls.length > 0);
});

test("--check-fresh：同梱の祝日表が来年分まであれば（2026年は2027年まで）、警告は出さない", async () => {
  const dir = tmp(), lines = [];
  await go(dir, server(), "2026-10-07 10:00");
  const code = await run({ argv: ["--check-fresh"], nowMs: H.jst("2026-10-07 12:00"), fetchImpl: server().fetchImpl, sleep: noSleep, dataDir: dir, log: (m) => lines.push(m), env: {} });
  assert.equal(code, 0);
  assert.ok(!lines.some((l) => l.startsWith("::warning")));
});
