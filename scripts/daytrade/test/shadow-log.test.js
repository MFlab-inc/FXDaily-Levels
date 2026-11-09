"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { main } = require("../../daytrade-plan");
const { main: scoreMain } = require("../../daytrade-score");
const L = require("../log");
const J = require("../jst");
const { evaluate } = require("../evaluate");
const { buildDesign, buildStatus, buildCtx } = require("../plan");
const { evaluateShadow, shadowOf, SHADOW_OPTS } = require("../shadow");
const { render } = require("../render");
const { globalMtfStatus } = require("../direction");
const { PAIRS } = require("../pairs");
const { loadInputs } = require("../inputs");
const { runNotify } = require("../notify/run");
const { createMemoryClient } = require("../notify/github");
const F = require("../notify/format");
const { makeScenario } = require("./scenario");
const { rm, jstAt } = require("./helpers");
// この試験は、銘柄を問わないライブの規則の試験。模擬の場面で XAUUSD もライブの候補になる前提で書かれているので、pairs.js の live:false を外した状態（＝今までと同じ出力）で動かす（helpers.js の setXauLive）
require("./helpers").setXauLive(true);

/**
 * ■4 並行記録（参考の案。発注の対象外）。ライブ（SL下限 (a)）では不採用だが、SL下限 (b)（SL＝max(k×ATR, 10pips)）なら通る案を
 * data/daytrade/shadow-log.csv に記録する。版・取消・採点（■1・■3）は log.csv と同じ規則で、別のファイルとして独立に扱う。
 * ライブの候補・log.csv・通知・Issue には出ない。
 */
const noFeed = { status: "未取得", reason: "x", pairs: {} };
const cleanup = (...scs) => { for (const sc of scs) rm(path.dirname(sc.dataDir)); };
const inputsOf = (sc) => loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs, env: sc.env });
const SHADOW_NOTE = /参考：SL下限\(b\)なら通る案 (\d+)件（発注対象外）/;

// EURUSD の H1 の幅（=ATR）を pips にする。階段の間隔 6pips より大きいので H1 群はできない。A案は 0.5×ATR < 10pips → ライブでは『SL幅不足』、(b) なら 10pips で通る
const narrow = (pips, touchAt = null) => (bars) => bars.map((b) => {
  const mid = b.o;
  let x = { ...b, h: Number((mid + (pips * 0.0001) / 2).toFixed(5)), l: Number((mid - (pips * 0.0001) / 2).toFixed(5)) };
  if (touchAt && b.t === jstAt("2026-10-08", touchAt)) x = { ...x, h: 1.1045, l: 1.1035 };
  return x;
});
const eurusd = (cands) => cands.find((c) => c.symbol === "EURUSD");
const shadowRows = (rows) => rows.filter((r) => r.variant === "sl_floor_b");

test("shadow.js: 評価は SL下限 (b) だけを指定する。(b) だけで通る案（A／B案）を返す。(a) で通る案・(b) でも通らない案は返さない", () => {
  assert.deepEqual(SHADOW_OPTS, { slFloor: "widen" });
  assert.ok(Object.isFrozen(SHADOW_OPTS));
  const sc = makeScenario({ barsEdit: { EURUSD: narrow(12) } });
  try {
    const inputs = inputsOf(sc);
    const mtf = globalMtfStatus(inputs.raw.mtf, inputs.expectedSession);
    const pair = PAIRS.find((p) => p.code === "EURUSD");
    const ctx = buildCtx(pair, inputs, "2026-10-08", "A", mtf);
    const live = evaluate(ctx, "A");
    assert.equal(live.schemes.A.pass, false);
    assert.equal(live.schemes.A.reason, "sl_narrow");
    assert.equal(live.schemes.B.pass, true);
    const sh = shadowOf(live, evaluateShadow(ctx, "A"));
    assert.deepEqual(sh.onlyB, ["A"]);
    assert.ok(Math.abs(sh.sres.schemes.A.sl_pips - 10) < 1e-9);
    assert.ok(Math.abs(sh.sres.schemes.B.sl_pips - 12) < 1e-9); // B案は (a) と同じ（広げない）
    // ATR が大きい銘柄（A案が (a) で通る）では、(b) だけで通る案は無い
    const gbp = buildCtx(PAIRS.find((p) => p.code === "GBPUSD"), inputs, "2026-10-08", "A", mtf);
    assert.equal(shadowOf(evaluate(gbp, "A"), evaluateShadow(gbp, "A")), null);
    // 評価は ctx を変えない
    const before = JSON.stringify(ctx);
    evaluateShadow(ctx, "A");
    assert.equal(JSON.stringify(ctx), before);
  } finally { cleanup(sc); }
});

