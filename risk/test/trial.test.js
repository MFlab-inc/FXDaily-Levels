"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const T = require("../lib/trial");
const { run, trialNeedsRefresh } = require("../run-daily");
const H = require("./helpers");

const TEN = ["2 Yr", "5 Yr", "10 Yr", "30 Yr"];

test("米財務省のCSV（実データの切り出し）：4つの年限を bp の整数で、古い順に読む", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "..", "rates", "test", "fixtures", "ust-2026-tail.csv"), "utf8");
  const rows = T.parseParYieldCsv(text, TEN);
  assert.equal(rows[0].date, "2026-07-01");
  const last = rows[rows.length - 1];
  assert.equal(last.date, "2026-10-06");
  assert.deepEqual(last.bp, { "2 Yr": 479, "5 Yr": 503, "10 Yr": 527, "30 Yr": 564 });
  assert.throws(() => T.parseParYieldCsv('Date,"2 Yr"\n10/06/2026,4.79\n', TEN), /列名/);
  assert.deepEqual(T.parseParYieldCsv("", TEN, { allowEmpty: true }), []);
});

test("実際の値動きの大きさ：年限ごとの1日の変化（bp）の二乗平均平方根を、4つの年限で平均する。素朴な計算と一致", () => {
  const rows = H.syntheticYields("2025-01-01", "2025-06-30");
  const lb = 20;
  const s = T.realizedVolSeries(rows, TEN, lb);
  assert.equal(s.length, rows.length - lb);
  for (const k of [0, 7, s.length - 1]) {
    const i = k + lb;
    let sum = 0;
    for (const t of TEN) {
      const d = [];
      for (let j = i - lb + 1; j <= i; j++) d.push(rows[j].bp[t] - rows[j - 1].bp[t]);
      sum += Math.sqrt(d.reduce((a, x) => a + x * x, 0) / lb);
    }
    assert.ok(Math.abs(s[k].value - sum / 4) < 1e-9, k);
    assert.equal(s[k].date, rows[i].date);
  }
});

test("実際の値動きの大きさ：1つの年限でも値が無い日は、その日ごと使わない（前後の日をつないで数える）", () => {
  const rows = H.syntheticYields("2025-01-01", "2025-03-31");
  const holed = rows.map((r, i) => (i === 30 ? { date: r.date, bp: { ...r.bp, "30 Yr": null } } : r));
  const a = T.realizedVolSeries(holed, TEN, 20);
  const b = T.realizedVolSeries(rows.filter((_, i) => i !== 30), TEN, 20);
  assert.deepEqual(a, b);
});

test("順位：最新と直近の履歴。値を載せるかを選べる", () => {
  const series = Array.from({ length: 300 }, (_, i) => ({ date: `d${String(i).padStart(3, "0")}`, value: (i * 37) % 101 }));
  const a = T.rankSnapshot(series, { window: 252, thresholdPct: 80, historyN: 5, keepValue: true });
  assert.equal(a.window_start, "d048");
  assert.equal(a.history.length, 5);
  assert.ok("value" in a && "value" in a.history[0]);
  assert.equal(a.rank_pct, H.naiveRank(series.map((x) => x.value), 299, 252));
  const b = T.rankSnapshot(series, { window: 52, thresholdPct: 70, historyN: 3, keepValue: false });
  assert.ok(!("value" in b) && !("value" in b.history[0]));
  assert.match(T.rankSnapshot(series.slice(0, 10), { window: 52, thresholdPct: 70, historyN: 3 }).error, /足りません/);
});

test("HY OAS の代わりの候補（CP 金利差・NFCI）は計算しない（2026-11-02 決定。SPEC 10-2）", () => {
  const cfg = require("../config");
  assert.deepEqual(Object.keys(cfg.TRIAL).sort(), ["minRefetchMinutes", "ratesVol", "staleDays"]);
  assert.deepEqual(Object.keys(T).sort(), ["TrialError", "parseParYieldCsv", "rankSnapshot", "realizedVolSeries"]);
});

