"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../num");
const { atrWilder } = require("../indicators");
const { referenceLevel } = require("../levels");
const { tokyoRange } = require("../tokyo");
const { simulate } = require("../fill");
const { scoreRows } = require("../score");
const { rankCandidates, entryStateOf } = require("../plan");
const L = require("../log");
const { createHistory, upperBound } = require("../histctx");
const { runBacktest } = require("../backtest");
const { pairOf } = require("../pairs");
const { allSynth, P0 } = require("./bt-data");
const { lastCompletedSessionDate } = require("../../../mtf/lib/ny-time");
const J = require("../jst");

/**
 * 変異試験（コードを少し壊して試験が気づくか）で生き残った境界・計算の試験。
 */

test("atrWilder: 独立に書いた Wilder の式（ギャップのある足を含む）と一致する", () => {
  const closes = [100, 101.5, 99, 103, 102, 98, 104, 106, 101, 99.5, 100.5, 107, 105, 103, 108, 104, 100, 102, 109, 111];
  const bars = closes.map((c, i) => {
    const o = i ? closes[i - 1] + (i % 3 === 0 ? 1.7 : -0.9) : c; // 前の終値からのギャップ
    return { t: i * J.HR, o, h: Math.max(o, c) + (i % 4) * 0.3 + 0.2, l: Math.min(o, c) - (i % 5) * 0.2 - 0.1, c };
  });
  const tr = [];
  for (let i = 1; i < bars.length; i++) tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  let atr = tr.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  for (let i = 14; i < tr.length; i++) atr = (atr * 13 + tr[i]) / 14;
  assert.ok(Math.abs(atrWilder(bars) - atr) < 1e-12, `${atrWilder(bars)} vs ${atr}`);
  // ギャップを無視した（h−l だけの）計算とは違う値になる足を使っていること
  const naive = (() => { const t = bars.slice(1).map((b) => b.h - b.l); let a = t.slice(0, 14).reduce((x, y) => x + y, 0) / 14; for (let i = 14; i < t.length; i++) a = (a * 13 + t[i]) / 14; return a; })();
  assert.ok(Math.abs(naive - atr) > 0.01);
});

test("num.floorLot: 0.129995 は 0.12（許容が緩すぎない）", () => {
  assert.equal(N.floorLot(0.129995), 0.12);
  assert.equal(N.floorLot(0.13), 0.13);
});

test("levels: 現在値と同値の水準は買いの基準にならず、前日高値は売りの基準になる", () => {
  const none = { highs: [], lows: [] };
  assert.equal(referenceLevel("buy", 1.1040, { pivot: 1.1040, s1: 1.1040, s2: 1.1040, prev_low: 1.1040 }, none), null);
  assert.deepEqual(referenceLevel("sell", 1.1000, { prev_high: 1.1050, pivot: 1.2, r1: 1.2, r2: 1.2 }, none), { label: "前日高値", price: 1.105 });
});

test("tokyo: 終値がレンジ安値ちょうどはブレイクではない（高値側も）", () => {
  const D = "2026-10-08";
  const rb = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00"].map((hm, i) => ({ t: J.jstAt(D, hm), o: 1.1075, h: i === 2 ? 1.11 : 1.109, l: i === 4 ? 1.105 : 1.106, c: 1.1075 }));
  const r = tokyoRange([...rb, { t: J.jstAt(D, "15:00"), o: 1.106, h: 1.107, l: 1.1040, c: 1.105 }], D);
  assert.equal(r.breakDown, false);
  assert.equal(tokyoRange([...rb, { t: J.jstAt(D, "15:00"), o: 1.106, h: 1.107, l: 1.1040, c: 1.10499 }], D).breakDown, true);
});

