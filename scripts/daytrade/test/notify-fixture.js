"use strict";
const path = require("path");
const { makeScenario } = require("./scenario");
const { loadInputs } = require("../inputs");
const { buildDesign } = require("../plan");
const D = require("../notify/detect");
const J = require("../jst");
const { rm } = require("./helpers");

/**
 * Issue 通知の試験の共通部品。模擬データ: 2026-10-08（木）の設計②（15:30）= AUDUSD 買い・EURUSD 売り・XAUUSD 買い・GBPUSD 売り（型A）の4件。
 * EURUSD に 15:25〜16:10 のイベント停止。資金は試験用の架空の額。
 */
const EV = [{ time_jst: "15:40", datetime_jst: "2026-10-08T15:40:00+09:00", currency: "EUR", impact: "Medium", event: "ECB Speaks" }];
const iso = (s) => J.parseIso(s);
const clone = (o) => JSON.parse(JSON.stringify(o));
const noFeed = { status: "未取得", pairs: {} };

function basePlan(env) {
  const sc = makeScenario({ events: EV, ...(env ? { env } : {}) });
  try {
    const inputs = loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs, env: sc.env });
    return buildDesign({ inputs, riskFeed: noFeed, nowMs: sc.nowMs, slot: 2, prevPlan: null, logRows: [] }).plan;
  } finally { rm(path.dirname(sc.dataDir)); }
}
const BASE = basePlan();
const plan = (mut) => { const p = clone(BASE); if (mut) mut(p); return p; };
const by = (p, sym) => p.candidates.find((c) => c.symbol === sym);
const vOf = (p, sym) => D.versionKey(by(p, sym));
const intraday = (nowMs, prices, ageMin = 1) => ({ as_of: J.jstIso(nowMs - ageMin * 60000), pairs: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, { price: v }])) });

module.exports = { EV, iso, clone, noFeed, basePlan, BASE, plan, by, vOf, intraday };
