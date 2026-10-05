"use strict";
// 一時的な Twelve Data 実API確認 第2弾（EURUSD / XAUUSD）。結果はジョブログに出すだけ。コミットしない。
// 安全装置: リクエスト総数<=10 / 間隔16秒 / 他ワークフロー稼働中は待機 / daily の起動分(:18〜:24 UTC)を避ける / APIキーは出力しない。

const TEST = process.env.PROBE_TEST === "1"; // ローカルのモック検証専用。ワークフローでは設定しない
const MAX_REQ = 10;
const SPACING_MS = TEST ? Number(process.env.PROBE_SPACING_MS || 0) : 16000;
const API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const GH_TOKEN = process.env.GH_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || "";
const RUN_ID = process.env.GITHUB_RUN_ID || "";
const WATCH_NAMES = new Set(["Intraday Snapshot", "Daily FX Data", "TMP Twelve Data probe"]);
const HR = 3600000, DAY = 86400000;

if (!API_KEY) { console.log("ERROR: TWELVE_DATA_API_KEY が未設定です（APIは呼んでいません）"); process.exit(1); }
if (Intl.DateTimeFormat().resolvedOptions().timeZone !== "UTC") { console.log("ERROR: 実行環境のタイムゾーンがUTCではないため中止（APIは呼んでいません）"); process.exit(1); }

