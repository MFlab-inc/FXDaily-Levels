"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadInputs } = require("../inputs");
const { buildDesign, buildStatus, candRow } = require("../plan");
const { render } = require("../render");
const { main } = require("../../daytrade-plan");
const { main: scoreMain } = require("../../daytrade-score");
const L = require("../log");
const V = require("../versions");
const J = require("../jst");
const { scoreRows } = require("../score");
const { PAIRS, pairOf, isLive } = require("../pairs");
const D = require("../notify/detect");
const F = require("../notify/format");
const { makeScenario } = require("./scenario");
const { rm, setXauLive } = require("./helpers");

/**
 * XAUUSD を発注の対象外の並行記録に移す（2026-11-09 本人決定。論点 c）。pairs.js の XAUUSD は live:false が既定（この試験は既定のまま動かす）。
 * 案はこれまでどおり同じ規則（SL下限(a)・障害(a)）で作り、shadow-log.csv の variant=xau_paper に記録・採点する。ライブの候補・log.csv・通知・上限ロットには出さない。
 * 版・取消・採点・『同じ水準は到達済み』・型Bの重複の判定は variant ごとに独立（版の鍵に variant は入っていない）。live を戻せば今までと同じ出力。
 * 既存の試験は先頭で setXauLive(true) として（XAUUSD もライブの候補になる前提で書かれているので）、期待値は変えずに動かしている。
 */
const noFeed = { status: "未取得", reason: "x", pairs: {} };
const cleanup = (...scs) => { for (const sc of scs) rm(path.dirname(sc.dataDir)); };
const inputsOf = (sc) => loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs, env: sc.env });
const design = (sc, o = {}) => buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, slot: o.slot ?? 2, prevPlan: o.prevPlan ?? null, logRows: o.logRows ?? [], shadowLogRows: o.shadowLogRows ?? [] });
const status = (sc, o = {}) => buildStatus({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, prevPlan: o.prevPlan ?? null, logRows: o.logRows ?? [], shadowLogRows: o.shadowLogRows ?? [] });
const live = (fn) => { const restore = setXauLive(true); try { return fn(); } finally { restore(); } };
const xau = (rows) => rows.filter((r) => r.symbol === "XAUUSD");
const syms = (cs) => cs.map((c) => `${c.symbol}${c.setup}`);
const SCHEME_KEYS = ["pass", "reason", "k", "sl", "sl_pips", "tp1", "profit_pips", "rr", "cost_cap_pips", "cost_threshold_pips"];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

// XAUUSD の H1 の幅（=ATR）を pips（0.1ドル）にする。12pips なら A案は (a) で『SL幅不足』、(b)（10pips に広げる）なら通る。B案は (a) でも通る
const narrowXau = (pips) => (bars) => bars.map((b) => ({ ...b, h: Number((b.o + (pips * 0.1) / 2).toFixed(2)), l: Number((b.o - (pips * 0.1) / 2).toFixed(2)) }));
const DOWN_EU = { EURUSD: { bars: { dir: "down" } } };

test("pairs.js: XAUUSD だけが live:false（ここ1か所が設定）。ほかの銘柄は live の扱い（既定）。isLive は live が false のものだけを対象外にする", () => {
  assert.equal(PAIRS.length, 10);
  assert.deepEqual(PAIRS.filter((p) => !isLive(p)).map((p) => p.code), ["XAUUSD"]);
  assert.equal(pairOf("XAUUSD").live, false);
  assert.ok(PAIRS.filter((p) => p.code !== "XAUUSD").every((p) => !("live" in p) && isLive(p)));
  assert.equal(isLive(null), false);
  assert.equal(isLive({ code: "X" }), true);
  assert.equal(isLive({ code: "X", live: true }), true);
  assert.equal(L.PAPER_VARIANT, "xau_paper");
});

test("設計: XAUUSD の案は、候補・log.csv・通知・上限ロットに出ず、plan.json の paper と shadow-log の xau_paper に出る（価格あり・ロットなし）", () => {
  const sc = makeScenario({});
  try {
    const { plan, logAppend, shadowAppend } = design(sc);
    assert.deepEqual(syms(plan.candidates), ["AUDUSDA", "EURUSDA", "GBPUSDA"]);
    assert.deepEqual(plan.candidates.map((c) => c.rank), [1, 2, 3]);
    assert.equal(logAppend.length, 3);
    assert.ok(!logAppend.some((r) => r.symbol === "XAUUSD"));
    // paper: 価格は含むが、ロット・手数料は含まない
    assert.equal(plan.paper.length, 1);
    const p = plan.paper[0];
    assert.deepEqual([p.symbol, p.setup, p.side, p.variant], ["XAUUSD", "A", "buy", "xau_paper"]);
    assert.ok(Number.isFinite(p.band.low) && Number.isFinite(p.schemes.A.sl) && Number.isFinite(p.schemes.A.tp1));
    for (const s of Object.values(p.schemes)) assert.ok(!("lots" in s) && !("commission_jpy" in s));
    assert.deepEqual(plan.paper_status, { variant: "xau_paper", symbols: ["XAUUSD"], recording: "ok", recorded: 1 });
    // 並行記録: xau_paper の行だけ（ロットの列は空）
    const rows = shadowAppend.filter((r) => r.variant === "xau_paper");
    assert.deepEqual(rows.map((r) => [r.run, r.setup, r.symbol, r.side]), [["design", "A", "XAUUSD", "buy"]]);
    assert.deepEqual([rows[0].lot_cap_a_A, rows[0].lot_cap_b_A, rows[0].lot_cap_a_B, rows[0].lot_cap_b_B], ["", "", "", ""]);
    assert.ok(!shadowAppend.some((r) => r.variant === "sl_floor_b" && r.symbol === "XAUUSD"), "(b) だけで通る案は無い場面");
    // 候補数・通った案の数は、ライブの候補だけ
    assert.equal(plan.summary.candidate_rows, 3);
    assert.deepEqual(plan.summary.scheme_pass, { A: 3, B: 3 });
    // txt: 候補の欄に XAUUSD は出ない。候補の後に1行だけ、件数（価格・ロットなし）
    const txt = render(plan, plan.accounts);
    const sec2 = txt.split("== 3.")[0].split("== 2.")[1];
    assert.ok(!/\] (売り|買い) XAUUSD/.test(sec2), "候補の欄に XAUUSD の案はない");
    const lines = sec2.split("\n").filter((l) => /XAUUSD/.test(l));
    assert.deepEqual(lines, ["  参考：XAUUSD は発注の対象外（並行記録のみ。今回 1 件記録）"]);
    assert.ok(sec2.trimEnd().endsWith("参考：XAUUSD は発注の対象外（並行記録のみ。今回 1 件記録）"), "候補の後");
    assert.ok(!/(1995|1996|1994)\.\d/.test(lines[0]), "価格を書かない");
    assert.ok(!/ロット/.test(lines[0]));
    // 価格根拠（4項目目）にも XAUUSD の案は出ない
    assert.ok(!/XAUUSD 買い 型A/.test(txt.split("== 4.")[1].split("== 5.")[0]));
    // 通知: Issue の本文・新しい案・到達／接近の対象に XAUUSD は入らない
    const body = F.issueBody({ planDate: plan.plan_date, plan }).body;
    assert.ok(!/XAUUSD/.test(body));
    const ev = D.candidateEvents({ nowMs: sc.nowMs, plan, intraday: { as_of: J.jstIso(sc.nowMs - 60000), pairs: { XAUUSD: { price: 1996.0 }, EURUSD: { price: 1.1 } } }, markers: [] });
    assert.ok(ev.newCands.every((c) => c.symbol !== "XAUUSD") && ev.near.every((n) => n.c.symbol !== "XAUUSD"));
    assert.ok(!/XAUUSD/.test(F.newCandidatesComment({ cands: ev.newCands, plan }).body));
    // 資金（試験用の架空の額）は、plan.json・txt・両ログの行のどこにも出ない
    const all = JSON.stringify(plan) + txt + JSON.stringify(shadowAppend) + JSON.stringify(logAppend);
    for (const e of Object.values(sc.env)) assert.ok(!all.includes(e), "資金が出ていない");
  } finally { cleanup(sc); }
});

