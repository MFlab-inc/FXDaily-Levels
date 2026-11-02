"use strict";
const { jstIso } = require("./jst");
const { expiresAtMs } = require("./windows");
const { simulate, coversExpiry } = require("./fill");
const L = require("./log");
const { pairOf } = require("./pairs");

/**
 * 採点（仕様 6-1）。06:30 の設計①の前に daytrade-score.js が動かす。
 *  対象 [Q21]: 有効期限（翌3:00）を過ぎて、まだ採点も取消もされていないすべての案（金曜の案は月曜に採点される）。
 *  必要な H1 足が有効期限まで届いていないときは採点を保留し、『未到達』と確定させない（次の実行で再試行）。
 *  判定は fill.js（バックテストと共通）。結果は run=status の新しい行として追記（旧行は変えない）[Q18]。
 *  イベント停止は、過去のカレンダーが無いので採点には反映しない。
 */
const N = require("./num");
const V = require("./versions");
const { candFromRow } = V;

// 採点の行に入れる案ごとの損益（週次の集計用。log.csv の PNL_COLUMNS）。最悪Entry（売り=帯の下端、買い=帯の上端）を基準に、コスト0。
// exit=決済の価格（未決は有効期限の直前の足の終値。fill.js の exit_price と同じ）、pips=損益、r=pips÷SL幅。円の金額は書かない。案が無い（その案が通っていない）列は空
const fixed = (v, d) => { const t = v.toFixed(d); return /^-0(\.0+)?$/.test(t) ? t.slice(1) : t; };
function pnlColumns(row, sim) {
  const pair = pairOf(row.symbol);
  const out = {};
  if (!pair || !sim) return out;
  const sell = row.side === "sell";
  const entry = Number(sell ? row.entry_low : row.entry_high);
  if (!Number.isFinite(entry)) return out;
  const tpp = N.ticksPerPip(pair);
  const entryT = Math.round(N.toTicks(entry, pair));
  for (const name of ["a", "b"]) {
    const sc = sim.schemes[name.toUpperCase()];
    const sl = Number(row[`sl_${name}`]);
    if (!sc || !Number.isFinite(sc.exit_price) || !Number.isFinite(sl)) continue;
    const exitT = Math.round(N.toTicks(sc.exit_price, pair));
    const pips = ((sell ? 1 : -1) * (entryT - exitT)) / tpp;
    const slPips = Math.abs(entryT - Math.round(N.toTicks(sl, pair))) / tpp;
    out[`exit_${name}`] = N.fromTicks(exitT, pair).toFixed(pair.digits);
    out[`pips_${name}`] = fixed(pips, 1);
    out[`r_${name}`] = slPips > 0 ? fixed(pips / slPips, 2) : "";
  }
  return out;
}

const hitsOf = (r, sim) => ({
  first_hit_a: r.reached === "到達" && sim.schemes.A ? sim.schemes.A.first_hit : "",
  first_hit_b: r.reached === "到達" && sim.schemes.B ? sim.schemes.B.first_hit : "",
});
// 取消(到達後) の行が、有効期限までの追跡（先着の判定）を終えているか
const isScoredRow = (r) => r.first_hit_a !== "" || r.first_hit_b !== "";

// H1 足が設計時刻から有効期限まで届いているか。届いていなければ理由の文字列、届いていれば null
function barsProblem(bars, cand, planDate) {
  if (!coversExpiry(bars, planDate)) return "H1足が有効期限まで届いていません";
  // 設計時刻の後の足が途中から（古い案に対して新しい足だけ）では、『未到達』と確定させない
  if (bars[0].t > cand.generated_at_ms + 60 * 60000) return "H1足が設計時刻まで遡って届いていません";
  return null;
}

/**
 * 採点（有効期限を過ぎた案）。barsByCode: { 'XAUUSD': [{t,o,h,l,c}] }。nowMs より前に有効期限が来た未採点の案を採点して、追記する行を返す。
 *  ・直近の行が design／design-b … 設計時刻から有効期限まで判定（到達／未到達／失効後到達。到達なら SL/TP1 の先着）。
 *  ・直近の行が 取消(到達後) で先着が空 … 取消の時刻までの到達（H1 足）を確かめ、有効期限まで SL/TP1 を追う。reached は 取消(到達後) のまま。
 *  ・直近の行が 取消(再設計) … 取消の時刻までに H1 足で到達していたかを判定し直す。到達していれば 取消(到達後) の行を足す
 *    （取消の時に H1 足が届いていなかった分と、過去分の移行。期限を過ぎて足がそろっていれば、先着まで判定した1行を足す）。到達していなければ何もしない。
 *    判定し直せない（足が設計時刻・取消の時刻まで届いていない・足が古くなって落ちた）ものは、何もしない（黙って飛ばす）。
 * 返り値: { newRows, held, details }。details は書いた行ごとの説明（ログ出力用）。
 */
