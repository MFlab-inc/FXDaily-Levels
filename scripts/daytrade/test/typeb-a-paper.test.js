"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadInputs } = require("../inputs");
const { buildDesign, buildStatus, buildCtx, candRow, markSameDirection, markPaperGroups, splitBySchemeLive } = require("../plan");
const { render } = require("../render");
const { main } = require("../../daytrade-plan");
const { main: scoreMain } = require("../../daytrade-score");
const { evaluate, SCHEME_LIVE, paperSchemes } = require("../evaluate");
const { globalMtfStatus } = require("../direction");
const L = require("../log");
const V = require("../versions");
const J = require("../jst");
const { pairOf } = require("../pairs");
const D = require("../notify/detect");
const F = require("../notify/format");
const { makeScenario } = require("./scenario");
const { rm, setSchemeLive } = require("./helpers");

/**
 * 型B×A案を発注の対象外の並行記録に移す（2026-11-21 本人決定。論点 b）。evaluate.js の SCHEME_LIVE（{ setup: "B", scheme: "A", live: false, variant: "typeb_a_paper" }）が設定。
 * 型B×A案は同じ規則で評価・記録・採点するが、ライブの候補（candidates・txt の候補・通知・log.csv）には出さず、上限ロットも出さない。型Bで B案も通った案は、ライブには B案だけの案として出る。
 * 並行記録は shadow-log.csv の variant=typeb_a_paper（A案だけの版）。版・取消・採点・同じ水準・型Bの重複は variant ごとに独立。設定を戻せば今までと同じ出力。
 * 既存の試験のうち、型Bの案に A案・B案が両方付く前提のものは、先頭で setSchemeLive("B", "A", true) として期待値を変えずに動かしている（helpers.js）。この試験は既定のまま動かす。
 */
const noFeed = { status: "未取得", reason: "x", pairs: {} };
const cleanup = (...scs) => { for (const sc of scs) rm(path.dirname(sc.dataDir)); };
const inputsOf = (sc) => loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs, env: sc.env });
const design = (sc, o = {}) => buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, slot: o.slot ?? 3, prevPlan: o.prevPlan ?? null, logRows: o.logRows ?? [], shadowLogRows: o.shadowLogRows ?? [], shadowReadable: o.shadowReadable ?? true });
const status = (sc, o = {}) => buildStatus({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, prevPlan: o.prevPlan ?? null, logRows: o.logRows ?? [], shadowLogRows: o.shadowLogRows === undefined ? [] : o.shadowLogRows });
const restored = (fn) => { const back = setSchemeLive("B", "A", true); try { return fn(); } finally { back(); } };
const typeB = (cs) => cs.filter((c) => c.setup === "B");
const sym = (cs, s) => cs.find((c) => c.symbol === s);
const TV = "typeb_a_paper";
const DOWN_EU = { EURUSD: { bars: { dir: "down" } } };
const AT = { d3: "2026-10-08T21:30:00+09:00", s17: "2026-10-08T17:00:00+09:00", s18: "2026-10-08T18:00:00+09:00" };

// EURUSD の型B（17:00〜）: H1 の幅を変える（k 倍）。k=1 は ATR 20pips（A案 SL 10pips・B案 20pips ともに通る）、k≦0.7 は A案が『SL幅不足』で B案だけ通る
const scaleBars = (k) => (bars) => bars.map((b) => ({ ...b, h: Number((b.o + ((b.h - b.l) * k) / 2).toFixed(5)), l: Number((b.o - ((b.h - b.l) * k) / 2).toFixed(5)) }));
// A案だけ通る型B（EURUSD）: 型Bの基準水準（東京レンジ安値）の 27pips 下に最初の障害を置く。利益幅 26.5pips → A案（SL 10pips）は通り、B案（SL 20pips）は『コスト不足』。
// 基準水準は時刻で変わる（階段状の足）ので、その時刻の模擬データで基準水準を求めてから置く
const aOnlyFor = (at) => {
  const sc0 = scen(at);
  try {
    const inputs = inputsOf(sc0);
    const ref = evaluate(buildCtx(pairOf("EURUSD"), inputs, "2026-10-08", "B", globalMtfStatus(inputs.raw.mtf, inputs.expectedSession)), "B").ref.price;
    return { tweak: (files) => { const d = files["daily-levels.json"].pairs.EURUSD; d.s1 = Number((ref - 0.0027).toFixed(5)); d.s2 = Number((ref - 0.01).toFixed(5)); d.prev_low = Number((ref - 0.009).toFixed(5)); } };
  } finally { cleanup(sc0); }
};
const BOTH = {}; // A案・B案とも通る（既定の場面）
const B_ONLY = { barsEdit: { EURUSD: scaleBars(0.6) } };
const scen = (at, o = {}) => makeScenario({ nowIso: at, spec: DOWN_EU, ...o });
const SCHEME_KEYS = ["pass", "reason", "k", "sl", "sl_pips", "tp1", "profit_pips", "rr", "cost_cap_pips", "cost_threshold_pips", "lots", "commission_jpy"];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

test("設定: SCHEME_LIVE は型B×A案だけが live:false（variant=typeb_a_paper）。evaluate() の結果は設定に関係しない（評価は変えない）", () => {
  assert.deepEqual(SCHEME_LIVE, [{ setup: "B", scheme: "A", live: false, variant: "typeb_a_paper" }]);
  assert.deepEqual(paperSchemes().map((x) => `${x.setup}×${x.scheme}`), ["B×A"]);
  const sc = scen(AT.s17);
  try {
    const inputs = inputsOf(sc);
    const mtf = globalMtfStatus(inputs.raw.mtf, inputs.expectedSession);
    const ctx = buildCtx(pairOf("EURUSD"), inputs, "2026-10-08", "B", mtf);
    const a = evaluate(ctx, "B");
    const b = restored(() => evaluate(ctx, "B"));
    assert.deepEqual(a, b);
    assert.deepEqual([a.schemes.A.pass, a.schemes.B.pass], [true, true]);
  } finally { cleanup(sc); }
  const back = setSchemeLive("B", "A", true);
  assert.deepEqual(paperSchemes(), []);
  back();
  assert.equal(paperSchemes().length, 1);
});