test("評価は今までどおり: XAUUSD の paper の案は、live:true のときのライブの候補と同じ中身（ロット・同方向の印・順位だけが違う）。ほかの銘柄の案も同じ", () => {
  const sc = makeScenario({});
  try {
    const paper = design(sc).plan;
    const old = live(() => design(sc).plan);
    const strip = (c) => ({
      id: c.id, setup: c.setup, side: c.side, strength: c.strength, alignment: c.alignment, dirs: c.dirs, ref: c.ref, band: c.band, worst_entry: c.worst_entry, price: c.price,
      distance_pips: c.distance_pips, atr_pips: c.atr_pips, adr_used_pct: c.adr_used_pct, adr_remaining_pips: c.adr_remaining_pips, obstacle: c.obstacle, confirm: c.confirm,
      levels: c.levels, generated_at: c.generated_at, expires_at: c.expires_at, entry_state: c.entry_state, state: c.state,
      schemes: Object.fromEntries(Object.entries(c.schemes).map(([n, s]) => [n, pick(s, SCHEME_KEYS)])),
    });
    const oldX = old.candidates.find((c) => c.symbol === "XAUUSD");
    assert.deepEqual(strip(paper.paper[0]), strip(oldX));
    assert.ok(oldX.schemes.A.lots.A > 0, "live:true なら上限ロットを計算している");
    for (const sym of ["AUDUSD", "EURUSD", "GBPUSD"]) {
      assert.deepEqual(strip(paper.candidates.find((c) => c.symbol === sym)), strip(old.candidates.find((c) => c.symbol === sym)), sym);
      assert.deepEqual(paper.candidates.find((c) => c.symbol === sym).schemes.A.lots, old.candidates.find((c) => c.symbol === sym).schemes.A.lots, `${sym} のロットは変わらない`);
    }
    // 不採用の理由・6分類・不採用の一覧は変わらない（XAUUSD の評価結果も今までどおり残る）
    assert.deepEqual(paper.summary.rejections, old.summary.rejections);
    assert.deepEqual(paper.summary.rejected_cases, old.summary.rejected_cases);
  } finally { cleanup(sc); }
});

test("live:true に戻すと今までと同じ出力: XAUUSD はライブの候補（ロットあり）・log.csv に出て、paper・並行記録の xau_paper・txt の参考の行は無い", () => {
  const sc = makeScenario({});
  try {
    const r = live(() => design(sc));
    assert.deepEqual(syms(r.plan.candidates).sort(), ["AUDUSDA", "EURUSDA", "GBPUSDA", "XAUUSDA"]);
    assert.ok(r.logAppend.some((x) => x.symbol === "XAUUSD" && x.lot_cap_a_A !== ""));
    assert.deepEqual(r.plan.paper, []);
    assert.deepEqual(r.plan.paper_status.symbols, []);
    assert.equal(r.shadowAppend.filter((x) => x.variant === "xau_paper").length, 0);
    assert.ok(!/参考：XAUUSD/.test(render(r.plan, r.plan.accounts)));
    assert.equal(r.plan.summary.candidate_rows, 4);
    // 型Bの追加も今までどおり
    const s17 = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: DOWN_EU });
    try {
      const st = live(() => status(s17, { prevPlan: r.plan, logRows: r.logAppend }));
      assert.deepEqual(st.logAppend.map((x) => x.symbol).sort(), ["AUDUSD", "EURUSD", "XAUUSD"]);
      assert.deepEqual(st.plan.paper, []);
    } finally { cleanup(s17); }
  } finally { cleanup(sc); }
});

test("ほかの銘柄に影響させない: 同方向の印（XAUUSD は USD 脚）は、ライブでは XAUUSD を数えない。並行記録の中では今までと同じ数え方（ライブの案も数える）", () => {
  const sc = makeScenario({});
  try {
    const d = design(sc);
    const g = Object.fromEntries(d.plan.candidates.map((c) => [c.symbol, c.same_direction_group]));
    assert.deepEqual(g, { AUDUSD: "", EURUSD: "USD買い", GBPUSD: "USD買い" }, "AUDUSD は USD売り で XAUUSD と同じだが、ライブでは数えない");
    // 並行記録の XAUUSD は、ライブの AUDUSD（USD売り）と同じ組として数える
    assert.equal(d.plan.paper[0].same_direction_group, "USD売り");
    assert.equal(d.shadowAppend.find((r) => r.variant === "xau_paper").same_direction_group, "USD売り");
    // ライブの案の印は、paper を数えるときに書き換わらない
    assert.equal(d.plan.candidates.find((c) => c.symbol === "AUDUSD").same_direction_group, "");
    // live:true なら AUDUSD にも印が付く（今までの出力）
    const old = live(() => design(sc).plan);
    assert.equal(old.candidates.find((c) => c.symbol === "AUDUSD").same_direction_group, "USD売り");
  } finally { cleanup(sc); }
});

