"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate } = require("../evaluate");
const { summarize } = require("../plan");
const { evalCtx, DAILY } = require("./helpers");
const { render } = require("../render");

const withProfit = (p) => ({ ...DAILY, s1: Number((1.104 - (p + 0.5) * 0.0001).toFixed(5)), s2: 1, prev_low: 1 });
const reject = (opts) => summarize([evaluate(evalCtx(opts), "A")]).rejected_cases;

test("不採用A/Bとも、元の評価値を保持する（RR/コスト）", () => {
  const rows = reject({ daily: withProfit(17.5) });
  const a = rows.find((r) => r.scheme === "A");
  const b = rows.find((r) => r.scheme === "B");
  assert.equal(a.reason, "cost_low");
  assert.equal(b.reason, "rr_low");
  assert.deepEqual(a.detail.reference, { price: 1.104, type: "Pivot" });
  assert.deepEqual(a.detail.entry_band, { low: 1.104, high: 1.1042 });
  assert.equal(a.detail.side, "sell");
  assert.equal(a.detail.h1_atr14_pips, 20);
  assert.deepEqual(a.detail.sl, { price: 1.105, width_pips: 10 });
  assert.deepEqual(a.detail.first_obstacle, { price: 1.1022, type: "S1" });
  assert.equal(a.detail.tp1, 1.10225);
  assert.equal(a.detail.profit_pips, 17.5);
  assert.equal(a.detail.rr, 1.75);
  assert.equal(a.detail.cost_cap_pips, 1);
  assert.equal(a.detail.cost_threshold_pips, 1.2);
  assert.equal(a.detail.distance_to_reference_pips, 40);
  assert.equal(a.detail.adr_remaining_pips, 60);
  assert.equal(b.detail.sl.width_pips, 20);
});

test("SL幅不足も後段で算出済みの値を残し、方向なしは旧形式を保持する", () => {
  const rows = reject({ atr: 0.0019 });
  const a = rows.find((r) => r.scheme === "A");
  assert.equal(a.reason, "sl_narrow");
  assert.equal(a.detail.sl.width_pips, 9.5);
  assert.ok(a.detail.tp1 !== null);
  const noDir = reject({ direction: { ok: false, kind: "watch", reason: "監視のみ" } });
  assert.equal(noDir[0].detail, "監視のみ");
});

test("途中終了は未計算値をnullにし、本文にEntry/SL/TP価格を出さない", () => {
  const noRef = reject({ price: 1.3 });
  assert.equal(noRef[0].reason, "no_reference");
  assert.equal(noRef[0].detail.reference, null);
  assert.equal(noRef[0].detail.sl, null);
  assert.equal(noRef[0].detail.tp1, null);
  const fake = {
    banners: [], plan_date: "2026-10-08", run: "design", candidates: [],
    freshness: { feeds: [], daily: {}, h1_last_closed: {}, ctx_m15: {} },
    mtf: {}, accounts: {}, settings: {}, designs: [], events: {},
    summary: { rejected_cases: reject({ atr: 0.0019 }), candidate_rows: 0,
      scheme_pass: { A: 0, B: 0 }, rejections: { no_direction: 0, unreachable: 0, sl_narrow: 1, rr_low: 0, cost_low: 0, adr_over: 0 },
      extra: {}, not_formed: [] },
    reference: { volatility: { risk_feed: { status: "未取得" }, pairs: {} }, existing_gate: { states: {} } },
  };
  // render expects volatility for each pair, supplied as unavailable.
  const { PAIRS } = require("../pairs");
  for (const p of PAIRS) fake.reference.volatility.pairs[p.code] = { state: "未取得" };
  const section = render(fake).split("== 3. ")[1].split("== 4. ")[0];
  assert.match(section, /SL幅 9.5p ＜ 10p、ATR14 19p/);
  assert.doesNotMatch(section, /1\.10[0-9]+/);
});
