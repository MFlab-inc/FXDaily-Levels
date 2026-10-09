"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadInputs } = require("../inputs");
const { buildDesign, buildStatus } = require("../plan");
const { render } = require("../render");
const L = require("../log");
const S = require("../schedule");
const { dayEvents, calendarStatus } = require("../events");
const { main } = require("../../daytrade-plan");
const { makeScenario } = require("./scenario");
const { rm } = require("./helpers");
const J = require("../jst");

/**
 * 独立レビュー（第4回）で見つかった不具合の回帰試験と、変異試験で生き残った箇所の試験。
 */
const noFeed = { status: "未取得", reason: "試験", pairs: {} };
const inputsOf = (sc) => loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs });
const design = (sc, { slot = 2, prevPlan = null, logRows = [] } = {}) => ({ inputs: inputsOf(sc), ...buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, slot, prevPlan, logRows }) });
const status = (sc, { prevPlan = null, logRows = [], nowMs = sc.nowMs } = {}) => buildStatus({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs, prevPlan, logRows });
const cleanup = (...scs) => { for (const sc of scs) rm(path.dirname(sc.dataDir)); };
const down = { EURUSD: { bars: { dir: "down" } } };
const read = (sc, rel) => fs.readFileSync(path.join(sc.dataDir, rel), "utf8");
const writeJson = (sc, rel, obj) => fs.writeFileSync(path.join(sc.dataDir, rel), JSON.stringify(obj));

// ---- 型B追加まわり ----
test("状態更新で型Bを追加すると、候補数・A案／B案を通った案の数も最終の候補から数え直す。追加した型Bの件数を3項目目に出す", () => {
  const d = makeScenario({ spec: down });
  const s17 = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: down });
  try {
    const first = design(d);
    const { plan } = status(s17, { prevPlan: first.plan, logRows: first.logAppend });
    assert.equal(plan.candidates.length, 7);
    assert.equal(plan.summary.candidate_rows, 7);
    assert.deepEqual(plan.summary.scheme_pass, { A: plan.candidates.filter((c) => c.schemes.A.pass).length, B: plan.candidates.filter((c) => c.schemes.B.pass).length });
    // 不採用の内訳は設計時のまま
    assert.deepEqual(plan.summary.rejections, first.plan.summary.rejections);
    const txt = render(plan, {});
    assert.match(txt, /== 2\. 候補（7件。/);
    assert.match(txt, /候補数: 7件/);
    assert.match(txt, /状態更新で追加した型B 3件（候補欄を参照）/);
    assert.match(txt, /\[\d\] 売り EURUSD 型B .*※型Bの追加（状態更新 17:00）/);
    assert.match(txt, /設計の履歴: 設計2 /);
    assert.match(txt, /型Bの追加（この状態更新）: .*B:EURUSD:sell/);
    // 何度状態更新を重ねても数え直しは冪等
    const again = status(s17, { prevPlan: plan, logRows: [...first.logAppend] , nowMs: s17.nowMs + 40 * J.MIN });
    assert.equal(again.plan.summary.candidate_rows, 7);
  } finally { cleanup(d, s17); }
});

test("設計②を型B追加のあとにやり直しても、追加した型Bは取消さず引き継ぐ（型Bを再設計するのは設計③）", () => {
  const d = makeScenario({ spec: down });
  const s17 = makeScenario({ nowIso: "2026-10-08T17:30:00+09:00", spec: down });
  try {
    const first = design(d);
    const st = status(s17, { prevPlan: first.plan, logRows: first.logAppend, nowMs: s17.nowMs });
    assert.equal(st.logAppend.length, 3);
    const rows = [...first.logAppend, ...st.logAppend];
    const redo = design(s17, { slot: 2, prevPlan: st.plan, logRows: rows });
    assert.equal(redo.plan.candidates.filter((c) => c.setup === "B").length, 3);
    assert.ok(redo.plan.candidates.filter((c) => c.setup === "B").every((c) => c.run === "design-b"));
    assert.ok(!redo.logAppend.some((r) => r.setup === "B"), JSON.stringify(redo.logAppend.map((r) => [r.run, r.setup, r.symbol])));
    // 追加した型Bはあとの状態更新でも追加し直されない
    const next = status(s17, { prevPlan: redo.plan, logRows: [...rows, ...redo.logAppend], nowMs: s17.nowMs + J.HR });
    assert.equal(next.logAppend.length, 0);
  } finally { cleanup(d, s17); }
});

