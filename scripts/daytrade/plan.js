"use strict";
const { PAIRS, pairOf } = require("./pairs");
const { atrWilder } = require("./indicators");
const { h1Groups } = require("./levels");
const { tokyoRange } = require("./tokyo");
const { evaluate, COUNTED, REASONS, SCHEMES } = require("./evaluate");
const { globalMtfStatus, symbolDirection } = require("./direction");
const { calendarStatus, stopWindows, activeStops } = require("./events");
const { volatilityOf } = require("./riskfeed");
const { simulate } = require("./fill");
const { planDateOf, expiresAtMs, noNewEntryReason } = require("./windows");
const { jstIso, MIN } = require("./jst");
const { provisionalIds } = require("./decisions");
const { previousDaySummary } = require("./score");
const L = require("./log");
const N = require("./num");

/**
 * 計画の組み立て（仕様 2〜5節・7節）。
 *   buildDesign … 門→型A・型B で案を作る（Entry・SL・TP を決める）。前の案との差で『取消（再設計）』を出す
 *   buildStatus … Entry・SL・TP は変えず、距離・ADR消化・鮮度・到達／失効・停止中の印だけ更新する
 * 候補数に上限は設けない。判定文は出さない（数字と状態だけ）。
 */
const SCHEMA_VERSION = 1;

const fmt = (v, pair) => (Number.isFinite(v) ? v.toFixed(pair.digits) : "");
const pipsOf = (v, pair) => (Number.isFinite(v) ? Number((v / pair.pip).toFixed(1)) : null);

function ratesOf(raw) {
  const p = (c) => raw.intraday?.pairs?.[c]?.price;
  return { USDJPY: p("USDJPY"), USDCAD: p("USDCAD"), USDCHF: p("USDCHF"), GBPUSD: p("GBPUSD") };
}

function buildCtx(pair, inputs, planDate, setup, mtfStatus) {
  const raw = inputs.raw;
  const p = raw.intraday?.pairs?.[pair.code];
  const bars = inputs.h1[pair.code] || [];
  const atr = atrWilder(bars);
  return {
    pair, price: p?.price, atr: atr ?? NaN,
    adr: p && Number.isFinite(p.adr_used_pct) && Number.isFinite(p.adr_remaining) ? { used_pct: p.adr_used_pct, remaining: p.adr_remaining } : null,
    daily: inputs.freshness.daily.ok ? raw.daily.pairs?.[pair.code] ?? null : null,
    groups: atr ? h1Groups(bars, atr) : { highs: [], lows: [] },
    direction: symbolDirection(raw.mtf, pair.code, mtfStatus),
    tokyo: setup === "B" ? tokyoRange(bars, planDate) : null,
    rates: ratesOf(raw), accounts: inputs.accounts, riskPct: inputs.riskPct,
  };
}

// 新規を出せる状態か（時間帯のルール＋イベント停止）。reasons が空なら『新規可』
function entryStateOf(nowMs, planDate, stops) {
  const reasons = [];
  const t = noNewEntryReason(nowMs, planDate);
  if (t) reasons.push(t);
  const act = stops.filter((w) => nowMs >= w.start && nowMs <= w.end);
  for (const w of act) reasons.push(`停止中: ${w.time_jst ?? ""} [${w.currency}] ${w.event}`);
  return { ok: reasons.length === 0, reasons };
}

function schemeOut(s, pair) {
  const out = { pass: s.pass, reason: s.reason ?? null, reason_text: s.reason ? REASONS[s.reason] : null, k: s.k };
  if (Number.isFinite(s.sl)) Object.assign(out, { sl: s.sl, sl_pips: Number(s.sl_pips.toFixed(1)) });
  if (Number.isFinite(s.tp)) {
    Object.assign(out, {
      tp1: s.tp, profit_pips: Number(s.profit_pips.toFixed(1)), rr: Number.isFinite(s.rr) ? Number(s.rr.toFixed(2)) : null,
      cost_cap_pips: Number(s.cost_cap_pips.toFixed(2)), cost_threshold_pips: s.cost_threshold_pips,
    });
  }
  out.lots = s.lots;
  return out;
}

