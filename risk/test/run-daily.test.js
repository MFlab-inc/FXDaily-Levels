"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { run } = require("../run-daily");
const H = require("./helpers");

const noSleep = async () => {};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "risk-test-"));
const readRisk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "risk.json"), "utf8"));

// Cboe の URL に、試験用の CSV を返す差し替えの fetch
function server({ to = "2026-10-29", status = 200, body } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (!url.includes("cdn-api.cboe.com")) return new Response("not found", { status: 404 });
    if (status !== 200) return new Response("x", { status });
    return new Response(body ?? H.toCboeCsv(H.syntheticRows("2024-06-03", to)), { status: 200, headers: { "last-modified": "Thu, 29 Oct 2026 22:05:00 GMT" } });
  };
  return { fetchImpl, calls };
}
const go = (dir, srv, now, argv = [], logs = []) =>
  run({ argv, nowMs: H.jst(now), fetchImpl: srv.fetchImpl, sleep: noSleep, dataDir: dir, log: (m) => logs.push(m), env: {} });

test("取得：10/30 10:00 に実行すると、VIX は 10/29 まで・順位は素朴な計算と一致。イベント警戒は High（3件）", async () => {
  const dir = tmp(), srv = server();
  assert.equal(await go(dir, srv, "2026-10-30 10:00"), 0);
  const r = readRisk(dir);
  assert.equal(r.schema, "fxdaily-levels/risk/v1");
  assert.equal(r.as_of, "2026-10-30T10:00:00+09:00");
  const rows = H.syntheticRows("2024-06-03", "2026-10-29");
  const closes = rows.map((x) => x.close);
  assert.equal(r.vix.date, "2026-10-29");
  assert.equal(r.vix.rank_pct, H.naiveRank(closes, closes.length - 1, 252));
  assert.equal(r.vix.threshold_pct, 70);
  assert.equal(r.vix.history.length, 60);
  assert.equal(r.vix.source.url, "https://cdn-api.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv");
  assert.equal(r.vix.source.last_modified, "Thu, 29 Oct 2026 22:05:00 GMT");
  assert.equal(r.event.level, "High");
  assert.equal(r.event.count, 3);
  assert.equal(r.event.base_jst, "2026-10-30T09:00+09:00");
  assert.equal(r.generation.status, "ok");
  assert.deepEqual(r.generation.errors, []);
  assert.equal(srv.calls.length, 1);
  assert.ok(srv.calls.every((u) => !u.includes("stlouisfed")), "FRED は使わない");
});

test("--if-stale：VIX が最新で、イベント警戒も今日の分なら、接続せず・書き換えない", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-30 10:00");
  const before = fs.readFileSync(path.join(dir, "risk.json"), "utf8");
  const srv = server(), logs = [];
  assert.equal(await go(dir, srv, "2026-10-30 13:00", ["--if-stale"], logs), 0);
  assert.equal(srv.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, "risk.json"), "utf8"), before);
  assert.match(logs.join("\n"), /スキップ/);
});

test("--if-stale：日曜（VIX は金曜の値で最新）は接続せず、イベント警戒だけ数え直して書き換える", async () => {
  const dir = tmp();
  await go(dir, server({ to: "2026-10-30" }), "2026-10-31 10:00");
  const srv = server({ to: "2026-10-30" });
  assert.equal(await go(dir, srv, "2026-11-01 10:00", ["--if-stale"]), 0);
  assert.equal(srv.calls.length, 0);
  const r = readRisk(dir);
  assert.equal(r.vix.date, "2026-10-30");
  assert.equal(r.event.base_jst, "2026-11-01T09:00+09:00");
});

test("--if-stale：翌朝（VIX の期待する日が進んだ）は取得する。掲載前（更新待ち）でも取得し直す", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-30 10:00");
  const srv = server({ to: "2026-10-30" });
  assert.equal(await go(dir, srv, "2026-10-31 10:00", ["--if-stale"]), 0);
  assert.equal(srv.calls.length, 1);
  assert.equal(readRisk(dir).vix.date, "2026-10-30");
  // Cboe がまだ 10/30 を載せていない（10/29 まで）→ 内容は同じなので書き換えず、終了コードは0
  const dir2 = tmp();
  await go(dir2, server(), "2026-10-30 10:00");
  const srv2 = server({ to: "2026-10-29" }), logs = [];
  assert.equal(await go(dir2, srv2, "2026-10-31 10:00", ["--if-stale"], logs), 0);
  assert.equal(srv2.calls.length, 1);
  assert.equal(readRisk(dir2).vix.date, "2026-10-29");
});