test("型B追加は、発注できる状態の入力（鮮度・日次レベル・MTF・停止対象通貨表・口座設定）のときだけ。門で不採用の型Bは追加しない", () => {
  const ok = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: down });
  const stale = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: down, intradayLagMin: 25 });
  const mtfBad = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: down, mtfStatus: "partial" });
  const noRules = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: down });
  const noAcc = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: down });
  const gate = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: down, tweak: (f) => { f["daily-levels.json"].pairs.EURUSD.s1 = 1.0990; } });
  try {
    assert.equal(status(ok).logAppend.length, 3);
    for (const sc of [stale, mtfBad]) assert.equal(status(sc).logAppend.length, 0);
    fs.writeFileSync(path.join(noRules.repoRoot, "config", "daytrade-rules.json"), JSON.stringify({}));
    assert.equal(status(noRules).logAppend.length, 0);
    fs.rmSync(path.join(noAcc.dataDir, "daytrade", "accounts.json"));
    assert.equal(status(noAcc).logAppend.length, 0);
    // EURUSD の型Bは門（コスト／RR）で不採用 → 計画にもログにも入らず、ほかの2銘柄だけ追加される
    const g = status(gate);
    assert.deepEqual(g.logAppend.map((r) => r.symbol).sort(), ["AUDUSD", "XAUUSD"]);
    assert.ok(!g.plan.candidates.some((c) => c.symbol === "EURUSD" && c.setup === "B"));
  } finally { cleanup(ok, stale, mtfBad, noRules, noAcc, gate); }
});

test("型B追加の案の性質: 停止中の印・往復手数料・calendar_ok・確認条件・設計の枠なし（design_slot=null）", () => {
  const ev = [{ time_jst: "17:10", datetime_jst: "2026-10-08T17:10:00+09:00", currency: "EUR", impact: "High", event: "ECB" }];
  const sc = makeScenario({ nowIso: "2026-10-08T17:00:00+09:00", spec: down, events: ev });
  try {
    const { plan } = status(sc);
    const b = plan.candidates.find((c) => c.symbol === "EURUSD" && c.setup === "B");
    assert.equal(b.design_slot, null);
    assert.equal(b.calendar_ok, true);
    assert.equal(b.entry_state.ok, false); // 16:55〜17:40 は停止中
    assert.match(b.entry_state.reasons.join(), /ECB/);
    assert.equal(b.stops.length, 1);
    assert.ok(Number.isFinite(b.schemes.A.commission_jpy[701620]) || b.schemes.A.pass === false);
    assert.match(b.confirm, /M15がレンジ安値（[\d.]+）より下で陰線確定/);
    const aud = plan.candidates.find((c) => c.symbol === "AUDUSD" && c.setup === "B");
    assert.equal(aud.entry_state.ok, true);
  } finally { cleanup(sc); }
});

// ---- 設計の履歴 ----
test("設計の履歴（designs）: 前日の履歴は引き継がない／同じ枠の再実行は置き換え／設計③で [2,3] になる。状態更新は引き継ぐ", () => {
  const d1 = makeScenario({ nowIso: "2026-10-07T15:30:00+09:00", mtfBase: "2026-10-06", dailySession: "2026-10-06" });
  const d2 = makeScenario();
  const d3 = makeScenario({ nowIso: "2026-10-08T21:00:00+09:00" });
  try {
    const yesterday = design(d1);
    assert.deepEqual(yesterday.plan.designs.map((x) => x.slot), [2]);
    const today = design(d2, { prevPlan: { ...yesterday.plan, designs: [{ slot: 1 }, { slot: 2 }, { slot: 3 }], plan_date: "2026-10-07" } });
    assert.deepEqual(today.plan.designs.map((x) => x.slot), [2]);
    const redo = design(d2, { prevPlan: today.plan });
    assert.deepEqual(redo.plan.designs.map((x) => x.slot), [2]);
    const third = design(d3, { slot: 3, prevPlan: today.plan });
    assert.deepEqual(third.plan.designs.map((x) => x.slot), [2, 3]);
    assert.ok(third.plan.designs.every((x) => x.inputs_ok === true));
    const st = status(d3, { prevPlan: third.plan, nowMs: d3.nowMs + 61 * J.MIN });
    assert.deepEqual(st.plan.designs.map((x) => x.slot), [2, 3]);
  } finally { cleanup(d1, d2, d3); }
});

