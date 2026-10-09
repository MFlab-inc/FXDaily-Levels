"use strict";
const fs = require("fs");
const path = require("path");
const { MIN, parseIso, parseJstLabel, jstLabel } = require("./jst");
const { lastCompletedSessionDate } = require("../../mtf/lib/ny-time");
const { PAIRS, pairOf } = require("./pairs");

/**
 * 入力の読み込みと鮮度（仕様 1節）。既存のファイルは読むだけ（変更しない）。
 *  Pivot・R1・R2・S1・S2・前日高安は data/daily-levels.json から読む（gpt-feed.txt はその文章版。intraday.json には無い）[Q38]。
 *  鮮度 [Q14]: intraday.json・daytrade-context.json・h1-bars.json の as_of が20分を超えていれば『発注不可（鮮度超過）』。計算はする。
 *  日次レベルとMTFは、日付が直近に確定したNYセッション日と一致するかで確認する [Q15]。
 */
const FRESH_LIMIT_MIN = 20;
const RISK_PCT_MAX = 5; // これを超える risk_pct は入力ミスとみなす（仕様の値は 0.5）
// 口座のラベル（口座番号は公開されるリポジトリに置かない）。資金（円）は GitHub Actions の Variables（DAYTRADE_EQUITY_<ラベル>）から環境変数で受け取り、
// ファイル（accounts.json・plan.json・plan.txt・log.csv）には書かない。
const ACCOUNT_LABELS = ["A", "B"];
const equityEnvName = (label) => `DAYTRADE_EQUITY_${label}`;
// 'ok'（正の整数の円）／'unset'（未設定・空）／'invalid'（それ以外）。不正な値そのものは返さない・メッセージにも出さない
function readEquity(env, label) {
  const v = env ? env[equityEnvName(label)] : undefined;
  if (v === undefined || v === null || String(v).trim() === "") return { status: "unset", equity: null };
  const s = String(v).trim();
  return /^[1-9][0-9]{0,14}$/.test(s) ? { status: "ok", equity: Number(s) } : { status: "invalid", equity: null };
}
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