test("取得の失敗（HTTP 403）：VIX は前回の値のまま、イベント警戒は更新し、失敗を記録して終了コード1", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-30 10:00");
  const logs = [];
  assert.equal(await go(dir, server({ status: 403 }), "2026-10-31 10:00", [], logs), 1);
  const r = readRisk(dir);
  assert.equal(r.vix.date, "2026-10-29");
  assert.equal(r.event.base_jst, "2026-10-31T09:00+09:00");
  assert.equal(r.generation.status, "error");
  assert.match(r.generation.errors[0], /HTTP 403/);
  assert.match(logs.join("\n"), /前回の値のまま/);
});

test("初回で取得に失敗：VIX は null のまま記録し、終了コード1。--check-fresh は STALE", async () => {
  const dir = tmp();
  assert.equal(await go(dir, server({ status: 500 }), "2026-10-30 10:00"), 1);
  const r = readRisk(dir);
  assert.equal(r.vix, null);
  assert.equal(r.event.level, "High");
  assert.equal(await go(dir, server(), "2026-10-30 10:05", ["--check-fresh"]), 1);
});

test("形式の変化（見出しが違う）・未来の日付は失敗として記録し、VIX は前回の値のまま", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-30 10:00");
  assert.equal(await go(dir, server({ body: "Date,Price\n10/30/2026,17\n" }), "2026-10-31 10:00"), 1);
  assert.match(readRisk(dir).generation.errors[0], /形式が想定と違います/);
  const dir2 = tmp();
  assert.equal(await go(dir2, server({ to: "2026-11-02" }), "2026-10-30 10:00"), 1);
  assert.match(readRisk(dir2).generation.errors[0], /より先です/);
});

test("内容が同じなら書き換えない（as_of・取得時刻だけの違いではコミットを作らない）", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-30 10:00");
  const before = fs.readFileSync(path.join(dir, "risk.json"), "utf8");
  assert.equal(await go(dir, server(), "2026-10-30 11:00"), 0); // --if-stale なしで取得し直す
  assert.equal(fs.readFileSync(path.join(dir, "risk.json"), "utf8"), before);
});

test("--check-fresh：OK／PENDING（掲載待ち）／STALE（16時間を過ぎた・イベント警戒が別の日）", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-30 10:00");
  const check = async (now) => { const logs = []; const code = await go(dir, server(), now, ["--check-fresh"], logs); return { code, out: logs.join("\n") }; };
  let c = await check("2026-10-30 12:00");
  assert.equal(c.code, 0); assert.match(c.out, /^OK: VIX は 2026-10-29 まで/m);
  // 10/31 07:30（米東部 10/30 18:30）：10/30 の値の掲載待ち。ただしイベント警戒は 10/31 の分が無い → STALE
  c = await check("2026-10-31 07:30");
  assert.match(c.out, /^PENDING: VIX は 2026-10-29 まで（2026-10-30 の値の掲載待ち）/m);
  assert.equal(c.code, 1);
  assert.match(c.out, /^STALE: イベント警戒/m);
  // 10/31 の分を書いたあと：VIX は掲載待ちのまま（10/31 23:00＝米東部 10/31 10:00 までは PENDING）
  await go(dir, server({ to: "2026-10-29" }), "2026-10-31 07:30", ["--if-stale"]);
  c = await check("2026-10-31 22:59");
  assert.equal(c.code, 0); assert.match(c.out, /^PENDING/m);
  c = await check("2026-10-31 23:00");
  assert.equal(c.code, 1); assert.match(c.out, /^STALE: VIX は 2026-10-29 まで。2026-10-30 の値が/m);
});

test("risk.json に書くのは data フォルダの risk.json だけ（他のファイルを作らない）", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-30 10:00");
  assert.deepEqual(fs.readdirSync(dir), ["risk.json"]);
});