test("設計が一つ済んだあとの状態更新: 『設計なし』にならず、入力が整っていれば発注可。古い入力で作った設計の旨はバナーに出す", () => {
  const d = makeScenario();
  const staleD = makeScenario({ intradayLagMin: 30 });
  const s16 = makeScenario({ nowIso: "2026-10-08T16:05:00+09:00" });
  try {
    const ok = design(d);
    const a = status(s16, { prevPlan: ok.plan });
    assert.equal(a.plan.design_missing, false);
    assert.equal(a.plan.order_ok, true);
    assert.equal(a.plan.inputs_ok, true);
    assert.deepEqual(a.plan.banners, []);
    // 古い入力で作った設計 → inputs_ok=false（済みにならない）。そのあとの状態更新には旨のバナーが残る
    const bad = design(staleD);
    assert.equal(bad.plan.inputs_ok, false);
    assert.equal(bad.plan.designs[0].inputs_ok, false);
    const b = status(s16, { prevPlan: bad.plan });
    assert.match(b.plan.banners.join("\n"), /設計2（2026-10-08 15:30）は、発注できる状態の入力が整う前に作られました/);
    assert.equal(b.plan.design_missing, false);
  } finally { cleanup(d, staleD, s16); }
});

// ---- 設定の問題 ----
test("口座設定・停止対象通貨表の問題は、黙らずバナーに出して『発注不可』にする。表示だけの設定のおかしさは問題として出すだけ", () => {
  const mk = () => makeScenario();
  const cases = [];
  const noAcc = mk(); fs.rmSync(path.join(noAcc.dataDir, "daytrade", "accounts.json")); cases.push([noAcc, /口座設定の問題: .*accounts\.json がありません/, true]);
  const badRisk = mk(); writeJson(badRisk, "daytrade/accounts.json", { accounts: { 701620: { equity_jpy: 610273, role: "daytrade" } }, commission_per_lot_jpy: 1013, risk_pct: 50, daily_loss_pct: 1.5 }); cases.push([badRisk, /risk_pct が 0 超 5 以下の数ではありません（50）/, true]);
  const negEq = mk(); writeJson(negEq, "daytrade/accounts.json", { accounts: { 701620: { equity_jpy: -610273, role: "daytrade" }, 702449: { equity_jpy: 4682566, role: "x" } }, commission_per_lot_jpy: 1013, risk_pct: 0.5, daily_loss_pct: 1.5 }); cases.push([negEq, /口座 701620 の equity_jpy が正の数ではありません/, true]);
  const noRules = mk(); fs.writeFileSync(path.join(noRules.repoRoot, "config", "daytrade-rules.json"), JSON.stringify({ pair_currencies: { EURUSD: ["EUR", "USD"] } })); cases.push([noRules, /pair_currencies）が読めません/, true]);
  const softBad = mk(); writeJson(softBad, "daytrade/accounts.json", { accounts: { 701620: { equity_jpy: 610273, role: "daytrade" } }, risk_pct: 0.5 }); cases.push([softBad, null, false]);
  try {
    for (const [sc, re, blocks] of cases) {
      const { plan, inputs } = design(sc);
      assert.equal(plan.order_ok, !blocks, String(re));
      if (re) assert.match(plan.banners.join("\n"), re);
      assert.equal(plan.designs[0].inputs_ok, !blocks);
      if (blocks) assert.match(render(plan, inputs.accounts), /発注可否: 発注不可/);
    }
    // 表示だけの設定（daily_loss_pct・commission_per_lot_jpy）がおかしくても発注不可にはしないが、入力の問題として出す。損失上限・手数料は出さない
    const { plan, inputs } = design(softBad);
    assert.match(plan.inputs_problems.join("\n"), /daily_loss_pct が 0 以上の数ではありません/);
    assert.match(plan.inputs_problems.join("\n"), /commission_per_lot_jpy が 0 以上の数ではありません/);
    const txt = render(plan, inputs.accounts);
    assert.match(txt, /本日の損失上限 —/);
    assert.ok(!/往復手数料 [0-9,]+円/.test(txt)); // 問題の文言に『往復手数料』は出るが、金額つきの表示は出さない
    // 口座が全く無いときは、1項目目にその旨
    const t = render(design(noAcc).plan, {});
    assert.match(t, /口座: 設定がありません/);
  } finally { cleanup(...cases.map((c) => c[0])); }
});