function scoreRows({ rows, barsByCode, nowMs }) {
  const lives = V.lastLifeByKey(rows);
  const newRows = [];
  const held = [];
  const details = [];
  for (const life of lives.values()) {
    const row = life.last;
    const key = life.key;
    const bars = barsByCode[row.symbol] || [];
    const expired = expiresAtMs(row.plan_date) <= nowMs;

    if (V.isDesignRow(row)) {
      if (!expired) continue; // まだ有効期限前
      const cand = candFromRow(row);
      if (!Number.isFinite(cand.generated_at_ms) || !Number.isFinite(cand.entry_low) || !Number.isFinite(cand.entry_high)) { held.push({ key, reason: "行の値が読めません" }); continue; }
      const why = barsProblem(bars, cand, row.plan_date);
      if (why) { held.push({ key, reason: why }); continue; }
      const r = simulate(cand, bars);
      newRows.push({
        ...row, run: "status", generated_at: jstIso(nowMs),
        reached: r.reached, reached_at: r.reached_at ? jstIso(r.reached_at) : "",
        ...hitsOf(r, r), ...(r.reached === "到達" ? pnlColumns(row, r) : {}),
      });
      details.push({ key, kind: "score", row: newRows[newRows.length - 1], sim: r });
      continue;
    }

    if (row.reached === V.CANCEL_REACHED && !isScoredRow(row)) {
      if (!expired) continue;
      const cancelMs = V.cancelMsOf(life);
      const cand = candFromRow(life.design);
      if (!Number.isFinite(cancelMs) || !Number.isFinite(cand.generated_at_ms)) { held.push({ key, reason: "取消の時刻が読めません" }); continue; }
      const why = barsProblem(bars, cand, row.plan_date);
      if (why) { held.push({ key, reason: why }); continue; }
      const r = simulate(cand, bars, { reachUntilMs: cancelMs });
      if (r.reached !== "到達") { held.push({ key, reason: "取消(到達後)の版が、H1足の判定では取消の時刻までに到達していません" }); continue; }
      newRows.push({
        ...row, run: "status", generated_at: jstIso(nowMs), reached: V.CANCEL_REACHED, reached_at: jstIso(r.reached_at),
        ...hitsOf({ reached: "到達" }, r), ...pnlColumns(row, r),
      });
      details.push({ key, kind: "score-cancelled", row: newRows[newRows.length - 1], sim: r });
      continue;
    }

    if (row.reached === V.CANCEL && life.status.length === 1) {
      const cancelMs = V.cancelMsOf(life);
      const j = V.judgeCancel({ designRow: life.design, bars, cancelMs });
      if (!j.reached) continue; // 到達していない（または判定し直せない）ので、取消(再設計) のまま
      const base = { ...row, run: "status", generated_at: jstIso(nowMs), reached: V.CANCEL_REACHED, reached_at: jstIso(j.reached_at) };
      const cand = candFromRow(life.design);
      if (expired && !barsProblem(bars, cand, row.plan_date)) {
        newRows.push({ ...base, ...hitsOf({ reached: "到達" }, j.sim), ...pnlColumns(row, j.sim) });
        details.push({ key, kind: "migrate-scored", row: newRows[newRows.length - 1], sim: j.sim });
      } else {
        newRows.push(base); // 期限前、または先着を判定する足がまだ無い。期限後の採点で先着を足す
        details.push({ key, kind: "migrate-pending", row: base, sim: j.sim });
      }
    }
  }
  return { newRows, held, details };
}

/**
 * 出力の6項目目: 直近に採点された計画日（今日より前）の結果。版ごとの直近の行から数える。
 */
function previousDaySummary(rows, beforePlanDate) {
  const latest = [...L.latestByKey(rows).values()].filter((r) => r.plan_date < beforePlanDate);
  const scored = latest.filter((r) => r.run === "status" && r.reached);
  if (!scored.length) return null;
  const date = scored.reduce((m, r) => (r.plan_date > m ? r.plan_date : m), "");
  const day = latest.filter((r) => r.plan_date === date);
  const items = day.map((r) => ({
    setup: r.setup, symbol: r.symbol, side: r.side, reached: r.reached || "未採点", reached_at: r.reached_at || null,
    first_hit_a: r.first_hit_a || null, first_hit_b: r.first_hit_b || null,
  }));
  const count = (f) => items.filter(f).length;
  return {
    plan_date: date, n: items.length,
    reached: count((i) => i.reached === "到達"), not_reached: count((i) => i.reached === "未到達"),
    after_expiry: count((i) => i.reached === "失効後到達"), cancelled: count((i) => i.reached === "取消(再設計)"),
    cancelled_after_reach: count((i) => i.reached === "取消(到達後)"), // 到達してから取消された版。先着（first_hit）まで追った分は下の a／b に含む
    unscored: count((i) => i.reached === "未採点"),
    a: { tp1: count((i) => i.first_hit_a === "TP1"), sl: count((i) => i.first_hit_a === "SL"), open: count((i) => i.first_hit_a === "未決") },
    b: { tp1: count((i) => i.first_hit_b === "TP1"), sl: count((i) => i.first_hit_b === "SL"), open: count((i) => i.first_hit_b === "未決") },
    items,
  };
}

module.exports = { candFromRow, scoreRows, pnlColumns, isScoredRow, previousDaySummary, pairOf };
