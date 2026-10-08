"use strict";
const { PAIRS } = require("./pairs");
const { evaluate, SCHEMES } = require("./evaluate");
const { globalMtfStatus, symbolDirection } = require("./direction");
const { simulate, coversExpiry } = require("./fill");
const { costThresholdPips } = require("./sizing");
const { createHistory } = require("./histctx");
const { slotNominalMs } = require("./schedule");
const { planDateOf, expiresAtMs } = require("./windows");
const { HR, jstAt, jstDate, jstDow, jstHour, jstIso, addDaysJst } = require("./jst");
const { lastCompletedSessionDate } = require("../../mtf/lib/ny-time");

/**
 * バックテスト（仕様 6-2）。型A・型B × ATR係数（A案0.5／B案1.0）で、過去の各設計時刻（平日の設計①②③）に
 * ライブと同じ evaluate() で案を作り、fill.js（採点と共通）で到達・SL/TP1先着を判定して集計する。
 * 仮置きの規則: Q25〜Q35（decisions.js）。結果はあくまで『規則を選んだうえでの数字』で、保証ではない。
 */
const SLOT_LABEL = { 1: "設計①", 2: "設計②", 3: "設計③" };
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

// evaluateImpl は試験用に差し替えられる（既定はライブと同じ evaluate）
function runBacktest({ barsByCode, rowsByCode, nowMs, windowDays = 365, thresholds, onProgress = () => {}, evaluateImpl = evaluate }) {
  const hist = createHistory({ barsByCode, rowsByCode, thresholds });
  const records = [];
  const stats = { designs: 0, evaluations: 0, skipped: {}, incomplete: 0, suppressed: 0, dates: 0, first: null, last: null };
  const skip = (why) => { stats.skipped[why] = (stats.skipped[why] || 0) + 1; };

  for (const D of planDates(nowMs, windowDays)) {
    const expires = expiresAtMs(D);
    const noon = jstAt(D, "12:00");
    const events = [];
    for (const slot of [1, 2, 3]) {
      const t = slotNominalMs(slot, D, noon);
      const cands = [];
      const setups = slot === 1 ? ["A"] : ["A", "B"];
      for (const pair of PAIRS) {
        for (const setup of setups) {
          const r = hist.ctxAt(pair, t, setup);
          if (r.skip || !r.ctx.daily || !r.ctx.adr) { skip(r.skip || "日次レベル／ADRなし"); continue; }
          const mtfSt = globalMtfStatus(r.ctx.mtfJson, r.meta.asOf);
          const ctx = { ...r.ctx, direction: symbolDirection(r.ctx.mtfJson, pair.code, mtfSt) };
          stats.evaluations++;
          const res = evaluateImpl(ctx, setup, { t, slot });
          if (res.outcome === "candidate") cands.push({ pair, res, meta: r.meta, t, slot, ctx });
        }
      }
      stats.designs++;
      events.push({ slot, t, cands });
    }

    // 再設計：同じ版（Entry帯・SL）は継続、無くなった版は次の設計時刻で取消 [Q25]
    const active = new Map();
    const finished = [];
    for (const ev of events) {
      const keys = new Set(ev.cands.map(keyOf));
      for (const [k, rec] of active) if (!keys.has(k)) { rec.cut = ev.t; finished.push(rec); active.delete(k); }
      for (const c of ev.cands) { const k = keyOf(c); if (!active.has(k)) active.set(k, { ...c, gen: ev.t, cut: expires }); }
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
        records.push(recordOf({ rec, res, pair, s, x, sim, D, expires }));
      }
    }
    stats.dates++;
    if (!stats.first) stats.first = D;
    stats.last = D;
    onProgress(D);
  }
  return { records, stats };
}

// 1案（A案またはB案）の記録。損益はpips（最悪Entryで約定）。コスト込み=往復で 2-2 の下限（1.2／1.6 pips）を引く [Q30]
function recordOf({ rec, res, pair, s, x, sim, D, expires }) {
  const sgn = res.side === "sell" ? 1 : -1;
  const sc = sim.schemes[s.name];
  const out = {
    plan_date: D, slot: rec.slot, weekday: jstDow(jstAt(D, "12:00")), setup: res.setup, scheme: s.name, k: s.k, symbol: pair.code, side: res.side,
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

const AXES = [
  ["全体", () => "全体"],
  ["銘柄", (r) => r.symbol],
  ["設計の回", (r) => SLOT_LABEL[r.slot]],
  ["設計日の曜日", (r) => WEEKDAY[r.weekday]],
  ["ボラ状態", (r) => r.vol],
  ["売買（参考）", (r) => (r.side === "sell" ? "売り" : "買い")],
];

function aggregate(records) {
  const rows = [];
  for (const setup of ["A", "B"]) for (const scheme of ["A", "B"]) {
    const grp = records.filter((r) => r.setup === setup && r.scheme === scheme);
    for (const [axis, f] of AXES) {
      const by = new Map();
      for (const r of grp) { const v = f(r); if (!by.has(v)) by.set(v, []); by.get(v).push(r); }
      for (const [value, recs] of [...by].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "ja"))) rows.push({ setup, scheme, atr_coef: scheme === "A" ? 0.5 : 1.0, axis, value, ...metrics(recs) });
    }
    // 約定後の指標：約定時刻（JST1時間刻み）の表
    const fillBy = new Map();
    for (const r of grp.filter((x) => x.reached === "到達")) { const v = `${String(r.fill_hour).padStart(2, "0")}時台`; if (!fillBy.has(v)) fillBy.set(v, []); fillBy.get(v).push(r); }
    for (const [value, recs] of [...fillBy].sort()) rows.push({ setup, scheme, atr_coef: scheme === "A" ? 0.5 : 1.0, axis: "約定時刻(JST)", value, ...metrics(recs) });
  }
  return rows;
}

module.exports = { runBacktest, aggregate, metrics, planDates, SLOT_LABEL, WEEKDAY, AXES };