// ---------- run-daily との結合 ----------
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "risk-trial-"));
const readRisk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "risk.json"), "utf8"));
function server({ to = "2026-10-29", fail = {} } = {}) {
  const calls = [];
  const yields = H.syntheticYields("2023-06-01", to);
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [frag, st] of Object.entries(fail)) if (url.includes(frag)) return new Response("x", { status: st });
    if (url.includes("daily-treasury-rates.csv/")) return new Response(H.toTreasuryCsv(yields, /csv\/(\d{4})\//.exec(url)[1]), { status: 200 });
    if (url.includes("cdn-api.cboe.com")) return new Response(H.toCboeCsv(H.syntheticRows("2024-06-03", to)), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls, n: (frag) => calls.filter((u) => u.includes(frag)).length };
}
const go = (dir, srv, now, argv = [], logs = []) =>
  run({ argv, nowMs: H.jst(now), fetchImpl: srv.fetchImpl, sleep: async () => {}, dataDir: dir, log: (m) => logs.push(m), env: {} });

test("試し運転の指標（米国債の値動き）を risk.json の trial に出す", async () => {
  const dir = tmp(), srv = server();
  assert.equal(await go(dir, srv, "2026-10-30 10:00"), 0);
  const t = readRisk(dir).trial;
  assert.match(t.note, /試し運転/);
  assert.equal(t.rates_vol.date, "2026-10-29");
  assert.equal(t.rates_vol.threshold_pct, 80);
  assert.equal(t.rates_vol.window, 252);
  assert.equal(t.rates_vol.history.length, 60);
  assert.equal(typeof t.rates_vol.value, "number");
  assert.ok(!("cp_spread" in t) && !("nfci_credit" in t));
  assert.deepEqual(t.warnings, []);
  // FRB・シカゴ連銀へは接続しない
  assert.ok(srv.calls.every((u) => !u.includes("federalreserve.gov") && !u.includes("chicagofed.org")));
  // 素朴な計算と一致（米国債の値動き）
  const rows = H.syntheticYields("2023-06-01", "2026-10-29");
  const s = T.realizedVolSeries(rows, TEN, 20);
  const vals = s.map((x) => x.value), i = vals.length - 1;
  assert.equal(t.rates_vol.rank_pct, H.naiveRank(vals, i, 252));
});

test("試し運転の取得に失敗しても、実行は赤くしない（errors にせず、trial.warnings に記録）", async () => {
  const dir = tmp(), srv = server({ fail: { "daily-treasury-rates.csv/": 404 } });
  const logs = [];
  assert.equal(await go(dir, srv, "2026-10-30 10:00", [], logs), 0);
  const r = readRisk(dir);
  assert.equal(r.generation.status, "ok");
  assert.deepEqual(r.generation.errors, []);
  assert.match(r.trial.rates_vol.error, /HTTP 404/);
  assert.equal(r.trial.warnings.length, 1);
  assert.equal(r.vix.date, "2026-10-29");
  const out = [];
  assert.equal(await go(dir, server(), "2026-10-30 10:05", ["--check-fresh"], out), 0);
  assert.match(out.join("\n"), /TRIAL（試し運転・判定には使わない）: 米国債の値動き 取得失敗/);
  // 取り直すと、その日のうちに成功の値に置き換わる（60分たってから）
  assert.equal(await go(dir, server(), "2026-10-30 11:05", ["--if-stale"]), 0);
  assert.equal(readRisk(dir).trial.rates_vol.date, "2026-10-29");
  const out2 = [];
  assert.equal(await go(dir, server(), "2026-10-30 11:10", ["--check-fresh"], out2), 0);
  assert.match(out2.join("\n"), /TRIAL（試し運転・判定には使わない）: 米国債の値動き 2026-10-29 順位[\d.]+%/);
});

test("取り直しの条件：その日（日本時間）に未取得なら取る。同じ日は60分たち、米国債の値の公表待ち・失敗があるときだけ", () => {
  const base = (fetched, rvDate, extra = {}) => ({
    fetched_at: fetched, rates_vol: { date: rvDate, history: [{ date: rvDate }] }, ...extra,
  });
  const now = H.jst("2026-10-30 10:00");
  assert.equal(trialNeedsRefresh(null, now), true);
  assert.equal(trialNeedsRefresh(base("2026-10-29T23:00:00+09:00", "2026-10-29"), now), true);   // 前の日
  assert.equal(trialNeedsRefresh(base("2026-10-30T09:30:00+09:00", "2026-10-28"), now), false);  // 60分たっていない
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-28"), now), true);   // 10/29 の値が公表済みのはず
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-29"), now), false);  // 最新
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-29", { rates_vol: { error: "x" } }), now), true);  // 前回失敗
  assert.equal(trialNeedsRefresh(base("2026-10-30T09:30:00+09:00", "2026-10-29", { rates_vol: { error: "x" } }), now), false); // 失敗でも60分は待つ
});

test("--if-stale：VIX が最新でも、その日の試し運転がまだなら取り直す（Cboe へは接続しない）", async () => {
  const dir = tmp();
  await go(dir, server({ to: "2026-10-30" }), "2026-10-31 10:00");
  const srv = server({ to: "2026-10-30" });
  assert.equal(await go(dir, srv, "2026-11-01 10:00", ["--if-stale"]), 0);
  assert.equal(srv.n("cdn-api.cboe.com"), 0);
  assert.ok(srv.n("daily-treasury-rates.csv") >= 1);
  assert.equal(srv.calls.length, srv.n("daily-treasury-rates.csv"));
  assert.equal(readRisk(dir).trial.fetched_at, "2026-11-01T10:00:00+09:00");
  // 同じ日の30分後は、どこへも接続しない
  const srv2 = server({ to: "2026-10-30" });
  assert.equal(await go(dir, srv2, "2026-11-01 10:30", ["--if-stale"]), 0);
  assert.equal(srv2.calls.length, 0);
});

test("最新の値が古ければ警告する（7日より古いとき）。止めはしない", async () => {
  const dir = tmp();
  // 米国債の CSV が 10/20 で止まっているとする（10/30 の時点で10日前）
  const srv = server({ to: "2026-10-20" });
  const base = srv.fetchImpl;
  srv.fetchImpl = async (url) => (url.includes("cdn-api.cboe.com") ? server().fetchImpl(url) : base(url));
  assert.equal(await go(dir, srv, "2026-10-30 10:00"), 0);
  const t = readRisk(dir).trial;
  assert.equal(t.rates_vol.date, "2026-10-20");
  assert.equal(t.rates_vol.stale, true);
  assert.match(t.warnings.join("\n"), /米国債の値動き：最新の値が 2026-10-20 で、7日より古くなっています/);
  assert.equal(readRisk(dir).generation.status, "ok");
  // 7日ちょうど（10/23）なら警告しない
  const dir2 = tmp(), srv2 = server({ to: "2026-10-23" });
  const b2 = srv2.fetchImpl;
  srv2.fetchImpl = async (url) => (url.includes("cdn-api.cboe.com") ? server().fetchImpl(url) : b2(url));
  await go(dir2, srv2, "2026-10-30 10:00");
  assert.ok(!readRisk(dir2).trial.rates_vol.stale);
});