test("型Bの追加: XAUUSD の型Bはライブに追加せず（log.csv にも書かず）xau_paper に記録する。ほかの銘柄の追加は変わらない。同じ日・銘柄・向きは1回（variant ごと）", () => {
  const d = makeScenario({ spec: DOWN_EU });
  const s17 = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: DOWN_EU });
  try {
    const first = design(d);
    const st = status(s17, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: first.shadowAppend });
    assert.deepEqual(st.logAppend.map((r) => r.symbol).sort(), ["AUDUSD", "EURUSD"]);
    assert.deepEqual(st.plan.additions_b.sort(), ["2026-10-08:B:AUDUSD:buy", "2026-10-08:B:EURUSD:sell"]);
    assert.ok(!st.plan.candidates.some((c) => c.symbol === "XAUUSD"));
    // ほかの銘柄の追加は、live:true のときと同じ（XAUUSD の分だけ少ない）
    const old = live(() => status(s17, { prevPlan: first.plan, logRows: first.logAppend }));
    assert.deepEqual(old.logAppend.map((r) => r.symbol).sort(), ["AUDUSD", "EURUSD", "XAUUSD"]);
    for (const sym of ["AUDUSD", "EURUSD"]) assert.deepEqual(old.logAppend.find((r) => r.symbol === sym), st.logAppend.find((r) => r.symbol === sym));
    // paper: 型Bの追加が1件（xau_paper の design-b の行）。paper の一覧にも載る（ロットなし）
    const prow = st.shadowAppend.filter((r) => r.variant === "xau_paper");
    assert.deepEqual(prow.map((r) => [r.run, r.setup, r.symbol, r.side]), [["design-b", "B", "XAUUSD", "buy"]]);
    assert.deepEqual(st.plan.paper.map((c) => [c.symbol, c.setup, c.run, c.variant]), [["XAUUSD", "A", "design", "xau_paper"], ["XAUUSD", "B", "design-b", "xau_paper"]], "設計の paper を引き継ぎ、型Bを足す");
    assert.ok(st.plan.paper.every((c) => !("lots" in c.schemes.A)));
    // 同じ日・銘柄・向きの型Bが（xau_paper に）既にあれば追加しない。計画だけにあっても、並行記録の行だけにあっても
    const again = status(s17, { prevPlan: st.plan, logRows: [...first.logAppend, ...st.logAppend], shadowLogRows: [...first.shadowAppend, ...st.shadowAppend] });
    assert.deepEqual(again.shadowAppend, []);
    assert.equal(again.plan.paper.filter((c) => c.setup === "B").length, 1, "型Bの paper は重ねて足さない");
    const onlyRows = status(s17, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: [...first.shadowAppend, ...st.shadowAppend] });
    assert.ok(!onlyRows.shadowAppend.some((r) => r.variant === "xau_paper"));
    // log.csv に切替前の XAUUSD の型B（design-b の行）が有効なまま残っていても、xau_paper の型Bの追加は止まらない（paper の重複判定は自分の variant の行だけ）。
    // その切替前の版は、plan.json から外れるこの実行で通常の取消の行になる（Q86）。ライブの型Bの追加（AUDUSD・EURUSD）は変わらない
    const oldB = live(() => status(s17, { prevPlan: null, logRows: [] })).logAppend.find((r) => r.symbol === "XAUUSD");
    assert.equal(oldB.run, "design-b");
    const withOldB = status(s17, { prevPlan: first.plan, logRows: [...first.logAppend, oldB], shadowLogRows: first.shadowAppend });
    assert.deepEqual(withOldB.logAppend.filter((r) => r.run === "design-b").map((r) => r.symbol).sort(), ["AUDUSD", "EURUSD"]);
    assert.deepEqual(withOldB.logAppend.filter((r) => r.symbol === "XAUUSD").map((r) => r.run), ["status"]);
    assert.deepEqual(withOldB.shadowAppend.filter((r) => r.variant === "xau_paper").map((r) => [r.run, r.setup]), [["design-b", "B"]], "log.csv の切替前の型Bは paper の重複判定に使わない");
  } finally { cleanup(d, s17); }
});

// ---- 取消・採点が log.csv と同じ規則 ----
const NORM = ["run", "setup", "symbol", "side", "entry_low", "entry_high", "sl_a", "tp_a", "sl_b", "tp_b", "rr_a", "rr_b", "cost_cap_a", "expires_at", "reached", "reached_at", "first_hit_a", "first_hit_b", "exit_a", "exit_b", "pips_a", "pips_b", "r_a", "r_b"];
const norm = (r) => Object.fromEntries(NORM.map((k) => [k, r[k] ?? ""]));
const touchBar = (code, band, at = "17:00") => (bars) => bars.map((b) => (b.t === J.parseIso(`2026-10-08T${at}:00+09:00`) ? { ...b, h: band.high + 0.5, l: band.low - 0.5 } : b));
const gone = { XAUUSD: { score: "0/3", dirs: ["→", "→", "→"] } }; // 方向なし → XAUUSD の案が消える

test("取消: XAUUSD の版が次の設計で消えると、xau_paper に 取消(再設計)／取消(到達後)（H1 で到達していれば）を追記する。log.csv に live:true で書いた行と同じ規則・同じ値", () => {
  const sc = makeScenario({});
  try {
    const band = design(sc).plan.paper[0].band;
    for (const reached of [false, true]) {
      const at21 = (o = {}) => makeScenario({ nowIso: "2026-10-08T21:05:00+09:00", spec: gone, ...o, ...(reached ? { barsEdit: { XAUUSD: touchBar("XAUUSD", band) } } : {}) });
      const d3 = at21();
      try {
        const first = design(sc);
        const next = design(d3, { slot: 3, prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: first.shadowAppend });
        const cancel = next.shadowAppend.filter((r) => r.variant === "xau_paper" && r.run === "status");
        assert.equal(cancel.length, 1);
        assert.equal(cancel[0].reached, reached ? "取消(到達後)" : "取消(再設計)");
        assert.equal(cancel[0].reached_at, reached ? "2026-10-08T17:00:00+09:00" : "");
        assert.ok(!next.logAppend.some((r) => r.symbol === "XAUUSD"), "log.csv には書かない");
        // live:true で同じことをしたときの log.csv の XAUUSD の行（design と取消）と、値が同じ
        const old = live(() => { const f = design(sc); return { f, n: design(d3, { slot: 3, prevPlan: f.plan, logRows: f.logAppend }) }; });
        assert.deepEqual(xau(first.shadowAppend).map(norm).map((r) => ({ ...r })), xau(old.f.logAppend).map(norm).map((r) => ({ ...r, ...pickLot(r) })));
        assert.deepEqual(xau(next.shadowAppend.filter((r) => r.variant === "xau_paper")).map(norm), xau(old.n.logAppend).map(norm));
      } finally { cleanup(d3); }
    }
  } finally { cleanup(sc); }
});
const pickLot = () => ({});