test("設計③（A案・B案とも通る型B）: ライブには B案だけ、並行記録（typeb_a_paper）には A案だけ。B案の上限ロット・SL・TP は今までと同じ。型Aは変わらない", () => {
  const sc = scen(AT.d3, BOTH);
  try {
    const r = design(sc);
    const old = restored(() => design(sc));
    // ライブの型B: B案だけ（A案は『不採用（並行記録のみ）』。価格・ロットは載せない）
    for (const s of ["EURUSD", "AUDUSD"]) {
      const c = r.plan.candidates.find((x) => x.symbol === s && x.setup === "B");
      const o = old.plan.candidates.find((x) => x.symbol === s && x.setup === "B");
      assert.equal(c.schemes.A.pass, false);
      assert.equal(c.schemes.A.reason_text, "並行記録のみ");
      assert.ok(!("sl" in c.schemes.A) && !("tp1" in c.schemes.A) && !("lots" in c.schemes.A));
      assert.deepEqual(pick(c.schemes.B, SCHEME_KEYS), pick(o.schemes.B, SCHEME_KEYS), `${s}: B案は今までと同じ（上限ロット・SL・TP1・RR・コスト）`);
      assert.ok(o.schemes.B.lots.A > 0 && o.schemes.B.lots.B > 0);
      assert.deepEqual([c.band, c.ref, c.worst_entry, c.confirm], [o.band, o.ref, o.worst_entry, o.confirm]);
    }
    // 型A・ほかの案は変わらない
    for (const c of r.plan.candidates.filter((x) => x.setup === "A")) assert.deepEqual(c.schemes, old.plan.candidates.find((x) => x.id === c.id).schemes);
    // log.csv: 型Bの行は A案の列が空（今までの『B案だけ通った案』と同じ形）。B案の列は今までと同じ
    const rows = r.logAppend.filter((x) => x.setup === "B");
    assert.equal(rows.length, 2);
    for (const x of rows) {
      const o = old.logAppend.find((y) => y.symbol === x.symbol && y.setup === "B");
      assert.deepEqual(["sl_a", "tp_a", "rr_a", "cost_cap_a", "lot_cap_a_A", "lot_cap_a_B"].map((k) => x[k]), ["", "", "", "", "", ""]);
      for (const k of ["sl_b", "tp_b", "rr_b", "lot_cap_b_A", "lot_cap_b_B", "entry_low", "entry_high"]) assert.equal(x[k], o[k], k);
      assert.notEqual(x.sl_b, "");
    }
    // 並行記録: A案だけの版（typeb_a_paper）。B案・ロットの列は空
    const prow = r.shadowAppend.filter((x) => x.variant === TV);
    assert.deepEqual(prow.map((x) => [x.run, x.setup, x.symbol, x.side]).sort(), [["design", "B", "AUDUSD", "buy"], ["design", "B", "EURUSD", "sell"]]);
    for (const x of prow) {
      const o = old.logAppend.find((y) => y.symbol === x.symbol && y.setup === "B");
      assert.deepEqual(["sl_a", "tp_a", "rr_a", "cost_cap_a"].map((k) => x[k]), ["sl_a", "tp_a", "rr_a", "cost_cap_a"].map((k) => o[k]), "A案の値は今までと同じ");
      assert.deepEqual(["sl_b", "tp_b", "rr_b", "lot_cap_a_A", "lot_cap_b_A", "lot_cap_a_B", "lot_cap_b_B"].map((k) => x[k]), ["", "", "", "", "", "", ""]);
    }
    // plan.json の paper: 同じ A案だけの版（価格あり・ロットなし）
    const pp = r.plan.paper.filter((c) => c.variant === TV);
    assert.deepEqual(pp.map((c) => [c.symbol, c.setup]).sort(), [["AUDUSD", "B"], ["EURUSD", "B"]]);
    for (const c of pp) { assert.equal(c.schemes.A.pass, true); assert.equal(c.schemes.B.pass, false); assert.ok(Number.isFinite(c.schemes.A.sl) && !("lots" in c.schemes.A)); }
    assert.deepEqual(r.plan.paper_schemes, [{ variant: TV, setup: "B", scheme: "A", recording: "ok", recorded: 2 }]);
    assert.deepEqual([r.plan.paper_status.variant, r.plan.paper_status.recorded], ["xau_paper", 2], "XAUUSD の paper_status は xau_paper の件数だけ（型B×A案を数えない）");
    // 候補数・通った案の数: 型B×A案は数えない。不採用の理由・6分類は今までどおり
    assert.equal(r.plan.summary.candidate_rows, 5);
    assert.deepEqual(r.plan.summary.scheme_pass, { A: 3, B: 5 });
    assert.deepEqual(old.plan.summary.scheme_pass, { A: 5, B: 5 });
    assert.deepEqual(r.plan.summary.rejections, old.plan.summary.rejections);
    assert.deepEqual(r.plan.summary.rejected_cases, old.plan.summary.rejected_cases);
    // txt: 候補の後に1行だけ（価格・ロットなし）。型Bの候補の欄には A案の SL・TP を出さない
    const txt = render(r.plan, r.plan.accounts);
    const sec2 = txt.split("== 3.")[0].split("== 2.")[1];
    const line = sec2.split("\n").filter((l) => /型B×A案/.test(l));
    assert.deepEqual(line, ["  参考：型B×A案は発注の対象外（並行記録のみ。今回 2 件記録）"]);
    assert.ok(!/\d\.\d{3}/.test(line[0]) && !/ロット/.test(line[0]));
    const euB = sec2.split("\n[").find((b) => /EURUSD 型B/.test(b));
    assert.match(euB, /A案\(0\.5×ATR\): 不採用（並行記録のみ）/);
    assert.ok(!/A案\(0\.5×ATR\): SL/.test(euB));
    assert.ok(/B案\(1\.0×ATR\): SL/.test(euB));
    assert.ok(!/型B×A案/.test(render(old.plan, old.plan.accounts)), "設定を戻すと、参考の1行は出ない");
  } finally { cleanup(sc); }
});

test("A案だけ通った型B: ライブには出ない（candidates・log.csv に無い）。並行記録にだけ出る。候補数・通った案の数に数えない。ライブの他の案は変わらない", () => {
  const sc = scen(AT.d3, aOnlyFor(AT.d3));
  try {
    const r = design(sc);
    const old = restored(() => design(sc));
    const oldEuB = old.plan.candidates.find((c) => c.symbol === "EURUSD" && c.setup === "B");
    assert.deepEqual([oldEuB.schemes.A.pass, oldEuB.schemes.B.pass, oldEuB.schemes.B.reason], [true, false, "cost_low"], "場面: A案だけ通る");
    assert.ok(!r.plan.candidates.some((c) => c.symbol === "EURUSD" && c.setup === "B"));
    assert.ok(!r.logAppend.some((x) => x.symbol === "EURUSD" && x.setup === "B"));
    assert.deepEqual(r.shadowAppend.filter((x) => x.variant === TV && x.symbol === "EURUSD").map((x) => [x.run, x.sl_a !== "", x.sl_b]), [["design", true, ""]]);
    assert.equal(r.plan.summary.candidate_rows, old.plan.summary.candidate_rows - 1);
    assert.deepEqual(r.plan.summary.scheme_pass, { A: 3, B: old.plan.summary.scheme_pass.B }, "A案を通った案は型Aの3件だけ（型Bの A案は並行記録）");
    // 不採用の理由（B案の『コスト不足』）は今までどおり一覧・6分類に残る
    assert.deepEqual(r.plan.summary.rejections, old.plan.summary.rejections);
    assert.deepEqual(r.plan.summary.rejected_cases, old.plan.summary.rejected_cases);
    assert.ok(r.plan.summary.rejected_cases.some((x) => x.symbol === "EURUSD" && x.setup === "B" && x.scheme === "B" && x.reason === "cost_low"));
    // ほかの案（型A・AUDUSD の型B）はそのまま
    for (const c of r.plan.candidates.filter((x) => !(x.symbol === "AUDUSD" && x.setup === "B"))) assert.deepEqual(c.schemes, old.plan.candidates.find((x) => x.id === c.id).schemes);
    // 状態更新（型Bの追加）でも同じ
    const s17 = scen(AT.s17, aOnlyFor(AT.s17));
    try {
      const st = status(s17);
      assert.ok(!st.plan.candidates.some((c) => c.symbol === "EURUSD"));
      assert.ok(!st.logAppend.some((x) => x.symbol === "EURUSD"));
      assert.deepEqual(st.shadowAppend.filter((x) => x.variant === TV && x.symbol === "EURUSD").map((x) => x.run), ["design-b"]);
    } finally { cleanup(s17); }
  } finally { cleanup(sc); }
});

test("B案だけ通った型B（A案が『SL幅不足』など）: 今までどおりライブに出る。並行記録には出ない", () => {
  const sc = scen(AT.d3, B_ONLY);
  try {
    const r = design(sc);
    const old = restored(() => design(sc));
    const pickEu = (x) => x.plan.candidates.find((c) => c.symbol === "EURUSD" && c.setup === "B");
    assert.deepEqual(pickEu(r), pickEu(old), "A案が通っていない型Bは、設定に関係なく同じ");
    const eu = r.plan.candidates.find((c) => c.symbol === "EURUSD" && c.setup === "B");
    assert.deepEqual([eu.schemes.A.pass, eu.schemes.A.reason, eu.schemes.B.pass], [false, "sl_narrow", true]);
    assert.ok(r.logAppend.some((x) => x.symbol === "EURUSD" && x.setup === "B" && x.sl_a === "" && x.sl_b !== ""));
    assert.ok(!r.shadowAppend.some((x) => x.variant === TV && x.symbol === "EURUSD"));
  } finally { cleanup(sc); }
});

test("XAUUSD の型B×A案は xau_paper にだけ入る（型B×A案の variant に二重に入らない）。xau_paper の記録の方式は変わらない（A案・B案とも）", () => {
  const sc = scen(AT.d3, BOTH);
  const s17 = scen(AT.s17, BOTH);
  try {
    for (const r of [design(sc), status(s17)]) {
      const xs = r.shadowAppend.filter((x) => x.symbol === "XAUUSD");
      assert.ok(xs.length >= 1);
      assert.ok(xs.every((x) => x.variant === "xau_paper"), "XAUUSD は xau_paper だけ");
      assert.ok(!r.shadowAppend.some((x) => x.variant === TV && x.symbol === "XAUUSD"));
      const xb = xs.find((x) => x.setup === "B");
      assert.deepEqual([xb.sl_a !== "", xb.sl_b !== ""], [true, true], "xau_paper の型Bは A案・B案とも（今までどおり）");
      const pe = r.plan.paper.filter((c) => c.symbol === "XAUUSD");
      assert.ok(pe.every((c) => c.variant === "xau_paper"));
      assert.ok(!r.plan.candidates.some((c) => c.symbol === "XAUUSD"));
    }
    // 設定を戻しても xau_paper の記録は同じ
    const a = design(sc).shadowAppend.filter((x) => x.variant === "xau_paper");
    const b = restored(() => design(sc)).shadowAppend.filter((x) => x.variant === "xau_paper");
    assert.deepEqual(a, b);
  } finally { cleanup(sc, s17); }
});

