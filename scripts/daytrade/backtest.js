"use strict";
const { PAIRS } = require("./pairs");
const { evaluate, SCHEMES } = require("./evaluate");
const { globalMtfStatus, symbolDirection } = require("./direction");
const { simulate, coversExpiry } = require("./fill");
const { costThresholdPips } = require("./sizing");
const { createHistory, REGIME_JA } = require("./histctx");
const { slotNominalMs } = require("./schedule");
const { bAddTimes } = require("./typeb");
const { planDateOf, expiresAtMs } = require("./windows");
const { HR, jstAt, jstDate, jstDow, jstHour, jstIso, addDaysJst } = require("./jst");
const { lastCompletedSessionDate } = require("../../mtf/lib/ny-time");

/**
 * バックテスト（仕様 6-2）。型A・型B × ATR係数（A案0.5／B案1.0）で、過去の各設計時刻にライブと同じ evaluate() で案を作り、
 * fill.js（採点と共通）で到達・SL/TP1先着を判定して集計する。規則: Q25〜Q35（decisions.js。本人が確認済み）と Q09（変更後）。
 * 結果はあくまで『規則を選んだうえでの数字』で、保証ではない。
 *
 * 計画日ごとの出来事（時刻順）[Q09 変更後]:
 *   設計①（NY17:30）…… 型Aのみ      設計②（15:30）…… 型Aのみ（型Bは作らない）
 *   型B追加（毎時 16:00〜21:00）…… 型Bのみ。追加だけで、取消も再設計もしない。同じ日に同じ銘柄・同じ向きの型Bが既にあれば追加しない。
 *       設計③の名目時刻（夏 21:00）は追加ではなく設計③そのもの。冬は 21:00 が追加、設計③は 22:00。時刻の定義は typeb.js（ライブと共通）
 *   設計③（NY8:00）…… 型A・型B     追加された型Bの版は、設計③の再設計の対象（同じ版は継続、違う版・無い版は設計③の時刻に取消し、新しい版が生まれる）
 *
 * SL下限方式（slFloor）: 'reject'=現行（丸め後のSL幅 10pips 未満は不採用）／'widen'=SL=max(係数×ATR, 10pips) に広げて採用。evaluate() の opts と同じ。
 * 障害の定義（obstacle）: 'both'=現行（TP1の障害に日次レベル7本＋H1高値群・安値群の両方）／'forward'=日次レベル7本＋進行方向側の群だけ
 *   （売りは安値群、買いは高値群）。evaluate() の opts と同じ。
 * 2つの軸は掛け合わせて4通りを、同じ入力で別々に計算する（ライブは SL下限 'reject'・障害 'both' のまま）。
 */
const SLOT_LABEL = { 1: "設計①", 2: "設計②", 3: "設計③", 4: "状態更新（型B追加）" };
const DESIGN_SLOTS = [1, 2, 3];
const ADD_SLOT = 4; // 型B追加の版の『設計の回』
// 型B追加の版は、毎時00分の評価から5分後（intraday の完了と生成器の実行の遅れ）に出たものとして追跡する。その時間に始まる足は使えない [Q57]
const ADD_LATENCY_MS = 5 * 60000;
const SLOT_SETUPS = { 1: ["A"], 2: ["A"], 3: ["A", "B"], 4: ["B"] };
const SL_FLOOR_MODES = [
  { id: "reject", code: "a_reject", tag: "(a)", label: "(a) 現行：丸め後のSL幅が10pips未満は不採用" },
  { id: "widen", code: "b_widen", tag: "(b)", label: "(b) SL=max(係数×ATR, 10pips) に広げて採用" },
];
const OBSTACLE_DEFS = [
  { id: "both", code: "a_both", tag: "(a)", label: "(a) 現行：日次レベル7本＋H1高値群・安値群の両方" },
  { id: "forward", code: "b_forward", tag: "(b)", label: "(b) 日次レベル7本＋進行方向側の群だけ（売りは安値群、買いは高値群）" },
];
// 比較する方式 = 障害の定義 × SL下限方式（この並びで records・集計・表に出す。先頭がライブと同じ方式）
const modeKey = (slFloor, obstacle) => `${slFloor}|${obstacle}`;
const BACKTEST_MODES = OBSTACLE_DEFS.flatMap((o) => SL_FLOOR_MODES.map((m) => ({ slFloor: m.id, obstacle: o.id, key: modeKey(m.id, o.id) })));
const BASE_MODE = BACKTEST_MODES[0].key; // SL下限 'reject' × 障害 'both' = ライブ
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

