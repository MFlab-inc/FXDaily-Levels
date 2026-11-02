"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { main } = require("../../daytrade-plan");
const { inputsWaiting } = require("../plan");
const { loadInputs } = require("../inputs");
const S = require("../schedule");
const { planDateOf } = require("../windows");
const { runNotify } = require("../notify/run");
const { createMemoryClient } = require("../notify/github");
const D = require("../notify/detect");
const L = require("../log");
const J = require("../jst");
const { makeScenario } = require("./scenario");
const { rm } = require("./helpers");

/**
 * ■2 設計①を、日次レベルと MTF の更新を待ってから出す。
 * 設計①の窓の中で、発注不可の理由が『日次レベル未更新』『MTF の日付』だけのときは、発注不可の計画をコミットしない（入力待ち）。
 * 入力がそろった最初の実行が設計①になる。窓の終わりまでそろわなければ『設計なし』の異常として通知する。
 */
const cleanup = (sc) => rm(path.dirname(sc.dataDir));
const quiet = () => { const out = []; return { out, io: { log: (m) => out.push(String(m)) } }; };
const run = (sc, extra = [], env = {}) => { const q = quiet(); return main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", `--now=${sc.nowIso}`, ...extra], { ...sc.env, ...env }, q.io).then((r) => ({ r, out: q.out })); };
const inputsOf = (sc) => loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs, env: sc.env });
// data/ の全ファイルの内容（ファイル名 → 本文）
const tree = (dir, base = dir) => Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? Object.entries(tree(path.join(dir, e.name), base)) : [[path.relative(base, path.join(dir, e.name)), fs.readFileSync(path.join(dir, e.name), "utf8")]])));
const STALE = { dailySession: "2026-10-06", mtfBase: "2026-10-06" }; // 2026-10-08（木）の朝の直近に確定した営業日は 10-07

test("inputsWaiting: 日付が古いだけのとき理由（日次・MTF）を返す。片方だけでも待つ", () => {
  const both = makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", ...STALE });
  const onlyDaily = makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", dailySession: "2026-10-06" });
  const onlyMtf = makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", mtfBase: "2026-10-06" });
  const ok = makeScenario({ nowIso: "2026-10-08T06:05:00+09:00" });
  try {
    const w = inputsWaiting(inputsOf(both));
    assert.equal(w.length, 2);
    assert.match(w[0], /^日次レベル未更新（daily-levels\.json の session_date 2026-10-06、直近に確定した営業日 2026-10-07）/);
    assert.match(w[1], /^MTF の日付が古い（mtf-feed\.json の data_base_date 2026-10-06/);
    assert.equal(inputsWaiting(inputsOf(onlyDaily)).length, 1);
    assert.match(inputsWaiting(inputsOf(onlyDaily))[0], /^日次レベル未更新/);
    assert.match(inputsWaiting(inputsOf(onlyMtf))[0], /^MTF の日付が古い/);
    assert.equal(inputsWaiting(inputsOf(ok)), null, "そろっていれば待たない");
  } finally { for (const s of [both, onlyDaily, onlyMtf, ok]) cleanup(s); }
});

test("inputsWaiting: 理由が日付以外にもあるときは待たない（鮮度超過・MTF の status・日付が新しすぎる・日次の errors・口座設定・ファイル欠落）", () => {
  const cases = {
    "鮮度超過も重なる": makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", ...STALE, intradayLagMin: 40 }),
    "MTF の status が ok でない": makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", dailySession: "2026-10-06", mtfBase: "2026-10-06", mtfStatus: "partial" }),
    "日付が新しすぎる（日次）": makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", dailySession: "2026-10-09", mtfBase: "2026-10-06" }),
    "日付が新しすぎる（MTF）": makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", dailySession: "2026-10-06", mtfBase: "2026-10-09" }),
    "日次の errors（日付は最新）": makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", dailyErrors: ["x"] }),
    "口座の資金が未設定": makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", ...STALE, env: { DAYTRADE_EQUITY_A: "" } }),
    "MTF が無い": makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", dailySession: "2026-10-06", tweak: (f) => { f["mtf-feed.json"] = null; } }),
    "日次が無い": makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", mtfBase: "2026-10-06", tweak: (f) => { f["daily-levels.json"] = null; } }),
    "停止通貨の対応表が壊れている": makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", ...STALE }),
  };
  // 対応表（config/daytrade-rules.json）の10銘柄が欠けている。日付が古いだけでなく別の問題もあるので、待たずに『発注不可』の計画を書く
  fs.writeFileSync(path.join(cases["停止通貨の対応表が壊れている"].repoRoot, "config", "daytrade-rules.json"), JSON.stringify({ pair_currencies: { EURUSD: ["EUR", "USD"] } }));
  try {
    assert.equal(inputsOf(cases["停止通貨の対応表が壊れている"]).rulesOk, false);
    for (const [name, sc] of Object.entries(cases)) assert.equal(inputsWaiting(inputsOf(sc)), null, name);
  } finally { for (const sc of Object.values(cases)) cleanup(sc); }
});

