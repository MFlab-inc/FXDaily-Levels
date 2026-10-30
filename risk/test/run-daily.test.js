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
  // 公開リポジトリに Cboe の終値を置かない（順位と個数だけ。SPEC 6節）
  assert.ok(!/"close"/.test(fs.readFileSync(path.join(dir, "risk.json"), "utf8")));
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

test("NYSE の休場日の行は使わない（Cboe のファイルには米国の祝日にも行がある。2026-10-30 の実データで確認）", async () => {
  const open = H.syntheticRows("2024-06-03", "2026-10-29");
  // 休場日の行を足す（実データで見つかった日の一部）。値は極端にして、混ざれば順位が変わるようにする
  const holidays = ["2025-11-27", "2026-01-19", "2026-09-07"];
  const all = [...open, ...holidays.map((date) => ({ date, close: 99 }))].sort((a, b) => (a.date < b.date ? -1 : 1));
  const dir = tmp();
  assert.equal(await go(dir, server({ body: H.toCboeCsv(all) }), "2026-10-30 10:00"), 0);
  const r = readRisk(dir);
  const closes = open.map((x) => x.close);
  assert.equal(r.vix.rank_pct, H.naiveRank(closes, closes.length - 1, 252));
  assert.equal(r.vix.window_start, open[open.length - 252].date);
  assert.deepEqual(r.vix.excluded_closed_days, holidays);
  assert.ok(!r.vix.history.some((h) => holidays.includes(h.date)));
  assert.deepEqual(r.vix.warnings, []);
  assert.equal(r.generation.status, "ok");
});

test("最新の行が休場日（労働者の日）なら、その前の営業日を最新とする", async () => {
  const open = H.syntheticRows("2024-06-03", "2026-09-04");
  const all = [...open, { date: "2026-09-07", close: 30 }];
  const dir = tmp();
  assert.equal(await go(dir, server({ body: H.toCboeCsv(all) }), "2026-09-08 10:00"), 0);
  assert.equal(readRisk(dir).vix.date, "2026-09-04");
  assert.equal(await go(dir, server(), "2026-09-08 10:05", ["--check-fresh"]), 0);
});

test("配信元から古い版が返っても、前回より古い日付には戻さない（前回の値を残し、警告に記録。終了コード0）", async () => {
  const dir = tmp();
  await go(dir, server({ to: "2026-10-30" }), "2026-10-31 10:00");
  const logs = [];
  assert.equal(await go(dir, server({ to: "2026-10-27" }), "2026-10-31 10:30", [], logs), 0);
  const r = readRisk(dir);
  assert.equal(r.vix.date, "2026-10-30");
  assert.equal(r.generation.status, "warning");
  assert.match(r.generation.warnings.join("\n"), /前回（2026-10-30）より古いため、前回の値を残しました/);
});

test("期待する最新日より新しい行（米国の取引時間中の途中の値かもしれない）は使わない。18:00 を過ぎたら取り直す", async () => {
  const dir = tmp();
  // 10/30 03:00 JST＝米東部 10/29 14:00。ファイルに 10/29 の行があっても、期待する最新日は 10/28
  assert.equal(await go(dir, server({ to: "2026-10-29" }), "2026-10-30 03:00"), 0);
  let r = readRisk(dir);
  assert.equal(r.vix.date, "2026-10-28");
  assert.deepEqual(r.vix.unconfirmed_rows_ignored, ["2026-10-29"]);
  // 米東部 18:00 を過ぎた（10/30 07:00 JST）--if-stale は、10/29 が無いので取り直す
  const srv = server({ to: "2026-10-29" });
  assert.equal(await go(dir, srv, "2026-10-30 07:00", ["--if-stale"]), 0);
  assert.equal(srv.calls.length, 1);
  r = readRisk(dir);
  assert.equal(r.vix.date, "2026-10-29");
  assert.deepEqual(r.vix.unconfirmed_rows_ignored, []);
});

test("失敗の文に、CSV の行の中身や値を入れない（risk.json は公開される）", async () => {
  const rows = H.syntheticRows("2024-01-02", "2026-10-29");
  const lines = H.toCboeCsv(rows).trim().split("\n");
  lines.splice(1, 0, "06/03/1990,20.123456,20.123456,20.123456,oops"); // 古い側の壊れた行 → 飛ばして警告
  const dir = tmp();
  assert.equal(await go(dir, server({ body: lines.join("\n") }), "2026-10-30 10:00"), 0);
  let text = fs.readFileSync(path.join(dir, "risk.json"), "utf8");
  assert.match(text, /形式の問題で飛ばしました/);
  assert.ok(!text.includes("20.123456") && !text.includes("oops"));
  // 新しい側の壊れた行 → 失敗の記録
  const lines2 = H.toCboeCsv(rows).trim().split("\n");
  lines2[lines2.length - 1] = "10/29/2026,17.654321,17.654321,17.654321,999.987654";
  const dir2 = tmp();
  assert.equal(await go(dir2, server({ body: lines2.join("\n") }), "2026-10-30 10:00"), 1);
  text = fs.readFileSync(path.join(dir2, "risk.json"), "utf8");
  assert.match(text, /想定の範囲/);
  assert.ok(!text.includes("17.654321") && !text.includes("999.987654"));
});

test("失敗の記録が残っていれば、同じ日の --if-stale でもスキップせずに作り直し、記録を消す", async () => {
  const dir = tmp();
  await go(dir, server(), "2026-10-30 10:00");
  assert.equal(await go(dir, server({ status: 403 }), "2026-10-30 10:30"), 1); // 手動の強制取得が失敗
  assert.equal(readRisk(dir).generation.status, "error");
  const srv = server();
  assert.equal(await go(dir, srv, "2026-10-30 11:00", ["--if-stale"]), 0);
  assert.equal(srv.calls.length, 0); // VIX は最新なので取りに行かない
  const r = readRisk(dir);
  assert.equal(r.generation.status, "ok");
  assert.deepEqual(r.generation.errors, []);
  assert.equal(r.vix.date, "2026-10-29");
});

test("順位の範囲に、営業日なのに行が無い日があれば警告する", async () => {
  const rows = H.syntheticRows("2024-06-03", "2026-10-29").filter((r) => r.date !== "2026-10-14");
  const dir = tmp();
  assert.equal(await go(dir, server({ body: H.toCboeCsv(rows) }), "2026-10-30 10:00"), 0);
  const r = readRisk(dir);
  assert.equal(r.generation.status, "warning");
  assert.match(r.vix.warnings.join("\n"), /行が無い日があります：2026-10-14/);
});

test("イベント警戒が unknown（予定表が足りない）なら、--check-fresh は STALE", async () => {
  const dir = tmp();
  assert.equal(await go(dir, server({ to: "2027-11-26" }), "2027-11-29 10:00"), 0);
  const r = readRisk(dir);
  assert.equal(r.event.level, "unknown");
  const logs = [];
  assert.equal(await go(dir, server(), "2027-11-29 10:05", ["--check-fresh"], logs), 1);
  assert.match(logs.join("\n"), /^STALE: イベント警戒：unknown/m);
});