function lowerBound(bars, t) {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}

const keyOf = (c) => {
  const A = c.res.schemes.A, B = c.res.schemes.B;
  return [c.res.symbol, c.res.setup, c.res.side, c.res.band.low, c.res.band.high, A.pass ? A.sl : "-", B.pass ? B.sl : "-"].join("|");
};

function planDates(nowMs, windowDays) {
  const last = addDaysJst(planDateOf(nowMs), -1);
  const out = [];
  for (let k = windowDays - 1; k >= 0; k--) {
    const d = addDaysJst(last, -k);
    const dow = jstDow(jstAt(d, "12:00"));
    if (dow >= 1 && dow <= 5) out.push(d);
  }
  return out;
}

// evaluateImpl は試験用に差し替えられる（既定はライブと同じ evaluate）。呼び出しは evaluateImpl(ctx, setup, { t, slot, slFloor, obstacle })
function runBacktest({ barsByCode, rowsByCode, nowMs, windowDays = 365, thresholds, onProgress = () => {}, evaluateImpl = evaluate, slFloor = "reject", obstacle = "both" }) {
  if (!SL_FLOOR_MODES.some((m) => m.id === slFloor)) throw new Error(`runBacktest: slFloor は 'reject' か 'widen' です（${String(slFloor)}）`);
  if (!OBSTACLE_DEFS.some((o) => o.id === obstacle)) throw new Error(`runBacktest: obstacle は 'both' か 'forward' です（${String(obstacle)}）`);
  const hist = createHistory({ barsByCode, rowsByCode, thresholds });
  const records = [];
  const stats = { designs: 0, adds: 0, evaluations: 0, skipped: {}, incomplete: 0, suppressed: 0, bAdded: 0, bAddDup: 0, dates: 0, first: null, last: null };
  const skip = (why) => { stats.skipped[why] = (stats.skipped[why] || 0) + 1; };

  // 1つの出来事（設計または型B追加）の候補。対象の型だけを評価する
  const evaluateEvent = (ev) => {
    const cands = [];
    for (const pair of PAIRS) {
      for (const setup of ev.setups) {
        const r = hist.ctxAt(pair, ev.t, setup);
        if (r.skip || !r.ctx.daily || !r.ctx.adr) { skip(r.skip || "日次レベル／ADRなし"); continue; }
        const mtfSt = globalMtfStatus(r.ctx.mtfJson, r.meta.asOf);
        const ctx = { ...r.ctx, direction: symbolDirection(r.ctx.mtfJson, pair.code, mtfSt) };
        stats.evaluations++;
        const res = evaluateImpl(ctx, setup, { t: ev.t, slot: ev.slot, slFloor, obstacle });
        if (res.outcome === "candidate") cands.push({ pair, res, meta: r.meta, t: ev.t, slot: ev.slot, ctx });
      }
    }
    if (ev.kind === "design") stats.designs++; else stats.adds++;
    return cands;
  };

  for (const D of planDates(nowMs, windowDays)) {
    const expires = expiresAtMs(D);
    const noon = jstAt(D, "12:00");
    // 出来事を時刻順に並べる。型B追加の時刻のうち設計③の名目時刻と重なるもの（夏 21:00）は設計③そのものなので追加には数えない
    const events = DESIGN_SLOTS.map((slot) => ({ kind: "design", slot, t: slotNominalMs(slot, D, noon), setups: SLOT_SETUPS[slot] }));
    const design3 = events.find((e) => e.slot === 3).t;
    for (const t of bAddTimes(D)) if (t !== design3) events.push({ kind: "add", slot: ADD_SLOT, t, setups: SLOT_SETUPS[ADD_SLOT] });
    events.sort((a, b) => a.t - b.t);
    for (const ev of events) ev.cands = evaluateEvent(ev);

    // 再設計：同じ版（Entry帯・SL）は継続、無くなった版は次の設計時刻で取消 [Q25]。設計①②は型Aだけを評価するが、型Bの版が生まれるのは 16:00 以降なので、この時点で有効な版は型Aだけ。
    // 型B追加は追加だけ（取消さない）。同じ銘柄・同じ向きの型Bの版が既にあれば追加しない（取消済みも含む）[Q09]
    const active = new Map();
    const finished = [];
    const bSeen = new Set(); // 計画日に生まれた型Bの版の (銘柄, 向き)
    const born = (c, t) => { active.set(keyOf(c), { ...c, gen: t, cut: expires }); if (c.res.setup === "B") bSeen.add(`${c.res.symbol}|${c.res.side}`); };
    for (const ev of events) {
      if (ev.kind === "add") {
        for (const c of ev.cands) {
          if (bSeen.has(`${c.res.symbol}|${c.res.side}`)) { stats.bAddDup++; continue; }
          born(c, ev.t + ADD_LATENCY_MS);
          stats.bAdded++;
        }
        continue;
      }
      const keys = new Set(ev.cands.map(keyOf));
      for (const [k, rec] of active) if (!keys.has(k)) { rec.cut = ev.t; finished.push(rec); active.delete(k); }
      for (const c of ev.cands) if (!active.has(keyOf(c))) born(c, ev.t);
    }
    for (const rec of active.values()) finished.push(rec);

    // 同じ基準水準・同じ向き（=同じ取引の考え）の先の版が既に約定していれば、後の版は数えない（二重に建てない）[Q25]
    finished.sort((a, b) => a.gen - b.gen || keyOf(a).localeCompare(keyOf(b)));
    const filledIdea = new Map();
    for (const rec of finished) {
      const { res, pair } = rec;
      const bars = barsByCode[pair.code];
      if (!coversExpiry(bars, D)) { stats.incomplete++; continue; }
      const idea = [res.symbol, res.setup, res.side, res.ref.price].join("|");
      if (filledIdea.has(idea) && filledIdea.get(idea) < rec.gen) { stats.suppressed++; continue; }
      const schemes = {};
      for (const s of SCHEMES) { const x = res.schemes[s.name]; if (x.pass) schemes[s.name] = { sl: x.sl, tp: x.tp }; }
      const i0 = lowerBound(bars, rec.gen);
      const sim = simulate({
        side: res.side, plan_date: D, generated_at_ms: rec.gen,
        entry_low: res.band.low, entry_high: res.band.high, schemes,
      }, bars.slice(i0), { reachUntilMs: rec.cut });
      if (sim.reached === "到達" && !filledIdea.has(idea)) filledIdea.set(idea, sim.reached_at);
      for (const s of SCHEMES) {
        const x = res.schemes[s.name];
        if (!x.pass) continue;
        records.push(recordOf({ rec, res, pair, s, x, sim, D, expires, slFloor, obstacle }));
      }
    }
    stats.dates++;
    if (!stats.first) stats.first = D;
    stats.last = D;
    onProgress(D);
  }
  return { records, stats };
}

