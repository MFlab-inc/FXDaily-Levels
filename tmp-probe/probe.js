"use strict";
// 一時的な Twelve Data 実API確認（EURUSD 1銘柄のみ）。結果はジョブログに出すだけ。コミットしない。
// 安全装置: リクエスト総数<=10 / 間隔16秒 / 他ワークフロー(Intraday・Daily)稼働中は待機 / APIキーは出力しない。

const TZ = "America/New_York";
const SYMBOL = "EUR/USD";
const MAX_REQ = 10;
const TEST = process.env.PROBE_TEST === "1"; // ローカルのモック検証専用。ワークフローでは設定しない
const SPACING_MS = TEST ? Number(process.env.PROBE_SPACING_MS || 0) : 16000;
const API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const GH_TOKEN = process.env.GH_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || "";
const RUN_ID = process.env.GITHUB_RUN_ID || "";
const WATCH_NAMES = new Set(["Intraday Snapshot", "Daily FX Data", "TMP Twelve Data probe"]);

if (!API_KEY) { console.log("ERROR: TWELVE_DATA_API_KEY が未設定です（APIは呼んでいません）"); process.exit(1); }

const scrub = (s) => {
  let t = String(s);
  t = t.split(API_KEY).join("***");
  return t.replace(/apikey=[^&\s"']+/gi, "apikey=***");
};
const out = (...a) => console.log(scrub(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fetch.js から逐語コピー（同じ作り方で日足を作るため）----
function fmtDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function lastCompletedSessionDate(now = new Date()) {
  const nyStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const ny = new Date(nyStr);
  let d = new Date(ny);
  if (ny.getHours() < 17) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return fmtDateLocal(d);
}
function aggregateToNySessions(hourBarsAsc) {
  const sessions = new Map();
  for (const b of hourBarsAsc) {
    const dt = new Date(b.datetime.replace(" ", "T"));
    const shifted = new Date(dt.getTime() + 7 * 3600000);
    const sd = fmtDateLocal(shifted);
    const dow = shifted.getDay();
    if (dow === 0 || dow === 6) continue;
    if (!sessions.has(sd)) {
      sessions.set(sd, { date: sd, open: b.open, high: b.high, low: b.low, close: b.close, bars: 1 });
    } else {
      const s = sessions.get(sd);
      s.high = Math.max(s.high, b.high);
      s.low = Math.min(s.low, b.low);
      s.close = b.close;
      s.bars += 1;
    }
  }
  return [...sessions.values()].sort((a, b) => a.date.localeCompare(b.date));
}
// ---- ここまで ----

// ---- 他ワークフローとの重なり回避 ----
async function ghGet(path) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`GitHub API HTTP ${r.status}`);
  return r.json();
}
async function activeOthers() {
  const found = [];
  for (const status of ["in_progress", "queued"]) {
    const j = await ghGet(`/repos/${REPO}/actions/runs?status=${status}&per_page=100`);
    for (const run of j.workflow_runs || []) {
      if (WATCH_NAMES.has(run.name) && String(run.id) !== String(RUN_ID)) found.push({ name: run.name, id: run.id, status });
    }
  }
  return found;
}
async function waitQuiet(label) {
  const deadline = Date.now() + (TEST ? 3000 : 5 * 60000);
  for (;;) {
    let act = null;
    for (let i = 0; i < 3; i++) {
      try { act = await activeOthers(); break; }
      catch (e) {
        if (i === 2) throw new Error(`他ワークフローの稼働を確認できないため中止（Twelve Dataは呼んでいません）: ${e.message}`);
        await sleep(TEST ? 0 : 5000);
      }
    }
    if (!act.length) return;
    out(`[guard] ${label}: 他ワークフローが稼働中のため待機 → ${act.map((r) => `${r.name}#${r.id}(${r.status})`).join(", ")}`);
    if (Date.now() > deadline) throw new Error("他ワークフローが長時間稼働しているため中止しました");
    await sleep(TEST ? 100 : 10000);
  }
}
// intraday の schedule 名目は毎時 :02/:17/:32/:47 UTC（実際は数分遅れて届く）。次の名目時刻の約5分前から始める
async function waitStartWindow() {
  if (TEST) return;
  for (;;) {
    const now = new Date();
    const m = now.getUTCMinutes() % 15;
    const s = now.getUTCSeconds();
    if (m === 10 || (m === 11 && s < 30)) return;
    const ms = ((10 - m + 15) % 15) * 60000 - s * 1000;
    out(`[window] 開始を待機: 現在 ${now.toISOString()} → 次の枠まで約${Math.round(ms / 1000)}秒`);
    await sleep(Math.min(Math.max(ms, 1000), 60000));
  }
}

// ---- Twelve Data 呼び出し（上限・間隔・秘匿を一手に管理）----
let used = 0;
let lastEnd = 0;
const reqLog = [];
const HDR_RE = /credit|limit|usage|plan|rate|quota|retry/i;

async function call(id, kind, params) {
  if (used >= MAX_REQ) { out(`[skip] ${id}: リクエスト上限(${MAX_REQ})に達したため実行しません`); return null; }
  const wait = lastEnd + SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  await waitQuiet(id);
  const spare = lastEnd + SPACING_MS - Date.now();
  if (spare > 0) await sleep(spare);
  used += 1;
  const q = new URLSearchParams(kind === "usage" ? {} : { symbol: SYMBOL, ...params });
  q.set("apikey", API_KEY);
  const url = `https://api.twelvedata.com/${kind === "usage" ? "api_usage" : "time_series"}?${q.toString()}`;
  const t0 = Date.now();
  const r = { id, kind, n: used, startedAt: new Date().toISOString(), http: null, ms: null, bytes: null, json: null, err: null, hdr: {} };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(40000) });
    r.http = res.status;
    for (const [k, v] of res.headers) if (HDR_RE.test(k)) r.hdr[k] = v;
    const text = await res.text();
    r.bytes = Buffer.byteLength(text);
    try { r.json = JSON.parse(text); } catch { r.err = `JSON解析失敗(先頭80字): ${scrub(text.slice(0, 80))}`; }
  } catch (e) {
    r.err = `${e.name}: ${e.message}`;
  }
  r.ms = Date.now() - t0;
  lastEnd = Date.now();
  const vals = Array.isArray(r.json?.values) ? r.json.values.length : undefined;
  out(`[#${r.n}/${MAX_REQ}] ${id} http=${r.http} ${r.ms}ms ${r.bytes ?? "-"}B status=${r.json?.status ?? "-"}` +
      (vals !== undefined ? ` values=${vals}` : "") +
      (r.json?.code ? ` code=${r.json.code}` : "") +
      (r.json?.status === "error" ? ` message=${JSON.stringify(r.json.message)}` : "") +
      (r.err ? ` err=${r.err}` : "") +
      (Object.keys(r.hdr).length ? ` headers=${JSON.stringify(r.hdr)}` : ""));
  reqLog.push({ n: r.n, id, http: r.http, ms: r.ms, status: r.json?.status, startedAt: r.startedAt });
  return r;
}
const isTransient = (r) => !r || r.err || (r.http >= 500) || r.json?.code === 429 || (r.json?.code >= 500 && r.json?.code <= 599);
const isOk = (r) => r && !r.err && r.json && r.json.status !== "error";