test("設定を戻すと今までと同じ出力: 型Bの案に A案・B案が付き、paper・型B×A案の並行記録・参考の1行・paper_schemes が無い", () => {
  const sc = scen(AT.d3, BOTH);
  try {
    const r = restored(() => design(sc));
    const eu = r.plan.candidates.find((c) => c.symbol === "EURUSD" && c.setup === "B");
    assert.deepEqual([eu.schemes.A.pass, eu.schemes.B.pass], [true, true]);
    assert.ok(eu.schemes.A.lots.A > 0);
    assert.ok(r.logAppend.some((x) => x.symbol === "EURUSD" && x.setup === "B" && x.sl_a !== "" && x.lot_cap_a_A !== ""));
    assert.deepEqual(r.plan.paper.filter((c) => c.variant === TV), []);
    assert.ok(!("paper_schemes" in r.plan), "設定を戻したら paper_schemes の項目ごと無い（plan.json も今までと同じ）");
    assert.ok(!r.shadowAppend.some((x) => x.variant === TV));
    assert.ok(!/型B×A案/.test(render(r.plan, r.plan.accounts)));
    assert.deepEqual(r.plan.summary.scheme_pass, { A: 5, B: 5 });
  } finally { cleanup(sc); }
});

// ---- variant ごとの独立（sl_floor_b・xau_paper・typeb_a_paper）----
const quiet = () => { const out = []; return { out, io: { log: (m) => out.push(String(m)) } }; };
const run = (sc, extra, env = {}) => { const q = quiet(); return main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", `--now=${sc.nowIso}`, ...extra], { ...sc.env, ...env }, q.io).then((r) => ({ r, out: q.out })); };
const read = (sc, rel) => fs.readFileSync(path.join(sc.dataDir, rel), "utf8");
const readShadow = (sc) => L.parseLog(read(sc, "daytrade/shadow-log.csv"), L.SHADOW_COLUMNS);
const readLog = (sc) => L.parseLog(read(sc, "daytrade/log.csv"));
const as = (row, variant, o = {}) => ({ ...row, variant, ...o });
const NORM = ["run", "setup", "symbol", "side", "entry_low", "entry_high", "sl_a", "tp_a", "sl_b", "tp_b", "rr_a", "rr_b", "cost_cap_a", "expires_at", "reached", "reached_at", "first_hit_a", "first_hit_b", "exit_a", "exit_b", "pips_a", "pips_b", "r_a", "r_b"];
const norm = (r, keys = NORM) => Object.fromEntries(keys.map((k) => [k, r[k] ?? ""]));

test("variant の独立（設計）: 同じ版が sl_floor_b・xau_paper・typeb_a_paper の3つに入っていても、取消・追記は variant ごと（typeb の版が続けば、ほかの2つの取消は typeb に影響しない）", () => {
  const sc = scen(AT.d3, BOTH);
  try {
    const first = design(sc);
    const p = first.shadowAppend.find((r) => r.variant === TV && r.symbol === "EURUSD");
    const s = as(p, "sl_floor_b"), x = as(p, "xau_paper");
    assert.equal(L.keyOf(p), L.keyOf(s));
    const byV = (r, v) => r.shadowAppend.filter((y) => y.variant === v);
    // typeb の版 K は今回も出る（続く）。sl_floor_b・xau_paper の K は今回の案に無い → その2つだけ取消。typeb には何も足さない（K も、ほかの版も）
    const next = design(sc, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: [p, s, x] });
    assert.deepEqual(byV(next, TV).filter((y) => y.symbol === "EURUSD"), [], "typeb の K は続く。取消されない");
    assert.deepEqual(byV(next, "sl_floor_b").map((y) => [y.run, y.symbol, L.keyOf(y) === L.keyOf(p)]), [["status", "EURUSD", true]]);
    assert.deepEqual(byV(next, "xau_paper").filter((y) => y.run === "status").map((y) => [y.symbol, L.keyOf(y) === L.keyOf(p)]), [["EURUSD", true]]);
    assert.ok(byV(next, "sl_floor_b")[0].reached.startsWith("取消"));
    // typeb の行が無いとき（sl_floor_b・xau_paper にだけある）: typeb は K を新しい版として追記する。ほかの2つの取消の行は typeb に出ない
    const only = design(sc, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: [s, x] });
    assert.deepEqual(byV(only, TV).filter((y) => y.symbol === "EURUSD").map((y) => [y.run, L.keyOf(y) === L.keyOf(p)]), [["design", true]]);
    assert.ok(byV(only, TV).every((y) => y.run === "design"), "typeb に取消の行は出ない");
    // 取消のあとの次の設計: どの variant も何も足さない
    const again = design(sc, { prevPlan: next.plan, logRows: [...first.logAppend, ...next.logAppend], shadowLogRows: [p, s, x, ...next.shadowAppend] });
    assert.deepEqual(again.shadowAppend, []);
  } finally { cleanup(sc); }
});

function extendBars(sc, rows) {
  // 有効期限（翌03:00）まで H1 足を足す。rows: { EURUSD: [[時刻, o, h, l, c], ...] }。ほかの銘柄は 02:00 の足を足す
  const h1 = JSON.parse(fs.readFileSync(path.join(sc.dataDir, "h1-bars.json"), "utf8"));
  const mk = ([t, o, h, l, c]) => ({ time_jst: t, o, h, l, c });
  for (const [code, list] of Object.entries(rows)) h1.pairs[code].push(...list.map(mk));
  for (const code of Object.keys(h1.pairs)) if (!rows[code]) h1.pairs[code].push(mk(["2026-10-09 02:00", 1, 1, 1, 1]));
  fs.writeFileSync(path.join(sc.dataDir, "h1-bars.json"), JSON.stringify(h1));
}
const parseBars = (sc) => Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(sc.dataDir, "h1-bars.json"), "utf8")).pairs).map(([c, list]) => [c, list.map((b) => ({ t: J.parseIso(b.time_jst.replace(" ", "T") + ":00+09:00"), o: b.o, h: b.h, l: b.l, c: b.c }))]));
const { scoreRows } = require("../score");

test("variant の独立（採点）: 同じ版が3つの variant にあり、取消の有無・時刻が違っても、それぞれ自分の行だけで採点される（daytrade-score.js も variant ごと）", () => {
  const sc = scen(AT.d3, BOTH);
  try {
    const first = design(sc);
    const p = first.shadowAppend.find((r) => r.variant === TV && r.symbol === "EURUSD");
    const bl = Number(p.entry_low), bh = Number(p.entry_high), tp = Number(p.tp_a);
    // 売り: 22:00 の足が帯に触れ、23:00 の足が TP1 に届く。有効期限（03:00）まで届く足も足す
    extendBars(sc, { EURUSD: [["2026-10-08 22:00", bl, bh + 0.0003, bl - 0.0001, bl], ["2026-10-08 23:00", bl, bl, tp - 0.0002, tp], ["2026-10-09 02:00", tp, tp + 0.0001, tp - 0.0001, tp]] });
    const bars = parseBars(sc);
    const now = J.parseIso("2026-10-09T06:30:00+09:00");
    const s = as(p, "sl_floor_b"), x = as(p, "xau_paper");
    // sl_floor_b は 21:45（帯に触れる前）に取消、xau_paper は 23:05（22:00 の足が確定して帯に触れたあと）に取消、typeb は取消なし
    const cs = { ...s, run: "status", generated_at: "2026-10-08T21:45:00+09:00", reached: "取消(再設計)" };
    const cx = { ...x, run: "status", generated_at: "2026-10-08T23:05:00+09:00", reached: "取消(再設計)" };
    const rows = [p, s, cs, x, cx];
    const tp1 = scoreRows({ rows, barsByCode: bars, nowMs: now, variant: TV });
    const sf = scoreRows({ rows, barsByCode: bars, nowMs: now, variant: "sl_floor_b" });
    const xp = scoreRows({ rows, barsByCode: bars, nowMs: now, variant: "xau_paper" });
    assert.deepEqual(tp1.newRows.map((r) => [r.variant, r.run, r.reached, r.first_hit_a]), [[TV, "status", "到達", "TP1"]], "typeb の版は取消の影響を受けずに採点される");
    assert.deepEqual(sf.newRows, [], "sl_floor_b: 取消の時刻（21:45）までに到達していない → 取消(再設計)のまま");
    assert.deepEqual(xp.newRows.map((r) => [r.variant, r.reached]), [["xau_paper", "取消(到達後)"]], "xau_paper: 取消の時刻（23:05）までに到達 → 取消(到達後)（採点は有効期限まで追う）");
    // CLI: 1つのファイルの variant を全部採点する
    fs.mkdirSync(path.join(sc.dataDir, "daytrade"), { recursive: true });
    fs.writeFileSync(path.join(sc.dataDir, "daytrade", "shadow-log.csv"), L.appendedText("", rows, L.SHADOW_COLUMNS));
    scoreMain([`--data-dir=${sc.dataDir}`, "--now=2026-10-09T06:30:00+09:00"], quiet().io);
    const after = readShadow(sc).slice(rows.length);
    assert.deepEqual(after.map((r) => [r.variant, r.reached, r.first_hit_a]).sort(), [[TV, "到達", "TP1"], ["xau_paper", "取消(到達後)", "TP1"]]);
  } finally { cleanup(sc); }
});