// 障害の定義 × SL下限方式の4通りを同じ入力で実行し、記録をまとめる（BACKTEST_MODES の並び）。stats は方式（modeKey）ごと
function runBacktestModes(args) {
  const records = [], statsByMode = {};
  for (const m of BACKTEST_MODES) {
    const r = runBacktest({ ...args, slFloor: m.slFloor, obstacle: m.obstacle });
    records.push(...r.records);
    statsByMode[m.key] = r.stats;
  }
  return { records, statsByMode, stats: statsByMode[BASE_MODE] };
}

// 1案（A案またはB案）の記録。損益はpips（最悪Entryで約定）。コスト込み=往復で 2-2 の下限（1.2／1.6 pips）を引く [Q30]
function recordOf({ rec, res, pair, s, x, sim, D, expires, slFloor, obstacle }) {
  const sgn = res.side === "sell" ? 1 : -1;
  const sc = sim.schemes[s.name];
  const out = {
    sl_floor: slFloor, sl_floored: x.sl_floored === true, obstacle, obstacle_changed: res.obstacle_changed === true, plan_date: D, slot: rec.slot, weekday: jstDow(jstAt(D, "12:00")), setup: res.setup, scheme: s.name, k: s.k, symbol: pair.code, side: res.side,
    ref: res.ref.price, vol: rec.meta.vol, plan_rr: x.rr, sl_pips: x.sl_pips, profit_pips: x.profit_pips,
    reached: sim.reached, reached_ms: sim.reached_at, cancelled_unreached: sim.reached === "未到達" && rec.cut < expires,
  };
  if (sim.reached !== "到達" || !sc) return out;
  const entry = res.worst_entry;
  const gross = (sgn * (entry - sc.exit_price)) / pair.pip;
  const cost = costThresholdPips(pair);
  Object.assign(out, {
    first_hit: sc.first_hit, same_bar: sc.same_bar, gap: sc.gap, fill_hour: jstHour(sim.reached_at),
    exit_ms: sc.hit_at ?? expires, pips_gross: gross, cost_pips: cost, pips_net: gross - cost,
    r_gross: gross / x.sl_pips, r_net: (gross - cost) / x.sl_pips,
    yen_net_1lot: res.pip_value_jpy ? (gross - cost) * res.pip_value_jpy : null,
  });
  return out;
}