const D = "2026-10-08";
const bar = (hm, h, l, o, c, date = D) => ({ t: J.jstAt(date, hm), o: o ?? (h + l) / 2, h, l, c: c ?? (h + l) / 2 });
const sellCand = (o = {}) => ({
  side: "sell", plan_date: D, generated_at_ms: J.jstAt(D, "15:30"), entry_low: 1.1040, entry_high: 1.1042,
  schemes: { A: { sl: 1.1050, tp: 1.0990 } }, ...o,
});
test("fill: SL・TP1 にちょうど触れた足も『届いた』。始値がSLちょうどはギャップではない。設計時刻ちょうどに始まる足は使う", () => {
  const reach = bar("16:00", 1.1045, 1.1035, 1.1038, 1.1036);
  assert.equal(simulate(sellCand(), [reach, bar("17:00", 1.1050, 1.1030)]).schemes.A.first_hit, "SL"); // 高値 = SL ちょうど
  assert.equal(simulate(sellCand(), [reach, bar("17:00", 1.1030, 1.0990)]).schemes.A.first_hit, "TP1"); // 安値 = TP1 ちょうど
  const g = simulate(sellCand(), [reach, bar("17:00", 1.1060, 1.1045, 1.1050, 1.1055)]).schemes.A; // 始値 = SL ちょうど
  assert.equal(g.first_hit, "SL");
  assert.equal(g.gap, false);
  assert.equal(g.exit_price, 1.105);
  // 設計時刻ちょうどに始まる足（21:00 の設計の 21:00 開始の足）は使う
  assert.equal(simulate(sellCand({ generated_at_ms: J.jstAt(D, "16:00") }), [bar("16:00", 1.1045, 1.1035)]).reached, "到達");
});

test("score: 有効期限ちょうどの時刻に採点できる", () => {
  const row = {
    plan_date: D, generated_at: "2026-10-08T15:30:00+09:00", run: "design", setup: "A", symbol: "EURUSD", side: "sell", same_direction_group: "",
    entry_low: "1.10400", entry_high: "1.10420", sl_a: "1.10500", tp_a: "1.09900", sl_b: "", tp_b: "", rr_a: "", rr_b: "", cost_cap_a: "",
    lot_cap_a_701620: "", lot_cap_b_701620: "", lot_cap_a_702449: "", lot_cap_b_702449: "", expires_at: "2026-10-09T03:00:00+09:00",
    reached: "", reached_at: "", first_hit_a: "", first_hit_b: "", filled_ticket_701620: "", filled_ticket_702449: "",
  };
  const bars = [bar("16:00", 1.1030, 1.1020), bar("02:00", 1.1030, 1.1020, undefined, undefined, "2026-10-09")];
  assert.equal(scoreRows({ rows: [row], barsByCode: { EURUSD: bars }, nowMs: J.parseIso("2026-10-09T03:00:00+09:00") }).newRows.length, 1);
  assert.equal(scoreRows({ rows: [row], barsByCode: { EURUSD: bars }, nowMs: J.parseIso("2026-10-09T02:59:59+09:00") }).newRows.length, 0);
});

test("順位: 同点は銘柄名順。RRは通っているA案・B案のうち小さい方", () => {
  const mk = (symbol, a, b) => ({ symbol, setup: "A", strength: 3, schemes: { A: { pass: true, rr: a }, B: { pass: true, rr: b } } });
  const eg = mk("EURGBP", 2, 2), jp = mk("USDJPY", 2, 2);
  const cs = [jp, eg];
  rankCandidates(cs);
  assert.deepEqual(cs.map((c) => c.symbol), ["EURGBP", "USDJPY"]);
  // 同じ優先の USDCAD(A 2.0 / B 3.0 → 小さい方 2.0) と USDCHF(A 2.5 / B 2.6 → 2.5)。大きい方で比べると逆になる
  const x = [mk("USDCAD", 2.0, 3.0), mk("USDCHF", 2.5, 2.6)];
  rankCandidates(x);
  assert.deepEqual(x.map((c) => c.symbol), ["USDCHF", "USDCAD"]);
});

test("entryStateOf: 停止窓の両端を含む（端ちょうどは新規不可）", () => {
  const w = [{ start: J.parseIso("2026-10-08T21:15:00+09:00"), end: J.parseIso("2026-10-08T22:00:00+09:00"), time_jst: "21:30", currency: "USD", event: "CPI" }];
  const at = (s, extra = 0) => entryStateOf(J.parseIso(s) + extra, D, w).ok;
  assert.equal(at("2026-10-08T21:14:59+09:00"), true);
  assert.equal(at("2026-10-08T21:15:00+09:00"), false);
  assert.equal(at("2026-10-08T22:00:00+09:00"), false);
  assert.equal(at("2026-10-08T22:00:00+09:00", 1), true);
});