test("variant の独立（同じ水準は到達済み）: typeb_a_paper の到達済みの版は、同じ水準の新しい typeb の版だけを抑える（sl_floor_b・xau_paper・ライブ log.csv の履歴とは別）", () => {
  const sc = scen(AT.d3, BOTH);
  try {
    const first = design(sc);
    const p = first.shadowAppend.find((r) => r.variant === TV && r.symbol === "EURUSD");
    // 同じ水準で SL だけ違う、17:00 に作った到達済みの版（模擬の H1 足は 18:00〜20:00 に帯へ触れる）
    const old = { ...p, sl_a: "1.10900", generated_at: "2026-10-08T17:00:00+09:00" };
    const idea = (rows, variant) => V.reachedIdeas({ rows, planDate: "2026-10-08", barsByCode: { EURUSD: sc.barsByCode.EURUSD }, nowMs: sc.nowMs, variant }).ideas.size;
    assert.equal(idea([old], TV), 1);
    assert.equal(idea([old], "sl_floor_b"), 0);
    assert.equal(idea([old], "xau_paper"), 0);
    assert.equal(idea([old], null), 0);
    const hasEu = (r, v) => r.shadowAppend.some((y) => y.variant === v && y.run === "design" && y.symbol === "EURUSD" && y.setup === "B");
    // typeb の履歴だけ: typeb の版は抑える（出し直さない）。『同じ水準は到達済み』として数える
    const t = design(sc, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: [old] });
    assert.equal(hasEu(t, TV), false);
    assert.ok(t.plan.summary.extra["同じ水準は到達済み"] >= 1);
    // ライブの B案は抑えない（ライブの履歴は空・前の計画も無い状態で、typeb の到達済みの版だけがある → ライブの版は出て log.csv にも追記される）
    const liveOnly = design(sc, { prevPlan: null, logRows: [], shadowLogRows: [old] });
    assert.equal(hasEu(liveOnly, TV), false);
    assert.ok(liveOnly.plan.candidates.some((c) => c.symbol === "EURUSD" && c.setup === "B"), "ライブの B案は抑えない");
    assert.ok(liveOnly.logAppend.some((r) => r.symbol === "EURUSD" && r.setup === "B" && r.run !== "status"), "log.csv にも追記される");
    // 別の variant の同じ履歴では、typeb の版は出る
    for (const v of ["sl_floor_b", "xau_paper"]) assert.equal(hasEu(design(sc, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: [as(old, v)] }), TV), true, `${v} の履歴は typeb を抑えない`);
    // ライブ（log.csv）の同じ水準の到達済みの行は、typeb の版を抑えない（ライブの B案だけを抑える。今までの規則）
    const liveOld = restored(() => design(sc)).logAppend.find((r) => r.symbol === "EURUSD" && r.setup === "B");
    const reachedLive = { ...liveOld, sl_a: "1.10900", generated_at: "2026-10-08T17:00:00+09:00" };
    const withLive = design(sc, { prevPlan: null, logRows: [reachedLive], shadowLogRows: [] });
    assert.equal(hasEu(withLive, TV), true, "log.csv の履歴は typeb を抑えない");
    // ライブの B案だけの版は、log.csv の同じ水準の到達済みの版で、今までどおり抑える（出し直さない）
    const reachedLive2 = { ...liveOld, sl_a: "1.10900", sl_b: "1.11000", generated_at: "2026-10-08T17:00:00+09:00" };
    const suppressed = design(sc, { prevPlan: null, logRows: [reachedLive2], shadowLogRows: [] });
    assert.ok(!suppressed.plan.candidates.some((c) => c.symbol === "EURUSD" && c.setup === "B"), "ライブの B案だけの版は同じ水準の到達済みで抑える");
    assert.ok(!suppressed.logAppend.some((r) => r.symbol === "EURUSD" && r.setup === "B" && r.run !== "status"));
    assert.ok(suppressed.plan.summary.extra["同じ水準は到達済み"] >= 1);
  } finally { cleanup(sc); }
});

// ---- 切替 ----
test("切替: 切替前の plan.json の型B（A案・B案とも通っていた）は、状態更新でも設計①②でも、ライブの見え方（B案だけ）に変える。log.csv は元の版を取消して新しい版を追記する（元の設計時刻のまま）。通知は取消＋新しい案", () => {
  const sc = scen(AT.d3, BOTH);
  const s2 = scen("2026-10-08T21:40:00+09:00", BOTH);
  const d2 = scen("2026-10-08T21:45:00+09:00", BOTH);
  try {
    const before = restored(() => design(sc));
    const oldEu = before.plan.candidates.find((c) => c.symbol === "EURUSD" && c.setup === "B");
    assert.equal(oldEu.schemes.A.pass, true);
    const oldKey = D.versionKey(oldEu);
    const markers = before.plan.candidates.map((c) => D.markerOf(D.K.new(D.versionKey(c))).match(/key=(.*?) -->/)[1]);
    // (1) 切替後の最初の実行が状態更新
    const st = status(s2, { prevPlan: before.plan, logRows: before.logAppend });
    const eu = st.plan.candidates.find((c) => c.symbol === "EURUSD" && c.setup === "B");
    assert.deepEqual([eu.schemes.A.pass, eu.schemes.A.reason, eu.schemes.B.pass], [false, "paper_scheme", true]);
    assert.ok(!("sl" in eu.schemes.A) && !("lots" in eu.schemes.A));
    assert.equal(eu.generated_at, oldEu.generated_at, "元の設計時刻のまま");
    for (const k of ["pass", "sl", "tp1", "rr", "lots", "commission_jpy", "cost_cap_pips"]) assert.deepEqual(eu.schemes.B[k], oldEu.schemes.B[k], `B案の ${k} は切替前の版のまま（上限ロットも）`);
    const cancel = st.logAppend.filter((r) => r.run === "status" && r.symbol === "EURUSD" && r.setup === "B");
    assert.equal(cancel.length, 1);
    assert.equal(L.keyOf(cancel[0]), L.keyOf(before.logAppend.find((r) => r.symbol === "EURUSD" && r.setup === "B")), "元の版（A案つき）を取消す");
    const added = st.logAppend.filter((r) => r.run !== "status" && r.symbol === "EURUSD" && r.setup === "B");
    assert.deepEqual(added.map((r) => [r.run, r.sl_a, r.sl_b !== "", r.generated_at]), [["design", "", true, oldEu.generated_at]], "新しい版（B案だけ）。時刻は元の設計時刻");
    // 通知: 元の版は取消、B案だけの版は新しい案
    const ev = D.candidateEvents({ nowMs: s2.nowMs, plan: st.plan, intraday: null, markers });
    assert.ok(ev.cancelled.some((c) => c.v === oldKey));
    assert.ok(ev.newCands.some((c) => c.symbol === "EURUSD" && c.setup === "B"));
    // 状態更新で追加した型B（design-b）が切り替わるときは、新しい版の行も design-b
    const s17 = scen(AT.s17, BOTH);
    try {
      const addedOld = restored(() => status(s17));
      const stB = status(s2, { prevPlan: { ...addedOld.plan, plan_date: "2026-10-08", designs: [{ slot: 3, generated_at: "2026-10-08T17:00:00+09:00", inputs_ok: true }] }, logRows: addedOld.logAppend });
      const row = stB.logAppend.find((r) => r.run !== "status" && r.symbol === "EURUSD" && r.setup === "B");
      assert.deepEqual([row.run, row.sl_a, row.generated_at], ["design-b", "", "2026-10-08T17:00:00+09:00"]);
    } finally { cleanup(s17); }
    // 取消・追記したあとは何も足さない
    const again = status(s2, { prevPlan: st.plan, logRows: [...before.logAppend, ...st.logAppend] });
    assert.deepEqual(again.logAppend.filter((r) => r.symbol === "EURUSD" && r.setup === "B"), []);
    // (2) 切替後の最初の実行が設計②（型Bは再設計しないで引き継ぐ）: 同じ変換
    const d = design(d2, { slot: 2, prevPlan: before.plan, logRows: before.logAppend });
    const deu = d.plan.candidates.find((c) => c.symbol === "EURUSD" && c.setup === "B");
    assert.deepEqual([deu.schemes.A.pass, deu.schemes.B.pass], [false, true]);
    assert.equal(d.logAppend.filter((r) => r.run === "status" && r.symbol === "EURUSD" && r.setup === "B").length, 1);
    assert.equal(d.logAppend.filter((r) => r.run !== "status" && r.symbol === "EURUSD" && r.setup === "B").length, 1);
  } finally { cleanup(sc, s2, d2); }
});