async function step(id, kind, params, essential) {
  let r = await call(id, kind, params);
  if (essential && r && isTransient(r) && used < MAX_REQ) {
    const is429 = r.json?.code === 429;
    out(`[retry] ${id}: 一時的な失敗のため${is429 ? 65 : 20}秒後に1回だけ再試行（リクエスト数に加算）`);
    if (!TEST) await sleep(is429 ? 65000 : 20000);
    r = await call(`${id}(retry)`, kind, params);
  }
  return r;
}

// ---- 解析 ----
const toBars = (values) => values.map((v) => ({ datetime: v.datetime, open: +v.open, high: +v.high, low: +v.low, close: +v.close }));
function nyParts(dt) {
  const [d, t] = dt.split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  return { d, hh: t ? Number(t.slice(0, 2)) : 0, dow: new Date(Date.UTC(y, mo - 1, da)).getUTCDay() };
}
const inClosedBand = (dt) => { const p = nyParts(dt); return (p.dow === 5 && p.hh >= 17) || p.dow === 6 || (p.dow === 0 && p.hh < 17); };
const DOW = ["日", "月", "火", "水", "木", "金", "土"];
function addDays(ds, k) { const [y, m, d] = ds.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10); }

function analyzeHours(label, r) {
  if (!isOk(r) || !Array.isArray(r.json.values)) { out(`${label}: データなし`); return null; }
  const v = r.json.values;
  const newest = v[0].datetime, oldest = v[v.length - 1].datetime;
  const closed = v.filter((x) => inClosedBand(x.datetime));
  const byDow = {};
  for (const x of v) { const k = DOW[nyParts(x.datetime).dow]; byDow[k] = (byDow[k] || 0) + 1; }
  const asc = toBars(v).reverse();
  const sessions = aggregateToNySessions(asc);
  const dist = {};
  for (const s of sessions) dist[s.bars] = (dist[s.bars] || 0) + 1;
  out(`${label}: 本数=${v.length} 最新=${newest} 最古=${oldest}`);
  out(`${label}: 休場帯(金17時NY〜日17時NY)に入る足=${closed.length}本 / 曜日別本数(NY現地)=${JSON.stringify(byDow)}`);
  if (closed.length) out(`${label}: 休場帯の足の例=${JSON.stringify(closed.slice(0, 6).map((x) => x.datetime))}`);
  out(`${label}: fetch.jsと同じNY17区切りで作れるセッション数=${sessions.length} / セッション別の足本数の分布=${JSON.stringify(dist)}`);
  return { asc, sessions, closed: closed.length };
}

