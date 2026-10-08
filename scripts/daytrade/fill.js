"use strict";
const { HR } = require("./jst");
const { expiresAtMs, noNewEntryReason } = require("./windows");
const { EPS } = require("./num");

/**
 * 到達と SL/TP1 の先着の判定。採点（daytrade-score.js）とバックテストが同じ関数を使う（判定がずれないように）。
 * 使える足は H1 の高安だけ（M15 以下の履歴は無い）なので、足の中の順序は分からない。規則（すべて仮置き）:
 *  到達 [Q19]    : 設計時刻（generated_at）以後に開始する最初の足のうち、足の高安が Entry 帯と重なった足。
 *                  足の開始時刻が新規不可（9時台・翌1:00以降・土曜0:00以降・有効期限後）なら『失効後到達』に回す。
 *  約定価格 [Q26]: 最悪Entry（売り=帯の下端、買い=帯の上端）。M15の確認条件は反映しない。
 *  先着 [Q20]    : 到達した足では SL だけ判定（TP1 は次の足から）。同一足に SL と TP1 が両方入れば SL 先。
 *                  SL の始値ギャップは始値で損切り（損失を縮めない）、TP1 は TP1 の価格で利確（利益を増やさない）。
 *                  有効期限（翌3:00）まで決着しなければ『未決』（最終足の終値で決済した扱いは exit に別記）。
 * 追跡の打ち切り（バックテスト用）: reachUntilMs 以後に始まる足では到達を見ない（取消された案）。到達した後の SL/TP1 は有効期限まで追う。
 * bars: 古い順の確定 H1 {t(開始ms), o,h,l,c}
 * cand: { side, plan_date, generated_at_ms, entry_low, entry_high, worst_entry, schemes: { A: {sl, tp}|null, B: {sl, tp}|null } }
 */
function overlaps(b, low, high) {
  return b.h - low > -EPS && b.l - high < EPS;
}

function simulate(cand, bars, { reachUntilMs = null } = {}) {
  const expires = expiresAtMs(cand.plan_date);
  const sell = cand.side === "sell";
  let reachedIdx = -1;
  let late = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.t < cand.generated_at_ms) continue;
    if (reachUntilMs !== null && b.t >= reachUntilMs) break; // 次の設計で取消された案は、そこまでの足でしか到達を見ない（バックテスト [Q25]）
    if (!overlaps(b, cand.entry_low, cand.entry_high)) continue;
    const blocked = noNewEntryReason(b.t, cand.plan_date);
    if (!blocked) { reachedIdx = i; break; }
    if (!late) late = { t: b.t, why: blocked };
  }
  const out = { reached: "未到達", reached_at: null, late_reason: null, schemes: {} };
  if (reachedIdx < 0) {
    if (late) { out.reached = "失効後到達"; out.reached_at = late.t; out.late_reason = late.why; }
    return out;
  }
  out.reached = "到達";
  out.reached_at = bars[reachedIdx].t;

  for (const [name, s] of Object.entries(cand.schemes || {})) {
    if (!s || !Number.isFinite(s.sl) || !Number.isFinite(s.tp)) continue;
    const slHit = (b) => (sell ? b.h - s.sl > -EPS : s.sl - b.l > -EPS);
    const tpHit = (b) => (sell ? s.tp - b.l > -EPS : b.h - s.tp > -EPS);
    const res = { first_hit: "未決", hit_at: null, same_bar: false, gap: false, exit_price: null, exit_kind: "timeout", bars_held: 0 };
    let last = reachedIdx;
    // 到達した足: SL だけ判定
    if (slHit(bars[reachedIdx])) {
      Object.assign(res, { first_hit: "SL", hit_at: bars[reachedIdx].t, exit_price: s.sl, exit_kind: "sl" });
    } else {
      for (let j = reachedIdx + 1; j < bars.length && bars[j].t < expires; j++) {
        const b = bars[j];
        last = j;
        const sl = slHit(b), tp = tpHit(b);
        if (sl) {
          const gapped = sell ? b.o - s.sl > -EPS : s.sl - b.o > -EPS;
          Object.assign(res, { first_hit: "SL", hit_at: b.t, same_bar: tp, gap: gapped && Math.abs(b.o - s.sl) > EPS, exit_price: gapped ? b.o : s.sl, exit_kind: "sl" });
          break;
        }
        if (tp) { Object.assign(res, { first_hit: "TP1", hit_at: b.t, exit_price: s.tp, exit_kind: "tp" }); break; }
      }
    }
    if (res.first_hit === "未決") res.exit_price = bars[last].c; // 期限までに決着しなければ最終足の終値（別集計）
    res.bars_held = last - reachedIdx;
    out.schemes[name] = res;
  }
  return out;
}

// 失効（翌3:00）までの足がそろっているか。最後の足の終了が有効期限以降なら、期限までを判定できる
function coversExpiry(bars, planDate) {
  if (!bars.length) return false;
  return bars[bars.length - 1].t + HR >= expiresAtMs(planDate);
}

module.exports = { simulate, coversExpiry, overlaps };