test("切替: 切替前の型B（A案だけ通っていた）は、ライブの候補から外し、log.csv は取消す（通知は取消）。B案が通っていなければ新しい版は無い", () => {
  const sc = scen(AT.d3, aOnlyFor(AT.d3));
  const s2 = scen("2026-10-08T21:40:00+09:00", aOnlyFor("2026-10-08T21:40:00+09:00"));
  try {
    const before = restored(() => design(sc));
    const oldEu = before.plan.candidates.find((c) => c.symbol === "EURUSD" && c.setup === "B");
    assert.deepEqual([oldEu.schemes.A.pass, oldEu.schemes.B.pass], [true, false]);
    const markers = before.plan.candidates.map((c) => D.markerOf(D.K.new(D.versionKey(c))).match(/key=(.*?) -->/)[1]);
    const st = status(s2, { prevPlan: before.plan, logRows: before.logAppend });
    assert.ok(!st.plan.candidates.some((c) => c.symbol === "EURUSD" && c.setup === "B"));
    const rows = st.logAppend.filter((r) => r.symbol === "EURUSD" && r.setup === "B");
    assert.deepEqual(rows.map((r) => r.run), ["status"]);
    assert.ok(/^取消\(/.test(rows[0].reached));
    const ev = D.candidateEvents({ nowMs: s2.nowMs, plan: st.plan, intraday: null, markers });
    assert.ok(ev.cancelled.some((c) => c.info.symbol === "EURUSD" && c.info.setup === "B"));
  } finally { cleanup(sc, s2); }
});

test("設計①②: 状態更新で追加した型Bは取消さずに引き継ぐ（ライブは B案だけ、paper の型B×A案も引き継ぐ）。前の計画日・設定を戻したあとの paper は引き継がない", () => {
  const s17 = scen(AT.s17, BOTH);
  const d2 = scen("2026-10-08T16:30:00+09:00", BOTH);
  const d3 = scen(AT.d3, BOTH);
  try {
    const st = status(s17);
    const rows = st.shadowAppend;
    const d = design(d2, { slot: 2, prevPlan: st.plan, logRows: st.logAppend, shadowLogRows: rows });
    // 型Bの版は取消さない（log.csv も typeb も）
    assert.ok(!d.logAppend.some((r) => r.setup === "B" && r.run === "status"));
    assert.ok(!d.shadowAppend.some((r) => r.variant === TV));
    assert.deepEqual(typeB(d.plan.candidates).map((c) => c.symbol).sort(), ["AUDUSD", "EURUSD"]);
    assert.ok(typeB(d.plan.candidates).every((c) => c.schemes.A.pass === false));
    assert.deepEqual(d.plan.paper.filter((c) => c.variant === TV).map((c) => c.symbol).sort(), ["AUDUSD", "EURUSD"]);
    // 前の計画日の paper は引き継がない
    const yesterday = { ...st.plan, plan_date: "2026-10-07" };
    assert.deepEqual(design(d2, { slot: 2, prevPlan: yesterday }).plan.paper.filter((c) => c.variant === TV), []);
    // 設定を戻したあと（paper が残っている plan.json）は、型B×A案の paper を引き継がない（同じ案がライブと paper の両方に出ない）
    const back = restored(() => design(d2, { slot: 2, prevPlan: st.plan, logRows: st.logAppend, shadowLogRows: rows }));
    assert.deepEqual(back.plan.paper.filter((c) => c.variant === TV), []);
    const backSt = restored(() => status(s17, { prevPlan: st.plan, logRows: st.logAppend, shadowLogRows: rows }));
    assert.deepEqual(backSt.plan.paper.filter((c) => c.variant === TV), []);
    // 設計③は型Bを再設計する: 同じ版が続く（取消さない）
    const third = design(d3, { slot: 3, prevPlan: st.plan, logRows: st.logAppend, shadowLogRows: rows });
    assert.ok(third.plan.paper.some((c) => c.variant === TV));
  } finally { cleanup(s17, d2, d3); }
});

test("同方向の印: ライブでは並行記録の型B×A案を数えない。並行記録の中では今までと同じ数え方（ライブの案も数え、同じ案〔B案がライブ・A案が paper〕は1つとして数える）", () => {
  const sc = scen(AT.d3, aOnlyFor(AT.d3));
  const sb = scen(AT.d3, BOTH);
  try {
    // A案だけ通った EURUSD の型B（paper のみ）: ライブの EURUSD 型A・GBPUSD 型A（どちらも USD買い・売りの組）と数える
    const r = design(sc);
    const old = restored(() => design(sc));
    const liveGroups = Object.fromEntries(r.plan.candidates.map((c) => [c.id, c.same_direction_group]));
    const clones = r.plan.candidates.map((c) => ({ ...c }));
    markSameDirection(clones, { USDJPY: ["USD", "JPY"], EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], EURJPY: ["EUR", "JPY"], AUDUSD: ["AUD", "USD"], EURGBP: ["EUR", "GBP"], USDCAD: ["USD", "CAD"], USDCHF: ["USD", "CHF"], NZDUSD: ["NZD", "USD"], XAUUSD: ["USD"] });
    assert.deepEqual(liveGroups, Object.fromEntries(clones.map((c) => [c.id, c.same_direction_group])), "ライブの印は、ライブの案だけで付けたものと同じ（paper を数えない）");
    const paperEu = r.plan.paper.find((c) => c.variant === TV && c.symbol === "EURUSD");
    assert.ok(paperEu.same_direction_group.includes("USD買い"));
    const oldGroups = Object.fromEntries(old.plan.candidates.map((c) => [c.id, c.same_direction_group]));
    assert.equal(paperEu.same_direction_group, oldGroups["2026-10-08:B:EURUSD:sell"], "今までのライブの数え方（型B×A案もライブの案だった）と同じ");
    // A案・B案とも通る型B: 同じ案（id が同じ）は1つとして数える。paper の印はライブの B案だけの案と同じ
    const b = design(sb);
    const liveEu = b.plan.candidates.find((c) => c.symbol === "EURUSD" && c.setup === "B");
    const pEu = b.plan.paper.find((c) => c.variant === TV && c.symbol === "EURUSD");
    assert.equal(pEu.id, liveEu.id);
    assert.equal(pEu.same_direction_group, liveEu.same_direction_group);
    const oldB = restored(() => design(sb));
    assert.deepEqual(Object.fromEntries(b.plan.candidates.map((c) => [c.id, c.same_direction_group])), Object.fromEntries(oldB.plan.candidates.map((c) => [c.id, c.same_direction_group])), "ライブの印は今までと同じ");
    // log の行の印も同じ
    assert.equal(b.shadowAppend.find((x) => x.variant === TV && x.symbol === "EURUSD").same_direction_group, liveEu.same_direction_group);
  } finally { cleanup(sc, sb); }
});

test("型Bの追加（状態更新）: 重複の判定は variant ごと。別の variant・log.csv の行が止めない。typeb の行はライブの B案の追加を止めない", () => {
  const s18 = scen(AT.s18, BOTH);
  try {
    const base = status(s18);
    const p = base.shadowAppend.find((r) => r.variant === TV && r.symbol === "EURUSD");
    const livePair = (r) => r.logAppend.filter((x) => x.run === "design-b").map((x) => x.symbol).sort();
    const typebSyms = (r) => r.shadowAppend.filter((x) => x.variant === TV).map((x) => x.symbol).sort();
    assert.deepEqual(typebSyms(base), ["AUDUSD", "EURUSD"]);
    assert.deepEqual(livePair(base), ["AUDUSD", "EURUSD"]);
    // typeb の行がある → typeb の EURUSD は追加しない（ほかは追加）。ライブの B案の追加は止めない
    const withP = status(s18, { shadowLogRows: [p] });
    assert.deepEqual(typebSyms(withP), ["AUDUSD"]);
    assert.deepEqual(livePair(withP), ["AUDUSD", "EURUSD"]);
    // 別の variant に同じ鍵の行があっても、typeb は追加される
    for (const v of ["sl_floor_b", "xau_paper"]) assert.deepEqual(typebSyms(status(s18, { shadowLogRows: [as(p, v)] })), ["AUDUSD", "EURUSD"], v);
    // log.csv に（切替前の）EURUSD の型Bの行があっても、typeb は追加される。ライブの EURUSD の B案の追加は、今までどおり止まる（同じ日・銘柄・向き）
    const oldRow = restored(() => status(s18)).logAppend.find((x) => x.symbol === "EURUSD");
    const withLog = status(s18, { logRows: [oldRow] });
    assert.deepEqual(typebSyms(withLog), ["AUDUSD", "EURUSD"]);
    assert.ok(!livePair(withLog).includes("EURUSD"));
    // sl_floor_b・xau_paper の追加は、typeb の行に影響されない
    const others = (r) => r.shadowAppend.filter((x) => x.variant !== TV).map((x) => `${x.variant}/${x.symbol}`).sort();
    assert.deepEqual(others(withP), others(base));
  } finally { cleanup(s18); }
});