test("■4 設計: (b) だけで通る案を shadowAppend に入れる（先頭の variant 列＝sl_floor_b、列は log.csv と同じ）。ライブの候補・logAppend・通知は変わらない", () => {
  const sc = makeScenario({ barsEdit: { EURUSD: narrow(12) } });
  try {
    const { plan, logAppend, shadowAppend } = buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, slot: 2, prevPlan: null, logRows: [] });
    // ライブ: EURUSD は B案だけが通る候補。A案は SL幅不足
    const live = eurusd(plan.candidates);
    assert.equal(live.schemes.A.pass, false);
    assert.equal(live.schemes.B.pass, true);
    // 並行記録: EURUSD の版（A案は 10pips に広げる）。(b) だけで通る案がある版だけ
    assert.equal(shadowAppend.length, 1);
    const r = shadowAppend[0];
    assert.deepEqual([r.variant, r.run, r.setup, r.symbol, r.side, r.entry_low, r.entry_high], ["sl_floor_b", "design", "A", "EURUSD", "sell", "1.10400", "1.10412"]); // 帯の幅は 0.1×ATR(12pips)＝1.2pips
    assert.equal(r.sl_a, "1.10500"); // 10pips
    assert.equal(r.sl_b, "1.10520"); // 12pips
    // 列は log.csv と同じで、先頭に variant を足しただけ
    assert.deepEqual(L.SHADOW_COLUMNS, ["variant", ...L.COLUMNS]);
    assert.equal(L.SHADOW_VARIANT, "sl_floor_b");
    // log.csv の行・計画の候補に、並行記録の版は入らない
    assert.ok(logAppend.every((x) => x.variant === undefined));
    assert.ok(plan.candidates.every((c) => !(c.symbol === "EURUSD" && c.schemes.A.pass)));
    assert.deepEqual(plan.candidates.map((c) => c.symbol).sort(), ["AUDUSD", "EURUSD", "GBPUSD", "XAUUSD"]);
    // 件数: 参考欄（plan.summary.sl_floor_b）。単位は案（型×銘柄×A/B案）= EURUSD の A案 1件
    assert.deepEqual(plan.summary.sl_floor_b, { pass: 1 });
    const txt = render(plan, plan.accounts);
    assert.equal(txt.match(SHADOW_NOTE)[1], "1");
    const sec3 = txt.split("== 4.")[0].split("== 3.")[1];
    assert.ok(sec3.trimEnd().endsWith("参考：SL下限(b)なら通る案 1件（発注対象外）"), "3項目目の末尾");
    assert.ok(!txt.split("== 2.")[1].split("== 3.")[0].includes("参考：SL下限"), "候補の欄には出さない");
    // Issue（通知）には出ない
    const body = F.issueBody({ planDate: plan.plan_date, plan }).body;
    assert.ok(!/SL下限|sl_floor|shadow|並行/.test(body));
  } finally { cleanup(sc); }
});

test("■4 ライブの出力が変わらない: 計画の候補は、(a) の評価だけで作った候補（evaluate(ctx, setup)）と一致する。(b) で通る案が無い日は並行記録の行が 0", () => {
  for (const edit of [narrow(12), undefined]) {
    const sc = makeScenario(edit ? { barsEdit: { EURUSD: edit } } : {});
    try {
      const inputs = inputsOf(sc);
      const mtf = globalMtfStatus(inputs.raw.mtf, inputs.expectedSession);
      const { plan, shadowAppend } = buildDesign({ inputs, riskFeed: noFeed, nowMs: sc.nowMs, slot: 2, prevPlan: null, logRows: [] });
      const expected = PAIRS.map((p) => ({ p, res: evaluate(buildCtx(p, inputs, "2026-10-08", "A", mtf), "A") })).filter((x) => x.res.outcome === "candidate");
      assert.deepEqual(plan.candidates.map((c) => c.symbol).sort(), expected.map((x) => x.p.code).sort());
      for (const c of plan.candidates) {
        const res = expected.find((x) => x.p.code === c.symbol).res;
        assert.deepEqual(["A", "B"].map((n) => c.schemes[n].pass), ["A", "B"].map((n) => res.schemes[n].pass));
        assert.deepEqual(["A", "B"].map((n) => c.schemes[n].sl), ["A", "B"].map((n) => (res.schemes[n].pass || res.schemes[n].sl !== undefined ? res.schemes[n].sl : undefined)));
      }
      if (!edit) { assert.deepEqual(shadowAppend, []); assert.deepEqual(plan.summary.sl_floor_b, { pass: 0 }); assert.match(render(plan, plan.accounts), /参考：SL下限\(b\)なら通る案 0件（発注対象外）/); }
    } finally { cleanup(sc); }
  }
});

