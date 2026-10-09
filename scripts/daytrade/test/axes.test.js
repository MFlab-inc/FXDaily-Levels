"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadInputs } = require("../inputs");
const { makeScenario } = require("./scenario");
const { rm } = require("./helpers");
const fs = require("fs");

/**
 * バックテストの比較軸（SL下限方式・障害の定義）は、ライブの生成器には影響しない。
 * ライブは evaluate() を『opts なし』で呼ぶ（= SL下限 'reject'・障害 'both'）ことを、実際の呼び出しで確かめる。
 */
const noFeed = { status: "未取得", reason: "試験", pairs: {} };
const down = { EURUSD: { bars: { dir: "down" } } };

test("ライブの生成器（設計①②③・状態更新・型B追加）は evaluate に opts を渡さない（SL下限 (a)・障害 (a) のまま）", () => {
  const ev = require("../evaluate");
  const planPath = require.resolve("../plan");
  const orig = ev.evaluate;
  const calls = [];
  ev.evaluate = (...args) => { calls.push(args); return orig(...args); };
  delete require.cache[planPath];
  const d = makeScenario({ spec: down });
  const s17 = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: down });
  try {
    const { buildDesign, buildStatus } = require("../plan"); // evaluate の差し替え後に読み込む
    const inputsOf = (sc) => loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs, env: sc.env });
    const d2 = buildDesign({ inputs: inputsOf(d), riskFeed: noFeed, nowMs: d.nowMs, slot: 2, prevPlan: null, logRows: [] });
    const d3 = buildDesign({ inputs: inputsOf(d), riskFeed: noFeed, nowMs: d.nowMs, slot: 3, prevPlan: null, logRows: [] }); // 型A・型B
    const st = buildStatus({ inputs: inputsOf(s17), riskFeed: noFeed, nowMs: s17.nowMs, prevPlan: d2.plan, logRows: d2.logAppend }); // 型B追加
    assert.ok(calls.length >= 10, `evaluate の呼び出しが少なすぎる: ${calls.length}`);
    assert.ok(calls.some((c) => c[1] === "A") && calls.some((c) => c[1] === "B"), "型A・型B の両方が呼ばれる");
    for (const c of calls) assert.equal(c.length, 2, `evaluate は (ctx, setup) の2引数だけで呼ばれる: ${c.length}`);
    // 出力にも比較軸の印は出ない
    for (const x of [d2, d3, st]) {
      const text = JSON.stringify(x.plan);
      assert.ok(!/obstacle_changed|sl_floored/.test(text), "計画に比較軸の印が出ていない");
    }
  } finally {
    ev.evaluate = orig;
    delete require.cache[planPath];
    rm(path.dirname(d.dataDir)); rm(path.dirname(s17.dataDir));
  }
});

test("ライブの生成器のソースに、障害の定義・SL下限方式の指定が無い（バックテストだけが指定する）", () => {
  const root = path.join(__dirname, "..", "..");
  const live = ["daytrade-plan.js", "daytrade-score.js", "daytrade/plan.js", "daytrade/render.js", "daytrade/schedule.js", "daytrade/typeb.js"];
  for (const f of live) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!/slFloor|obstacle\s*:\s*["']|obstacle\s*=\s*["']|'forward'|"forward"|'widen'|"widen"/.test(src), `${f} に比較軸の指定がある`);
  }
});

test("判断の台帳（decisions.js）: すべて確定済み。出力の『暫定』の行は出さず、JSON は『未確定の判断なし』と書く", () => {
  const { QUESTIONS, provisionalIds } = require("../decisions");
  assert.equal(QUESTIONS.length, 69);
  assert.deepEqual(provisionalIds(), []);
  for (const q of QUESTIONS) assert.equal(q.status, "confirmed", q.id);
  for (const q of QUESTIONS) assert.ok(typeof q.answer === "string" && q.answer.length > 0, `${q.id} に回答の記録がある`);
  const { render } = require("../render");
  const sc = makeScenario();
  try {
    const inputs = loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs, env: sc.env });
    const { buildDesign } = require("../plan");
    const { plan } = buildDesign({ inputs, riskFeed: noFeed, nowMs: sc.nowMs, slot: 2, prevPlan: null, logRows: [] });
    assert.deepEqual(plan.provisional.open_questions, []);
    assert.match(plan.provisional.note, /未確定の判断はありません/);
    assert.ok(!/暫定:/.test(render(plan, inputs.accounts)));
  } finally { rm(path.dirname(sc.dataDir)); }
});