const FEEDS = ["intraday.json", "daily-levels.json", "h1-bars.json", "daytrade-context.json", "mtf-feed.json", "economic-calendar.json"];
test("設計①の窓の中（夏 06:05〜）: 日次・MTF が古いあいだは何もコミットしない（data/ の全ファイルが一字も変わらない）。入力がそろった最初の実行が設計①になる", async () => {
  const base = makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", ...STALE });
  try {
    // 実際の 10/29 のように、約15分ごとの実行。フィード（intraday など）は実行ごとに新しくなるが、日次・MTF は古いまま
    for (const t of ["06:05", "06:21", "06:35", "06:50", "07:05"]) {
      const s = makeScenario({ nowIso: `2026-10-08T${t}:30+09:00`, ...STALE });
      try {
        for (const f of FEEDS) fs.copyFileSync(path.join(s.dataDir, f), path.join(base.dataDir, f));
        const before = tree(base.dataDir);
        const q = quiet();
        const r = await main([`--data-dir=${base.dataDir}`, "--no-risk-feed", `--now=${s.nowIso}`], base.env, q.io);
        assert.ok(r.waiting, t);
        assert.match(q.out.join("\n"), /入力待ち: 設計①の窓の中で、日次レベル未更新/);
        assert.deepEqual(tree(base.dataDir), before, `${t}: 何も書かない`);
        assert.deepEqual(Object.keys(before).filter((f) => /daytrade-plan|log\.csv/.test(f)), [], "計画もログも作っていない");
      } finally { cleanup(s); }
    }
    // 入力がそろった（07:22。実際の 10/29 と同じ流れ）
    const fresh = makeScenario({ nowIso: "2026-10-08T07:22:00+09:00" });
    try {
      for (const f of FEEDS) fs.copyFileSync(path.join(fresh.dataDir, f), path.join(base.dataDir, f));
      const q = quiet();
      const r = await main([`--data-dir=${base.dataDir}`, "--no-risk-feed", "--now=2026-10-08T07:22:00+09:00"], base.env, q.io);
      assert.ok(r.plan, "設計を作る");
      assert.equal(r.plan.run, "design");
      assert.equal(r.plan.design_slot, 1);
      assert.equal(r.plan.order_ok, true);
      assert.deepEqual(r.plan.designs, [{ slot: 1, generated_at: "2026-10-08T07:22:00+09:00", inputs_ok: true }]);
      assert.ok(fs.existsSync(path.join(base.dataDir, "daytrade-plan.json")));
    } finally { cleanup(fresh); }
  } finally { cleanup(base); }
});

test("入力待ちを無視する場合: --force・手動（run を指定）・設計②（15:05）は、これまでどおり発注不可の計画を書く", async () => {
  for (const [name, nowIso, extra, slot] of [
    ["--force", "2026-10-08T06:05:00+09:00", ["--force"], 1],
    ["手動の設計①", "2026-10-08T06:05:00+09:00", ["--run=design", "--slot=1"], 1],
    ["設計②の窓", "2026-10-08T15:05:00+09:00", [], 2],
  ]) {
    const sc = makeScenario({ nowIso, ...STALE });
    try {
      const { r } = await run(sc, extra);
      assert.ok(r.plan, name);
      assert.equal(r.plan.design_slot, slot, name);
      assert.equal(r.plan.order_ok, false, name);
      assert.equal(r.plan.designs[0].inputs_ok, false, name);
    } finally { cleanup(sc); }
  }
});