function main_analysis(R) {
  out("");
  out("=================== RESULT ===================");
  // Q1
  out("【Q1】outputsize 上限と start_date/end_date");
  const f1 = analyzeHours("F1(1h, outputsize=5000)", R.F1);
  if (R.F1) out(`F1 meta=${JSON.stringify(R.F1.json?.meta ?? null)}`);
  const f5 = R.F5;
  if (f5) {
    out(`F5(outputsize=5001): http=${f5.http} status=${f5.json?.status} ` + (Array.isArray(f5.json?.values) ? `values=${f5.json.values.length}` : `code=${f5.json?.code} message=${JSON.stringify(f5.json?.message)}`));
  } else out("F5(outputsize=5001): 未実行");
  if (isOk(R.F3)) {
    const v = R.F3.json.values;
    const dates = {};
    for (const x of v) { const d = x.datetime.slice(0, 10); dates[d] = (dates[d] || 0) + 1; }
    let expected = 0;
    for (let t = Date.UTC(2023, 9, 2); t <= Date.UTC(2023, 9, 13, 23); t += 3600000) {
      const d = new Date(t); const ds = d.toISOString().slice(0, 10) + " " + String(d.getUTCHours()).padStart(2, "0") + ":00:00";
      if (!inClosedBand(ds)) expected += 1;
    }
    out(`F3(期間指定 2023-10-02〜10-13, outputsize=5000): 本数=${v.length}（休場帯の足なしと仮定した想定=${expected}） 最新=${v[0].datetime} 最古=${v[v.length - 1].datetime}`);
    out(`F3: 日付別本数=${JSON.stringify(dates)}`);
    out(`F3: 休場帯の足=${v.filter((x) => inClosedBand(x.datetime)).length}本 / 範囲内か=${v.every((x) => x.datetime >= "2023-10-02" && x.datetime <= "2023-10-13 23:59:59")}`);
  } else out(`F3(期間指定): ${R.F3 ? `失敗 http=${R.F3.http} code=${R.F3.json?.code} message=${JSON.stringify(R.F3.json?.message)}` : "未実行"}`);
  // Q2
  out("【Q2】遡れる期間");
  if (isOk(R.F2)) out(`F2(start_date=2000-01-01, order=ASC, outputsize=5): 最古の足=${JSON.stringify(R.F2.json.values.map((x) => x.datetime))}`);
  else out(`F2: ${R.F2 ? `失敗 http=${R.F2.http} code=${R.F2.json?.code} message=${JSON.stringify(R.F2.json?.message)}` : "未実行"}`);
  out(`F3で2023-10の足が${isOk(R.F3) && R.F3.json.values.length > 0 ? "取得できた" : "取得できなかった"}`);
  // Q3
  out("【Q3】週末の足");
  out(`F1の休場帯の足=${f1 ? f1.closed : "-"}本（0なら週末の足は返らない）`);
  // Q4
  out("【Q4】クレジット");
  const usageIds = ["A0a", "A0b", "A1", "A2", "A3"];
  let prev = null;
  for (const id of usageIds) {
    const u = R[id];
    if (!u) { out(`${id}: 未実行`); continue; }
    out(`${id}: ${JSON.stringify(u.json)}`);
    if (prev && isOk(u) && isOk(prev)) {
      const keys = Object.keys(u.json).filter((k) => typeof u.json[k] === "number" && typeof prev.json[k] === "number");
      out(`  ${prev.id}→${id} の差: ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, u.json[k] - prev.json[k]])))}`);
    }
    if (isOk(u)) prev = { id, json: u.json };
  }
  out(`各取得の応答ヘッダ(クレジット関連): ${JSON.stringify(Object.fromEntries(["F1", "F3", "F4", "F2", "F5"].filter((k) => R[k]).map((k) => [k, R[k].hdr])))}`);
  // Q5
  out("【Q5】1day(timezone=America/New_York) と 1時間足から作った日足の比較");
  if (isOk(R.F4) && f1) {
    const days = R.F4.json.values; // 新しい順
    out(`F4 meta=${JSON.stringify(R.F4.json.meta)}`);
    const dowCount = {};
    for (const x of days) { const k = DOW[nyParts(x.datetime.slice(0, 10) + " 00:00:00").dow]; dowCount[k] = (dowCount[k] || 0) + 1; }
    out(`F4: 本数=${days.length} 最新=${days[0].datetime} 最古=${days[days.length - 1].datetime} / ラベルの曜日分布=${JSON.stringify(dowCount)}`);
    const cutoff = lastCompletedSessionDate(new Date());
    const mine = new Map(f1.sessions.filter((s) => s.date <= cutoff && s.bars >= 6).map((s) => [s.date, s]));
    const TOLR = 0.000015;
    const target = days.slice(0, 20);
    const stat = {};
    for (const k of [-1, 0, 1]) stat[k] = { all4: 0, n: 0, maxDiff: 0 };
    const rows = [];
    for (const d of target) {
      const D = d.datetime.slice(0, 10);
      const o = { D, c: [+d.open, +d.high, +d.low, +d.close] };
      for (const k of [-1, 0, 1]) {
        const s = mine.get(addDays(D, k));
        if (!s || s.bars < 24) continue;
        const diffs = [s.open - o.c[0], s.high - o.c[1], s.low - o.c[2], s.close - o.c[3]].map(Math.abs);
        const mx = Math.max(...diffs);
        stat[k].n += 1; stat[k].maxDiff = Math.max(stat[k].maxDiff, mx);
        if (mx <= TOLR) stat[k].all4 += 1;
        if (k === 0) o.k0 = { bars: s.bars, maxDiffE5: Math.round(mx * 1e5) };
      }
      rows.push(o);
    }
    for (const k of [-1, 0, 1]) out(`ラベル差 ${k >= 0 ? "+" : ""}${k}日（1day のラベル日 D と 1時間足セッション D${k >= 0 ? "+" : ""}${k} を比較）: 比較可能=${stat[k].n}件 / O,H,L,C すべて一致=${stat[k].all4}件 / 最大差=${Math.round(stat[k].maxDiff * 1e5)}（1e-5単位）`);
    out(`直近20日の突き合わせ（ラベルD同士）: ${JSON.stringify(rows.map((r) => ({ D: r.D, k0: r.k0 ?? "比較不可" })))}`);
    out(`1day直近3本: ${JSON.stringify(days.slice(0, 3))}`);
    const best = Object.entries(stat).sort((a, b) => b[1].all4 - a[1].all4)[0];
    if (best[1].all4 === 0) out("判定: どのラベル差でも O,H,L,C が一致しない → 1day足は『1時間足から作ったNY17区切りの日足』とは別の区切り");
    else out(`判定: 最も一致するラベル差=${best[0]}日（${best[1].all4}/${best[1].n}件）。NY17時区切りと言えるのは、この件数が比較可能件数とほぼ同数のときのみ`);
  } else out("F4 または F1 が無いため比較できません");
}

