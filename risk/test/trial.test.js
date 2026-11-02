"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const T = require("../lib/trial");
const { run, trialNeedsRefresh, trialTarget, trialAttemptsSoFar, ratesVolRowsNeeded } = require("../run-daily");
const cfg = require("../config");
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
  assert.deepEqual(Object.keys(cfg.TRIAL).sort(), ["http", "maxFetchesPerTarget", "minRefetchMinutes", "ratesVol", "staleDays"]);
  assert.deepEqual(Object.keys(T).sort(), ["TrialError", "parseParYieldCsv", "rankSnapshot", "realizedVolSeries"]);
});

test("必要な行の数：20＋252＋60−1＝331行で、履歴60個がそろう（330行では59個）", () => {
  const R = cfg.TRIAL.ratesVol;
  assert.equal(ratesVolRowsNeeded(R), 331);
  const all = H.syntheticYields("2024-01-01", "2026-10-29");
  for (const [n, hist] of [[331, 60], [330, 59]]) {
    const snap = T.rankSnapshot(T.realizedVolSeries(all.slice(-n), TEN, R.lookback), { window: R.window, thresholdPct: 80, historyN: R.historyN, keepValue: true });
    assert.equal(snap.history.length, hist, `${n}行`);
  }
});

// ---------- run-daily との結合 ----------
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "risk-trial-"));
const readRisk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "risk.json"), "utf8"));
// to＝VIX の最新日、ratesTo＝米国債の最新日（省略時は to と同じ）。fail に URL の断片 → HTTPステータス
function server({ to = "2026-10-29", ratesTo = to, ratesFrom = "2023-06-01", fail = {} } = {}) {
  const calls = [];
  const yields = H.syntheticYields(ratesFrom, ratesTo);
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
  assert.equal(t.attempts, 1);
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

test("年ごとのCSV：10月は今年と前の年の2つで足りる。1月の初めは今年が空なので3年分。途中の年が失敗したら試し運転だけ失敗", async () => {
  const srv = server();
  await go(tmp(), srv, "2026-10-30 10:00");
  assert.deepEqual([2026, 2025, 2024, 2023].map((y) => srv.n(`csv/${y}/`)), [1, 1, 0, 0]);

  const dir = tmp(), srvJan = server({ to: "2026-12-31" });
  assert.equal(await go(dir, srvJan, "2027-01-04 10:00"), 0);
  assert.deepEqual([2027, 2026, 2025, 2024].map((y) => srvJan.n(`csv/${y}/`)), [1, 1, 1, 0]);
  assert.equal(readRisk(dir).trial.rates_vol.date, "2026-12-31");
  assert.equal(readRisk(dir).trial.rates_vol.history.length, 60);

  // ちょうど331行そろった年で止まる（330行なら、さらに前の年を取りに行く）
  const all = H.syntheticYields("2025-01-01", "2026-10-29");
  for (const [n, years] of [[331, [1, 1, 0]], [330, [1, 1, 1]]]) {
    const srvN = server({ ratesFrom: all[all.length - n].date });
    await go(tmp(), srvN, "2026-10-30 10:00");
    assert.deepEqual([2026, 2025, 2024].map((y) => srvN.n(`csv/${y}/`)), years, `${n}行`);
  }

  const dir2 = tmp(), srvFail = server({ fail: { "csv/2025/": 503 } });
  assert.equal(await go(dir2, srvFail, "2026-10-30 10:00"), 0);
  const r = readRisk(dir2);
  assert.match(r.trial.rates_vol.error, /HTTP 503 \(treasury:csv:2025\)/);
  assert.equal(srvFail.n("csv/2025/"), 1 + cfg.TRIAL.http.retries);
  assert.equal(r.generation.status, "ok");
  assert.equal(r.vix.date, "2026-10-29");
});

test("試し運転の取得に失敗しても、実行は赤くしない（errors にせず、trial.warnings に記録）。取り直しでは Cboe へ接続しない", async () => {
  const dir = tmp(), srv = server({ fail: { "daily-treasury-rates.csv/": 404 } });
  const logs = [];
  assert.equal(await go(dir, srv, "2026-10-30 10:00", [], logs), 0);
  const r = readRisk(dir);
  assert.equal(r.generation.status, "ok");
  assert.deepEqual(r.generation.errors, []);
  assert.match(r.trial.rates_vol.error, /HTTP 404/);
  assert.equal(r.trial.warnings.length, 1);
  assert.match(logs.join("\n"), /::warning title=試し運転の指標（記事には未使用）::米国債の値動き：HTTP 404/);
  assert.equal(r.vix.date, "2026-10-29");
  const out = [];
  assert.equal(await go(dir, server(), "2026-10-30 10:05", ["--check-fresh"], out), 0);
  assert.match(out.join("\n"), /TRIAL（試し運転・判定には使わない）: 米国債の値動き 取得失敗/);
  // 60分たってから取り直すと、成功の値に置き換わる。VIX は最新なので Cboe へは接続しない
  const srv2 = server();
  assert.equal(await go(dir, srv2, "2026-10-30 11:05", ["--if-stale"]), 0);
  assert.equal(srv2.n("cdn-api.cboe.com"), 0);
  assert.ok(srv2.n("daily-treasury-rates.csv") >= 1);
  const t = readRisk(dir).trial;
  assert.equal(t.rates_vol.date, "2026-10-29");
  assert.equal(t.attempts, 2);
  assert.deepEqual(t.warnings, []);
  const out2 = [];
  assert.equal(await go(dir, server(), "2026-10-30 11:10", ["--check-fresh"], out2), 0);
  assert.match(out2.join("\n"), /TRIAL（試し運転・判定には使わない）: 米国債の値動き 2026-10-29 順位[\d.]+%$/m);
});

test("失敗したときは、前回の正しい値を残して last_error を付ける", async () => {
  const dir = tmp();
  // 8:00：米国債は 10/28 まで（10/29 の値はまだ）
  assert.equal(await go(dir, server({ ratesTo: "2026-10-28" }), "2026-10-30 08:00"), 0);
  const before = readRisk(dir).trial.rates_vol;
  assert.equal(before.date, "2026-10-28");
  // 9:05：取り直したが失敗
  assert.equal(await go(dir, server({ fail: { "daily-treasury-rates.csv/": 404 } }), "2026-10-30 09:05", ["--if-stale"]), 0);
  const t = readRisk(dir).trial;
  assert.equal(t.rates_vol.date, "2026-10-28");
  assert.equal(t.rates_vol.rank_pct, before.rank_pct);
  assert.deepEqual(t.rates_vol.history, before.history);
  assert.match(t.rates_vol.last_error, /HTTP 404/);
  assert.equal(t.attempts, 2);
  const out = [];
  await go(dir, server(), "2026-10-30 09:10", ["--check-fresh"], out);
  assert.match(out.join("\n"), /米国債の値動き 2026-10-28 順位[\d.]+%（直近の取得は失敗。前回の値）/);
  // 10:10：成功すると last_error は消える
  assert.equal(await go(dir, server(), "2026-10-30 10:10", ["--if-stale"]), 0);
  const t2 = readRisk(dir).trial;
  assert.equal(t2.rates_vol.date, "2026-10-29");
  assert.ok(!("last_error" in t2.rates_vol));
  assert.equal(t2.attempts, 3);
  // ここまでで 10/29 を待つ3回を使い切ったので、手動で失敗させても、次の --if-stale では取らない（上限）
  assert.equal(await go(dir, server({ fail: { "daily-treasury-rates.csv/": 404 } }), "2026-10-30 11:15"), 0);
  const srvCap = server();
  await go(dir, srvCap, "2026-10-30 12:20", ["--if-stale"]);
  assert.equal(srvCap.n("daily-treasury-rates.csv"), 0);
});

test("値が最新のときに（手動の実行で）失敗しても、上限に達していなければ次の --if-stale で取り直す", async () => {
  const dir = tmp();
  assert.equal(await go(dir, server(), "2026-10-30 10:00"), 0); // 1回目：10/29 まで（最新）
  assert.equal(await go(dir, server({ fail: { "daily-treasury-rates.csv/": 404 } }), "2026-10-30 11:00"), 0); // 2回目（手動）：失敗
  assert.match(readRisk(dir).trial.rates_vol.last_error, /HTTP 404/);
  const early = server();
  await go(dir, early, "2026-10-30 11:30", ["--if-stale"]); // 60分たっていない
  assert.equal(early.n("daily-treasury-rates.csv"), 0);
  const srv = server();
  assert.equal(await go(dir, srv, "2026-10-30 12:05", ["--if-stale"]), 0); // 3回目：取り直して成功
  assert.ok(srv.n("daily-treasury-rates.csv") >= 1);
  assert.equal(srv.n("cdn-api.cboe.com"), 0);
  const t = readRisk(dir).trial;
  assert.ok(!("last_error" in t.rates_vol));
  assert.equal(t.attempts, 3);
});

test("残した前回の値の古さは、そのときの日付で計算し直す", async () => {
  const dir = tmp();
  assert.equal(await go(dir, server({ ratesTo: "2026-10-28" }), "2026-10-30 08:00"), 0);
  assert.ok(!readRisk(dir).trial.rates_vol.stale);
  // 11/06：取得に失敗。残した 10/28 の値は9日前なので古い
  assert.equal(await go(dir, server({ to: "2026-11-05", fail: { "daily-treasury-rates.csv/": 404 } }), "2026-11-06 10:00", ["--if-stale"]), 0);
  const t = readRisk(dir).trial;
  assert.equal(t.rates_vol.date, "2026-10-28");
  assert.equal(t.rates_vol.stale, true);
  assert.match(t.rates_vol.last_error, /HTTP 404/);
  assert.equal(t.warnings.length, 2);
});

test("取りに行くのは、待っている米国の日付ごとに3回まで：値が届かない日に30分ごとに起動しても3回で止まり、夜中の起動で回数を使わない", async () => {
  const dir = tmp();
  const srv = server({ ratesTo: "2026-10-28" }); // 10/29 の値がいつまでも届かない（VIX は 10/29 まで）
  const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  let fetchRounds = 0, writes = 0, last = null;
  // 10/30 8:00〜23:30（日本時間）。待っている日付は米国の 10/29
  for (let m = 8 * 60; m <= 23 * 60 + 30; m += 30) {
    const before = srv.n("daily-treasury-rates.csv");
    assert.equal(await go(dir, srv, `2026-10-30 ${hhmm(m)}`, m === 8 * 60 ? [] : ["--if-stale"]), 0);
    if (srv.n("daily-treasury-rates.csv") > before) fetchRounds++;
    const txt = fs.readFileSync(path.join(dir, "risk.json"), "utf8");
    if (txt !== last) { writes++; last = txt; }
  }
  assert.equal(fetchRounds, cfg.TRIAL.maxFetchesPerTarget);
  assert.equal(writes, cfg.TRIAL.maxFetchesPerTarget);
  assert.equal(srv.n("cdn-api.cboe.com"), 1);
  assert.equal(readRisk(dir).trial.attempts, 3);
  assert.equal(readRisk(dir).trial.attempts_for, "us:2026-10-29");
  // 10/31 0:00〜7:00：日本時間の日付は変わったが、待っている日付は同じ 10/29 なので取りに行かない
  for (let m = 0; m <= 7 * 60; m += 30) {
    const before = srv.n("daily-treasury-rates.csv");
    await go(dir, srv, `2026-10-31 ${hhmm(m)}`, ["--if-stale"]);
    assert.equal(srv.n("daily-treasury-rates.csv"), before, `10/31 ${hhmm(m)}`);
  }
  // 10/31 7:30（米東部 10/30 18:30）：待っている日付が 10/30 に変わり、また取りに行ける
  const before = srv.n("daily-treasury-rates.csv");
  await go(dir, srv, "2026-10-31 07:30", ["--if-stale"]);
  assert.ok(srv.n("daily-treasury-rates.csv") > before);
  assert.equal(readRisk(dir).trial.attempts, 1);
  assert.equal(readRisk(dir).trial.attempts_for, "us:2026-10-30");
});

test("取り直しの条件：待っている米国の日付の値が無いとき・前回失敗したときだけ。60分は待つ。同じ日付で3回まで", () => {
  const T29 = "us:2026-10-29";
  const base = (fetched, rvDate, extra = {}) => ({
    fetched_at: fetched, rates_vol: { date: rvDate, history: [{ date: rvDate }] }, ...extra,
  });
  const now = H.jst("2026-10-30 10:00"); // 米東部 10/29 21:00（夏時間）→ 10/29 の値が出ているはず
  assert.equal(trialTarget(null, now), T29);
  assert.equal(trialNeedsRefresh(null, now), true);
  assert.equal(trialNeedsRefresh({ fetched_at: "壊れた値" }, now), true);
  assert.equal(trialNeedsRefresh(base("2026-10-29T23:00:00+09:00", "2026-10-29"), now), false);  // 前の日に取ったが、値は最新
  assert.equal(trialNeedsRefresh(base("2026-10-29T23:00:00+09:00", "2026-10-28"), now), true);   // 10/29 が未取得
  assert.equal(trialNeedsRefresh(base("2026-10-30T09:30:00+09:00", "2026-10-28"), now), false);  // 60分たっていない
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-28"), now), true);   // 10/29 の値が公表済みのはず
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-29"), now), false);  // 最新
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-29", { rates_vol: { error: "x" } }), now), true);  // 前回失敗
  assert.equal(trialNeedsRefresh(base("2026-10-30T09:30:00+09:00", "2026-10-29", { rates_vol: { error: "x" } }), now), false); // 失敗でも60分は待つ
  // 前回の値を残して失敗（last_error）。値が最新でも取り直す
  const kept = { rates_vol: { date: "2026-10-29", history: [{ date: "2026-10-29" }], last_error: "x" } };
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-29", kept), now), true);
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-29", { ...kept, attempts: 3, attempts_for: T29 }), now), false);
  // 回数：同じ日付で3回なら取らない。別の日付の3回は数えない。壊れた回数は1回とみなす
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-28", { attempts: 3, attempts_for: T29 }), now), false);
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-28", { attempts: 3, attempts_for: "us:2026-10-28" }), now), true);
  for (const bad of ["5", -1, 0, 2.5, null]) assert.equal(trialAttemptsSoFar({ attempts: bad, attempts_for: T29 }, T29), 1, String(bad));
  assert.equal(trialAttemptsSoFar({ attempts: 2, attempts_for: T29 }, "us:2026-10-30"), 0);
  // 週末：日曜の朝は、金曜（米国）の値が最新なので取らない。冬時間に入った火曜（米東部 月曜 18:30 ＝ 日本時間 8:30）から月曜の値を取りに行く
  assert.equal(trialNeedsRefresh(base("2026-10-31T09:00:00+09:00", "2026-10-30"), H.jst("2026-11-01 10:00")), false);
  assert.equal(trialNeedsRefresh(base("2026-11-02T09:00:00+09:00", "2026-10-30"), H.jst("2026-11-03 08:20")), false);
  assert.equal(trialNeedsRefresh(base("2026-11-02T09:00:00+09:00", "2026-10-30"), H.jst("2026-11-03 08:40")), true);
});

test("最新の値が古ければ警告する（7日より古いとき）。止めはしない", async () => {
  const dir = tmp();
  // 米国債の CSV が 10/20 で止まっているとする（10/30 の時点で10日前）
  assert.equal(await go(dir, server({ ratesTo: "2026-10-20" }), "2026-10-30 10:00"), 0);
  const t = readRisk(dir).trial;
  assert.equal(t.rates_vol.date, "2026-10-20");
  assert.equal(t.rates_vol.stale, true);
  assert.match(t.warnings.join("\n"), /米国債の値動き：最新の値が 2026-10-20 で、7日より古くなっています/);
  assert.equal(readRisk(dir).generation.status, "ok");
  const out = [];
  await go(dir, server(), "2026-10-30 10:05", ["--check-fresh"], out);
  assert.match(out.join("\n"), /米国債の値動き 2026-10-20 順位[\d.]+%（古い）/);
  // 7日ちょうど（10/23）なら警告しない
  const dir2 = tmp();
  await go(dir2, server({ ratesTo: "2026-10-23" }), "2026-10-30 10:00");
  assert.ok(!readRisk(dir2).trial.rates_vol.stale);
});