test("型Bの追加（状態更新）: ライブの『同じ銘柄・向きが既にある』は plan.json の paper を数えない。A案だけ通った17時のあとで B案も通れば、18時にライブの B案が追加され、typeb は二重に足さない", () => {
  const s17 = scen(AT.s17, aOnlyFor(AT.s17));
  const s18 = scen(AT.s18, BOTH);
  try {
    const first = status(s17);
    assert.ok(!first.plan.candidates.some((c) => c.symbol === "EURUSD" && c.setup === "B"));
    assert.ok(first.plan.paper.some((c) => c.variant === TV && c.symbol === "EURUSD"), "17時: A案だけ → paper にだけある");
    const prev = { ...first.plan, plan_date: "2026-10-08", designs: [{ slot: 3, generated_at: "2026-10-08T17:00:00+09:00", inputs_ok: true }] };
    const next = status(s18, { prevPlan: prev, logRows: first.logAppend, shadowLogRows: first.shadowAppend });
    const live = next.logAppend.filter((r) => r.symbol === "EURUSD" && r.setup === "B" && r.run === "design-b");
    assert.deepEqual(live.map((r) => [r.sl_a, r.sl_b !== ""]), [["", true]], "ライブの B案だけの版が追加される（paper の EURUSD に止められない）");
    assert.ok(next.plan.candidates.some((c) => c.symbol === "EURUSD" && c.setup === "B"));
    assert.deepEqual(next.shadowAppend.filter((r) => r.variant === TV && r.symbol === "EURUSD"), [], "typeb の EURUSD は、17時の行があるので二重に足さない");
    assert.equal(next.plan.paper.filter((c) => c.variant === TV && c.symbol === "EURUSD").length, 1);
  } finally { cleanup(s17, s18); }
});

test("同方向の印（状態更新）: ライブの印は paper を数えない（ライブの案だけで付けた値と同じ）。typeb の印はライブの B案だけの案と同じ（同じ案を1つとして数える）", () => {
  const s18 = scen(AT.s18, BOTH);
  try {
    const st = status(s18);
    const cur = { USDJPY: ["USD", "JPY"], EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], EURJPY: ["EUR", "JPY"], AUDUSD: ["AUD", "USD"], EURGBP: ["EUR", "GBP"], USDCAD: ["USD", "CAD"], USDCHF: ["USD", "CHF"], NZDUSD: ["NZD", "USD"], XAUUSD: ["USD"] };
    const clones = st.plan.candidates.map((c) => ({ ...c }));
    markSameDirection(clones, cur);
    assert.deepEqual(Object.fromEntries(st.plan.candidates.map((c) => [c.id, c.same_direction_group])), Object.fromEntries(clones.map((c) => [c.id, c.same_direction_group])));
    for (const s of ["EURUSD", "AUDUSD"]) {
      const l = st.plan.candidates.find((c) => c.symbol === s && c.setup === "B");
      const p = st.plan.paper.find((c) => c.variant === TV && c.symbol === s);
      assert.equal(p.id, l.id);
      assert.equal(p.same_direction_group, l.same_direction_group, s);
      assert.equal(st.shadowAppend.find((r) => r.variant === TV && r.symbol === s).same_direction_group, l.same_direction_group, `${s}: 行の印も同じ`);
    }
    // xau_paper の印には、型Bの A案（paper）も入る（XAUUSD の記録の値は、型B×A案がライブだった今までと同じ）
    const back = restored(() => status(s18));
    const xau = (r) => r.plan.paper.filter((c) => c.variant === "xau_paper").map((c) => [c.id, c.same_direction_group]);
    assert.deepEqual(xau(st), xau(back), "xau_paper の印は設定を戻したときと同じ");
  } finally { cleanup(s18); }
});

test("型Bの追加（状態更新）: shadow-log.csv を読めない（null）ときは typeb も追加しない（記録 0 件・unreadable）。読めた次の実行で記録される", () => {
  const s18 = scen(AT.s18, BOTH);
  try {
    const bad = status(s18, { shadowLogRows: null });
    assert.deepEqual(bad.shadowAppend, []);
    assert.deepEqual(bad.plan.paper.filter((c) => c.variant === TV), []);
    assert.deepEqual(bad.plan.paper_schemes, [{ variant: TV, setup: "B", scheme: "A", recording: "unreadable", recorded: 0 }]);
    assert.equal(bad.plan.paper_status.recording, "unreadable");
    assert.match(render(bad.plan, bad.plan.accounts), /参考：型B×A案は発注の対象外（並行記録のみ。並行記録を読めないため、今回は記録なし）/);
    // ライブの B案は影響を受けない
    assert.deepEqual(typeB(bad.plan.candidates).map((c) => c.symbol).sort(), ["AUDUSD", "EURUSD"]);
    assert.ok(typeB(bad.plan.candidates).every((c) => c.schemes.A.pass === false && c.schemes.B.pass === true));
    // 読めた次の実行（前の計画あり）: 記録される
    const next = status(s18, { prevPlan: { ...bad.plan, plan_date: "2026-10-08", designs: [{ slot: 3, generated_at: "2026-10-08T17:00:00+09:00", inputs_ok: true }] }, logRows: bad.logAppend, shadowLogRows: [] });
    assert.deepEqual(next.shadowAppend.filter((r) => r.variant === TV).map((r) => r.symbol).sort(), ["AUDUSD", "EURUSD"]);
    assert.equal(next.plan.paper_schemes[0].recorded, 2);
  } finally { cleanup(s18); }
});

test("記録件数（引き継ぎ）: 前の計画から引き継いだ型B×A案も、記録済みなら『今回 n 件記録』に数える（設計②・状態更新とも）", () => {
  const s17 = scen(AT.s17, BOTH);
  const s18 = scen(AT.s18, BOTH);
  const d2 = scen("2026-10-08T16:30:00+09:00", BOTH);
  try {
    const first = status(s17);
    assert.equal(first.plan.paper_schemes[0].recorded, 2);
    const prev = { ...first.plan, plan_date: "2026-10-08", designs: [{ slot: 3, generated_at: "2026-10-08T17:00:00+09:00", inputs_ok: true }] };
    const second = status(s18, { prevPlan: prev, logRows: first.logAppend, shadowLogRows: first.shadowAppend });
    assert.deepEqual(second.shadowAppend.filter((r) => r.variant === TV), [], "引き継ぎ: 追記しない");
    assert.equal(second.plan.paper_schemes[0].recorded, 2, "引き継いだ2件は記録済み");
    assert.match(render(second.plan, second.plan.accounts), /今回 2 件記録/);
    const d = design(d2, { slot: 2, prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: first.shadowAppend });
    assert.equal(d.plan.paper_schemes[0].recorded, 2);
    assert.match(render(d.plan, d.plan.accounts), /今回 2 件記録/);
    // 記録が無ければ 0（読めるが、行が無い）
    assert.equal(design(d2, { slot: 2, prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: [] }).plan.paper_schemes[0].recorded, 0);
  } finally { cleanup(s17, s18, d2); }
});