test("入力待ちの理由が日付以外にもあるとき（鮮度超過が重なる）は、待たずに発注不可の計画を書く", async () => {
  const sc = makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", ...STALE, h1LagMin: 45 });
  try {
    const { r } = await run(sc);
    assert.ok(r.plan);
    assert.equal(r.plan.order_ok, false);
  } finally { cleanup(sc); }
});

test("入力待ちのあいだ、通知（Issue）は何も出さない。窓の終わり（夏 09:00）までそろわなければ、状態更新が『設計なし』を書き、異常として通知する", async () => {
  const sc = makeScenario({ nowIso: "2026-10-08T06:05:00+09:00", ...STALE });
  try {
    const notify = async (nowIso, client = createMemoryClient()) => {
      // 入力のフィードは新しい（as_of は now の数分前）ので、更新停止の異常は出ない
      const r = await runNotify({ dataDir: sc.dataDir, nowMs: J.parseIso(nowIso), client, log: () => {} });
      return { r, ops: client.ops, client };
    };
    // 前日の計画が残っている状態（計画日が違うので、何も出さない）で、入力待ち → 通知は何もしない
    fs.writeFileSync(path.join(sc.dataDir, "daytrade-plan.json"), JSON.stringify({ plan_date: "2026-10-07", designs: [{ slot: 1, inputs_ok: true }], order_ok: true, candidates: [] }));
    for (const f of ["intraday.json", "h1-bars.json", "daytrade-context.json"]) { const j = JSON.parse(fs.readFileSync(path.join(sc.dataDir, f), "utf8")); j.as_of = "2026-10-08T06:00:00+09:00"; fs.writeFileSync(path.join(sc.dataDir, f), JSON.stringify(j)); }
    const w = await run(sc);
    assert.ok(w.r.waiting);
    assert.deepEqual((await notify("2026-10-08T06:06:00+09:00")).ops, [], "入力待ちのあいだ Issue も出さない");
    // 窓の終わり（09:00）を過ぎた 09:05 に入力がまだ古い → 通常の状態更新（設計なし）。通知は『設計①がありません』を出す
    const late = makeScenario({ nowIso: "2026-10-08T09:05:00+09:00", ...STALE });
    try {
      assert.deepEqual(S.resolveAuto({ nowMs: late.nowMs, prevPlan: null, logRows: [] }), { action: "status", slot: null });
      const { r } = await run(late);
      assert.equal(r.plan.run, "status");
      assert.equal(r.plan.design_missing, true);
      assert.equal(r.plan.order_ok, false);
      assert.ok(r.plan.banners.some((b) => /^設計なし/.test(b)));
      const ev = D.anomalyEvents({ nowMs: late.nowMs, plan: r.plan, logRows: [], feeds: [], failure: null, markers: [] });
      assert.deepEqual(ev.map((e) => [e.kind, e.slot]), [["nodesign", 1]]);
      const client = createMemoryClient();
      await runNotify({ dataDir: late.dataDir, nowMs: late.nowMs, client, log: () => {} });
      const bodies = client.ops.map((o) => o.body || "").join("\n");
      assert.match(bodies, /設計①がありません/);
    } finally { cleanup(late); }
  } finally { cleanup(sc); }
});