function extendBars(sc, rows) {
  // 有効期限（翌03:00）まで H1 足を足す。rows: { XAUUSD: [[時刻, o, h, l, c], ...] }
  const h1 = JSON.parse(fs.readFileSync(path.join(sc.dataDir, "h1-bars.json"), "utf8"));
  const mk = ([t, o, h, l, c]) => ({ time_jst: t, o, h, l, c });
  for (const [code, list] of Object.entries(rows)) h1.pairs[code].push(...list.map(mk));
  for (const code of Object.keys(h1.pairs)) if (!rows[code]) h1.pairs[code].push(mk(["2026-10-09 02:00", 1, 1, 1, 1]));
  fs.writeFileSync(path.join(sc.dataDir, "h1-bars.json"), JSON.stringify(h1));
}
const quiet = () => { const out = []; return { out, io: { log: (m) => out.push(String(m)) } }; };
const run = (sc, extra, env = {}) => { const q = quiet(); return main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", `--now=${sc.nowIso}`, ...extra], { ...sc.env, ...env }, q.io).then((r) => ({ r, out: q.out })); };
const read = (sc, rel) => fs.readFileSync(path.join(sc.dataDir, rel), "utf8");
const readShadow = (sc) => L.parseLog(read(sc, "daytrade/shadow-log.csv"), L.SHADOW_COLUMNS);

test("採点: xau_paper の版は、log.csv に live:true で書いた版と同じ規則・同じ値で採点される（到達・SL/TP1 の先着・損益の列）。log.csv には XAUUSD の行が出ない", async () => {
  const mk = () => makeScenario({ nowIso: "2026-10-08T15:30:00+09:00" });
  const paperSc = mk(), liveSc = mk();
  try {
    const restore = setXauLive(true);
    try { await run(liveSc, ["--run=design", "--slot=2"]); } finally { restore(); }
    await run(paperSc, ["--run=design", "--slot=2"]);
    assert.ok(!L.parseLog(read(paperSc, "daytrade/log.csv")).some((r) => r.symbol === "XAUUSD"));
    const p = readShadow(paperSc).find((r) => r.symbol === "XAUUSD");
    assert.equal(p.variant, "xau_paper");
    // 帯に触れて TP1 に届く足と、有効期限まで届く足
    const bl = Number(p.entry_low), bh = Number(p.entry_high), tp = Number(p.tp_a);
    const bars = { XAUUSD: [["2026-10-08 16:00", bh + 1, bh + 1.5, bl - 0.1, bh], ["2026-10-08 17:00", bh, tp + 1, bh - 0.2, tp], ["2026-10-09 02:00", tp, tp + 1, tp - 1, tp]] };
    extendBars(paperSc, bars); extendBars(liveSc, bars);
    const next = "2026-10-09T06:30:00+09:00";
    const q = quiet(); const r = scoreMain([`--data-dir=${paperSc.dataDir}`, `--now=${next}`], q.io);
    scoreMain([`--data-dir=${liveSc.dataDir}`, `--now=${next}`], quiet().io);
    const paperScored = readShadow(paperSc).filter((x) => x.symbol === "XAUUSD" && x.run === "status");
    const liveScored = L.parseLog(read(liveSc, "daytrade/log.csv")).filter((x) => x.symbol === "XAUUSD" && x.run === "status");
    assert.equal(paperScored.length, 1);
    assert.equal(paperScored[0].variant, "xau_paper");
    assert.deepEqual([paperScored[0].reached, paperScored[0].first_hit_a], ["到達", "TP1"]);
    assert.deepEqual(paperScored.map(norm), liveScored.map(norm));
    assert.ok(paperScored[0].pips_a !== "" && paperScored[0].r_a !== "", "損益の列も入る");
    assert.ok(!L.parseLog(read(paperSc, "daytrade/log.csv")).some((x) => x.symbol === "XAUUSD"), "log.csv に XAUUSD の行は足されない");
    assert.match(q.out.join("\n"), /\[並行記録\] 採点: 2026-10-08 型A XAUUSD 買い .*［xau_paper］/);
    assert.equal(r.shadow.newRows.length, 1);
  } finally { cleanup(paperSc, liveSc); }
});

// ---- variant ごとの独立 ----
// 同じ版（鍵が同じ）が sl_floor_b と xau_paper の両方に入っている場面を作る。XAUUSD の H1 の幅 12pips: sl_floor_b は A案（SL 10pips に広げる）、xau_paper は B案だけの版
const same = (row, variant, o = {}) => ({ ...row, variant, ...o });
function bothVariants() {
  const sc = makeScenario({ barsEdit: { XAUUSD: narrowXau(12) } });
  const d = design(sc);
  const s = d.shadowAppend.find((r) => r.variant === "sl_floor_b" && r.symbol === "XAUUSD");
  const p = d.shadowAppend.find((r) => r.variant === "xau_paper" && r.symbol === "XAUUSD");
  assert.ok(s && p && L.keyOf(s) !== L.keyOf(p), "場面: 2つの variant の版は鍵が違う（sl_floor_b は A案あり、xau_paper は B案だけ）");
  return { sc, d, s, p };
}

test("variant の独立（設計）: 同じ版が両方の variant にあるとき、片方の版が消えても、もう片方の行には取消を足さない", () => {
  const { sc, d, s } = bothVariants();
  try {
    // s（sl_floor_b の版 K）を xau_paper にも同じ鍵で入れる。今回の設計: sl_floor_b は K が続く（追記も取消もしない）、xau_paper は K が無い（新しい版 P が出る）→ xau_paper の K だけ取消
    const k = same(s, "xau_paper");
    const next = design(sc, { prevPlan: d.plan, logRows: d.logAppend, shadowLogRows: [s, k] });
    const byV = (v) => next.shadowAppend.filter((r) => r.variant === v);
    assert.deepEqual(byV("sl_floor_b"), [], "sl_floor_b の K は続く。取消されない");
    assert.deepEqual(byV("xau_paper").map((r) => [r.run, r.setup, L.keyOf(r) === L.keyOf(s) ? "K" : "P"]), [["design", "A", "P"], ["status", "A", "K"]]);
    const cancel = byV("xau_paper").find((r) => r.run === "status");
    assert.ok(cancel.reached === "取消(再設計)" || cancel.reached === "取消(到達後)");
    // 逆: sl_floor_b だけが K を持ち、xau_paper が持たない → xau_paper の K は取消の対象に出てこない（自分の行だけを見る）
    const only = design(sc, { prevPlan: d.plan, logRows: d.logAppend, shadowLogRows: [s] });
    assert.ok(!only.shadowAppend.some((r) => r.variant === "xau_paper" && r.run === "status"));
    // 取消した後の次の設計: xau_paper は K が取消済み（最後の行が status）、sl_floor_b の K は続いたまま
    const rows2 = [s, k, ...next.shadowAppend];
    const next2 = design(sc, { prevPlan: next.plan, logRows: [...d.logAppend, ...next.logAppend], shadowLogRows: rows2 });
    assert.deepEqual(next2.shadowAppend, [], "二度目は何も追記しない（どちらの variant も）");
  } finally { cleanup(sc); }
});

test("variant の独立（採点）: 同じ版が両方の variant にあり、片方が取消済みでも、もう片方は自分の行だけで採点される（daytrade-score.js も variant ごと）", () => {
  const { sc, s } = bothVariants();
  try {
    const dsg = (v) => same(s, v);
    // xau_paper の K は 15:45 に取消（取消(再設計)）。sl_floor_b の K は有効期限まで続く
    const cancel = { ...dsg("xau_paper"), run: "status", generated_at: "2026-10-08T15:45:00+09:00", reached: "取消(再設計)" };
    const rows = [dsg("sl_floor_b"), dsg("xau_paper"), cancel];
    // 取消のあと（16:00）に帯へ触れ、有効期限まで続く
    const bl = Number(s.entry_low), bh = Number(s.entry_high);
    extendBars(sc, { XAUUSD: [["2026-10-08 16:00", bh + 1, bh + 1.5, bl - 0.1, bh], ["2026-10-09 02:00", bh, bh + 1, bh - 5, bh]] });
    const bars = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(sc.dataDir, "h1-bars.json"), "utf8")).pairs).map(([c, list]) => [c, list.map((b) => ({ t: J.parseIso(b.time_jst.replace(" ", "T") + ":00+09:00"), o: b.o, h: b.h, l: b.l, c: b.c }))]));
    const now = J.parseIso("2026-10-09T06:30:00+09:00");
    const sf = scoreRows({ rows, barsByCode: bars, nowMs: now, variant: "sl_floor_b" });
    const xp = scoreRows({ rows, barsByCode: bars, nowMs: now, variant: "xau_paper" });
    assert.equal(sf.newRows.length, 1);
    assert.deepEqual([sf.newRows[0].variant, sf.newRows[0].run, sf.newRows[0].reached], ["sl_floor_b", "status", "到達"], "sl_floor_b の版は、xau_paper の取消の影響を受けずに採点される");
    assert.deepEqual(xp.newRows, [], "xau_paper の版は取消(再設計)のまま（取消の時刻までに到達していない）。sl_floor_b の行では採点されない");
    // variant を指定しない（log.csv の行＝variant なし）と、どちらの行も見ない
    assert.deepEqual(scoreRows({ rows, barsByCode: bars, nowMs: now }).newRows, []);
    // CLI: shadow-log.csv を variant ごとに採点して追記する（variant の列は行ごとに残る）
    fs.mkdirSync(path.join(sc.dataDir, "daytrade"), { recursive: true });
    fs.writeFileSync(path.join(sc.dataDir, "daytrade", "shadow-log.csv"), L.appendedText("", rows, L.SHADOW_COLUMNS));
    const q = quiet();
    scoreMain([`--data-dir=${sc.dataDir}`, "--now=2026-10-09T06:30:00+09:00"], q.io);
    const after = readShadow(sc);
    assert.deepEqual(after.slice(3).map((r) => [r.variant, r.run, r.reached]), [["sl_floor_b", "status", "到達"]]);
    assert.match(q.out.join("\n"), /\[並行記録\] 採点: .*［sl_floor_b］/);
  } finally { cleanup(sc); }
});