// ---- 集計 ----
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sum = (a) => a.reduce((s, v) => s + v, 0);

function maxLossStreak(filled) {
  let best = 0, cur = 0;
  for (const r of [...filled].sort((a, b) => a.exit_ms - b.exit_ms)) { if (r.pips_net < 0) { cur++; best = Math.max(best, cur); } else cur = 0; }
  return best;
}

function metrics(recs) {
  const filled = recs.filter((r) => r.reached === "到達");
  const tp = filled.filter((r) => r.first_hit === "TP1").length;
  const sl = filled.filter((r) => r.first_hit === "SL").length;
  const open = filled.filter((r) => r.first_hit === "未決").length;
  return {
    n: recs.length, reached: filled.length, reach_rate: recs.length ? filled.length / recs.length : null,
    tp1: tp, sl, timeout: open, win_rate: filled.length ? tp / filled.length : null,
    plan_rr_avg: mean(recs.map((r) => r.plan_rr)),
    real_r_gross_avg: mean(filled.map((r) => r.r_gross)), real_r_net_avg: mean(filled.map((r) => r.r_net)),
    pips_gross_sum: sum(filled.map((r) => r.pips_gross)), pips_net_sum: sum(filled.map((r) => r.pips_net)),
    pips_gross_avg: mean(filled.map((r) => r.pips_gross)), pips_net_avg: mean(filled.map((r) => r.pips_net)),
    yen_net_1lot_avg: mean(filled.filter((r) => r.yen_net_1lot !== null).map((r) => r.yen_net_1lot)),
    max_loss_streak: maxLossStreak(filled),
    same_bar: filled.filter((r) => r.same_bar).length, gap: filled.filter((r) => r.gap).length,
    after_expiry: recs.filter((r) => r.reached === "失効後到達").length, cancelled_unreached: recs.filter((r) => r.cancelled_unreached).length,
  };
}

// 軸: [名前, 値を出す関数, 行の並び順（無ければ値の五十音順）]。並び順を決めておくと、表が読みやすく、照合順序（ICU）にも左右されない
const AXES = [
  ["全体", () => "全体"],
  ["銘柄", (r) => r.symbol],
  ["設計の回", (r) => SLOT_LABEL[r.slot], Object.values(SLOT_LABEL)],
  ["設計日の曜日", (r) => WEEKDAY[r.weekday], ["月", "火", "水", "木", "金", "土", "日"]],
  ["ボラ状態", (r) => r.vol, [...REGIME_JA, "不明"]],
  ["売買（参考）", (r) => (r.side === "sell" ? "売り" : "買い"), ["売り", "買い"]],
];

const byOrder = (order) => (a, b) => {
  if (!order) return String(a[0]).localeCompare(String(b[0]), "ja");
  const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
  return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || String(a[0]).localeCompare(String(b[0]), "ja");
};