function loadInputs({ dataDir, repoRoot, nowMs, env = process.env }) {
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

  // 口座設定（人が手で書くファイル。ラベルと役割だけで、口座番号と資金は置かない）。資金は環境変数 DAYTRADE_EQUITY_A／B（Variables）から読む。
  // 上限ロットの元になるので、読めない・未設定・範囲外のときは『発注不可』（accountProblems）にする。
  // daily_loss_pct・commission_per_lot_jpy は表示だけなので、おかしくても発注不可にはせず問題として出す
  const accounts = {};
  const accountProblems = [];
  if (acc.problem) accountProblems.push(acc.problem);
  let legacyEquity = false, badLabel = false;
  for (const [id, a] of Object.entries(acc.value?.accounts || {})) {
    if (!ACCOUNT_LABELS.includes(id)) { badLabel = true; continue; } // 口座番号などが残っていても、出力には出さない
    if (a && Object.prototype.hasOwnProperty.call(a, "equity_jpy")) legacyEquity = true;
    const e = readEquity(env, id);
    accounts[id] = { role: a?.role || null, equity_jpy: e.equity, equity_status: e.status };
    if (e.status === "unset") accountProblems.push(`口座 ${id} の資金が未設定です（GitHub Actions の Variables ${equityEnvName(id)} を設定してください。上限ロットは出せません）`);
    else if (e.status === "invalid") accountProblems.push(`口座 ${id} の資金（${equityEnvName(id)}）が正の整数（円）ではありません。上限ロットは出せません`);
  }
  if (badLabel) accountProblems.push(`accounts.json: 口座のラベルは ${ACCOUNT_LABELS.join("・")} だけです（それ以外の口座は読みません）`);
  if (legacyEquity) problems.push("accounts.json に equity_jpy があります（読みません。公開されるので削除してください。資金は Variables から読みます）");
  if (!acc.problem && !Object.keys(accounts).length) accountProblems.push("accounts.json: 有効な口座がありません");
  const riskPctRaw = acc.value?.risk_pct;
  const riskPctOk = Number.isFinite(riskPctRaw) && riskPctRaw > 0 && riskPctRaw <= RISK_PCT_MAX;
  if (!acc.problem && !riskPctOk) accountProblems.push(`accounts.json: risk_pct が 0 超 ${RISK_PCT_MAX} 以下の数ではありません（${JSON.stringify(riskPctRaw ?? null)}）`);
  const dlp = acc.value?.daily_loss_pct, cpl = acc.value?.commission_per_lot_jpy;
  if (!acc.problem && !(Number.isFinite(dlp) && dlp >= 0)) problems.push("accounts.json: daily_loss_pct が 0 以上の数ではありません（本日の損失上限は表示できません）");
  if (!acc.problem && !(Number.isFinite(cpl) && cpl >= 0)) problems.push("accounts.json: commission_per_lot_jpy が 0 以上の数ではありません（往復手数料は表示できません）");
  // イベント停止の対象通貨表。無いと停止時間が全く出せない（黙って停止なしになる）ので『発注不可』にする
  const pc = rules.value?.pair_currencies;
  const rulesOk = Boolean(pc && typeof pc === "object" && PAIRS.every((p) => Array.isArray(pc[p.code]) && pc[p.code].length));
  if (!rulesOk && !rules.problem) problems.push("config/daytrade-rules.json: pair_currencies が読めません（10銘柄の通貨の対応表が必要）");
  const expectedSession = lastCompletedSessionDate(nowMs);

  const feeds = [];
  for (const [name, key] of [["intraday.json", "intraday"], ["daytrade-context.json", "ctx"], ["h1-bars.json", "h1"]]) {
    const asOf = parseIso(raw[key]?.as_of);
    const age = Number.isFinite(asOf) ? Math.max(0, Math.round((nowMs - asOf) / MIN)) : null;
    feeds.push({ name, as_of: raw[key]?.as_of ?? null, age_min: age, stale: age === null || nowMs - asOf > FRESH_LIMIT_MIN * MIN });
  }

  // daytrade-context.json の『確定M15の最終足』（仕様 1節は鮮度確認用と書く）。20分の判定には使わず、最古の最終足と data_status が OK でない銘柄を参考表示する [Q42]
  const ctxM15 = { oldest_last_closed: null, newest_last_closed: null, not_ok: [] };
  let oldestT = null, newestT = null;
  for (const [code, p] of Object.entries(raw.ctx?.pairs || {})) {
    if (!pairOf(code)) continue;
    const t = parseJstLabel(p?.m15?.last_closed?.time_jst);
    if (Number.isFinite(t) && (oldestT === null || t < oldestT)) { oldestT = t; ctxM15.oldest_last_closed = p.m15.last_closed.time_jst; }
    if (Number.isFinite(t) && (newestT === null || t > newestT)) { newestT = t; ctxM15.newest_last_closed = p.m15.last_closed.time_jst; }
    if (p?.data_status && p.data_status !== "OK") ctxM15.not_ok.push(`${code}:${p.data_status}`);
  }
  // h1-bars.json の最終確定足（開始時刻）。10銘柄の最古と最新
  const h1 = parseH1(raw.h1);
  const lastStarts = Object.entries(h1).filter(([c]) => pairOf(c)).map(([, bars]) => (bars.length ? bars[bars.length - 1].t : null)).filter(Number.isFinite);
  const h1Last = { oldest: lastStarts.length ? jstLabel(Math.min(...lastStarts)) : null, newest: lastStarts.length ? jstLabel(Math.max(...lastStarts)) : null };

  const daily = raw.daily;
  const dailyErrors = Array.isArray(daily?.errors) ? daily.errors : [];
  const dailyOk = Boolean(daily && daily.session_date === expectedSession && dailyErrors.length === 0 && daily.pairs);
  const dailyReason = dailyOk ? null
    : !daily ? "daily-levels.json がありません"
      : daily.session_date !== expectedSession ? `daily-levels.json の session_date（${daily.session_date}）が直近に確定した営業日（${expectedSession}）ではありません`
        : dailyErrors.length ? `daily-levels.json に errors があります（${dailyErrors.length}件）` : "daily-levels.json に pairs がありません";

  return {
    raw, rules: rules.value, rulesOk, accounts, accountProblems, riskPct: riskPctOk ? riskPctRaw : null,
    dailyLossPct: Number.isFinite(dlp) && dlp >= 0 ? dlp : null, commissionPerLotJpy: Number.isFinite(cpl) && cpl >= 0 ? cpl : null,
    h1, problems, expectedSession,
    freshness: { limit_min: FRESH_LIMIT_MIN, feeds, ctx_m15: ctxM15, h1_last_closed: h1Last, stale: feeds.some((f) => f.stale), daily: { ok: dailyOk, reason: dailyReason, session_date: daily?.session_date ?? null, as_of: daily?.as_of ?? null } },
  };
}

module.exports = { FRESH_LIMIT_MIN, ACCOUNT_LABELS, equityEnvName, loadInputs, parseH1, readJson };