test("variant の独立（同じ水準は到達済み）: xau_paper の到達済みの版は、sl_floor_b の同じ水準の案を抑えない（逆も同じ）。ライブ（log.csv）にも影響しない", () => {
  const sc1 = makeScenario({ nowIso: "2026-10-08T06:30:00+09:00", barsEdit: { XAUUSD: narrowXau(12) } });
  const sc2 = makeScenario({ nowIso: "2026-10-08T15:30:00+09:00", barsEdit: { XAUUSD: narrowXau(13) } });
  try {
    // 06:30 の設計①で作った版 S（sl_floor_b）・P（xau_paper）。08:00 の足が帯に触れて到達済みにする
    const first = design(sc1, { slot: 1 });
    const s = first.shadowAppend.find((r) => r.variant === "sl_floor_b" && r.symbol === "XAUUSD");
    const p = first.shadowAppend.find((r) => r.variant === "xau_paper" && r.symbol === "XAUUSD");
    // 模擬の H1 足（階段状に上がる）は、07:00〜08:00 の足が帯（1995.88〜1996.00）に触れている ＝ 06:30 の版は H1 で到達済み
    const sc3 = makeScenario({ nowIso: "2026-10-08T15:30:00+09:00", barsEdit: { XAUUSD: narrowXau(13) } });
    try {
      const idea = (rows, variant) => V.reachedIdeas({ rows, planDate: "2026-10-08", barsByCode: { XAUUSD: sc3.barsByCode.XAUUSD }, nowMs: sc3.nowMs, variant }).ideas.size;
      assert.equal(idea([p], "xau_paper"), 1);
      assert.equal(idea([p], "sl_floor_b"), 0);
      assert.equal(idea([p], null), 0);
      assert.equal(idea([s], "sl_floor_b"), 1);
      assert.equal(idea([s], "xau_paper"), 0);
      // 設計②（ATR 13pips＝SL が違う新しい版）: 両方の履歴があれば、どちらの variant も抑える
      const both = design(sc3, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: [s, p] });
      assert.ok(!both.shadowAppend.some((r) => r.run === "design" && r.symbol === "XAUUSD"), "両方到達済み: どちらも出し直さない");
      assert.equal(both.plan.summary.extra["同じ水準は到達済み"], 1, "paper の案（B案だけ通っていた）を数える");
      // xau_paper の履歴だけ: xau_paper は抑え、sl_floor_b は出す
      const onlyP = design(sc3, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: [p] });
      assert.deepEqual(onlyP.shadowAppend.filter((r) => r.run === "design").map((r) => r.variant), ["sl_floor_b"]);
      // sl_floor_b の履歴だけ: sl_floor_b は抑え、xau_paper は出す
      const onlyS = design(sc3, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: [s] });
      assert.deepEqual(onlyS.shadowAppend.filter((r) => r.run === "design").map((r) => r.variant), ["xau_paper"]);
      // ライブ（log.csv）の履歴は並行記録に影響しない: log.csv に同じ水準の XAUUSD（切替前）の到達済みの行があっても、paper は抑えられない
      const liveRow = { ...candRow(oldLiveCandidate(), "design", "2026-10-08T06:30:00+09:00") };
      const withLive = design(sc3, { prevPlan: null, logRows: [liveRow], shadowLogRows: [] });
      assert.ok(withLive.shadowAppend.some((r) => r.variant === "xau_paper" && r.run === "design"));
    } finally { cleanup(sc3); }
  } finally { cleanup(sc1, sc2); }
});
function oldLiveCandidate() {
  const sc = makeScenario({ nowIso: "2026-10-08T06:30:00+09:00", barsEdit: { XAUUSD: narrowXau(12) } });
  try { return live(() => design(sc, { slot: 1 })).plan.candidates.find((c) => c.symbol === "XAUUSD"); } finally { cleanup(sc); }
}