test("本日の損失上限は切り捨て（equity×1.5%）。往復手数料は円未満を四捨五入", () => {
  const sc = makeScenario();
  try {
    writeJson(sc, "daytrade/accounts.json", { accounts: { 701620: { equity_jpy: 123457, role: "daytrade" } }, commission_per_lot_jpy: 1013, risk_pct: 0.5, daily_loss_pct: 1.5 });
    const { plan } = design(sc);
    assert.equal(plan.accounts[701620].daily_loss_limit_jpy, 1851); // 1851.855 を切り捨て
    const c = plan.candidates.find((x) => x.symbol === "EURUSD");
    const lots = c.schemes.A.lots[701620];
    assert.equal(c.schemes.A.commission_jpy[701620], Math.round(lots * 1013));
  } finally { cleanup(sc); }
});

// ---- 出力の細部 ----
test("出力: 5項目目の『対象』は対象10銘柄だけ（rules に USOIL・AUDNZD があっても出さない）。RRの丸めは通貨ペアによらず同じ", () => {
  const ev = [{ time_jst: "15:40", datetime_jst: "2026-10-08T15:40:00+09:00", currency: "USD", impact: "High", event: "CPI" }];
  const sc = makeScenario({ events: ev });
  try {
    const rules = JSON.parse(fs.readFileSync(path.join(sc.repoRoot, "config", "daytrade-rules.json"), "utf8"));
    rules.pair_currencies.USOIL = ["USD"]; rules.pair_currencies.AUDNZD = ["AUD", "NZD"];
    fs.writeFileSync(path.join(sc.repoRoot, "config", "daytrade-rules.json"), JSON.stringify(rules));
    const { plan } = design(sc);
    const e = plan.events_today[0];
    assert.ok(!e.symbols.includes("USOIL") && !e.symbols.includes("AUDNZD"));
    assert.ok(e.symbols.includes("EURUSD") && e.symbols.includes("XAUUSD"));
    // 6.975 のような『ちょうど半端』の比は、どの通貨ペアでも上に丸める（浮動小数の誤差で 6.97／6.98 とぶれない）
    assert.equal(plan.candidates.find((c) => c.symbol === "EURUSD").schemes.B.rr, 6.98);
    assert.equal(plan.candidates.find((c) => c.symbol === "AUDUSD").schemes.B.rr, 6.98);
  } finally { cleanup(sc); }
});

test("出力: 旧形式の計画（不採用の一覧が無い summary）は『一覧なし』と出す。最終確定足は最古と最新が違えば両方出し、対象外の銘柄は数えない", () => {
  const sc = makeScenario({
    barsEdit: { EURUSD: (bars) => bars.slice(0, -1) },
    tweak: (f) => { f["daytrade-context.json"].pairs.AUDNZD = { m15: { last_closed: { time_jst: "2026-10-08 09:00" } }, data_status: "DEGRADED" }; f["daytrade-context.json"].pairs.EURGBP.m15 = { last_closed: { time_jst: "2026-10-08 15:15" } }; },
  });
  try {
    const { plan, inputs } = design(sc);
    assert.deepEqual(inputs.freshness.h1_last_closed, { oldest: "2026-10-08 13:00", newest: "2026-10-08 14:00" });
    assert.equal(inputs.freshness.ctx_m15.oldest_last_closed, "2026-10-08 15:15"); // 対象外の AUDNZD は数えない
    assert.deepEqual(inputs.freshness.ctx_m15.not_ok, []);
    const old = { ...plan, summary: { ...plan.summary, rejected_cases: undefined } };
    assert.match(render(old, {}), /旧形式の計画のため一覧はありません/);
  } finally { cleanup(sc); }
});