async function main() {
  out(`probe: 開始 ${new Date().toISOString()} / 銘柄=${SYMBOL} のみ / 上限${MAX_REQ}回 / 間隔${SPACING_MS}ms以上`);
  await waitStartWindow();
  const t0 = new Date();
  out(`probe: API呼び出し開始 ${t0.toISOString()}`);
  const R = {};
  const T = TZ;
  const plan = [
    ["A0a", "usage", null, false],
    ["A0b", "usage", null, false],
    ["F1", "ts", { interval: "1h", outputsize: "5000", timezone: T }, true],
    ["A1", "usage", null, false],
    ["F3", "ts", { interval: "1h", start_date: "2023-10-02 00:00:00", end_date: "2023-10-13 23:59:59", outputsize: "5000", timezone: T }, true],
    ["A2", "usage", null, false],
    ["F4", "ts", { interval: "1day", outputsize: "30", timezone: T }, true],
    ["F2", "ts", { interval: "1h", start_date: "2000-01-01", order: "ASC", outputsize: "5", timezone: T }, false],
    ["A3", "usage", null, false],
    ["F5", "ts", { interval: "1h", outputsize: "5001", timezone: T }, false], // 予算が残った場合のみ（上限確認）
  ];
  let consec429 = 0;
  for (const [id, kind, params, essential] of plan) {
    const r = await step(id, kind, params, essential);
    if (r) R[id] = r;
    if (r && (r.http === 401 || r.http === 403 || [401, 403].includes(r.json?.code))) {
      out(`[abort] ${id}: 認証/権限エラーのため以降の呼び出しを中止します`);
      break;
    }
    consec429 = r && r.json?.code === 429 ? consec429 + 1 : 0;
    if (consec429 >= 2 || (id === "A0a" && r && r.json?.code === 429)) {
      out(`[abort] ${id}: レート制限/クレジット枯渇(429)のため、予算を使い切る前に以降の呼び出しを中止します`);
      break;
    }
  }
  const t1 = new Date();
  main_analysis(R);
  out("");
  out(`probe: API呼び出し期間 ${t0.toISOString()} 〜 ${t1.toISOString()} （UTC）`);
  out(`probe: 使用リクエスト数 ${used}/${MAX_REQ}`);
  out(`probe: リクエスト一覧 ${JSON.stringify(reqLog)}`);
}

main().catch((e) => { out(`ERROR: ${e.message}`); process.exit(1); });