// ---- 切替 ----
test("切替: 切替前から有効だった log.csv の XAUUSD の版は、plan.json から外れる最初の実行（状態更新でも設計でも）で通常の取消の行を追記する。到達済みなら 取消(到達後)＋通知に『到達済み…』。旧い行は書き換えない", () => {
  const sc = makeScenario({});
  const band = design(sc).plan.paper[0].band;
  const reachedAt17 = (extra = {}) => makeScenario({ nowIso: "2026-10-08T17:05:00+09:00", barsEdit: { XAUUSD: touchBar("XAUUSD", band, "16:00") }, ...extra });
  const s17 = reachedAt17();
  const s17n = makeScenario({ nowIso: "2026-10-08T17:05:00+09:00" });
  const d3 = makeScenario({ nowIso: "2026-10-08T21:05:00+09:00" });
  try {
    // 切替前の状態: ライブの設計②（XAUUSD もライブの候補。log.csv に XAUUSD の design の行）
    const before = live(() => design(sc));
    const xv = before.plan.candidates.find((c) => c.symbol === "XAUUSD");
    const oldRows = L.appendedText("", before.logAppend);
    const newMarker = D.markerOf(D.K.new(D.versionKey(xv))).match(/key=(.*?) -->/)[1];

    // (1) 切替後の最初の実行が状態更新: plan.json からも、log.csv からも、同じ実行で外れる（H1 で到達していれば 取消(到達後)）
    const st = status(s17, { prevPlan: before.plan, logRows: before.logAppend });
    assert.ok(!st.plan.candidates.some((c) => c.symbol === "XAUUSD"));
    const cx = st.logAppend.filter((r) => r.symbol === "XAUUSD");
    assert.deepEqual(cx.map((r) => [r.run, r.setup, r.reached]), [["status", "A", "取消(到達後)"]]);
    assert.equal(L.keyOf(cx[0]), L.keyOf(before.logAppend.find((r) => r.symbol === "XAUUSD")));
    assert.ok(!st.plan.paper.some((c) => c.setup === "A"), "切替前の plan.json に paper は無い。型Aの paper は次の設計から（型Bは状態更新で追加される）");
    // Issue: 通知済みの版は『案を取消しました』。到達済みなので『到達済み。保有中なら元の SL・TP1 のまま』が付く
    const ev = D.candidateEvents({ nowMs: s17.nowMs, plan: st.plan, intraday: null, markers: [newMarker] });
    assert.deepEqual(ev.cancelled.map((c) => c.info.symbol), ["XAUUSD"]);
    const reachedKeys = new Set([...L.latestByKey([...before.logAppend, ...st.logAppend]).entries()].filter(([, r]) => r.run === "status" && r.reached === D.CANCELLED_REACHED).map(([k]) => k));
    assert.match(F.cancelComment({ cancelled: ev.cancelled, newCands: [], nowMs: s17.nowMs, reachedKeys }).body, /XAUUSD 買い 型A.*到達済み。保有中なら元の SL・TP1 のまま/);
    // 取消した後は、もう何も足さない（同じ実行をもう一度しても、次の設計でも）
    const again = status(s17, { prevPlan: st.plan, logRows: [...before.logAppend, ...st.logAppend] });
    assert.deepEqual(again.logAppend.filter((r) => r.symbol === "XAUUSD"), []);
    const afterDesign = design(d3, { slot: 3, prevPlan: st.plan, logRows: [...before.logAppend, ...st.logAppend], shadowLogRows: st.shadowAppend });
    assert.deepEqual(afterDesign.logAppend.filter((r) => r.symbol === "XAUUSD"), []);
    assert.ok(afterDesign.shadowAppend.some((r) => r.variant === "xau_paper" && r.run === "design" && r.symbol === "XAUUSD"), "paper の記録は設計から");

    // (2) 切替後の最初の実行が設計: 古い plan.json の候補（XAUUSD を含む）と log.csv の両方から来ても、取消は1回だけ。未到達なら 取消(再設計)
    const direct = design(d3, { slot: 3, prevPlan: before.plan, logRows: before.logAppend });
    const dx = direct.logAppend.filter((r) => r.symbol === "XAUUSD");
    assert.deepEqual(dx.map((r) => [r.run, r.setup, r.reached]), [["status", "A", "取消(再設計)"]].map(([a1, b1]) => [a1, b1, dx[0].reached]));
    assert.equal(dx.length, 1);
    assert.ok(/^取消\(/.test(dx[0].reached));

    // 旧い行は一字も変わらない（追記は末尾に足すだけ）
    assert.ok(L.appendedText(oldRows, st.logAppend).startsWith(oldRows));
    // 取消の対象は、発注の対象外の銘柄の、その計画日の版だけ: ライブの銘柄の版（plan.json に無くても）・前の計画日の採点待ちの行には触らない
    const eu = { ...before.logAppend.find((r) => r.symbol === "EURUSD") };
    const oldDay = { ...before.logAppend.find((r) => r.symbol === "XAUUSD"), plan_date: "2026-10-07", generated_at: "2026-10-07T15:30:00+09:00", expires_at: "2026-10-08T03:00:00+09:00" };
    for (const r of [status(s17n, { prevPlan: null, logRows: [eu, oldDay] }), design(d3, { slot: 3, prevPlan: null, logRows: [eu, oldDay] })]) {
      assert.ok(!r.logAppend.some((x) => x.run === "status"), "ライブの銘柄の版・前の計画日の版は取消さない");
    }
  } finally { cleanup(sc, s17, s17n, d3); }
});

test("設計①②で、状態更新で追加した型B（xau_paper）は取消さずに引き継ぐ。型Bを再設計するのは設計③", () => {
  const d = makeScenario({ spec: DOWN_EU });
  const s17 = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: DOWN_EU });
  const d1 = makeScenario({ nowIso: "2026-10-08T21:05:00+09:00", spec: DOWN_EU });
  try {
    const first = design(d);
    const st = status(s17, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: first.shadowAppend });
    const rows = [...first.shadowAppend, ...st.shadowAppend];
    const again = design(d1, { slot: 2, prevPlan: st.plan, logRows: [...first.logAppend, ...st.logAppend], shadowLogRows: rows });
    assert.ok(!again.shadowAppend.some((r) => r.variant === "xau_paper" && r.setup === "B"), "設計②では型Bの paper を取消さない");
    assert.ok(again.plan.paper.some((c) => c.setup === "B" && c.symbol === "XAUUSD"), "paper の一覧にも引き継ぐ");
    assert.ok(!again.plan.candidates.some((c) => c.symbol === "XAUUSD"));
  } finally { cleanup(d, s17, d1); }
});

// ---- CLI ----
test("daytrade-plan.js: shadow-log.csv に xau_paper の行を書く。同じ実行を繰り返しても二重に追記しない。log.csv は今までどおり（XAUUSD なし）。資金は出ない", async () => {
  const sc = makeScenario({});
  try {
    const { r } = await run(sc, ["--run=design", "--slot=2"]);
    assert.equal(r.plan.paper.length, 1);
    const rows = readShadow(sc);
    assert.deepEqual(rows.map((x) => [x.variant, x.symbol, x.run]), [["xau_paper", "XAUUSD", "design"]]);
    assert.equal(L.parseLog(read(sc, "daytrade/log.csv")).length, 3);
    assert.match(read(sc, "daytrade-plan.txt"), /参考：XAUUSD は発注の対象外（並行記録のみ。今回 1 件記録）/);
    const planJson = JSON.parse(read(sc, "daytrade-plan.json"));
    assert.equal(planJson.paper.length, 1);
    assert.ok(!planJson.candidates.some((c) => c.symbol === "XAUUSD"));
    const text = read(sc, "daytrade/shadow-log.csv");
    const again = await run(sc, ["--run=design", "--slot=2", "--force"]);
    assert.deepEqual(again.r.shadowAppend, []);
    assert.equal(read(sc, "daytrade/shadow-log.csv"), text);
    // 状態更新（同じ時間帯）も paper を引き継ぐ
    const st = await run(sc, ["--run=status", "--force"]);
    assert.equal(st.r.plan.paper.length, 1);
    assert.match(read(sc, "daytrade-plan.txt"), /今回 1 件記録/);
    for (const f of ["daytrade/shadow-log.csv", "daytrade/log.csv", "daytrade-plan.txt", "daytrade-plan.json"]) for (const e of Object.values(sc.env)) assert.ok(!read(sc, f).includes(e), `${f} に資金が出ていない`);
  } finally { cleanup(sc); }
});