test("log.keyOf: 版の識別に使う8項目のどれが違っても別の版になる", () => {
  const base = { plan_date: D, setup: "A", symbol: "EURUSD", side: "sell", entry_low: "1.10400", entry_high: "1.10420", sl_a: "1.10500", sl_b: "1.10600" };
  for (const [f, v] of Object.entries({ plan_date: "2026-10-09", setup: "B", symbol: "GBPUSD", side: "buy", entry_low: "1.1", entry_high: "1.2", sl_a: "1.3", sl_b: "1.4" })) {
    assert.notEqual(L.keyOf({ ...base, [f]: v }), L.keyOf(base), f);
  }
  assert.equal(L.keyOf({ ...base, tp_a: "x", reached: "到達" }), L.keyOf(base)); // 状態の列は版の識別に入らない
});

// ---- バックテストの入力の再構成 ----
const eu = pairOf("EURUSD");
test("histctx.upperBound: 足の終わりが設計時刻ちょうどの足も確定として数える。設計③（:00ちょうど）の入力が作れる", () => {
  const bars = [0, 1, 2].map((i) => ({ t: i * J.HR }));
  assert.equal(upperBound(bars, 2 * J.HR), 2);
  assert.equal(upperBound(bars, 2 * J.HR - 1), 1);
  const { barsByCode, rowsByCode } = allSynth();
  const h = createHistory({ barsByCode, rowsByCode });
  const r = h.ctxAt(eu, J.jstAt("2026-10-05", "21:00"), "A");
  assert.equal(r.skip, undefined);
  assert.equal(r.ctx.price, barsByCode.EURUSD.find((b) => b.t === J.jstAt("2026-10-05", "20:00")).c);
  // 実際のバックテストでも設計③の評価がある。型Bは設計③と型B追加（slot 4）だけ、型Aは設計①②③だけ
  const slots = new Set(), setupsBySlot = {};
  runBacktest({ barsByCode, rowsByCode, nowMs: J.parseIso("2026-10-08T12:00:00+09:00"), windowDays: 3, evaluateImpl: (ctx, setup, info) => { slots.add(info.slot); (setupsBySlot[info.slot] ||= new Set()).add(setup); return { outcome: "rejected", symbol: ctx.pair.code, setup, schemes: { A: { pass: false }, B: { pass: false } } }; } });
  assert.deepEqual([...slots].sort(), [1, 2, 3, 4]);
  assert.deepEqual(Object.fromEntries(Object.entries(setupsBySlot).map(([k, v]) => [k, [...v].sort()])), { 1: ["A"], 2: ["A"], 3: ["A", "B"], 4: ["B"] });
});

// ADR と当日高安: NY17時（夏 JST6:00／冬 JST7:00）以降の確定足の高安、ADR20 は日足の直近20セッションの平均値幅
function expectedAdr(rows, bars, asOf, tMs, boundaryHm) {
  const idx = rows.findIndex((r) => r.date === asOf);
  const adr20 = rows.slice(idx - 19, idx + 1).reduce((s, r) => s + (r.high - r.low), 0) / 20;
  let start = J.jstAt(J.jstDate(tMs), boundaryHm);
  if (start > tMs) start = J.jstAt(J.addDaysJst(J.jstDate(tMs), -1), boundaryHm);
  const inDay = bars.filter((b) => b.t >= start && b.t + J.HR <= tMs);
  const used = Math.max(...inDay.map((b) => b.h)) - Math.min(...inDay.map((b) => b.l));
  return { adr20, used, used_pct: (used / adr20) * 100, remaining: Math.max(adr20 - used, 0) };
}
test("histctx: 当日高安はNY17時（夏 JST6:00／冬 JST7:00）以降の足だけ。ADR20は直近20セッションの平均で割る", () => {
  const spike = (bars, t) => bars.map((b) => (b.t === t ? { ...b, h: Number((b.h + P0.EURUSD * 0.02).toFixed(5)) } : b));
  const cases = [["夏", "2026-10-06", "06:00"], ["冬", "2025-12-02", "07:00"]];
  for (const [season, date, boundary] of cases) {
    const { barsByCode, rowsByCode } = allSynth({ h1: { fromLabel: "2025-11-01 00:00", toLabel: "2026-10-08 05:00" } });
    // 夏の境界は 06:00、冬は 07:00。『06:00開始の足』は夏だけ当日に入り、冬は前日の扱い。その足にスパイクを入れて違いを出す
    const bars = spike(barsByCode.EURUSD, J.jstAt(date, "06:00"));
    const h = createHistory({ barsByCode: { ...barsByCode, EURUSD: bars }, rowsByCode });
    const t = J.jstAt(date, "15:30");
    const r = h.ctxAt(eu, t, "A");
    const e = expectedAdr(rowsByCode.EURUSD, bars, lastCompletedSessionDate(t), t, boundary);
    assert.ok(Math.abs(r.ctx.adr.used_pct - e.used_pct) < 1e-6, `${season} used_pct ${r.ctx.adr.used_pct} vs ${e.used_pct}`);
    assert.ok(Math.abs(r.ctx.adr.remaining - e.remaining) < 1e-9, `${season} remaining ${r.ctx.adr.remaining} vs ${e.remaining}`);
    // スパイクが当日に入っているのは夏だけ（used が大きい）
    const base = expectedAdr(rowsByCode.EURUSD, barsByCode.EURUSD, lastCompletedSessionDate(t), t, boundary);
    if (season === "夏") assert.ok(e.used > base.used + 0.01); else assert.ok(Math.abs(e.used - base.used) < 1e-12);
  }
});