// 集計の単位は 障害の定義 × SL下限方式 × 型 × ATR係数。records の obstacle（'both'|'forward'）・sl_floor（'reject'|'widen'）で分ける
function aggregate(records) {
  const badFloor = records.find((r) => !SL_FLOOR_MODES.some((m) => m.id === r.sl_floor));
  if (badFloor) throw new Error(`aggregate: 記録の sl_floor が不正です（${String(badFloor.sl_floor)}）`);
  const badObs = records.find((r) => !OBSTACLE_DEFS.some((o) => o.id === r.obstacle));
  if (badObs) throw new Error(`aggregate: 記録の obstacle が不正です（${String(badObs.obstacle)}）`);
  const rows = [];
  for (const mode of BACKTEST_MODES) for (const setup of ["A", "B"]) for (const scheme of ["A", "B"]) {
    const grp = records.filter((r) => r.sl_floor === mode.slFloor && r.obstacle === mode.obstacle && r.setup === setup && r.scheme === scheme);
    const head = { sl_floor: mode.slFloor, obstacle: mode.obstacle, setup, scheme, atr_coef: scheme === "A" ? 0.5 : 1.0 };
    for (const [axis, f, order] of AXES) {
      const by = new Map();
      for (const r of grp) { const v = f(r); if (!by.has(v)) by.set(v, []); by.get(v).push(r); }
      for (const [value, recs] of [...by].sort(byOrder(order))) rows.push({ ...head, axis, value, ...metrics(recs) });
    }
    // 約定後の指標：約定時刻（JST1時間刻み）の表
    const fillBy = new Map();
    for (const r of grp.filter((x) => x.reached === "到達")) { const v = `${String(r.fill_hour).padStart(2, "0")}時台`; if (!fillBy.has(v)) fillBy.set(v, []); fillBy.get(v).push(r); }
    for (const [value, recs] of [...fillBy].sort()) rows.push({ ...head, axis: "約定時刻(JST)", value, ...metrics(recs) });
  }
  return rows;
}

// SL下限方式 (b) の内訳: SLが10pips下限で決まった案（現行の規則なら『SL幅不足』で不採用）と、下限が効かなかった案（(a) と同じ案）を分けた集計。障害の定義 × 型 × ATR係数ごと
function floorBreakdown(records) {
  const rows = [];
  for (const o of OBSTACLE_DEFS) for (const setup of ["A", "B"]) for (const scheme of ["A", "B"]) {
    const grp = records.filter((r) => r.sl_floor === "widen" && r.obstacle === o.id && r.setup === setup && r.scheme === scheme);
    if (!grp.length) continue;
    for (const [value, floored] of [["下限が効かなかった案（SL下限 (a) と同じ案）", false], ["10pips下限で広げた案（SL下限 (a) では不採用）", true]]) {
      rows.push({ obstacle: o.id, setup, scheme, atr_coef: scheme === "A" ? 0.5 : 1.0, value, ...metrics(grp.filter((r) => r.sl_floored === floored)) });
    }
  }
  return rows;
}

// 障害の定義 (b) の内訳: TP1 が変わった案（障害の定義 (a) で置く TP1 と違う案。(a) なら手前に逆側の群などの別の障害があった案）と、変わらなかった案（(a) と同じTP1。障害の価格が違っても丸めた TP1 が同じ案を含む）を分けた集計。SL下限方式 × 型 × ATR係数ごと
function obstacleBreakdown(records) {
  const rows = [];
  for (const m of SL_FLOOR_MODES) for (const setup of ["A", "B"]) for (const scheme of ["A", "B"]) {
    const grp = records.filter((r) => r.obstacle === "forward" && r.sl_floor === m.id && r.setup === setup && r.scheme === scheme);
    if (!grp.length) continue;
    for (const [value, changed] of [["TP1 が変わらなかった案（障害 (a) と同じTP1）", false], ["TP1 が変わった案（障害 (a) とTP1が違う）", true]]) {
      rows.push({ sl_floor: m.id, setup, scheme, atr_coef: scheme === "A" ? 0.5 : 1.0, value, ...metrics(grp.filter((r) => r.obstacle_changed === changed)) });
    }
  }
  return rows;
}

module.exports = { runBacktest, runBacktestModes, aggregate, floorBreakdown, obstacleBreakdown, metrics, planDates, SLOT_LABEL, SL_FLOOR_MODES, OBSTACLE_DEFS, BACKTEST_MODES, BASE_MODE, modeKey, WEEKDAY, AXES, ADD_SLOT };