test("■4 版の一生: 同じ版は二重に追記しない。次の設計で無くなれば 取消(再設計) の行（H1 で到達していれば 取消(到達後)）を shadow-log に追記する。設計①②は型Bの版を取消さない", () => {
  const sc = makeScenario({ barsEdit: { EURUSD: narrow(12) } });
  const gone = makeScenario({ nowIso: "2026-10-08T21:05:00+09:00" }); // ATR 20pips → A案は (a) で通る → (b) だけで通る案が無い
  const reached = makeScenario({ nowIso: "2026-10-08T21:05:00+09:00", barsEdit: { EURUSD: (bars) => bars.map((b) => (b.t === jstAt("2026-10-08", "17:00") ? { ...b, h: 1.1045, l: 1.1035 } : b)) } });
  try {
    const first = buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, slot: 2, prevPlan: null, logRows: [] });
    // 同じ入力でもう一度 → 追記なし
    const again = buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs + 5 * J.MIN, slot: 2, prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: first.shadowAppend });
    assert.deepEqual(again.shadowAppend, []);
    // 並行記録の版が無くなる → 取消(再設計)。ライブ側の取消とは独立（ライブの版は log.csv 側で取消される）
    const d3 = buildDesign({ inputs: inputsOf(gone), riskFeed: noFeed, nowMs: gone.nowMs, slot: 3, prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: first.shadowAppend });
    const c = d3.shadowAppend.find((x) => x.run === "status");
    assert.deepEqual([c.variant, c.symbol, c.reached, c.reached_at], ["sl_floor_b", "EURUSD", "取消(再設計)", ""]);
    assert.equal(L.keyOf(c), L.keyOf(first.shadowAppend[0]));
    // 取消の時刻までに H1 で到達していれば 取消(到達後)
    const d3r = buildDesign({ inputs: inputsOf(reached), riskFeed: noFeed, nowMs: reached.nowMs, slot: 3, prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: first.shadowAppend });
    const cr = d3r.shadowAppend.find((x) => x.run === "status" && x.symbol === "EURUSD");
    assert.deepEqual([cr.reached, cr.reached_at], ["取消(到達後)", "2026-10-08T17:00:00+09:00"]);
    // 設計①②は型Aだけ再設計: 型Bの版は取消さない。設計③は型Bも再設計する（取消対象）
    const bRow = { ...first.shadowAppend[0], setup: "B", run: "design-b", entry_low: "1.10200", entry_high: "1.10220", sl_a: "1.10300", sl_b: "" };
    const keepB = buildDesign({ inputs: inputsOf(gone), riskFeed: noFeed, nowMs: gone.nowMs, slot: 2, prevPlan: null, logRows: [], shadowLogRows: [...first.shadowAppend, bRow] });
    assert.ok(!keepB.shadowAppend.some((x) => x.setup === "B"));
    const cutB = buildDesign({ inputs: inputsOf(gone), riskFeed: noFeed, nowMs: gone.nowMs, slot: 3, prevPlan: null, logRows: [], shadowLogRows: [...first.shadowAppend, bRow] });
    assert.ok(cutB.shadowAppend.some((x) => x.setup === "B" && x.run === "status"));
  } finally { cleanup(sc, gone, reached); }
});