// ---- 評価を差し替えた小さな場面（取消・損益・不完全な日） ----
function stubRun({ slots, touch = false, tp = false, truncate = false }) {
  const Dd = "2026-10-06";
  const { barsByCode, rowsByCode } = allSynth();
  const quietFrom = J.jstAt(Dd, "07:00"), quietTo = J.jstAt("2026-10-07", "03:00");
  let eub = barsByCode.EURUSD.map((b) => {
    if (b.t < quietFrom || b.t >= quietTo) return b;
    const quiet = { t: b.t, o: 1.0995, h: 1.1010, l: 1.0990, c: 1.0995 };
    if (touch && b.t === J.jstAt(Dd, "10:00")) return { ...quiet, h: 1.1045 };
    if (tp && b.t === J.jstAt(Dd, "12:00")) return { ...quiet, l: 1.0985 };
    return quiet;
  });
  if (truncate) eub = eub.filter((b) => b.t < J.jstAt("2026-10-07", "01:00"));
  const cand = {
    outcome: "candidate", symbol: "EURUSD", setup: "A", side: "sell", ref: { label: "Pivot", price: 1.104 }, band: { low: 1.104, high: 1.1042 }, worst_entry: 1.104,
    pip_value_jpy: 1500, schemes: { A: { pass: true, sl: 1.105, tp: 1.099, sl_pips: 10, profit_pips: 50, rr: 5 }, B: { pass: false } },
  };
  const evaluateImpl = (ctx, setup, { t, slot }) => (ctx.pair.code === "EURUSD" && setup === "A" && J.jstDate(t) === Dd && slots.includes(slot) ? cand : { outcome: "rejected", symbol: ctx.pair.code, setup, schemes: { A: { pass: false }, B: { pass: false } } });
  return runBacktest({ barsByCode: { ...barsByCode, EURUSD: eub }, rowsByCode, nowMs: J.parseIso("2026-10-08T12:00:00+09:00"), windowDays: 3, evaluateImpl });
}
test("backtest: TP1 先着の損益（pips・R・コスト込み・1ロットの円）を手計算と照合する", () => {
  const { records } = stubRun({ slots: [1], touch: true, tp: true });
  const r = records.find((x) => x.symbol === "EURUSD");
  assert.equal(r.first_hit, "TP1");
  assert.ok(Math.abs(r.pips_gross - 50) < 1e-9);
  assert.equal(r.cost_pips, 1.2);
  assert.ok(Math.abs(r.pips_net - 48.8) < 1e-9);
  assert.ok(Math.abs(r.r_gross - 5) < 1e-9);
  assert.ok(Math.abs(r.r_net - 4.88) < 1e-9);
  assert.ok(Math.abs(r.yen_net_1lot - 48.8 * 1500) < 1e-6);
  assert.equal(r.fill_hour, 10);
});
test("backtest: 『取消・未到達』は次の設計で取消された版だけ（有効期限まで残った版は数えない）", () => {
  const cut = stubRun({ slots: [1] }).records.find((x) => x.symbol === "EURUSD");
  assert.equal(cut.reached, "未到達");
  assert.equal(cut.cancelled_unreached, true);
  const last = stubRun({ slots: [3] }).records.find((x) => x.symbol === "EURUSD");
  assert.equal(last.reached, "未到達");
  assert.equal(last.cancelled_unreached, false);
});
test("backtest: 有効期限まで足がそろわない日の版は除く（数に入れない）", () => {
  const { records, stats } = stubRun({ slots: [1], touch: true, truncate: true });
  assert.equal(records.filter((x) => x.symbol === "EURUSD").length, 0);
  assert.ok(stats.incomplete >= 1);
});