test("設計①②: 切替前の A案だけ通った型Bを引き継いでも、ライブには出ない（A案の価格・ロットがライブに漏れない）。log.csv の版は取消す", () => {
  const sc = scen(AT.d3, aOnlyFor(AT.d3));
  const d2 = scen("2026-10-08T21:45:00+09:00", aOnlyFor("2026-10-08T21:45:00+09:00"));
  try {
    const before = restored(() => design(sc));
    const oldEu = before.plan.candidates.find((c) => c.symbol === "EURUSD" && c.setup === "B");
    assert.deepEqual([oldEu.schemes.A.pass, oldEu.schemes.B.pass], [true, false]);
    const d = design(d2, { slot: 2, prevPlan: before.plan, logRows: before.logAppend });
    assert.ok(!d.plan.candidates.some((c) => c.id === oldEu.id), "ライブの候補に出ない");
    assert.ok(!JSON.stringify(d.plan.candidates).includes(String(oldEu.schemes.A.sl)), "A案の SL の価格がライブに出ない");
    assert.ok(!d.logAppend.some((r) => r.symbol === "EURUSD" && r.setup === "B" && r.run !== "status"), "log.csv に新しい版を足さない");
    const cancel = d.logAppend.filter((r) => r.symbol === "EURUSD" && r.setup === "B");
    assert.deepEqual(cancel.map((r) => r.run), ["status"]);
    assert.ok(/^取消\(/.test(cancel[0].reached));
    assert.equal(L.keyOf(cancel[0]), L.keyOf(before.logAppend.find((r) => r.symbol === "EURUSD" && r.setup === "B")));
  } finally { cleanup(sc, d2); }
});

test("通知・Issue: 型Bの案は B案だけ（A案は『不採用（並行記録のみ）』。SL・ロットなし）。A案だけ通った型Bは新しい案に出ない。設定を戻すと A案も出る", () => {
  const sc = scen(AT.d3, BOTH);
  const sa = scen(AT.d3, aOnlyFor(AT.d3));
  try {
    const r = design(sc);
    const ev = D.candidateEvents({ nowMs: sc.nowMs, plan: r.plan, intraday: null, markers: [] });
    const eu = ev.newCands.find((c) => c.symbol === "EURUSD" && c.setup === "B");
    assert.ok(eu, "B案だけの型Bは新しい案に出る");
    const block = F.candidateBlock(eu, r.plan.accounts);
    assert.match(block, /A案\(0\.5×ATR\): 不採用（並行記録のみ）/);
    assert.match(block, /B案\(1\.0×ATR\): SL/);
    assert.ok(!/A案\(0\.5×ATR\): SL/.test(block));
    // 型Bの案のどれにも A案の SL・ロットが出ない（型Aの案には今までどおり出る）
    const typeBs = ev.newCands.filter((c) => c.setup === "B");
    assert.equal(typeBs.length, 2);
    for (const c of typeBs) assert.ok(!/A案\(0\.5×ATR\): SL/.test(F.candidateBlock(c, r.plan.accounts)), c.symbol);
    assert.ok(ev.newCands.filter((c) => c.setup === "A").every((c) => /A案\(0\.5×ATR\): SL/.test(F.candidateBlock(c, r.plan.accounts))));
    const body = F.newCandidatesComment({ cands: ev.newCands, plan: r.plan }).body;
    assert.equal((body.match(/A案\(0\.5×ATR\): 不採用（並行記録のみ）/g) || []).length, 2, "新しい案のコメントでも、型Bの2件は A案が『並行記録のみ』");
    const old = restored(() => design(sc));
    const oldEv = D.candidateEvents({ nowMs: sc.nowMs, plan: old.plan, intraday: null, markers: [] });
    assert.match(F.candidateBlock(oldEv.newCands.find((c) => c.symbol === "EURUSD" && c.setup === "B"), old.plan.accounts), /A案\(0\.5×ATR\): SL/, "設定を戻すと A案も出る");
    // A案だけ通った型B: 新しい案に出ない（Issue にも出ない）
    const ra = design(sa);
    const eva = D.candidateEvents({ nowMs: sa.nowMs, plan: ra.plan, intraday: null, markers: [] });
    assert.ok(!eva.newCands.some((c) => c.symbol === "EURUSD" && c.setup === "B"));
    const textA = [F.newCandidatesComment({ cands: eva.newCands, plan: ra.plan }).body, F.issueBody({ planDate: "2026-10-08", plan: ra.plan }).body].join("\n");
    assert.ok(!/EURUSD 型B/.test(textA));
  } finally { cleanup(sc, sa); }
});

// ---- CLI ----
test("daytrade-plan.js: shadow-log.csv に typeb_a_paper の行を書く（A案だけ）。同じ実行を繰り返しても二重に追記しない。log.csv の型Bは B案だけ。資金は出ない。読めないときは記録しない", async () => {
  const sc = scen(AT.d3, BOTH);
  try {
    const { r } = await run(sc, ["--run=design", "--slot=3"]);
    assert.equal(r.plan.paper_schemes[0].recorded, 2);
    const rows = readShadow(sc).filter((x) => x.variant === TV);
    assert.deepEqual(rows.map((x) => [x.run, x.setup, x.symbol, x.sl_a !== "", x.sl_b]).sort(), [["design", "B", "AUDUSD", true, ""], ["design", "B", "EURUSD", true, ""]]);
    const log = readLog(sc).filter((x) => x.setup === "B");
    assert.ok(log.length === 2 && log.every((x) => x.sl_a === "" && x.sl_b !== ""));
    assert.match(read(sc, "daytrade-plan.txt"), /参考：型B×A案は発注の対象外（並行記録のみ。今回 2 件記録）/);
    const text = read(sc, "daytrade/shadow-log.csv");
    const again = await run(sc, ["--run=design", "--slot=3", "--force"]);
    assert.deepEqual(again.r.shadowAppend.filter((x) => x.variant === TV), []);
    assert.equal(read(sc, "daytrade/shadow-log.csv"), text);
    for (const f of ["daytrade/shadow-log.csv", "daytrade/log.csv", "daytrade-plan.txt", "daytrade-plan.json"]) for (const e of Object.values(sc.env)) assert.ok(!read(sc, f).includes(e), `${f} に資金が出ていない`);
    // 読めないとき: ライブの計画は今までどおり。並行記録は触らない。txt に『記録なし』
    fs.writeFileSync(path.join(sc.dataDir, "daytrade", "shadow-log.csv"), "broken,header\n1,2\n");
    const bad = await run(sc, ["--run=design", "--slot=3", "--force"]);
    assert.equal(bad.r.plan.paper_schemes[0].recording, "unreadable");
    assert.equal(bad.r.plan.paper_schemes[0].recorded, 0);
    assert.match(read(sc, "daytrade-plan.txt"), /参考：型B×A案は発注の対象外（並行記録のみ。並行記録を読めないため、今回は記録なし）/);
    assert.equal(read(sc, "daytrade/shadow-log.csv"), "broken,header\n1,2\n");
    assert.ok(typeB(bad.r.plan.candidates).length >= 1);
  } finally { cleanup(sc); }
});

test("採点: typeb_a_paper の版は、log.csv に設定を戻して書いた A案と同じ規則・同じ値で採点される（到達・先着・損益）。ライブの B案の採点も今までと同じ", async () => {
  const mk = () => scen(AT.d3, BOTH);
  const a = mk(), b = mk();
  try {
    await run(a, ["--run=design", "--slot=3"]);
    const back = setSchemeLive("B", "A", true);
    try { await run(b, ["--run=design", "--slot=3"]); } finally { back(); }
    const p = readShadow(a).find((x) => x.variant === TV && x.symbol === "EURUSD");
    const bl = Number(p.entry_low), bh = Number(p.entry_high), tp = Number(p.tp_a);
    const bars = { EURUSD: [["2026-10-08 22:00", bl, bh + 0.0003, bl - 0.0001, bl], ["2026-10-08 23:00", bl, bl, tp - 0.0002, tp], ["2026-10-09 02:00", tp, tp + 0.0001, tp - 0.0001, tp]] };
    extendBars(a, bars); extendBars(b, bars);
    const next = "2026-10-09T06:30:00+09:00";
    const q = quiet();
    scoreMain([`--data-dir=${a.dataDir}`, `--now=${next}`], q.io);
    scoreMain([`--data-dir=${b.dataDir}`, `--now=${next}`], quiet().io);
    const paper = readShadow(a).find((x) => x.variant === TV && x.symbol === "EURUSD" && x.run === "status");
    const liveDefault = readLog(a).find((x) => x.symbol === "EURUSD" && x.setup === "B" && x.run === "status");
    const liveOld = readLog(b).find((x) => x.symbol === "EURUSD" && x.setup === "B" && x.run === "status");
    const A_COLS = ["reached", "reached_at", "first_hit_a", "exit_a", "pips_a", "r_a"];
    const B_COLS = ["reached", "reached_at", "first_hit_b", "exit_b", "pips_b", "r_b"];
    assert.deepEqual(norm(paper, A_COLS), norm(liveOld, A_COLS), "A案の採点は、今までの log.csv と同じ");
    assert.equal(paper.first_hit_a, "TP1");
    assert.ok(paper.pips_a !== "" && paper.r_a !== "");
    assert.deepEqual(norm(liveDefault, B_COLS), norm(liveOld, B_COLS), "ライブの B案の採点は今までと同じ");
    assert.deepEqual([liveDefault.first_hit_a, liveDefault.exit_a, liveDefault.pips_a, liveDefault.r_a], ["", "", "", ""], "ライブの行に A案の採点は入らない");
    assert.match(q.out.join("\n"), /\[並行記録\] 採点: 2026-10-08 型B EURUSD 売り .*［typeb_a_paper］/);
  } finally { cleanup(a, b); }
});

test("取消: 設計③で型Bの版が消えると、typeb の版も log.csv と同じ規則・同じ値で取消の行になる（H1 で到達していれば 取消(到達後)）", () => {
  const sc = scen(AT.d3, BOTH);
  const gone = makeScenario({ nowIso: "2026-10-08T22:30:00+09:00", spec: { ...DOWN_EU, EURUSD: { bars: { dir: "down" }, score: "0/3", dirs: ["→", "→", "→"] } } });
  try {
    const first = design(sc);
    const next = design(gone, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: first.shadowAppend });
    const old = restored(() => { const f = design(sc); return { f, n: design(gone, { prevPlan: f.plan, logRows: f.logAppend }) }; });
    const cancelT = next.shadowAppend.filter((r) => r.variant === TV && r.run === "status" && r.symbol === "EURUSD");
    const cancelOld = old.n.logAppend.filter((r) => r.run === "status" && r.symbol === "EURUSD" && r.setup === "B");
    assert.equal(cancelT.length, 1);
    assert.ok(/^取消\(/.test(cancelT[0].reached));
    const keys = ["run", "setup", "symbol", "side", "entry_low", "entry_high", "sl_a", "tp_a", "reached", "reached_at"];
    assert.deepEqual(norm(cancelT[0], keys), norm(cancelOld[0], keys), "log.csv に設定を戻して書いた取消と同じ値");
    const liveCancel = next.logAppend.filter((r) => r.run === "status" && r.symbol === "EURUSD" && r.setup === "B");
    assert.equal(liveCancel.length, 1);
    assert.deepEqual(norm(liveCancel[0], ["reached", "reached_at", "sl_a", "sl_b"]), { reached: cancelOld[0].reached, reached_at: cancelOld[0].reached_at, sl_a: "", sl_b: liveCancel[0].sl_b });
  } finally { cleanup(sc, gone); }
});

test("同方向の印（単体）: 同じ案（id が同じ）の paper は1つとして数える。ライブにその案が無い paper は、ライブの案と一緒に数える。variant ごとに数え直す", () => {
  const cur = { EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], XAUUSD: ["XAU", "USD"] };
  const mkc = (id, symbol, side, variant) => ({ id, symbol, side, setup: "B", ...(variant ? { variant } : {}) });
  // 同じ案がライブ（B案）と paper（A案）の両方にあり、ほかに同じ向きの案が無い → 印は付かない（自分と自分を数えない）
  const live = [mkc("X:B:EURUSD:sell", "EURUSD", "sell")];
  const paper = [mkc("X:B:EURUSD:sell", "EURUSD", "sell", TV)];
  markPaperGroups(live, paper, cur);
  assert.equal(paper[0].same_direction_group, "");
  assert.equal(live[0].same_direction_group, undefined, "ライブの案の印は変えない");
  // ライブに同じ向きの別の案がある → paper に印が付く（ライブの案の印は変わらない）
  const live2 = [mkc("X:A:GBPUSD:sell", "GBPUSD", "sell")];
  const paper2 = [mkc("X:B:EURUSD:sell", "EURUSD", "sell", TV)];
  markPaperGroups(live2, paper2, cur);
  assert.equal(paper2[0].same_direction_group, "USD買い");
  assert.equal(live2[0].same_direction_group, undefined);
  // variant ごとに数え直す: typeb_a_paper の案は XAUUSD（xau_paper）を数えない／xau_paper の案は、後から対象外になった型B×A案を数える（今までライブだった案）
  const xau = mkc("X:B:XAUUSD:sell", "XAUUSD", "sell", "xau_paper"), tb = mkc("X:B:EURUSD:sell", "EURUSD", "sell", TV);
  markPaperGroups([], [xau, tb], cur);
  assert.equal(tb.same_direction_group, "", "typeb_a_paper の印にXAUUSDは入らない");
  assert.equal(xau.same_direction_group, "USD買い", "xau_paper の印は、型B×A案も数える（今までと同じ値）");
  // ライブの案と同じ向きなら、どちらの variant にも印が付く
  const xau2 = mkc("X:B:XAUUSD:sell", "XAUUSD", "sell", "xau_paper"), tb2 = mkc("X:B:EURUSD:sell", "EURUSD", "sell", TV);
  markPaperGroups([mkc("X:A:GBPUSD:sell", "GBPUSD", "sell")], [xau2, tb2], cur);
  assert.equal(tb2.same_direction_group, "USD買い");
  assert.equal(xau2.same_direction_group, "USD買い");
});