test("shadow-log.csv を読めないとき: paper は一覧に出すが、記録できないと txt に書く。状態更新では型Bの paper を追加しない（件数を積み上げない）。ファイルは触らない", async () => {
  const sc = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: DOWN_EU });
  try {
    await run(sc, ["--run=design", "--slot=2"]);
    fs.mkdirSync(path.join(sc.dataDir, "daytrade"), { recursive: true });
    fs.writeFileSync(path.join(sc.dataDir, "daytrade", "shadow-log.csv"), "broken,header\n1,2\n");
    const d = await run(sc, ["--run=design", "--slot=2", "--force"]);
    assert.equal(d.r.plan.paper_status.recording, "unreadable");
    assert.match(read(sc, "daytrade-plan.txt"), /参考：XAUUSD は発注の対象外（並行記録のみ。並行記録を読めないため、今回は記録なし）/);
    const st = await run(sc, ["--run=status", "--force"]);
    assert.equal(st.r.plan.paper_status.recording, "unreadable");
    assert.ok(!st.r.plan.paper.some((c) => c.setup === "B"), "読めないときは型Bの paper を追加しない");
    assert.equal(read(sc, "daytrade/shadow-log.csv"), "broken,header\n1,2\n");
    assert.ok(st.r.plan.candidates.some((c) => c.symbol === "AUDUSD"), "ライブの計画は今までどおり");
  } finally { cleanup(sc); }
});

// ---- レビューで見つかった試験の隙間（変異を入れて落ちることを確認したもの）----
const { buildCtx } = require("../plan");
const { evaluate } = require("../evaluate");
const { globalMtfStatus } = require("../direction");
const baseRow = (r, o) => ({ ...r, ...o });

test("型Bの追加（状態更新）: 重複の判定は variant ごと。片方の行がもう片方の追加を止めない。log.csv・ライブの行も paper／sl_floor_b を止めない。sl_floor_b の XAUUSD の型Bは今までどおり続く", () => {
  // H1 の幅 12pips: XAUUSD の型Bは、ライブ(a)では B案だけ通る（xau_paper）、(b) では A案も通る（sl_floor_b）ので、両方の variant に追加される
  const s18 = makeScenario({ nowIso: "2026-10-08T18:00:00+09:00", spec: DOWN_EU, barsEdit: { XAUUSD: narrowXau(12) } });
  try {
    const base = status(s18);
    const sf = base.shadowAppend.find((r) => r.variant === "sl_floor_b" && r.symbol === "XAUUSD");
    const xp = base.shadowAppend.find((r) => r.variant === "xau_paper" && r.symbol === "XAUUSD");
    assert.deepEqual([sf?.run, sf?.setup, xp?.run, xp?.setup], ["design-b", "B", "design-b", "B"], "既定の場面で、sl_floor_b の XAUUSD の型Bも追加される");
    const variantsOf = (r) => r.shadowAppend.filter((x) => x.symbol === "XAUUSD").map((x) => x.variant).sort();
    assert.deepEqual(variantsOf(base), ["sl_floor_b", "xau_paper"]);
    // 片方の variant の行だけがあるとき、もう片方は追加される（逆も）
    assert.deepEqual(variantsOf(status(s18, { shadowLogRows: [xp] })), ["sl_floor_b"]);
    assert.deepEqual(variantsOf(status(s18, { shadowLogRows: [sf] })), ["xau_paper"]);
    assert.deepEqual(variantsOf(status(s18, { shadowLogRows: [sf, xp] })), []);
    // 同じ鍵の行を、もう片方の variant の行として持っていても、自分の variant の追加は止まらない（鍵に variant が入っていない）
    assert.deepEqual(variantsOf(status(s18, { shadowLogRows: [baseRow(xp, { variant: "sl_floor_b" })] })), ["xau_paper"], "sl_floor_b の同じ鍵の行は xau_paper を止めない");
    // log.csv の XAUUSD の型B（切替前の行）は paper・sl_floor_b の重複判定に使わない（ライブの取消の対象にはなる）
    const oldB = live(() => status(s18)).logAppend.find((r) => r.symbol === "XAUUSD" && r.run === "design-b");
    const withOld = status(s18, { logRows: [oldB] });
    assert.deepEqual(variantsOf(withOld), ["sl_floor_b", "xau_paper"]);
    // 並行記録の型Bの行が、ライブの銘柄（EURUSD）の型Bの追加を止めない
    const euRow = (v) => baseRow(xp, { variant: v, symbol: "EURUSD", side: "sell" });
    const liveAdds = (r) => r.logAppend.filter((x) => x.run === "design-b").map((x) => x.symbol).sort();
    assert.deepEqual(liveAdds(status(s18, { shadowLogRows: [euRow("sl_floor_b"), euRow("xau_paper")] })), liveAdds(base));
    assert.ok(liveAdds(base).includes("EURUSD"));
  } finally { cleanup(s18); }
});

test("上限ロットを計算しない: 発注の対象外の銘柄の評価は口座を渡さない（lots が空）。ライブの銘柄は口座を渡す。評価の中身（通る・通らない）は変わらない", () => {
  const sc = makeScenario({});
  try {
    const inputs = inputsOf(sc);
    const mtf = globalMtfStatus(inputs.raw.mtf, inputs.expectedSession);
    const ctxX = buildCtx(pairOf("XAUUSD"), inputs, "2026-10-08", "A", mtf);
    const ctxE = buildCtx(pairOf("EURUSD"), inputs, "2026-10-08", "A", mtf);
    assert.deepEqual(ctxX.accounts, {});
    assert.deepEqual(Object.keys(ctxE.accounts).sort(), ["A", "B"]);
    const rx = evaluate(ctxX, "A");
    assert.deepEqual(rx.schemes.A.lots, {});
    assert.equal(rx.outcome, "candidate");
    const withAcct = evaluate({ ...ctxX, accounts: inputs.accounts }, "A");
    assert.deepEqual([rx.schemes.A.pass, rx.schemes.B.pass, rx.schemes.A.sl, rx.schemes.A.tp], [withAcct.schemes.A.pass, withAcct.schemes.B.pass, withAcct.schemes.A.sl, withAcct.schemes.A.tp]);
    assert.ok(withAcct.schemes.A.lots.A > 0, "口座を渡すとロットを計算する（これを渡さないことが『計算しない』）");
  } finally { cleanup(sc); }
});