test("■3 は並行記録でも独立に効く: 並行記録の版が到達済みなら、同じ水準の新しい並行記録の版は出し直さない（ライブの履歴とは別に判定）", () => {
  const sc = makeScenario({ nowIso: "2026-10-08T23:05:00+09:00", barsEdit: { EURUSD: narrow(12, "08:00") } });
  try {
    // 06:30 に同じ入力で作った並行記録の版 V1（08:00 の足で到達済み）。ライブのログは空 → ライブ側は抑えない
    const first = buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: J.parseIso("2026-10-08T06:30:00+09:00"), slot: 1, prevPlan: null, logRows: [] });
    assert.equal(first.shadowAppend.length, 1);
    // V2 = V1 とは SL が違う版（ATR を少し変える）。並行記録は V1 が到達済みなので V2 を出さない
    const changed = makeScenario({ nowIso: "2026-10-08T23:05:00+09:00", barsEdit: { EURUSD: narrow(13, "08:00") } });
    try {
      const d = buildDesign({ inputs: inputsOf(changed), riskFeed: noFeed, nowMs: changed.nowMs, slot: 2, prevPlan: null, logRows: [], shadowLogRows: first.shadowAppend });
      assert.ok(!d.shadowAppend.some((x) => x.run === "design" && x.symbol === "EURUSD"), "並行記録の V2 は出さない");
      assert.ok(eurusd(d.plan.candidates), "ライブの履歴（log.csv）は別なので、ライブの EURUSD は抑えない");
      assert.equal(d.plan.summary.extra["同じ水準は到達済み"], 0);
      // 比較: 並行記録の履歴が無ければ V2 は出る
      const fresh = buildDesign({ inputs: inputsOf(changed), riskFeed: noFeed, nowMs: changed.nowMs, slot: 2, prevPlan: null, logRows: [], shadowLogRows: [] });
      assert.ok(fresh.shadowAppend.some((x) => x.run === "design" && x.symbol === "EURUSD"));
    } finally { cleanup(changed); }
  } finally { cleanup(sc); }
});

test("■4 型Bの追加（16:00〜21:59 の状態更新）も並行記録する。追加は (a) の追加と独立に、自分のログで『同じ日・銘柄・向きの型Bは1回』を判定する", () => {
  const down = { EURUSD: { bars: { dir: "down" } } };
  const d = makeScenario({ spec: down, barsEdit: { EURUSD: narrow(12) } });
  const s17 = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: down, barsEdit: { EURUSD: narrow(12) } });
  try {
    const design = buildDesign({ inputs: inputsOf(d), riskFeed: noFeed, nowMs: d.nowMs, slot: 2, prevPlan: null, logRows: [] });
    const st = buildStatus({ inputs: inputsOf(s17), riskFeed: noFeed, nowMs: s17.nowMs, prevPlan: design.plan, logRows: design.logAppend, shadowLogRows: design.shadowAppend });
    const b = shadowRows(st.shadowAppend).filter((x) => x.setup === "B");
    assert.deepEqual(b.map((x) => [x.run, x.symbol]), [["design-b", "EURUSD"]]);
    assert.ok(st.logAppend.every((x) => x.variant === undefined));
    assert.ok(st.plan.candidates.filter((c) => c.run === "design-b").every((c) => c.schemes.A.pass === false || c.symbol !== "EURUSD"), "ライブの候補に並行記録の版は入らない");
    assert.equal(st.plan.summary.sl_floor_b.pass, design.plan.summary.sl_floor_b.pass + 1, "型Bの追加分を足す");
    // 同じ日・銘柄・向きの型Bは、並行記録にあれば追加しない
    const again = buildStatus({ inputs: inputsOf(s17), riskFeed: noFeed, nowMs: s17.nowMs + 30 * J.MIN, prevPlan: st.plan, logRows: [...design.logAppend, ...st.logAppend], shadowLogRows: [...design.shadowAppend, ...st.shadowAppend] });
    assert.deepEqual(again.shadowAppend, []);
    assert.equal(again.plan.summary.sl_floor_b.pass, st.plan.summary.sl_floor_b.pass);
  } finally { cleanup(d, s17); }
});

test("■4 ライブが全案不採用でも (b) で通れば記録する。件数の単位は案（A案・B案それぞれ1件）。ライブの候補には出ない", () => {
  // H1 の幅 5pips: A案・B案とも (a) では『SL幅不足』→ ライブの EURUSD は不採用。(b) なら両案とも 10pips で通る
  const sc = makeScenario({ barsEdit: { EURUSD: narrow(5) } });
  try {
    const { plan, logAppend, shadowAppend } = buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, slot: 2, prevPlan: null, logRows: [] });
    assert.equal(eurusd(plan.candidates), undefined, "ライブの候補に EURUSD は無い");
    assert.ok(!logAppend.some((x) => x.symbol === "EURUSD"), "log.csv にも入らない");
    const rows = shadowAppend.filter((x) => x.symbol === "EURUSD");
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].variant, rows[0].run, rows[0].setup, rows[0].sl_a, rows[0].sl_b], ["sl_floor_b", "design", "A", "1.10500", "1.10500"]);
    assert.equal(plan.summary.sl_floor_b.pass, 2, "A案とB案で2件（版の数ではなく案の数）");
    assert.match(render(plan, plan.accounts), /参考：SL下限\(b\)なら通る案 2件（発注対象外）/);
  } finally { cleanup(sc); }
});