const scrub = (s) => String(s).split(API_KEY).join("***").replace(/apikey=[^&\s"']+/gi, "apikey=***");
const out = (...a) => console.log(scrub(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 他ワークフローとの重なり回避 =================
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
// 外部cron(cron-job.org)は 21:20 / 22:20 / 23:20 UTC に daily を起動し、その直後に intraday が続く
const inBlackout = (d) => !TEST && [21, 22, 23].includes(d.getUTCHours()) && d.getUTCMinutes() >= 18 && d.getUTCMinutes() <= 24;
async function waitQuiet(label) {
  const deadline = Date.now() + (TEST ? 3000 : 8 * 60000);
  for (;;) {
    let act = null;
    for (let i = 0; i < 3; i++) {
      try { act = await activeOthers(); break; }
      catch (e) {
        if (i === 2) throw new Error(`他ワークフローの稼働を確認できないため中止（Twelve Dataは呼んでいません）: ${e.message}`);
        await sleep(TEST ? 0 : 5000);
      }
    }
    const black = inBlackout(new Date());
    if (!act.length && !black) return;
    out(`[guard] ${label}: 待機 → ${black ? "dailyの起動時間帯(:18〜:24 UTC) " : ""}${act.map((r) => `${r.name}#${r.id}(${r.status})`).join(", ")}`);
    if (Date.now() > deadline) throw new Error("他ワークフローの稼働/起動時間帯が長引いたため中止しました");
    await sleep(TEST ? 100 : 10000);
  }
}
async function waitStartWindow() {
  if (TEST) return;
  for (;;) {
    const now = new Date();
    const m = now.getUTCMinutes() % 15, s = now.getUTCSeconds();
    if (!inBlackout(now) && (m === 10 || (m === 11 && s < 30))) return;
    const ms = ((10 - m + 15) % 15) * 60000 - s * 1000;
    out(`[window] 開始を待機: 現在 ${now.toISOString()} → 次の枠まで約${Math.round(ms / 1000)}秒`);
    await sleep(Math.min(Math.max(ms, 1000), 60000));
  }
}

// ================= Twelve Data 呼び出し =================
let used = 0, lastEnd = 0;
const reqLog = [];
const HDR_RE = /credit|limit|usage|plan|rate|quota|retry/i;
async function call(id, symbol, params) {
  if (used >= MAX_REQ) { out(`[skip] ${id}: リクエスト上限(${MAX_REQ})に達したため実行しません`); return null; }
  const wait = lastEnd + SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  await waitQuiet(id);
  const spare = lastEnd + SPACING_MS - Date.now();
  if (spare > 0) await sleep(spare);
  used += 1;
  const q = new URLSearchParams({ symbol, ...params });
  q.set("apikey", API_KEY);
  const url = `https://api.twelvedata.com/time_series?${q.toString()}`;
  const t0 = Date.now();
  const r = { id, n: used, startedAt: new Date().toISOString(), http: null, ms: null, bytes: null, json: null, err: null, hdr: {} };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    r.http = res.status;
    for (const [k, v] of res.headers) if (HDR_RE.test(k)) r.hdr[k] = v;
    const text = await res.text();
    r.bytes = Buffer.byteLength(text);
    try { r.json = JSON.parse(text); } catch { r.err = `JSON解析失敗(先頭80字): ${scrub(text.slice(0, 80))}`; }
  } catch (e) { r.err = `${e.name}: ${e.message}`; }
  r.ms = Date.now() - t0;
  lastEnd = Date.now();
  const vals = Array.isArray(r.json?.values) ? r.json.values.length : undefined;
  out(`[#${r.n}/${MAX_REQ}] ${id} ${symbol} http=${r.http} ${r.ms}ms ${r.bytes ?? "-"}B status=${r.json?.status ?? "-"}` +
      (vals !== undefined ? ` values=${vals}` : "") + (r.json?.code ? ` code=${r.json.code}` : "") +
      (r.json?.status === "error" ? ` message=${JSON.stringify(r.json.message)}` : "") + (r.err ? ` err=${r.err}` : "") +
      (Object.keys(r.hdr).length ? ` headers=${JSON.stringify(r.hdr)}` : ""));
  reqLog.push({ n: r.n, id, http: r.http, ms: r.ms, startedAt: r.startedAt });
  return r;
}
const isTransient = (r) => !r || r.err || r.http >= 500 || r.json?.code === 429 || (r.json?.code >= 500 && r.json?.code <= 599);
const isOk = (r) => r && !r.err && r.json && r.json.status !== "error" && Array.isArray(r.json.values);
async function step(id, symbol, params) {
  let r = await call(id, symbol, params);
  if (r && isTransient(r) && used < MAX_REQ) {
    const is429 = r.json?.code === 429;
    out(`[retry] ${id}: 一時的な失敗のため${is429 ? 65 : 20}秒後に1回だけ再試行（リクエスト数に加算）`);
    if (!TEST) await sleep(is429 ? 65000 : 20000);
    r = await call(`${id}(retry)`, symbol, params);
  }
  return r;
}

// ================= fetch.js から逐語コピー（日足の作り方を同じにするため）=================
function fmtDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
// ================= ここまで =================

// ================= 時刻・タイムゾーン =================
const nyFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function nyWallMs(utcMs) { // UTC時刻 → NY現地の壁時計（UTCとして表した値）
  const p = {};
  for (const x of nyFmt.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
const nyOffsetH = (utcMs) => (nyWallMs(utcMs) - utcMs) / HR; // 夏 -4 / 冬 -5
function nyLocalToUtcMs(wallMs) { // NY現地の壁時計 → UTC（曖昧な時刻は対象外）
  let utc = wallMs - nyOffsetH(wallMs + 5 * HR) * HR;
  const off2 = nyOffsetH(utc);
  utc = wallMs - off2 * HR;
  return utc;
}
const lbl = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?/.exec(s); return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)); };
const isoLabel = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (ds, k) => dateOf(lbl(ds) + k * DAY);
const DOWJ = ["日", "月", "火", "水", "木", "金", "土"];
const dowOf = (ds) => new Date(lbl(ds)).getUTCDay();
const dstState = (ds) => (nyOffsetH(lbl(ds) + 17 * HR) === -4 ? "夏" : "冬"); // その日のNY 12:00 付近の状態

function parseBars(values) {
  const a = values.map((v) => ({ label: v.datetime, ms: lbl(v.datetime), o: +v.open, h: +v.high, l: +v.low, c: +v.close, ro: v.open, rh: v.high, rl: v.low, rc: v.close }));
  a.sort((x, y) => x.ms - y.ms);
  return a;
}
const decimalsOf = (rows) => Math.max(...rows.slice(0, 300).map((r) => ((String(r.rc ?? r.close ?? "").split(".")[1]) || "").length));
const modeOf = (arr) => { const m = {}; for (const x of arr) m[x] = (m[x] || 0) + 1; return +Object.entries(m).sort((a, b) => b[1] - a[1])[0][0]; };
const pct = (a, b) => (b ? `${a}/${b}(${(100 * a / b).toFixed(1)}%)` : "-");

function fetchSummary(name, r) {
  if (!isOk(r)) { out(`${name}: データなし`); return null; }
  const bars = parseBars(r.json.values);
  out(`${name}: 本数=${bars.length} 最古=${bars[0].label} 最新=${bars[bars.length - 1].label} meta=${JSON.stringify(r.json.meta ?? null)}`);
  return bars;
}

// ================= 解析1: 週ごとの 金曜の最後の足 / 日曜の最初の足 =================
function weekly(name, bars, kind) {
  const byDate = new Map();
  for (const b of bars) {
    const d = b.label.slice(0, 10);
    let e = byDate.get(d);
    if (!e) { e = { min: b.ms, max: b.ms, n: 0 }; byDate.set(d, e); }
    e.min = Math.min(e.min, b.ms); e.max = Math.max(e.max, b.ms); e.n++;
  }
  const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
  const st = (obs, exp) => { const dh = (obs - exp) / HR; return dh === 0 ? "OK" : `${dh > 0 ? "+" : ""}${dh}h`; };
  let nF = 0, okF = 0, nS = 0, okS = 0;
  out(`--- ${name}（${kind === "utc" ? "UTC表記" : "NY現地表記"}。期待: ${kind === "utc" ? "夏 最後20:00/最初21:00・冬 最後21:00/最初22:00" : "最後16:00/最初17:00（夏冬とも）"}）---`);
  for (const d of [...byDate.keys()].sort()) {
    if (dowOf(d) !== 5) continue;
    const f = byDate.get(d);
    const expLast = kind === "utc" ? nyLocalToUtcMs(lbl(d) + 17 * HR) - HR : lbl(d) + 16 * HR;
    const sd = addDays(d, 2), s = byDate.get(sd);
    const expFirst = kind === "utc" ? nyLocalToUtcMs(lbl(sd) + 17 * HR) : lbl(sd) + 17 * HR;
    nF++; if (f.max === expLast) okF++;
    let sunTxt = `${sd}(日) 最初=なし`;
    if (s) { nS++; if (s.min === expFirst) okS++; sunTxt = `${sd}(日) 最初=${hhmm(s.min)} (期待${hhmm(expFirst)}) ${st(s.min, expFirst)}`; }
    out(`${d}(金 ${dstState(d)}) 最後=${hhmm(f.max)} (期待${hhmm(expLast)}) ${st(f.max, expLast)} | ${sunTxt}`);
  }
  out(`${name}: 金曜の最後が期待どおり ${pct(okF, nF)} / 日曜の最初が期待どおり ${pct(okS, nS)}`);
  return { nF, okF, nS, okS };
}

// ================= 解析2: NY表記の足が、本来のNY現地時刻からどれだけずれているか =================
function impliedOffsets(utcBars, nyBars) {
  const key = (b) => `${b.ro}|${b.rh}|${b.rl}|${b.rc}`;
  const cu = new Map(), cn = new Map();
  for (const b of utcBars) cu.set(key(b), (cu.get(key(b)) || 0) + 1);
  for (const b of nyBars) cn.set(key(b), (cn.get(key(b)) || 0) + 1);
  const mu = new Map();
  for (const b of utcBars) if (cu.get(key(b)) === 1 && cn.get(key(b)) === 1) mu.set(key(b), b);
  const perDate = new Map(); let matched = 0, unmatched = 0;
  for (const b of nyBars) {
    const u = mu.get(key(b));
    if (!u || cn.get(key(b)) !== 1) { unmatched++; continue; }
    matched++;
    const implied = (b.ms - u.ms) / HR, truth = nyOffsetH(u.ms);
    const d = dateOf(u.ms);
    let e = perDate.get(d); if (!e) { e = { ok: 0, ng: 0, implied: new Set(), truth: new Set() }; perDate.set(d, e); }
    if (implied === truth) e.ok++; else e.ng++;
    e.implied.add(implied); e.truth.add(truth);
  }
  out(`UTC版とNY版を値（O/H/L/C）で突き合わせ: 一致した足=${matched} / 対応づけできなかった足=${unmatched}（値が同じ足が複数あるものは除外）`);
  const segs = [];
  for (const d of [...perDate.keys()].sort()) {
    const e = perDate.get(d);
    const state = e.ng === 0 ? "一致" : e.ok === 0 ? "ずれ" : "混在";
    const label = state === "一致" ? `一致(本来のNY時刻と同じ。オフセット${[...e.truth].join("/")}h)` : `${state}(NY表記が使ったオフセット${[...e.implied].join("/")}h・本来は${[...e.truth].join("/")}h)`;
    const last = segs[segs.length - 1];
    if (last && last.label === label) { last.to = d; last.days++; last.bars += e.ok + e.ng; }
    else segs.push({ from: d, to: d, label, days: 1, bars: e.ok + e.ng });
  }
  for (const s of segs) out(`  ${s.from} 〜 ${s.to}（${s.days}日・${s.bars}本）: ${s.label}`);
  return segs;
}

// ================= 解析3: 日足の作成と比較 =================
function dailyFromUtc(bars) {
  return aggregateToNySessions(bars.map((b) => ({ datetime: isoLabel(nyWallMs(b.ms)), open: b.o, high: b.h, low: b.l, close: b.c })));
}
function dailyFromNyLabels(bars) {
  return aggregateToNySessions(bars.map((b) => ({ datetime: b.label, open: b.o, high: b.h, low: b.l, close: b.c })));
}
function analyzeDay(name, values) {
  const rows = values.map((v) => ({ date: v.datetime.slice(0, 10), open: +v.open, high: +v.high, low: +v.low, close: +v.close, ro: v.open, rc: v.close, rh: v.high, rl: v.low }));
  const seen = new Map(); let wk = 0, dupWk = 0, dupWd = 0, dupWdDiff = 0;
  const monthly = {};
  for (const r of rows) {
    const w = dowOf(r.date) === 0 || dowOf(r.date) === 6;
    if (w) { wk++; const m = r.date.slice(0, 7); monthly[m] = (monthly[m] || 0) + 1; }
    if (seen.has(r.date)) {
      if (w) dupWk++; else { dupWd++; const p = seen.get(r.date); if (p.ro !== r.ro || p.rh !== r.rh || p.rl !== r.rl || p.rc !== r.rc) dupWdDiff++; }
    } else seen.set(r.date, r);
  }
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  out(`${name}: 行数=${rows.length} 期間=${sorted[0].date}〜${sorted[sorted.length - 1].date} / 土日の行=${wk}件 / 同じ日付の重複(2行目以降)=${dupWk + dupWd}件（うち土日=${dupWk}・平日=${dupWd}。平日の重複で値が違うもの=${dupWdDiff}）`);
  out(`${name}: 土日の行の月別件数=${JSON.stringify(monthly)}`);
  const first = new Map(); // 先頭に来た行（API順＝新しい順）を採用、土日は除外
  for (const r of rows) { const w = dowOf(r.date) === 0 || dowOf(r.date) === 6; if (!w && !first.has(r.date)) first.set(r.date, r); }
  out(`${name}: 土日と重複を除いた平日の行=${first.size}件`);
  const sample = sorted.filter((r) => dowOf(r.date) === 0 || dowOf(r.date) === 6).slice(-3);
  if (sample.length) out(`${name}: 土日の行の例(新しい3件)=${JSON.stringify(sample.map((r) => ({ d: r.date + DOWJ[dowOf(r.date)], o: r.ro, h: r.rh, l: r.rl, c: r.rc })))}`);
  const dec = decimalsOf(rows);
  return { map: first, unit: Math.pow(10, -dec), dec, rows };
}
function compare(tag, built, day, extra) {
  const unit = day.unit, FIELDS = [["open", "始値"], ["high", "高値"], ["low", "安値"], ["close", "終値"]];
  const mode = modeOf(built.map((s) => s.bars));
  const full = built.filter((s) => s.bars === mode);
  out(`[${tag}] 作れたセッション=${built.length}（足本数の最頻値=${mode}本。完全セッション=${full.length}件）/ 比較の単位=${unit.toFixed(day.dec)}`);
  const res = {};
  for (const k of [-1, 0, 1]) {
    const r = { n: 0, f: { open: [0, 0, 0], high: [0, 0, 0], low: [0, 0, 0], close: [0, 0, 0] }, all4: 0, max: 0, bad: [] };
    for (const s of full) {
      const d = day.map.get(addDays(s.date, k)); if (!d) continue;
      r.n++;
      let all = true; const us = {};
      for (const [f] of FIELDS) {
        const u = Math.round(Math.abs(s[f] - d[f]) / unit);
        us[f] = Math.round((s[f] - d[f]) / unit);
        if (u === 0) r.f[f][0]++; else all = false;
        if (u <= 1) r.f[f][1]++;
        if (u <= 10) r.f[f][2]++;
        r.max = Math.max(r.max, u);
      }
      if (all) r.all4++; else r.bad.push({ date: s.date, bars: s.bars, dst: dstState(s.date), us });
    }
    res[k] = r;
  }
  const r0 = res[0];
  out(`  ラベル差0日（同じ日付で比較）: 比較できた=${r0.n}件 / 4つ全部一致=${pct(r0.all4, r0.n)} / 最大差=${r0.max}単位`);
  out(`    始値 完全一致 ${pct(r0.f.open[0], r0.n)} ±1単位 ${pct(r0.f.open[1], r0.n)} ±10単位 ${pct(r0.f.open[2], r0.n)}`);
  out(`    高値 完全一致 ${pct(r0.f.high[0], r0.n)} ±1単位 ${pct(r0.f.high[1], r0.n)} ±10単位 ${pct(r0.f.high[2], r0.n)}`);
  out(`    安値 完全一致 ${pct(r0.f.low[0], r0.n)} ±1単位 ${pct(r0.f.low[1], r0.n)} ±10単位 ${pct(r0.f.low[2], r0.n)}`);
  out(`    終値 完全一致 ${pct(r0.f.close[0], r0.n)} ±1単位 ${pct(r0.f.close[1], r0.n)} ±10単位 ${pct(r0.f.close[2], r0.n)}`);
  out(`  参考 ラベル差-1日: 4つ全部一致=${pct(res[-1].all4, res[-1].n)} / ラベル差+1日: 4つ全部一致=${pct(res[1].all4, res[1].n)}`);
  const byDst = { 夏: [0, 0], 冬: [0, 0] };
  for (const s of full) { const d = day.map.get(s.date); if (!d) continue; const ok = ["open", "high", "low", "close"].every((f) => Math.round(Math.abs(s[f] - d[f]) / unit) === 0); byDst[dstState(s.date)][1]++; if (ok) byDst[dstState(s.date)][0]++; }
  out(`  夏時間のセッション: 4つ全部一致=${pct(...byDst.夏)} / 冬時間のセッション: 4つ全部一致=${pct(...byDst.冬)}`);
  if (r0.bad.length) out(`  不一致の例（最大14件、差=こちらの値−1day の値、単位）: ${r0.bad.slice(0, 14).map((b) => `${b.date}[${b.dst},${b.bars}本]O${b.us.open >= 0 ? "+" : ""}${b.us.open} H${b.us.high >= 0 ? "+" : ""}${b.us.high} L${b.us.low >= 0 ? "+" : ""}${b.us.low} C${b.us.close >= 0 ? "+" : ""}${b.us.close}`).join(" / ")}`);
  const shortS = built.filter((s) => s.bars !== mode);
  if (shortS.length) {
    out(`  完全でないセッション（${mode}本未満または超過）${shortS.length}件: ${shortS.slice(0, 20).map((s) => { const d = day.map.get(s.date); const dd = d ? ["open", "high", "low", "close"].map((f) => Math.round((s[f] - d[f]) / unit)).join("/") : "1dayに無し"; return `${s.date}:${s.bars}本(${dd})`; }).join(" ")}${shortS.length > 20 ? " …" : ""}`);
  }
  if (extra) out(`  ${extra}`);
  return res;
}
function compareBuilt(tag, a, b) {
  const mb = new Map(b.map((s) => [s.date, s]));
  let n = 0, same = 0; const diff = [];
  for (const s of a) {
    const t = mb.get(s.date); if (!t) continue; n++;
    if (s.open === t.open && s.high === t.high && s.low === t.low && s.close === t.close && s.bars === t.bars) same++; else diff.push(`${s.date}[${dstState(s.date)}] ${s.bars}本/${t.bars}本`);
  }
  out(`[${tag}] 同じ日付のセッション=${n}件 / 値も本数も完全一致=${pct(same, n)}${diff.length ? ` / 違う日の例（最大12）: ${diff.slice(0, 12).join(", ")}` : ""}`);
}
function closedBand(name, bars) {
  const inBand = (ms) => { const w = new Date(nyWallMs(ms)); const dow = w.getUTCDay(), h = w.getUTCHours(); return (dow === 5 && h >= 17) || dow === 6 || (dow === 0 && h < 17); };
  const cb = bars.filter((b) => inBand(b.ms));
  const flat = cb.filter((b) => b.h === b.l && b.o === b.c && b.o === b.h).length;
  const range = cb.length ? cb.reduce((a, b) => a + (b.h - b.l), 0) / cb.length : 0;
  const nb = bars.filter((b) => !inBand(b.ms));
  const rangeN = nb.length ? nb.reduce((a, b) => a + (b.h - b.l), 0) / nb.length : 0;
  out(`${name}: 休場帯(金17時NY〜日17時NY)の足=${cb.length}本（うち値動きなし(O=H=L=C)=${flat}本）/ 平均値幅 休場帯=${range.toPrecision(3)} 通常=${rangeN.toPrecision(3)}`);
}

// ================= 実行 =================
async function main() {
  out(`probe2: 開始 ${new Date().toISOString()} / EURUSD・XAUUSD / 上限${MAX_REQ}回 / 間隔${SPACING_MS}ms以上 / api_usage は使わない`);
  await waitStartWindow();
  const t0 = new Date();
  out(`probe2: API呼び出し開始 ${t0.toISOString()}`);
  const OLD = { start_date: "2023-10-02 00:00:00", end_date: "2024-03-22 23:59:59", outputsize: "5000" };
  const plan = [
    ["E_UTC_OLD", "EUR/USD", { interval: "1h", ...OLD, timezone: "UTC" }],
    ["E_NY_OLD", "EUR/USD", { interval: "1h", ...OLD, timezone: "America/New_York" }],
    ["E_UTC_NEW", "EUR/USD", { interval: "1h", outputsize: "5000", timezone: "UTC" }],
    ["E_1D", "EUR/USD", { interval: "1day", start_date: "2023-09-25", outputsize: "5000", timezone: "America/New_York" }],
    ["X_UTC_OLD", "XAU/USD", { interval: "1h", ...OLD, timezone: "UTC" }],
    ["X_UTC_NEW", "XAU/USD", { interval: "1h", outputsize: "5000", timezone: "UTC" }],
    ["X_1D", "XAU/USD", { interval: "1day", start_date: "2023-09-25", outputsize: "5000", timezone: "America/New_York" }],
  ];
  const R = {};
  let consec429 = 0;
  for (const [id, sym, params] of plan) {
    const r = await step(id, sym, params);
    if (r) R[id] = r;
    if (r && (r.http === 401 || r.http === 403 || [401, 403].includes(r.json?.code))) { out(`[abort] ${id}: 認証/権限エラーのため以降の呼び出しを中止します`); break; }
    consec429 = r && r.json?.code === 429 ? consec429 + 1 : 0;
    if (consec429 >= 2) { out(`[abort] ${id}: 429が続いたため以降の呼び出しを中止します`); break; }
  }
  const t1 = new Date();
  out(""); out("=================== RESULT ===================");
  const safe = (name, fn) => { try { return fn(); } catch (e) { out(`[解析エラー] ${name}: ${e.message}`); return null; } };

  out("【取得データの概要】");
  const B = {};
  for (const [id] of plan) B[id] = safe(`概要 ${id}`, () => (id.endsWith("1D") ? (isOk(R[id]) ? (out(`${id}: 行数=${R[id].json.values.length} meta=${JSON.stringify(R[id].json.meta ?? null)}`), R[id].json.values) : (out(`${id}: データなし`), null)) : fetchSummary(id, R[id])));

  out(""); out("【1】EURUSD 1時間足 UTC: 週ごとの金曜の最後の足 / 日曜の最初の足（2023-10-02〜2024-03-22）");
  safe("週表UTC", () => B.E_UTC_OLD && weekly("EURUSD UTC", B.E_UTC_OLD, "utc"));

  out(""); out("【2】EURUSD 1時間足 NY表記: 週ごとの一覧と、ずれが出る期間・消える場所");
  safe("週表NY", () => B.E_NY_OLD && weekly("EURUSD NY表記", B.E_NY_OLD, "ny"));
  safe("オフセット", () => B.E_UTC_OLD && B.E_NY_OLD && impliedOffsets(B.E_UTC_OLD, B.E_NY_OLD));

  out(""); out("【5-1】1day の土日の行・重複行");
  const D = {};
  D.E = safe("1day EUR", () => (isOk(R.E_1D) ? analyzeDay("EURUSD 1day", R.E_1D.json.values) : null));
  D.X = safe("1day XAU", () => (isOk(R.X_1D) ? analyzeDay("XAUUSD 1day", R.X_1D.json.values) : null));

  out(""); out("【3】EURUSD: 日足の比較（1day は土日・重複を除いた平日の行。同じ日付で比較）");
  let eOld = null, eOldNy = null, eNew = null, xOld = null, xNew = null;
  safe("構築", () => {
    if (B.E_UTC_OLD) eOld = dailyFromUtc(B.E_UTC_OLD);
    if (B.E_NY_OLD) eOldNy = dailyFromNyLabels(B.E_NY_OLD);
    if (B.E_UTC_NEW) eNew = dailyFromUtc(B.E_UTC_NEW);
    if (B.X_UTC_OLD) xOld = dailyFromUtc(B.X_UTC_OLD);
    if (B.X_UTC_NEW) xNew = dailyFromUtc(B.X_UTC_NEW);
  });
  if (D.E) {
    if (eOld) safe("E旧UTC", () => compare("EURUSD 2023-10〜2024-03: UTC足→こちらでNY換算→17時区切り  vs  1day", eOld, D.E));
    if (eOldNy) safe("E旧NY", () => compare("EURUSD 2023-10〜2024-03: NY表記の足→fetch.jsと同じ作り方(現行方式)  vs  1day", eOldNy, D.E));
    if (eNew) safe("E新UTC", () => compare("EURUSD 直近5000本: UTC足→こちらでNY換算→17時区切り  vs  1day", eNew, D.E));
  }
  if (eOld && eOldNy) safe("E旧比較", () => compareBuilt("EURUSD 2023-10〜2024-03: UTC換算の日足 vs NY表記から作った日足", eOld, eOldNy));
  safe("EURUSD休場帯", () => { if (B.E_UTC_NEW) closedBand("EURUSD 直近5000本(UTC)", B.E_UTC_NEW); if (B.E_UTC_OLD) closedBand("EURUSD 2023-10〜2024-03(UTC)", B.E_UTC_OLD); });

  out(""); out("【4】XAUUSD: 同じ比較");
  if (B.X_UTC_OLD) safe("X週表", () => weekly("XAUUSD UTC（参考: FX標準の期待値との比較。金は日曜の開始が遅い場合がある）", B.X_UTC_OLD, "utc"));
  if (D.X) {
    if (xOld) safe("X旧UTC", () => compare("XAUUSD 2023-10〜2024-03: UTC足→NY換算→17時区切り  vs  1day", xOld, D.X));
    if (xNew) safe("X新UTC", () => compare("XAUUSD 直近5000本: UTC足→NY換算→17時区切り  vs  1day", xNew, D.X));
  }
  safe("XAU休場帯", () => { if (B.X_UTC_NEW) closedBand("XAUUSD 直近5000本(UTC)", B.X_UTC_NEW); if (B.X_UTC_OLD) closedBand("XAUUSD 2023-10〜2024-03(UTC)", B.X_UTC_OLD); });

  out(""); out(`probe2: API呼び出し期間 ${t0.toISOString()} 〜 ${t1.toISOString()} （UTC）`);
  out(`probe2: 使用リクエスト数 ${used}/${MAX_REQ}`);
  out(`probe2: リクエスト一覧 ${JSON.stringify(reqLog)}`);
}
main().catch((e) => { out(`ERROR: ${e.message}`); process.exit(1); });