function toCandidate(res, pair, { planDate, nowMs, slot, calOk, windows }) {
  const side = res.side;
  const schemes = {};
  for (const s of SCHEMES) schemes[s.name] = schemeOut(res.schemes[s.name], pair);
  const es = entryStateOf(nowMs, planDate, windows);
  return {
    id: `${planDate}:${res.setup}:${pair.code}:${side}`,
    plan_date: planDate, setup: res.setup, symbol: pair.code, side,
    strength: res.strength, alignment: res.alignment, dirs: res.dirs, note: pair.note,
    ref: res.ref, band: res.band, worst_entry: res.worst_entry, price: res.price,
    distance_pips: Number(res.distance_pips.toFixed(1)), atr_pips: Number(res.atr_pips.toFixed(1)),
    adr_used_pct: res.adr_used_pct, adr_remaining_pips: Number(res.adr_remaining_pips.toFixed(1)),
    obstacle: res.obstacle, pip_value_jpy: res.pip_value_jpy === null ? null : Math.round(res.pip_value_jpy),
    schemes,
    confirm: res.setup === "A" ? `帯に到達したあと、M15が基準価格（${fmt(res.ref.price, pair)}）より${side === "sell" ? "下で陰線" : "上で陽線"}確定` : null,
    generated_at: jstIso(nowMs), design_slot: slot, expires_at: jstIso(expiresAtMs(planDate)),
    entry_state: es, stops: windows.map((w) => ({ time_jst: w.time_jst, currency: w.currency, impact: w.impact, event: w.event, start: jstIso(w.start), end: jstIso(w.end) })),
    calendar_ok: calOk,
    state: { reached: "未到達", reached_at: null, expired: false, price_in_band: false },
  };
}

// 同方向の印 [Q16]: 通貨×向きのキーで2件以上になるものを『|』区切りで全部付ける（落とさない）
function markSameDirection(cands, pairCurrencies) {
  const keysOf = (c) => {
    const cur = pairCurrencies?.[c.symbol] || [];
    const sgn = c.side === "buy" ? 1 : -1; // 買い=ベース買い・クォート売り
    const legs = [];
    if (cur.length === 2) { legs.push([cur[0], sgn], [cur[1], -sgn]); }
    else if (cur.length === 1) legs.push([cur[0], -sgn]); // XAUUSD: USD脚のみ（買い=USD売り）
    return legs.map(([ccy, s]) => `${ccy}${s > 0 ? "買い" : "売り"}`);
  };
  const count = new Map();
  for (const c of cands) for (const k of keysOf(c)) count.set(k, (count.get(k) || 0) + 1);
  for (const c of cands) {
    const ks = keysOf(c).filter((k) => count.get(k) >= 2).sort();
    c.same_direction_group = ks.join("|");
  }
}

// 順位 [Q17]: 方向の強さ → 銘柄の優先 → RR（通っている案のうち小さい方）の高い順。同点は銘柄名 → 型A → 型B
function rankCandidates(cands) {
  const rrOf = (c) => {
    const v = Object.values(c.schemes).filter((s) => s.pass && Number.isFinite(s.rr)).map((s) => s.rr);
    return v.length ? Math.min(...v) : -Infinity;
  };
  const prio = (c) => pairOf(c.symbol).priority;
  cands.sort((a, b) => b.strength - a.strength || prio(a) - prio(b) || rrOf(b) - rrOf(a) || a.symbol.localeCompare(b.symbol) || a.setup.localeCompare(b.setup));
  cands.forEach((c, i) => { c.rank = i + 1; });
}

function summarize(results) {
  const rejections = Object.fromEntries(COUNTED.map((k) => [k, 0]));
  const extra = { no_reference: 0, no_obstacle: 0, no_data: 0 };
  const watch = new Map(), noBasis = new Map(), notFormed = [];
  let rows = 0; const pass = { A: 0, B: 0 };
  for (const r of results) {
    if (r.outcome === "not_formed") { notFormed.push({ symbol: r.symbol, setup: r.setup, detail: r.detail }); continue; }
    if (r.outcome === "candidate") rows += 1;
    for (const s of SCHEMES) {
      const sc = r.schemes[s.name];
      if (!sc) continue;
      if (sc.pass) { pass[s.name] += 1; continue; }
      if (rejections[sc.reason] !== undefined) rejections[sc.reason] += 1;
      else if (extra[sc.reason] !== undefined) extra[sc.reason] += 1;
    }
    if (r.setup === "A" && r.symbolReason === "no_direction") {
      (r.outcome === "watch" ? watch : noBasis).set(r.symbol, r.detail);
    }
  }
  return {
    candidate_rows: rows, scheme_pass: pass, rejections, rejections_text: Object.fromEntries(COUNTED.map((k) => [REASONS[k], rejections[k]])),
    extra: { 基準水準なし: extra.no_reference, 障害なし: extra.no_obstacle, 入力欠落: extra.no_data },
    unit: "案（型×銘柄×A/B案）。1案につき最初に当たった理由1つ", watch_only: [...watch].map(([symbol, detail]) => ({ symbol, detail })),
    no_basis: [...noBasis].map(([symbol, detail]) => ({ symbol, detail })), not_formed: notFormed,
  };
}