test("■4 設計③は型Bも並行記録する（型A・型Bの両方を評価）。①②は型Aだけ", () => {
  const down = { EURUSD: { bars: { dir: "down" } } };
  const sc = makeScenario({ nowIso: "2026-10-08T16:00:00+09:00", spec: down, barsEdit: { EURUSD: narrow(5) } });
  try {
    const d3 = buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, slot: 3, prevPlan: null, logRows: [] });
    assert.deepEqual(d3.shadowAppend.filter((x) => x.symbol === "EURUSD").map((x) => x.setup).sort(), ["A", "B"]);
    assert.equal(eurusd(d3.plan.candidates), undefined);
    const d2 = buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, slot: 2, prevPlan: null, logRows: [] });
    assert.deepEqual(d2.shadowAppend.filter((x) => x.symbol === "EURUSD").map((x) => x.setup), ["A"]);
  } finally { cleanup(sc); }
});

test("■4 型Bの追加で、ライブでは不採用の型Bも (b) で通れば並行記録する（件数は案の数だけ増える）", () => {
  const down = { EURUSD: { bars: { dir: "down" } } };
  const d = makeScenario({ spec: down, barsEdit: { EURUSD: narrow(5) } });
  const s17 = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: down, barsEdit: { EURUSD: narrow(5) } });
  try {
    const design = buildDesign({ inputs: inputsOf(d), riskFeed: noFeed, nowMs: d.nowMs, slot: 2, prevPlan: null, logRows: [] });
    const st = buildStatus({ inputs: inputsOf(s17), riskFeed: noFeed, nowMs: s17.nowMs, prevPlan: design.plan, logRows: design.logAppend, shadowLogRows: design.shadowAppend });
    assert.ok(!st.logAppend.some((x) => x.symbol === "EURUSD"), "ライブの型Bは EURUSD を追加しない（SL幅不足）");
    assert.deepEqual(st.shadowAppend.map((x) => [x.setup, x.run, x.symbol]), [["B", "design-b", "EURUSD"]]);
    assert.equal(st.plan.summary.sl_floor_b.pass, design.plan.summary.sl_floor_b.pass + 2, "A案・B案の2件を足す");
  } finally { cleanup(d, s17); }
});

test("■4 前の計画日の並行記録の版（採点待ち）には、新しい日の設計で取消の行を足さない", () => {
  const sc = makeScenario({ barsEdit: { EURUSD: narrow(12) } });
  try {
    const first = buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, slot: 2, prevPlan: null, logRows: [] });
    const prevDay = { ...first.shadowAppend[0], plan_date: "2026-10-07", generated_at: "2026-10-07T15:30:00+09:00", expires_at: "2026-10-08T03:00:00+09:00" };
    const d = buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, slot: 2, prevPlan: null, logRows: [], shadowLogRows: [prevDay] });
    assert.ok(!d.shadowAppend.some((x) => x.plan_date === "2026-10-07"), "前日の版には触らない");
    assert.equal(d.shadowAppend.filter((x) => x.run === "design" && x.symbol === "EURUSD").length, 1);
  } finally { cleanup(sc); }
});

