"use strict";
const L = require("./log");
const N = require("./num");
const { pairOf } = require("./pairs");
const { simulate, coversUntil } = require("./fill");
const { parseIso, HR } = require("./jst");

/**
 * 案の版の一生（log.csv・shadow-log.csv 共通）と、到達の判定。
 *  版 = 同じ (plan_date, setup, symbol, side, entry_low, entry_high, sl_a, sl_b)。一生 = design／design-b の行から、その後の status の行まで。
 *  同じ版が取消のあとで再び出れば、新しい design の行から新しい一生が始まる。
 *  取消の行（status）のうち、最初の1行が取消の時刻（generated_at）を表す。移行・採点で足す行の generated_at は、書いた時刻なので取消の時刻には使わない。
 */
const CANCEL = "取消(再設計)";
const CANCEL_REACHED = "取消(到達後)";
const isDesignRow = (r) => r.run === "design" || r.run === "design-b";
const isCancelLabel = (v) => v === CANCEL || v === CANCEL_REACHED;
const num = (v) => (v === "" || v === undefined || v === null ? null : Number(v));

// ログの行 → fill.js の simulate に渡す案。generated_at は設計の行のもの（status の行は書いた時刻に置き換わっているので使わない）
function candFromRow(row) {
  const sch = {};
  if (row.sl_a !== "" && row.tp_a !== "") sch.A = { sl: num(row.sl_a), tp: num(row.tp_a) };
  if (row.sl_b !== "" && row.tp_b !== "") sch.B = { sl: num(row.sl_b), tp: num(row.tp_b) };
  return {
    side: row.side, plan_date: row.plan_date, generated_at_ms: parseIso(row.generated_at),
    entry_low: num(row.entry_low), entry_high: num(row.entry_high), schemes: sch,
  };
}

// 行を古い順に見て、版の一生を作る（status の行だけで design の行が無いものは無視する）。variant の行だけを見る（既定は log.csv＝variant なし）[Q85]
function livesOf(allRows, variant = null) {
  const lives = [];
  const current = new Map();
  for (const r of L.forVariant(allRows, variant)) {
    const k = L.keyOf(r);
    if (isDesignRow(r)) { const life = { key: k, design: r, status: [], last: r }; lives.push(life); current.set(k, life); }
    else { const life = current.get(k); if (life) { life.status.push(r); life.last = r; } }
  }
  return lives;
}
// 版ごとの最後の一生
function lastLifeByKey(rows, variant = null) {
  const m = new Map();
  for (const life of livesOf(rows, variant)) m.set(life.key, life);
  return m;
}
// 一生の取消の時刻（最初の status の行が取消のときだけ）。無ければ NaN
const cancelMsOf = (life) => (life.status[0] && isCancelLabel(life.status[0].reached) ? parseIso(life.status[0].generated_at) : NaN);

/**
 * 取消の時刻までに到達していたか（H1 足。fill.js の simulate を reachUntilMs＝取消の時刻で呼ぶ。バックテストの Q25 と同じ）。
 * 返り値: { reached, reached_at(ms), known, sim }。known=false は『到達していない』と確定できない（H1 足が設計時刻まで遡って届いていない、または
 * 取消の時刻までの足がまだ届いていない）。到達していれば、足が足りなくても reached=true・known=true（到達は後から取り消されない）。
 * intraday.json の state.reached_at は使わない（H1 で届いているのに空欄になることがあるため）。
 */
function judgeCancel({ designRow, bars, cancelMs }) {
  const cand = candFromRow(designRow);
  const b = Array.isArray(bars) ? bars : [];
  if (!Number.isFinite(cand.generated_at_ms) || !Number.isFinite(cand.entry_low) || !Number.isFinite(cand.entry_high) || !Number.isFinite(cancelMs)) {
    return { reached: false, reached_at: null, known: false, sim: null };
  }
  const sim = simulate(cand, b, { reachUntilMs: cancelMs });
  if (sim.reached === "到達") return { reached: true, reached_at: sim.reached_at, known: true, sim };
  const known = b.length > 0 && b[0].t <= cand.generated_at_ms + HR && coversUntil(b, cancelMs);
  return { reached: false, reached_at: null, known, sim };
}

// ---- 同じ水準 ----
// 基準水準 = 売りは Entry 帯の下端、買いは上端。価格の丸めの単位（5ティック＝0.5pip。N.ROUND_UNIT_TICKS）に丸めて比べる [Q80]
function levelKey({ plan_date, setup, symbol, side, level }) {
  const pair = pairOf(symbol);
  if (!pair || !Number.isFinite(level)) return null;
  return [plan_date, setup, symbol, side, Math.round(N.toTicks(level, pair) / N.ROUND_UNIT_TICKS)].join("|");
}
const ideaKeyOfRow = (r) => levelKey({ plan_date: r.plan_date, setup: r.setup, symbol: r.symbol, side: r.side, level: Number(r.side === "sell" ? r.entry_low : r.entry_high) });
const ideaKeyOfCand = (c) => levelKey({ plan_date: c.plan_date, setup: c.setup, symbol: c.symbol, side: c.side, level: c.side === "sell" ? c.band.low : c.band.high });

/**
 * その計画日に、すでに到達している（到達／取消(到達後)）基準水準の一覧。ライブ（log.csv）と並行記録（shadow-log.csv の variant ごと）で、それぞれの行から独立に作る。
 *  到達の判定: 一生の最後の行が 取消(到達後)・到達 なら到達済み。取消(再設計) は H1 足で取消の時刻まで判定し直す（取消の時に足が届いていなかった分）。
 *  まだ有効な版（最後の行が design／design-b）は、いまの H1 足で判定する。
 * openKeys = いま有効な版の鍵。同じ版が続くだけの候補（鍵が同じ）は『出し直し』ではないので、抑えない [Q79]。
 */
function reachedIdeas({ rows, planDate, barsByCode, nowMs, variant = null }) {
  const ideas = new Set();
  const openKeys = new Set();
  void nowMs;
  for (const life of livesOf(rows, variant)) {
    const d = life.design;
    if (d.plan_date !== planDate) continue;
    const idea = ideaKeyOfRow(d);
    if (!idea) continue;
    const last = life.last;
    const bars = barsByCode?.[d.symbol] || [];
    if (isDesignRow(last)) {
      openKeys.add(life.key);
      const cand = candFromRow(d);
      if (Number.isFinite(cand.generated_at_ms) && simulate(cand, bars).reached === "到達") ideas.add(idea);
    } else if (last.reached === CANCEL_REACHED || last.reached === "到達") ideas.add(idea);
    else if (life.status[0]?.reached === CANCEL) {
      const j = judgeCancel({ designRow: d, bars, cancelMs: cancelMsOf(life) });
      if (j.reached) ideas.add(idea);
    }
  }
  // 候補を抑えるか。cand は toCandidate の結果（plan_date・setup・symbol・side・band）、keyOfCand は版の鍵
  const suppresses = (cand, versionKey) => ideas.has(ideaKeyOfCand(cand)) && !openKeys.has(versionKey);
  return { ideas, openKeys, suppresses };
}

module.exports = { CANCEL, CANCEL_REACHED, isDesignRow, isCancelLabel, candFromRow, livesOf, lastLifeByKey, cancelMsOf, judgeCancel, levelKey, ideaKeyOfRow, ideaKeyOfCand, reachedIdeas };