test("events.dayEvents: High・Medium だけ・時刻順・停止時間（前15分〜後30分）・対象銘柄。カレンダーが使えない／時刻が壊れていれば除く", () => {
  const cal = { as_of: "2026-10-08T15:25:00+09:00", date: "2026-10-08", events: [
    { time_jst: "22:00", datetime_jst: "2026-10-08T22:00:00+09:00", currency: "EUR", impact: "Medium", event: "B" },
    { time_jst: "21:30", datetime_jst: "2026-10-08T21:30:00+09:00", currency: "USD", impact: "High", event: "A" },
    { time_jst: "21:45", datetime_jst: "2026-10-08T21:45:00+09:00", currency: "JPY", impact: "Low", event: "ignored" },
    { time_jst: "??", datetime_jst: "garbage", currency: "USD", impact: "High", event: "bad" },
  ] };
  const now = J.parseIso("2026-10-08T15:30:00+09:00");
  const st = calendarStatus(cal, now);
  const out = dayEvents(cal, { EURUSD: ["EUR", "USD"], USDJPY: ["USD", "JPY"], XAUUSD: ["USD"] }, st);
  assert.deepEqual(out.map((e) => e.event), ["A", "B"]);
  assert.equal(J.jstIso(out[0].start), "2026-10-08T21:15:00+09:00");
  assert.equal(J.jstIso(out[0].end), "2026-10-08T22:00:00+09:00");
  assert.equal(out[0].time_jst, "21:30");
  assert.deepEqual(out[0].symbols, ["EURUSD", "USDJPY", "XAUUSD"]);
  assert.deepEqual(out[1].symbols, ["EURUSD"]);
  assert.deepEqual(dayEvents(cal, {}, { ok: false }), []);
  assert.deepEqual(dayEvents(null, {}, st), []);
});

// ---- 起動・ログ・CLI ----
test("schedule: 状態更新の時間帯の端（07:00・06:59・02:59・03:00）と、設計の履歴が空のときの log.csv の見方（design-b・status の行は設計ではない）", () => {
  const T = (s) => J.parseIso(s);
  const done = { plan_date: "2026-07-15", designs: [{ slot: 1, inputs_ok: true }] };
  const at = (iso, plan = done) => S.resolveAuto({ nowMs: T(iso), prevPlan: plan, logRows: [] }).action;
  assert.equal(at("2026-07-15T06:59:00+09:00"), "skip");   // 夏: 06時台は設計①の窓。済みなら状態更新の時間帯の前
  assert.equal(at("2026-07-15T07:00:00+09:00"), "status");
  assert.equal(at("2026-07-16T02:59:00+09:00"), "status");
  assert.equal(at("2026-07-16T03:00:00+09:00"), "skip");
  assert.equal(S.resolveAuto({ nowMs: T("2026-07-15T07:20:00+09:00"), prevPlan: { plan_date: "2026-07-15", designs: [] }, logRows: [{ plan_date: "2026-07-15", run: "design", generated_at: "2026-07-15T06:40:00+09:00" }] }).action, "status"); // 履歴が空 → log.csv の design 行で済み
  // design-b・status の行は設計ではない → 窓(06:00-08:59)の中なら設計①をやり直す
  assert.deepEqual(S.resolveAuto({ nowMs: T("2026-07-15T07:20:00+09:00"), prevPlan: null, logRows: [{ plan_date: "2026-07-15", run: "design-b", generated_at: "2026-07-15T06:40:00+09:00" }, { plan_date: "2026-07-15", run: "status", generated_at: "2026-07-15T06:40:00+09:00" }] }), { action: "design", slot: 1 });
  assert.deepEqual(S.resolveAuto({ nowMs: T("2026-07-15T08:20:00+09:00"), prevPlan: null, logRows: [{ plan_date: "2026-07-15", run: "design-b", generated_at: "2026-07-15T06:40:00+09:00" }] }), { action: "design", slot: 1 });
  // 古い入力で作った設計(inputs_ok=false)は済みにしない
  assert.deepEqual(S.resolveAuto({ nowMs: T("2026-07-15T08:20:00+09:00"), prevPlan: { plan_date: "2026-07-15", designs: [{ slot: 1, inputs_ok: false }] }, logRows: [] }), { action: "design", slot: 1 });
});