// ---- CLI（ファイル）----
const quiet = () => { const out = []; return { out, io: { log: (m) => out.push(String(m)) } }; };
const run = (sc, extra, env = {}) => { const q = quiet(); return main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", `--now=${sc.nowIso}`, ...extra], { ...sc.env, ...env }, q.io).then((r) => ({ r, out: q.out })); };
const read = (sc, rel) => fs.readFileSync(path.join(sc.dataDir, rel), "utf8");

test("■4 daytrade-plan.js: shadow-log.csv を書く（見出しは SHADOW_COLUMNS）。同じ実行を繰り返しても二重に追記しない。壊れた shadow-log.csv はライブに影響させない", async () => {
  const sc = makeScenario({ barsEdit: { EURUSD: narrow(12) } });
  try {
    const { r } = await run(sc, ["--run=design", "--slot=2"]);
    assert.equal(r.shadowAppend.length, 1);
    const text = read(sc, "daytrade/shadow-log.csv");
    assert.equal(text.split("\n")[0], L.SHADOW_COLUMNS.join(","));
    assert.equal(L.parseLog(text, L.SHADOW_COLUMNS).length, 1);
    assert.equal(L.parseLog(read(sc, "daytrade/log.csv")).length, 4, "log.csv は4件（並行記録の版は入らない）");
    const again = await run(sc, ["--run=design", "--slot=2", "--force"]);
    assert.deepEqual(again.r.shadowAppend, []);
    assert.equal(read(sc, "daytrade/shadow-log.csv"), text);
    assert.match(read(sc, "daytrade-plan.txt"), SHADOW_NOTE);
    // 公開されるファイルなので、口座の資金（試験用の架空の額）は書かない
    for (const f of ["daytrade/shadow-log.csv", "daytrade/log.csv", "daytrade-plan.txt", "daytrade-plan.json"]) for (const e of Object.values(sc.env)) assert.ok(!read(sc, f).includes(e), `${f} に資金が出ていない`);
    // 壊れた shadow-log.csv: ライブの計画・log.csv は今までどおり書く。並行記録は触らない（上書きしない）
    fs.writeFileSync(path.join(sc.dataDir, "daytrade", "shadow-log.csv"), "broken,header\n1,2\n");
    fs.writeFileSync(path.join(sc.dataDir, "daytrade", "log.csv"), "");
    fs.rmSync(path.join(sc.dataDir, "daytrade", "log.csv"));
    const q = await run(sc, ["--run=design", "--slot=1"]);
    assert.ok(q.r.plan);
    assert.equal(L.parseLog(read(sc, "daytrade/log.csv")).length >= 1, true);
    assert.equal(read(sc, "daytrade/shadow-log.csv"), "broken,header\n1,2\n");
    assert.match(q.out.join("\n"), /shadow-log\.csv を読めないため、並行記録の追記を行っていません/);
  } finally { cleanup(sc); }
});

test("■4 daytrade-score.js: shadow-log.csv も同じ規則で別に採点する（取消(到達後)・損益の列つき）。壊れていてもライブの採点は止めない。--dry-run は書かない", async () => {
  const sc = makeScenario({ nowIso: "2026-10-08T15:30:00+09:00", barsEdit: { EURUSD: narrow(12) } });
  try {
    await run(sc, ["--run=design", "--slot=2"]);
    const nextDay = "2026-10-09T06:30:00+09:00";
    // H1 足を有効期限（翌03:00）まで伸ばす: 17:00 の足が帯に触れて、翌 02:00 までに SL に届く
    const h1 = JSON.parse(read(sc, "h1-bars.json"));
    const mk = (hm, date, o, h, l, c) => ({ time_jst: `${date} ${hm}`, o, h, l, c });
    h1.pairs.EURUSD.push(mk("16:00", "2026-10-08", 1.1, 1.1045, 1.1035, 1.1036), mk("17:00", "2026-10-08", 1.1036, 1.1060, 1.1030, 1.1050), mk("02:00", "2026-10-09", 1.103, 1.103, 1.1025, 1.1028));
    for (const code of Object.keys(h1.pairs)) if (code !== "EURUSD") h1.pairs[code].push(mk("02:00", "2026-10-09", 1, 1, 1, 1));
    fs.writeFileSync(path.join(sc.dataDir, "h1-bars.json"), JSON.stringify(h1));
    const dry = quiet();
    scoreMain([`--data-dir=${sc.dataDir}`, `--now=${nextDay}`, "--dry-run"], dry.io);
    assert.equal(L.parseLog(read(sc, "daytrade/shadow-log.csv"), L.SHADOW_COLUMNS).length, 1, "dry-run は書かない");
    const q = quiet();
    const r = scoreMain([`--data-dir=${sc.dataDir}`, `--now=${nextDay}`], q.io);
    assert.ok(r.shadow.newRows.length >= 1);
    const rows = L.parseLog(read(sc, "daytrade/shadow-log.csv"), L.SHADOW_COLUMNS);
    const scored = rows.filter((x) => x.run === "status");
    assert.equal(scored.length, 1);
    assert.deepEqual([scored[0].variant, scored[0].symbol, scored[0].reached, scored[0].first_hit_a], ["sl_floor_b", "EURUSD", "到達", "SL"]);
    assert.equal(scored[0].r_a, "-1.00");
    assert.equal(scored[0].pips_a, "-10.0");
    assert.match(q.out.join("\n"), /\[並行記録\] 採点:/);
    // ライブの log.csv も同時に採点されている
    assert.ok(L.parseLog(read(sc, "daytrade/log.csv")).some((x) => x.run === "status"));
    // 壊れた shadow-log.csv でも、ライブの採点は動く
    const sc2 = makeScenario({ nowIso: "2026-10-08T15:30:00+09:00", barsEdit: { EURUSD: narrow(12) } });
    try {
      await run(sc2, ["--run=design", "--slot=2"]);
      fs.writeFileSync(path.join(sc2.dataDir, "h1-bars.json"), JSON.stringify(h1));
      fs.writeFileSync(path.join(sc2.dataDir, "daytrade", "shadow-log.csv"), "x,y\n1,2\n");
      const q2 = quiet();
      const r2 = scoreMain([`--data-dir=${sc2.dataDir}`, `--now=${nextDay}`], q2.io);
      assert.ok(r2.newRows.length >= 1, "ライブは採点される");
      assert.match(q2.out.join("\n"), /shadow-log\.csv を採点できません/);
      assert.equal(read(sc2, "daytrade/shadow-log.csv"), "x,y\n1,2\n");
    } finally { cleanup(sc2); }
  } finally { cleanup(sc); }
});

test("■4 daytrade-plan.js: 状態更新を何度繰り返しても、型Bの並行記録は1回だけ。shadow-log.csv を読めないときは、件数を積み上げず並行記録も触らない", async () => {
  const mk = () => makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: { EURUSD: { bars: { dir: "down" } } }, barsEdit: { EURUSD: narrow(12) } });
  const count = (sc) => Number(read(sc, "daytrade-plan.txt").match(SHADOW_NOTE)[1]);
  const designB = (sc) => L.parseLog(read(sc, "daytrade/shadow-log.csv"), L.SHADOW_COLUMNS).filter((x) => x.run === "design-b" && x.setup === "B" && x.symbol === "EURUSD");
  const sc = mk(), bad = mk();
  try {
    // 読める場合: 設計のあと状態更新を3回（--force）→ 型Bの行は1つ、件数も増え続けない
    await run(sc, ["--run=design", "--slot=2"]);
    await run(sc, ["--run=status", "--force"]);
    const n1 = count(sc);
    for (let i = 0; i < 2; i++) await run(sc, ["--run=status", "--force"]);
    assert.equal(designB(sc).length, 1);
    assert.equal(count(sc), n1);
    // 読めない場合: 件数が毎回増えない。shadow-log.csv は書き換えない
    await run(bad, ["--run=design", "--slot=2"]);
    fs.writeFileSync(path.join(bad.dataDir, "daytrade", "shadow-log.csv"), "broken,header\n1,2\n");
    const counts = [];
    for (let i = 0; i < 3; i++) { await run(bad, ["--run=status", "--force"]); counts.push(count(bad)); }
    assert.equal(new Set(counts).size, 1, `件数が増え続けない（${counts.join(",")}）`);
    assert.equal(read(bad, "daytrade/shadow-log.csv"), "broken,header\n1,2\n");
  } finally { cleanup(sc, bad); }
});

test("■4 通知（Issue）には出ない: 並行記録の版・件数は、Issue の本文にもコメントにも入らない。通知は shadow-log.csv を読まない", async () => {
  const sc = makeScenario({ barsEdit: { EURUSD: narrow(12) } });
  try {
    await run(sc, ["--run=design", "--slot=2"]);
    const client = createMemoryClient();
    await runNotify({ dataDir: sc.dataDir, nowMs: sc.nowMs + 5 * J.MIN, client, log: () => {} });
    const text = client.ops.map((o) => o.body || "").join("\n");
    assert.ok(client.ops.length >= 1);
    assert.ok(!/SL下限|sl_floor|並行|shadow/.test(text));
    const src = fs.readFileSync(path.join(__dirname, "..", "notify", "run.js"), "utf8") + fs.readFileSync(path.join(__dirname, "..", "notify", "detect.js"), "utf8");
    assert.ok(!/shadow/i.test(src), "通知のコードは shadow-log を参照しない");
  } finally { cleanup(sc); }
});
