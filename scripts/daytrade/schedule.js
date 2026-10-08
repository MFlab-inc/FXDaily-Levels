"use strict";
const { nyWallMs, lastCompletedSessionDate } = require("../../mtf/lib/ny-time");
const { HR, DAY, jstAt, addDaysJst, jstDow } = require("./jst");
const { planDateOf, newEntryCutoffMs } = require("./windows");

/**
 * 実行の種類（仕様 7節）。GitHub の cron は UTC 固定なので、夏冬の2本ずつを置き、実行時にニューヨークの
 * 夏時間かどうかで該当しない側を何もせず終了する [Q22]。
 *   設計①  NY 17:30（夏 06:30 JST / 冬 07:30）   設計②  15:30 JST 固定   設計③  NY 8:00（夏 21:00 / 冬 22:00）
 *   状態更新  毎時00分（07:00〜翌02:00 JST）。設計③の時刻は設計が状態更新を兼ねる
 * 下の CRON は .github/workflows/daytrade.yml の cron と一致していなければならない（試験が確かめる）。
 */
const CRON = {
  "30 21 * * 0-4": { kind: "design", slot: 1, season: "summer" },
  "30 22 * * 0-4": { kind: "design", slot: 1, season: "winter" },
  "30 6 * * 1-5": { kind: "design", slot: 2, season: null },
  "0 12 * * 1-5": { kind: "design-or-status", slot: 3, season: "summer" },
  "0 13 * * 1-5": { kind: "design-or-status", slot: 3, season: "winter" },
  "0 22,23 * * 0-4": { kind: "status", slot: null, season: null },
  "0 0-11,14-17 * * 1-5": { kind: "status", slot: null, season: null },
};

// ニューヨークが夏時間（EDT, UTC-4）か
// nyWallMs は秒未満を落とすので、ミリ秒つきの現在時刻（Date.now()）でも合うよう、先に秒へ切り捨てる
const isNyDst = (ms) => { const s = Math.floor(ms / 1000) * 1000; return (nyWallMs(s) - s) / HR === -4; };
const seasonOf = (ms) => (isNyDst(ms) ? "summer" : "winter");

// 実行時刻から、起動の種類を『やること』に解決する。{ action: 'design'|'status'|'skip', slot, reason }
function resolveAction(cronStr, nowMs) {
  const e = CRON[cronStr];
  if (!e) return { action: null, reason: `未知の cron（${cronStr}）` };
  const season = seasonOf(nowMs);
  if (e.kind === "design") {
    if (e.season && e.season !== season) return { action: "skip", slot: e.slot, reason: `${e.season === "summer" ? "夏" : "冬"}時間用の起動だが、今は${season === "summer" ? "夏" : "冬"}時間` };
    return { action: "design", slot: e.slot };
  }
  if (e.kind === "design-or-status") return e.season === season ? { action: "design", slot: e.slot } : { action: "status", slot: null };
  return { action: "status", slot: null };
}

// 設計の枠の名目時刻（JST の epoch ms）。planDate は計画日
function slotNominalMs(slot, planDate, ms) {
  const summer = isNyDst(ms);
  if (slot === 1) return jstAt(planDate, summer ? "06:30" : "07:30");
  if (slot === 2) return jstAt(planDate, "15:30");
  return jstAt(planDate, summer ? "21:00" : "22:00");
}

/**
 * 遅れて動いた設計の整合 [Q22]（新しい数値は足さない）:
 *  後の枠の設計が同じ計画日に既にある／次の枠の名目時刻を過ぎている（設計③は新規期限＝翌1:00を過ぎている）なら何もしない。
 * lastDesignSlot: 同じ計画日の plan.json にある設計の枠（無ければ null）
 */
function designStale({ slot, nowMs, lastDesignSlot }) {
  const planDate = planDateOf(nowMs);
  if (lastDesignSlot !== null && lastDesignSlot !== undefined && lastDesignSlot > slot) return `同じ計画日に後の枠（設計${lastDesignSlot}）の設計が既にあります`;
  const next = slot === 1 ? slotNominalMs(2, planDate, nowMs) : slot === 2 ? slotNominalMs(3, planDate, nowMs) : newEntryCutoffMs(planDate);
  if (nowMs >= next) return slot === 3 ? "設計③の新規期限（翌1:00）を過ぎています" : `次の枠（設計${slot + 1}）の名目時刻を過ぎています`;
  return null;
}

module.exports = { CRON, isNyDst, seasonOf, resolveAction, slotNominalMs, designStale, jstDow, DAY, addDaysJst, lastCompletedSessionDate };