// 銘柄ごとの方向（表示用）と、その日の停止時間（カレンダーが使えるときだけ）
function directionsOf(inputs, mtfSt) {
  const out = {};
  for (const pair of PAIRS) {
    const d = symbolDirection(inputs.raw.mtf, pair.code, mtfSt);
    out[pair.code] = d.ok ? { kind: "ok", side: d.side, strength: d.strength, alignment: d.alignment, dirs: d.dirs }
      : { kind: d.kind, reason: d.reason, alignment: d.alignment ?? null, dirs: d.dirs ?? null };
  }
  return out;
}
function stopWindowsOf(inputs, calSt) {
  const pairCur = inputs.rules?.pair_currencies || {};
  const out = {};
  for (const pair of PAIRS) {
    out[pair.code] = stopWindows(inputs.raw.calendar, pairCur[pair.code], calSt).map((w) => ({
      time_jst: w.time_jst, currency: w.currency, impact: w.impact, event: w.event, start: jstIso(w.start), end: jstIso(w.end),
    }));
  }
  return out;
}

function baseHeader(inputs, nowMs, calSt, mtfSt) {
  const banners = [];
  if (inputs.freshness.stale) {
    const which = inputs.freshness.feeds.filter((f) => f.stale).map((f) => `${f.name}${f.age_min === null ? "(読めない)" : `(${f.age_min}分前)`}`).join("・");
    banners.push(`発注不可（鮮度超過）: ${which}`);
  }
  if (!inputs.freshness.daily.ok) banners.push(`日次レベル未更新: ${inputs.freshness.daily.reason}`);
  if (!mtfSt.ok) banners.push(`方向根拠なし: ${mtfSt.reason}`);
  if (!calSt.ok) banners.push(`イベント未取得: ${calSt.reason}（停止時間なしで生成）`);
  return banners;
}

function referenceBlock(inputs, riskFeed) {
  const gate = {};
  for (const p of PAIRS) gate[p.code] = inputs.raw.ctx?.pairs?.[p.code]?.gate?.state ?? null;
  const vol = {};
  for (const p of PAIRS) vol[p.code] = volatilityOf(riskFeed, p.code);
  return {
    existing_gate: { as_of: inputs.raw.ctx?.as_of ?? null, note: "参考：既存ゲート（daytrade.js）。停止判定には使わない。生成時点のスナップショット", states: gate },
    volatility: { risk_feed: { status: riskFeed?.status ?? "未取得", reason: riskFeed?.reason ?? null, generated_intraday: riskFeed?.generated_intraday ?? null, age_min: riskFeed?.age_min ?? null }, pairs: vol },
  };
}