test("log.keyOf: 表計算ソフトを通して価格の桁が落ちても同じ版として扱う（重複行を追記しない）", () => {
  const sc = makeScenario();
  try {
    const first = design(sc);
    const squashed = first.logAppend.map((r) => ({ ...r, entry_low: String(Number(r.entry_low)), entry_high: String(Number(r.entry_high)), sl_a: r.sl_a === "" ? "" : String(Number(r.sl_a)), sl_b: r.sl_b === "" ? "" : String(Number(r.sl_b)) }));
    assert.equal(L.keyOf(first.logAppend[0]), L.keyOf(squashed[0]));
    const again = design(sc, { prevPlan: first.plan, logRows: squashed });
    assert.equal(again.logAppend.length, 0);
    assert.notEqual(L.keyOf({ ...squashed[0], sl_a: "1.2" }), L.keyOf(squashed[0]));
  } finally { cleanup(sc); }
});

test("CLI: log.csv が壊れていても計画は出す（ログは追記せず上書きもしない）。--resolve は now を出す。計画のファイルより先にログを置く", async () => {
  const sc = makeScenario();
  try {
    fs.mkdirSync(path.join(sc.dataDir, "daytrade"), { recursive: true });
    fs.writeFileSync(path.join(sc.dataDir, "daytrade", "log.csv"), "broken,header\n1,2\n");
    const out = [];
    const r = await main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", `--now=${sc.nowIso}`, "--run=design", "--slot=2"], {}, { log: (m) => out.push(m) });
    assert.equal(r.plan.candidates.length, 4);
    assert.equal(read(sc, "daytrade/log.csv"), "broken,header\n1,2\n");
    assert.match(read(sc, "daytrade-plan.txt"), /log\.csv を読めないため、ログの追記を行っていません/);
    assert.match(out.join("\n"), /log追記 0行/);
    const q = [];
    await main(["--resolve", `--data-dir=${sc.dataDir}`, `--now=${sc.nowIso}`], {}, { log: (m) => q.push(m) });
    assert.ok(q.some((l) => /^now=2026-10-08T15:30:00\+09:00$/.test(l)), q.join("|"));
  } finally { cleanup(sc); }
});

test("CLI: plan.json が無くても、log.csv の design 行があればその枠は済み（手動の設計は何もしない）。型Bの重複判定も log.csv を見る", async () => {
  const sc = makeScenario();
  try {
    const first = design(sc);
    fs.mkdirSync(path.join(sc.dataDir, "daytrade"), { recursive: true });
    fs.writeFileSync(path.join(sc.dataDir, "daytrade", "log.csv"), L.appendedText("", first.logAppend));
    const r = await main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", `--now=2026-10-08T15:40:00+09:00`, "--run=design", "--slot=2"], {}, { log: () => {} });
    assert.equal(r.skipped, "done");
    const auto = await main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", `--now=2026-10-08T15:40:00+09:00`], {}, { log: () => {} });
    assert.ok(auto.plan.run === "status"); // 自動でも設計②は済み
  } finally { cleanup(sc); }
});

test("workflow: Resolve と同じ時刻（now）を採点・生成の手順に渡す。この枝が既存ファイルを変えていないことを git の差分で確かめる（origin/main があるときだけ）", () => {
  const yml = fs.readFileSync(path.join(__dirname, "..", "..", "..", ".github", "workflows", "daytrade.yml"), "utf8");
  assert.match(yml, /run: node scripts\/daytrade-score\.js --now="\$NOW"/);
  assert.match(yml, /run: node scripts\/daytrade-plan\.js --now="\$NOW" \$FORCE/);
  assert.equal((yml.match(/NOW: \$\{\{ steps\.resolve\.outputs\.now \}\}/g) || []).length, 2);
  const { execFileSync } = require("node:child_process");
  const root = path.join(__dirname, "..", "..", "..");
  let diff = null;
  try { diff = execFileSync("git", ["diff", "--name-status", "origin/main...HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { /* origin/main が無い（CI の浅い checkout など） */ }
  if (diff === null) return;
  const nonAdded = diff.split("\n").filter((l) => l && !l.startsWith("A\t"));
  assert.deepEqual(nonAdded, [], "既存のファイルを変更・削除してはいけない");
});