test("引き継ぎ: 切替前の plan.json の型B（XAUUSD）は設計①②でもライブに引き継がない。前の計画日の paper・今はライブの銘柄の paper（live を戻したあと）も引き継がない", () => {
  const s17 = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: DOWN_EU });
  const d2 = makeScenario({ nowIso: "2026-10-08T21:05:00+09:00", spec: DOWN_EU });
  const s18 = makeScenario({ nowIso: "2026-10-08T18:00:00+09:00", spec: DOWN_EU });
  try {
    // 切替前の plan.json: ライブの型B（XAUUSD 含む）を状態更新で追加済み
    const oldPlan = live(() => status(s17, { prevPlan: null, logRows: [] })).plan;
    assert.ok(oldPlan.candidates.some((c) => c.symbol === "XAUUSD" && c.setup === "B"));
    const sameDayOld = { ...oldPlan, designs: [{ slot: 2, generated_at: "2026-10-08T15:30:00+09:00", inputs_ok: true }] };
    const d = design(d2, { slot: 2, prevPlan: sameDayOld, logRows: [] });
    assert.ok(!d.plan.candidates.some((c) => c.symbol === "XAUUSD"), "設計②で、切替前の XAUUSD の型Bはライブに残らない");
    // 前の計画日の paper は、設計①②・状態更新のどちらでも引き継がない
    const first = design(makeScenario({ spec: DOWN_EU }));
    const withB = status(s17, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: first.shadowAppend });
    assert.ok(withB.plan.paper.some((c) => c.setup === "B"));
    const yesterday = { ...withB.plan, plan_date: "2026-10-07" };
    assert.deepEqual(design(d2, { slot: 2, prevPlan: yesterday }).plan.paper.filter((c) => c.setup === "B"), []);
    assert.deepEqual(status(s18, { prevPlan: yesterday }).plan.paper.filter((c) => c.plan_date === "2026-10-07"), []);
    // live を戻したあと（paper が残っている plan.json）は、その銘柄の paper を引き継がない（同じ案がライブの候補と paper の両方に出ない）
    const reverted = live(() => status(s18, { prevPlan: withB.plan, logRows: [...first.logAppend, ...withB.logAppend], shadowLogRows: [...first.shadowAppend, ...withB.shadowAppend] }));
    assert.deepEqual(reverted.plan.paper, []);
    assert.ok(reverted.plan.candidates.some((c) => c.symbol === "XAUUSD"));
    const revertedDesign = live(() => design(d2, { slot: 2, prevPlan: withB.plan }));
    assert.deepEqual(revertedDesign.plan.paper, []);
  } finally { cleanup(s17, d2, s18); }
});

test("状態更新の paper: 距離・価格・状態を更新し、同方向の印はライブの案も数える（ライブの案の印は変えない）", () => {
  const d = makeScenario({ spec: DOWN_EU });
  const s17 = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: { ...DOWN_EU, XAUUSD: { price: 1999.0 } } });
  try {
    const first = design(d);
    const st = status(s17, { prevPlan: first.plan, logRows: first.logAppend, shadowLogRows: first.shadowAppend });
    const a = st.plan.paper.find((c) => c.setup === "A");
    const before = first.plan.paper.find((c) => c.setup === "A");
    assert.equal(a.price, 1999.0, "現在値を更新する");
    assert.notEqual(a.distance_pips, before.distance_pips, "距離も更新する");
    assert.ok(a.state && "reached" in a.state && a.entry_state && "ok" in a.entry_state);
    assert.deepEqual(a.band, before.band, "Entry 帯・SL・TP は変えない");
    // 同方向の印: ライブの案だけで付けたときと同じ（paper を数えても変わらない）。paper の XAUUSD は USD売り を AUDUSD（ライブ）と数える
    const liveOnly = st.plan.candidates.map((c) => ({ ...c }));
    require("../plan").markSameDirection(liveOnly, { USDJPY: ["USD", "JPY"], EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], EURJPY: ["EUR", "JPY"], AUDUSD: ["AUD", "USD"], EURGBP: ["EUR", "GBP"], USDCAD: ["USD", "CAD"], USDCHF: ["USD", "CHF"], NZDUSD: ["NZD", "USD"], XAUUSD: ["USD"] });
    assert.deepEqual(st.plan.candidates.map((c) => c.same_direction_group), liveOnly.map((c) => c.same_direction_group));
    assert.ok(st.plan.candidates.filter((c) => c.symbol === "AUDUSD").every((c) => !c.same_direction_group.includes("USD売り") || st.plan.candidates.filter((x) => x.same_direction_group.includes("USD売り")).length >= 2));
    assert.equal(a.same_direction_group, "USD売り");
  } finally { cleanup(d, s17); }
});

test("記録件数: txt の『今回 n 件記録』は、shadow-log.csv に記録済みの paper の数。読めなかった実行の分は、記録されるまで数えない", () => {
  const sc = makeScenario({});
  const s17 = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00" });
  try {
    const unreadable = buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, slot: 2, prevPlan: null, logRows: [], shadowLogRows: [], shadowReadable: false });
    assert.deepEqual([unreadable.plan.paper.length, unreadable.plan.paper_status.recording, unreadable.plan.paper_status.recorded], [1, "unreadable", 0]);
    assert.match(render(unreadable.plan, unreadable.plan.accounts), /並行記録を読めないため、今回は記録なし/);
    // 直し／消したあとの状態更新: paper は引き継ぐが、行はまだ無い → 0 件（txt に『1 件記録』と出さない）
    const st = status(s17, { prevPlan: unreadable.plan, logRows: [], shadowLogRows: [] });
    assert.ok(st.plan.paper.some((c) => c.setup === "A"));
    assert.equal(st.plan.paper_status.recorded, st.shadowAppend.filter((r) => r.variant === "xau_paper").length, "今回追記した行だけ");
    assert.ok(!/今回 [2-9] 件記録/.test(render(st.plan, st.plan.accounts)));
    // 記録済みなら数える
    const ok = design(sc);
    assert.equal(ok.plan.paper_status.recorded, 1);
    const st2 = status(s17, { prevPlan: ok.plan, logRows: ok.logAppend, shadowLogRows: ok.shadowAppend });
    assert.equal(st2.plan.paper_status.recorded, st2.plan.paper.length);
  } finally { cleanup(sc, s17); }
});

test("daytrade-score.js: 同じ shadow-log.csv の variant を全部採点する（先頭の variant だけで止まらない）。それぞれ自分の行だけで", () => {
  const { sc, s, p } = bothVariants();
  try {
    const bl = Number(s.entry_low), bh = Number(s.entry_high);
    extendBars(sc, { XAUUSD: [["2026-10-08 16:00", bh + 1, bh + 1.5, bl - 0.1, bh], ["2026-10-09 02:00", bh, bh + 1, bh - 5, bh]] });
    fs.mkdirSync(path.join(sc.dataDir, "daytrade"), { recursive: true });
    // xau_paper が先頭、sl_floor_b が後（別の版）。両方とも期限後に採点される
    fs.writeFileSync(path.join(sc.dataDir, "daytrade", "shadow-log.csv"), L.appendedText("", [p, s], L.SHADOW_COLUMNS));
    scoreMain([`--data-dir=${sc.dataDir}`, "--now=2026-10-09T06:30:00+09:00"], quiet().io);
    const after = readShadow(sc);
    assert.deepEqual(after.slice(2).map((r) => [r.variant, r.run, r.reached]).sort(), [["sl_floor_b", "status", "到達"], ["xau_paper", "status", "到達"]]);
    // もう一度動かしても、新しい行は出ない
    const text = read(sc, "daytrade/shadow-log.csv");
    scoreMain([`--data-dir=${sc.dataDir}`, "--now=2026-10-09T06:40:00+09:00"], quiet().io);
    assert.equal(read(sc, "daytrade/shadow-log.csv"), text);
  } finally { cleanup(sc); }
});