function buildDesign({ inputs, riskFeed, nowMs, slot, prevPlan, logRows }) {
  const planDate = planDateOf(nowMs);
  const mtfSt = globalMtfStatus(inputs.raw.mtf, inputs.expectedSession);
  const calSt = calendarStatus(inputs.raw.calendar, nowMs);
  const pairCur = inputs.rules?.pair_currencies || {};
  const setups = slot === 1 ? ["A"] : ["A", "B"];
  const results = [];
  const cands = [];
  for (const pair of PAIRS) {
    const windows = stopWindows(inputs.raw.calendar, pairCur[pair.code], calSt);
    for (const setup of setups) {
      let res;
      if (!inputs.freshness.daily.ok || !inputs.raw.intraday?.pairs?.[pair.code]) {
        res = {
          setup, symbol: pair.code, side: null, outcome: setup === "A" ? "rejected" : "not_formed", symbolReason: "no_data",
          detail: inputs.freshness.daily.ok ? "intraday.json に銘柄がありません" : inputs.freshness.daily.reason,
          schemes: setup === "A" ? Object.fromEntries(SCHEMES.map((s) => [s.name, { name: s.name, pass: false, reason: "no_data" }])) : {},
        };
      } else res = evaluate(buildCtx(pair, inputs, planDate, setup, mtfSt), setup);
      results.push(res);
      if (res.outcome === "candidate") cands.push(toCandidate(res, pair, { planDate, nowMs, slot, calOk: calSt.ok, windows }));
    }
  }
  markSameDirection(cands, pairCur);
  rankCandidates(cands);

  const rows = L.readLogLike(logRows);
  const plan = {
    schema_version: SCHEMA_VERSION,
    provisional: { open_questions: provisionalIds(), note: "仕様 v1.1 が沈黙・矛盾している点を、暫定の読みで処理しています（docs/daytrade-plan-impl-notes.md）" },
    plan_date: planDate, run: "design", design_slot: slot, generated_at: jstIso(nowMs), status_updated_at: jstIso(nowMs),
    expires_at: jstIso(expiresAtMs(planDate)),
    order_ok: !inputs.freshness.stale && inputs.freshness.daily.ok && mtfSt.ok,
    banners: baseHeader(inputs, nowMs, calSt, mtfSt),
    freshness: inputs.freshness,
    events: { status: calSt.ok ? "ok" : "イベント未取得", reason: calSt.reason, note: "カレンダーは当日（JST）分のみ。翌日0:00〜3:00のイベントは未取得で、日付が変わった後の状態更新で拾う" },
    mtf: { ok: mtfSt.ok, reason: mtfSt.reason, status: inputs.raw.mtf?.status ?? null, data_base_date: inputs.raw.mtf?.data_base_date ?? null, expected_session: inputs.expectedSession },
    directions: directionsOf(inputs, mtfSt),
    stop_windows: stopWindowsOf(inputs, calSt),
    candidates: cands,
    summary: summarize(results),
    reference: referenceBlock(inputs, riskFeed),
    previous_day: previousDaySummary(rows, planDate),
    inputs_problems: inputs.problems,
  };
  const logAppend = designLogRows(plan, prevPlan, rows, nowMs);
  return { plan, logAppend };
}

// log.csv の行（設計の案ごと）。版（値）が既にあれば追記しない。前の設計にあって今回消えた版は『取消（再設計）』を追記 [Q18]
function candRow(c, run, generatedIso) {
  const pair = pairOf(c.symbol);
  const A = c.schemes.A, B = c.schemes.B;
  const a = A?.pass ? A : null, b = B?.pass ? B : null;
  const lot = (s, acct) => (s && s.lots && s.lots[acct] !== null && s.lots[acct] !== undefined ? s.lots[acct].toFixed(2) : "");
  return {
    plan_date: c.plan_date, generated_at: generatedIso, run, setup: c.setup, symbol: c.symbol, side: c.side,
    same_direction_group: c.same_direction_group || "",
    entry_low: fmt(c.band.low, pair), entry_high: fmt(c.band.high, pair),
    sl_a: a ? fmt(a.sl, pair) : "", tp_a: a ? fmt(a.tp1, pair) : "", sl_b: b ? fmt(b.sl, pair) : "", tp_b: b ? fmt(b.tp1, pair) : "",
    rr_a: a ? String(a.rr) : "", rr_b: b ? String(b.rr) : "", cost_cap_a: a ? String(a.cost_cap_pips) : "",
    lot_cap_a_701620: lot(a, "701620"), lot_cap_b_701620: lot(b, "701620"), lot_cap_a_702449: lot(a, "702449"), lot_cap_b_702449: lot(b, "702449"),
    expires_at: c.expires_at, reached: "", reached_at: "", first_hit_a: "", first_hit_b: "", filled_ticket_701620: "", filled_ticket_702449: "",
  };
}

function designLogRows(plan, prevPlan, rows, nowMs) {
  const latest = L.latestByKey(rows);
  const out = [];
  const newKeys = new Set();
  for (const c of plan.candidates) {
    const row = candRow(c, "design", plan.generated_at);
    const key = L.keyOf(row);
    newKeys.add(key);
    if (!latest.has(key)) out.push(row);
  }
  if (prevPlan && prevPlan.plan_date === plan.plan_date && Array.isArray(prevPlan.candidates)) {
    for (const pc of prevPlan.candidates) {
      const pr = candRow(pc, "design", pc.generated_at);
      const key = L.keyOf(pr);
      if (newKeys.has(key)) continue; // 同じ版が続く
      const last = latest.get(key) || pr;
      if (last.run === "status") continue; // 既に取消・採点済み
      out.push({
        ...last, run: "status", generated_at: plan.generated_at,
        reached: "取消(再設計)", reached_at: pc.state?.reached_at || "",
      });
    }
  }
  return out;
}

