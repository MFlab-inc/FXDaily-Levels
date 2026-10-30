"use strict";

/**
 * 保存済みの risk.json が「いま」最新かどうか（SPEC 4節・5-4）。外部へは接続しない。
 * VIX：
 *   ok      … 期待する最新日（米東部18:00を過ぎた営業日）まで入っている
 *   pending … 期待する日の値はまだ無いが、掲載のはずの時刻から STALE_AFTER_HOURS 以内（更新待ち）
 *   stale   … それより古い、または risk.json が無い・形式が違う・VIX が無い
 * イベント警戒：基準時刻（日本時間のその日の9:00）が「いま」の日のものなら ok、違えば stale。
 */
const cfg = require("../config");
const { expectedLatest } = require("./calendar");
const { baseMsOf, toJstIso } = require("./events");
const { HR } = require("../../mtf/lib/ny-time");

const SCHEMA = "fxdaily-levels/risk/v1";

const docOk = (doc) => doc && doc.schema === SCHEMA;

function evaluateVix(doc, nowMs) {
  if (!docOk(doc) || !doc.vix || typeof doc.vix.date !== "string") {
    return { state: "stale", expected: null, reasons: ["VIX：risk.json が無いか、形式が違うか、VIX の値がありません"] };
  }
  const opts = { readyMin: cfg.READY_ET_MIN, extraClosed: cfg.EXTRA_CLOSED_DATES };
  const expected = expectedLatest(nowMs, opts);
  if (doc.vix.date >= expected) return { state: "ok", expected, reasons: [] };
  const staleLine = expectedLatest(nowMs - cfg.STALE_AFTER_HOURS * HR, opts);
  if (doc.vix.date >= staleLine) {
    return { state: "pending", expected, reasons: [`VIX は ${doc.vix.date} まで（${expected} の値の掲載待ち）`] };
  }
  return {
    state: "stale", expected,
    reasons: [`VIX は ${doc.vix.date} まで。${staleLine} の値が、掲載のはずの時刻（米東部18:00）から${cfg.STALE_AFTER_HOURS}時間を過ぎても入っていません`],
  };
}

function evaluateEvent(doc, nowMs) {
  const base = toJstIso(baseMsOf(nowMs));
  if (!docOk(doc) || !doc.event || doc.event.base_jst !== base) {
    return { state: "stale", reasons: [`イベント警戒：基準時刻 ${base} の集計がありません（${doc && doc.event ? doc.event.base_jst : "なし"}）`] };
  }
  return { state: "ok", reasons: [] };
}

module.exports = { SCHEMA, evaluateVix, evaluateEvent };