test("splitBySchemeLive（単体）: 対象外の案が通っていない候補はそのまま。通っていれば、ライブには B案だけ（A案は価格・ロットなし）、paper には A案だけ（ロットなし）", () => {
  const pair = pairOf("EURUSD");
  const sch = (pass) => ({ pass, reason: pass ? null : "x", k: 0.5, sl: 1.1, tp1: 1.09, lots: { A: 0.1 }, commission_jpy: { A: 1 } });
  const cand = (a, b) => ({ id: "i", symbol: pair.code, setup: "B", schemes: { A: sch(a), B: sch(b) } });
  const only = cand(false, true);
  assert.equal(splitBySchemeLive(only).live, only);
  assert.deepEqual(splitBySchemeLive(only).papers, []);
  const both = splitBySchemeLive(cand(true, true));
  assert.deepEqual([both.live.schemes.A.pass, both.live.schemes.B.pass, "sl" in both.live.schemes.A, "lots" in both.live.schemes.A], [false, true, false, false]);
  assert.deepEqual([both.papers.length, both.papers[0].variant, both.papers[0].schemes.A.pass, both.papers[0].schemes.B.pass, "lots" in both.papers[0].schemes.A], [1, TV, true, false, false]);
  const aOnly = splitBySchemeLive(cand(true, false));
  assert.equal(aOnly.live, null);
  assert.equal(aOnly.papers.length, 1);
  // 型A は対象外の設定がないので、そのまま
  const typeA = { ...cand(true, true), setup: "A" };
  assert.equal(splitBySchemeLive(typeA).live, typeA);
});

test("記録件数: 発注の対象外の銘柄（xau_paper）と型B×A案（typeb_a_paper）の『今回 n 件記録』は、それぞれ自分の variant の件数だけ。読めないときはどちらも 0", () => {
  const sc = scen(AT.d3, BOTH);
  try {
    const ok = design(sc);
    assert.equal(ok.plan.paper.filter((c) => c.variant === "xau_paper").length, 2);
    assert.equal(ok.plan.paper.filter((c) => c.variant === TV).length, 2);
    assert.equal(ok.plan.paper_status.recorded, 2);
    assert.equal(ok.plan.paper_schemes[0].recorded, 2);
    // 片方の variant の行だけを今回追記しない（すでにある）場合も、数えるのは自分の variant の行だけ
    const rows = ok.shadowAppend;
    const onlyX = status(sc, { prevPlan: ok.plan, logRows: ok.logAppend, shadowLogRows: rows.filter((r) => r.variant === "xau_paper") });
    assert.equal(onlyX.plan.paper_status.recorded, 2);
    assert.equal(onlyX.plan.paper_schemes[0].recorded, onlyX.shadowAppend.filter((r) => r.variant === TV).length, "typeb の行が無いので、今回追記した分だけ");
    // 同じ鍵の行が別の variant にあっても、自分の variant の行だけで数える（typeb の行を xau_paper の行として持たせても、xau_paper の記録済みには数えない）
    const swapped = status(sc, { prevPlan: ok.plan, logRows: ok.logAppend, shadowLogRows: rows.filter((r) => r.variant === TV).map((r) => as(r, "xau_paper")) });
    assert.equal(swapped.plan.paper_status.recorded, 0);
    assert.equal(swapped.plan.paper_schemes[0].recorded, 0);
    const bad = design(sc, { shadowReadable: false });
    assert.deepEqual([bad.plan.paper_status.recorded, bad.plan.paper_schemes[0].recorded, bad.plan.paper_schemes[0].recording], [0, 0, "unreadable"]);
  } finally { cleanup(sc); }
});