// ---- 状態更新 ----
function buildStatus({ inputs, riskFeed, nowMs, prevPlan, logRows }) {
  const planDate = planDateOf(nowMs);
  const mtfSt = globalMtfStatus(inputs.raw.mtf, inputs.expectedSession);
  const calSt = calendarStatus(inputs.raw.calendar, nowMs);
  const pairCur = inputs.rules?.pair_currencies || {};
  const rows = L.readLogLike(logRows);
  const header = {
    schema_version: SCHEMA_VERSION,
    provisional: { open_questions: provisionalIds(), note: "仕様 v1.1 が沈黙・矛盾している点を、暫定の読みで処理しています（docs/daytrade-plan-impl-notes.md）" },
    plan_date: planDate, run: "status", status_updated_at: jstIso(nowMs), expires_at: jstIso(expiresAtMs(planDate)),
    freshness: inputs.freshness,
    events: { status: calSt.ok ? "ok" : "イベント未取得", reason: calSt.reason, note: "カレンダーは当日（JST）分のみ。翌日0:00〜3:00のイベントは未取得で、日付が変わった後の状態更新で拾う" },
    mtf: { ok: mtfSt.ok, reason: mtfSt.reason, status: inputs.raw.mtf?.status ?? null, data_base_date: inputs.raw.mtf?.data_base_date ?? null, expected_session: inputs.expectedSession },
    directions: directionsOf(inputs, mtfSt),
    stop_windows: stopWindowsOf(inputs, calSt),
    reference: referenceBlock(inputs, riskFeed),
    previous_day: previousDaySummary(rows, planDate),
    inputs_problems: inputs.problems,
  };
  // 今日の設計が無い（全枠が抜けた・設計①の前・失効後）[W9]
  if (!prevPlan || prevPlan.plan_date !== planDate || !Array.isArray(prevPlan.candidates)) {
    const banners = baseHeader(inputs, nowMs, calSt, mtfSt);
    banners.unshift(`設計なし（計画日 ${planDate} の設計がまだありません）`);
    return { plan: { ...header, design_slot: null, generated_at: null, order_ok: false, banners, candidates: [], summary: null, design_missing: true } };
  }
  const cands = prevPlan.candidates.map((c) => updateCandidate(c, inputs, nowMs, planDate, pairCur, calSt));
  const banners = baseHeader(inputs, nowMs, calSt, mtfSt);
  return {
    plan: {
      ...header, design_slot: prevPlan.design_slot, generated_at: prevPlan.generated_at,
      order_ok: !inputs.freshness.stale && inputs.freshness.daily.ok && mtfSt.ok, banners,
      candidates: cands, summary: prevPlan.summary, design_missing: false,
    },
  };
}

// Entry・SL・TP は変えない。距離・ADR消化・到達／失効・新規可否・停止中だけ更新
function updateCandidate(c, inputs, nowMs, planDate, pairCur, calSt) {
  const pair = pairOf(c.symbol);
  const p = inputs.raw.intraday?.pairs?.[c.symbol];
  const bars = inputs.h1[c.symbol] || [];
  const windows = stopWindows(inputs.raw.calendar, pairCur[c.symbol], calSt);
  const sim = simulate({
    side: c.side, plan_date: planDate, generated_at_ms: Date.parse(c.generated_at),
    entry_low: c.band.low, entry_high: c.band.high, schemes: {},
  }, bars);
  const price = Number.isFinite(p?.price) ? p.price : c.price;
  const inBand = Number.isFinite(price) && N.gte(price, c.band.low) && N.lte(price, c.band.high);
  const expired = nowMs >= expiresAtMs(planDate);
  const es = entryStateOf(nowMs, planDate, windows);
  return {
    ...c, price, distance_pips: Number.isFinite(price) ? Number((Math.abs(c.worst_entry - price) / pair.pip).toFixed(1)) : c.distance_pips,
    adr_used_pct: Number.isFinite(p?.adr_used_pct) ? p.adr_used_pct : c.adr_used_pct,
    adr_remaining_pips: Number.isFinite(p?.adr_remaining) ? Number((p.adr_remaining / pair.pip).toFixed(1)) : c.adr_remaining_pips,
    entry_state: es,
    stops: windows.map((w) => ({ time_jst: w.time_jst, currency: w.currency, impact: w.impact, event: w.event, start: jstIso(w.start), end: jstIso(w.end) })),
    calendar_ok: calSt.ok,
    state: { reached: sim.reached, reached_at: sim.reached_at ? jstIso(sim.reached_at) : null, expired, price_in_band: inBand },
  };
}

module.exports = { SCHEMA_VERSION, buildDesign, buildStatus, buildCtx, toCandidate, candRow, markSameDirection, rankCandidates, summarize, entryStateOf, pipsOf };
