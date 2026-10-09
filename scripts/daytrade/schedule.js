"use strict";
const { nyWallMs } = require("../../mtf/lib/ny-time");
const { HR, jstAt, jstDow, jstHour, parseIso } = require("./jst");
const { planDateOf } = require("./windows");

/**
 * 実行の種類（仕様 7節 + 確定した解釈 Q14・Q22・Q23）。起動は intraday のワークフロー（Intraday Snapshot）の完了（workflow_run）で、
 * cron は使わない。何をするかは『実行時刻（JST）』と『その計画日・その枠の設計が済んでいるか』で決める。
 *   設計①＋採点 : 06:00〜08:59 の最初の実行（NY夏時間。冬時間は 07:00〜09:59）
 *   設計②       : 15:00〜16:59 の最初の実行
 *   設計③       : 21:00〜22:59 の最初の実行（冬時間は 22:00〜23:59）
 *   それ以外     : 状態更新（07:00〜翌02:59 の実行。毎時1回まで。型Bの追加は 16:00〜21:59 の状態更新の中）
 * 『最初の実行』= その計画日・その枠の設計がまだ無いこと（発注できる状態の入力で作れた設計だけが『済み』。古い入力・日次レベル未更新で作った設計は、窓の中の次の実行でやり直す）。済みかどうかは plan.json の設計の履歴（designs）と、
 * log.csv のその計画日の design 行（生成時刻が窓の中にあるもの）の両方で見る（候補が0件の設計は log.csv に行が残らないため）。
 * 土日の計画日（金曜の設計の有効期限＝土曜 3:00 以降）は何もしない。
 */
// ニューヨークが夏時間（EDT, UTC-4）か。nyWallMs は秒未満を落とすので、ミリ秒つきの現在時刻（Date.now()）でも合うよう、先に秒へ切り捨てる
const isNyDst = (ms) => { const s = Math.floor(ms / 1000) * 1000; return (nyWallMs(s) - s) / HR === -4; };
const seasonOf = (ms) => (isNyDst(ms) ? "summer" : "winter");

// 設計の枠の窓（JST）。planDate は計画日、ms は夏冬の判定に使う時刻
function slotWindow(slot, planDate, ms) {
  const summer = isNyDst(ms);
  if (slot === 1) { const start = jstAt(planDate, summer ? "06:00" : "07:00"); return { start, end: start + 3 * HR }; }
  if (slot === 2) return { start: jstAt(planDate, "15:00"), end: jstAt(planDate, "17:00") };
  const start = jstAt(planDate, summer ? "21:00" : "22:00");
  return { start, end: start + 2 * HR };
}

// 設計の枠の名目時刻（バックテストの再現用。JST の epoch ms）: ①=NY17:30（夏 06:30／冬 07:30）、②=15:30、③=NY8:00（夏 21:00／冬 22:00）
function slotNominalMs(slot, planDate, ms) {
  const summer = isNyDst(ms);
  if (slot === 1) return jstAt(planDate, summer ? "06:30" : "07:30");
  if (slot === 2) return jstAt(planDate, "15:30");
  return jstAt(planDate, summer ? "21:00" : "22:00");
}

// 時刻 ms がどの枠の窓に入るか（1|2|3|null）
function slotOfTime(ms, planDate) {
  for (const slot of [1, 2, 3]) {
    const w = slotWindow(slot, planDate, ms);
    if (ms >= w.start && ms < w.end) return slot;
  }
  return null;
}

// その計画日に済んでいる設計の枠の集合
function designsDone({ planDate, prevPlan, logRows = [] }) {
  const done = new Set();
  // plan.json にその計画日の設計の履歴があれば、それが正（手動で窓の外に作った設計を、窓の時刻から別の枠と取り違えない）
  if (prevPlan && prevPlan.plan_date === planDate && Array.isArray(prevPlan.designs) && prevPlan.designs.length) {
    // 発注できる状態の入力で作れなかった設計（inputs_ok=false）は『済み』にしない。窓の中の次の実行でやり直す [Q58]
    for (const d of prevPlan.designs) if ([1, 2, 3].includes(d.slot) && d.inputs_ok !== false) done.add(d.slot);
    return done;
  }
  // 履歴が無いとき（plan.json が無い・別の日のもの）は、log.csv のその計画日の design 行を、生成時刻の窓で枠に当てはめる
  for (const r of logRows) {
    if (r.plan_date !== planDate || r.run !== "design") continue;
    const t = parseIso(r.generated_at);
    const s = Number.isFinite(t) ? slotOfTime(t, planDate) : null;
    if (s) done.add(s);
  }
  return done;
}

const isWeekdayPlanDate = (planDate) => { const d = jstDow(jstAt(planDate, "12:00")); return d >= 1 && d <= 5; };
// 状態更新を出す時間帯（JST）: 07:00〜23:59 と 00:00〜02:59（翌日分）
const isStatusHour = (ms) => { const h = jstHour(ms); return h >= 7 || h <= 2; };

/**
 * 自動起動（workflow_run）の『やること』を、実行時刻と済みの設計から決める。
 * 返り値: { action: 'design'|'status'|'skip', slot, reason }
 */
function resolveAuto({ nowMs, prevPlan = null, logRows = [] }) {
  const planDate = planDateOf(nowMs);
  if (!isWeekdayPlanDate(planDate)) return { action: "skip", slot: null, reason: `計画日 ${planDate} は土日です` };
  const slot = slotOfTime(nowMs, planDate);
  if (slot && !designsDone({ planDate, prevPlan, logRows }).has(slot)) return { action: "design", slot };
  if (isStatusHour(nowMs)) return { action: "status", slot: null };
  return { action: "skip", slot: null, reason: "状態更新の時間帯（07:00〜翌02:59）ではありません" };
}

module.exports = { isNyDst, seasonOf, slotWindow, slotNominalMs, slotOfTime, designsDone, isWeekdayPlanDate, isStatusHour, resolveAuto };