// ---- 冬時間の窓の切り替え（2026-11-02（月）から）----
// 1週間分の intraday 完了（名目 :05,:20,:35,:50）を順に流して、設計の窓と最初の実行を調べる（schedule-week.test.js と同じ手順）
function week(startJst) {
  let plan = null;
  const events = [];
  const startMs = Date.parse(`${startJst}T00:00:00+09:00`);
  for (let t = startMs; t < startMs + 7 * J.DAY; t += 15 * J.MIN) {
    const nowMs = t + 5 * J.MIN;
    const r = S.resolveAuto({ nowMs, prevPlan: plan, logRows: [] });
    if (r.action === "skip") continue;
    const planDate = planDateOf(nowMs);
    if (r.action === "status") {
      const last = plan?.plan_date === planDate && plan.status_updated_at ? plan.status_updated_at : null;
      if (last !== null && Math.floor(last / 3600000) === Math.floor(nowMs / 3600000)) continue;
      plan = { ...(plan?.plan_date === planDate ? plan : { plan_date: planDate, designs: [] }), status_updated_at: nowMs };
      events.push({ nowMs, planDate, action: "status" });
    } else {
      plan = { plan_date: planDate, designs: [...(plan?.plan_date === planDate ? plan.designs : []), { slot: r.slot, inputs_ok: true }], status_updated_at: nowMs };
      events.push({ nowMs, planDate, action: "design", slot: r.slot });
    }
  }
  return events;
}

test("冬時間への切り替え（NY は 11/1 から冬時間）: 10/26〜10/30 の週は夏の窓（①06:00〜 ③21:00〜）、11/2〜11/6 の週は冬の窓（①07:00〜 ③22:00〜）", () => {
  const sum = week("2026-10-26").filter((e) => e.action === "design");
  const win = week("2026-11-02").filter((e) => e.action === "design");
  const first = (ev, d) => ev.filter((e) => e.planDate === d).map((e) => `${e.slot}@${J.jstHm(e.nowMs)}`);
  for (const d of ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]) assert.deepEqual(first(sum, d), ["1@06:05", "2@15:05", "3@21:05"], d);
  for (const d of ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]) assert.deepEqual(first(win, d), ["1@07:05", "2@15:05", "3@22:05"], d);
  // 窓そのもの
  const d = "2026-11-02";
  const w1 = S.slotWindow(1, d, J.jstAt(d, "07:05")), w3 = S.slotWindow(3, d, J.jstAt(d, "22:05"));
  assert.deepEqual([J.jstHm(w1.start), J.jstHm(w1.end)], ["07:00", "10:00"]);
  assert.deepEqual([J.jstHm(w3.start), J.jstHm(w3.end)], ["22:00", "00:00"]);
  // 11/2（月）の 06:05〜06:50 は冬の窓の前: 設計も状態更新もしない。07:05 が設計①
  const monEarly = week("2026-11-02").filter((e) => e.planDate === d && e.nowMs < J.jstAt(d, "07:05"));
  assert.deepEqual(monEarly, []);
  // 土日の計画日（10/31・11/1）は何もしない
  assert.deepEqual(week("2026-10-31").filter((e) => ["2026-10-31", "2026-11-01"].includes(e.planDate)), []);
});

test("冬時間（11/2 月曜）の設計①: 06:05 は窓の前で何もしない／07:05 の入力待ち／窓の終わり（10:00）を過ぎれば状態更新（設計なし）", async () => {
  const mk = (nowIso, o = {}) => makeScenario({ nowIso, dailySession: "2026-10-30", mtfBase: "2026-10-30", ...o });
  const early = mk("2026-11-02T06:05:00+09:00");
  const inWin = mk("2026-11-02T07:05:00+09:00", { dailySession: "2026-10-29", mtfBase: "2026-10-29" });
  const late = mk("2026-11-02T10:05:00+09:00", { dailySession: "2026-10-29", mtfBase: "2026-10-29" });
  const ok = mk("2026-11-02T07:05:00+09:00");
  try {
    assert.equal((await run(early)).r.skipped !== undefined, true);
    const w = await run(inWin);
    assert.ok(w.r.waiting, "冬の窓（07:00〜）の中で、日次・MTF が前々営業日のままなら待つ");
    assert.match(w.out.join("\n"), /直近に確定した営業日 2026-10-30/);
    const l = await run(late);
    assert.equal(l.r.plan.run, "status");
    assert.equal(l.r.plan.design_missing, true);
    const d = await run(ok);
    assert.equal(d.r.plan.design_slot, 1);
    assert.equal(d.r.plan.order_ok, true);
  } finally { for (const s of [early, inWin, late, ok]) cleanup(s); }
});
