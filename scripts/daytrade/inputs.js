"use strict";
const fs = require("fs");
const path = require("path");
const { MIN, parseIso, parseJstLabel } = require("./jst");
const { lastCompletedSessionDate } = require("../../mtf/lib/ny-time");
const { pairOf } = require("./pairs");

/**
 * 入力の読み込みと鮮度（仕様 1節）。既存のファイルは読むだけ（変更しない）。
 *  Pivot・R1・R2・S1・S2・前日高安は data/daily-levels.json から読む（gpt-feed.txt はその文章版。intraday.json には無い）[Q38]。
 *  鮮度 [Q14]: intraday.json・daytrade-context.json・h1-bars.json の as_of が20分を超えていれば『発注不可（鮮度超過）』。計算はする。
 *  日次レベルとMTFは、日付が直近に確定したNYセッション日と一致するかで確認する [Q15]。
 */
const FRESH_LIMIT_MIN = 20;
const FILES = {
  intraday: "intraday.json", daily: "daily-levels.json", h1: "h1-bars.json", ctx: "daytrade-context.json",
  mtf: "mtf-feed.json", calendar: "economic-calendar.json",
};

function readJson(p) {
  if (!fs.existsSync(p)) return { value: null, problem: `${path.basename(p)} がありません` };
  try { return { value: JSON.parse(fs.readFileSync(p, "utf8")), problem: null }; }
  catch (e) { return { value: null, problem: `${path.basename(p)} を読めません（${e.message}）` }; }
}

function parseH1(h1json) {
  const out = {};
  for (const [code, arr] of Object.entries(h1json?.pairs || {})) {
    if (!Array.isArray(arr)) continue;
    const bars = [];
    for (const b of arr) {
      const t = parseJstLabel(b.time_jst);
      if (!Number.isFinite(t) || ![b.o, b.h, b.l, b.c].every(Number.isFinite)) continue;
      if (bars.length && t <= bars[bars.length - 1].t) continue; // 昇順・重複なしのものだけ
      bars.push({ t, o: b.o, h: b.h, l: b.l, c: b.c });
    }
    out[code] = bars;
  }
  return out;
}

function loadInputs({ dataDir, repoRoot, nowMs }) {
  const problems = [];
  const raw = {};
  for (const [k, f] of Object.entries(FILES)) {
    const r = readJson(path.join(dataDir, f));
    raw[k] = r.value;
    if (r.problem) problems.push(r.problem);
  }
  const rules = readJson(path.join(repoRoot, "config", "daytrade-rules.json"));
  if (rules.problem) problems.push(rules.problem);
  const acc = readJson(path.join(dataDir, "daytrade", "accounts.json"));
  if (acc.problem) problems.push(acc.problem);

  const accounts = {};
  for (const [id, a] of Object.entries(acc.value?.accounts || {})) {
    if (Number.isFinite(a?.equity_jpy)) accounts[id] = { equity_jpy: a.equity_jpy, role: a.role || null };
  }
  const expectedSession = lastCompletedSessionDate(nowMs);

  const feeds = [];
  for (const [name, key] of [["intraday.json", "intraday"], ["daytrade-context.json", "ctx"], ["h1-bars.json", "h1"]]) {
    const asOf = parseIso(raw[key]?.as_of);
    const age = Number.isFinite(asOf) ? Math.max(0, Math.round((nowMs - asOf) / MIN)) : null;
    feeds.push({ name, as_of: raw[key]?.as_of ?? null, age_min: age, stale: age === null || nowMs - asOf > FRESH_LIMIT_MIN * MIN });
  }

  // daytrade-context.json の『確定M15の最終足』（仕様 1節は鮮度確認用と書く）。20分の判定には使わず、最古の最終足と data_status が OK でない銘柄を参考表示する [Q42]
  const ctxM15 = { oldest_last_closed: null, not_ok: [] };
  let oldestT = null;
  for (const [code, p] of Object.entries(raw.ctx?.pairs || {})) {
    if (!pairOf(code)) continue;
    const t = parseJstLabel(p?.m15?.last_closed?.time_jst);
    if (Number.isFinite(t) && (oldestT === null || t < oldestT)) { oldestT = t; ctxM15.oldest_last_closed = p.m15.last_closed.time_jst; }
    if (p?.data_status && p.data_status !== "OK") ctxM15.not_ok.push(`${code}:${p.data_status}`);
  }

  const daily = raw.daily;
  const dailyErrors = Array.isArray(daily?.errors) ? daily.errors : [];
  const dailyOk = Boolean(daily && daily.session_date === expectedSession && dailyErrors.length === 0 && daily.pairs);
  const dailyReason = dailyOk ? null
    : !daily ? "daily-levels.json がありません"
      : daily.session_date !== expectedSession ? `daily-levels.json の session_date（${daily.session_date}）が直近に確定した営業日（${expectedSession}）ではありません`
        : dailyErrors.length ? `daily-levels.json に errors があります（${dailyErrors.length}件）` : "daily-levels.json に pairs がありません";

  return {
    raw, rules: rules.value, accounts, riskPct: Number.isFinite(acc.value?.risk_pct) ? acc.value.risk_pct : null,
    dailyLossPct: acc.value?.daily_loss_pct ?? null, commissionPerLotJpy: acc.value?.commission_per_lot_jpy ?? null,
    h1: parseH1(raw.h1), problems, expectedSession,
    freshness: { limit_min: FRESH_LIMIT_MIN, feeds, ctx_m15: ctxM15, stale: feeds.some((f) => f.stale), daily: { ok: dailyOk, reason: dailyReason, session_date: daily?.session_date ?? null, as_of: daily?.as_of ?? null } },
  };
}

module.exports = { FRESH_LIMIT_MIN, loadInputs, parseH1, readJson };
