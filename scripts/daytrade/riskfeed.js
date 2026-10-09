"use strict";
const { MIN, parseIso } = require("./jst");

/**
 * EA-Risk-Monitor の risk-feed.json（ボラティリティの状態の表示用。判定には使わない。仕様 1節・9節-2）。
 * ?nocache=<時刻> を付けて取得し、meta.generated_intraday を読む。収録は12ペアだけ（GBPUSD・EURJPY・NZDUSD・USDCHF は『未収録』）。
 * 表示する項目は pairs.<ペア>.intraday 配下（range_today・range_vs_adr・spike_flag・updated_at）。無い・null の項目は出さない [Q24]。
 * 取得失敗は『未取得』。
 */
const URL = "https://mflab-inc.github.io/EA-Risk-Monitor/data/risk-feed.json";

async function fetchRiskFeed({ fetchImpl = (...a) => fetch(...a), nowMs = Date.now(), timeoutMs = 15000 } = {}) {
  try {
    const res = await fetchImpl(`${URL}?nocache=${Math.floor(nowMs / 1000)}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { status: "未取得", reason: `HTTP ${res.status}`, pairs: {} };
    const j = await res.json();
    if (!j || typeof j !== "object" || !j.meta || !j.pairs || typeof j.pairs !== "object") return { status: "未取得", reason: "形式が想定と違います", pairs: {} };
    const gen = parseIso(j.meta.generated_intraday);
    return {
      status: "ok", reason: null, generated_intraday: j.meta.generated_intraday ?? null,
      age_min: Number.isFinite(gen) ? Math.max(0, Math.round((nowMs - gen) / MIN)) : null,
      pairs: j.pairs,
    };
  } catch (e) {
    return { status: "未取得", reason: String(e.message || e).slice(0, 120), pairs: {} };
  }
}

// 銘柄ごとの表示用。{ state: '未取得'|'未収録'|'ok', items: {…} }
function volatilityOf(rf, code) {
  if (!rf || rf.status !== "ok") return { state: "未取得" };
  const p = rf.pairs[code];
  if (!p) return { state: "未収録" };
  const it = p.intraday || {};
  const items = {};
  if (Number.isFinite(it.range_today)) items.range_today = it.range_today;
  if (Number.isFinite(it.range_vs_adr)) items.range_vs_adr = it.range_vs_adr;
  // updated_at が null のときの spike_flag=false は『未計算』であって『急変なし』ではないので出さない
  if (typeof it.spike_flag === "boolean" && it.updated_at) items.spike_flag = it.spike_flag;
  if (it.updated_at) items.updated_at = it.updated_at;
  return { state: "ok", items };
}

module.exports = { URL, fetchRiskFeed, volatilityOf };
