"use strict";
// 一時的な Twelve Data 実API確認 第3弾（EURUSD・追加3回。第2弾と合わせて合計10回）。結果はジョブログに出すだけ。コミットしない。
// 安全装置: リクエスト総数<=10 / 間隔16秒 / 他ワークフロー稼働中は待機 / daily の起動分(:18〜:24 UTC)を避ける / APIキーは出力しない。

const TEST = process.env.PROBE_TEST === "1"; // ローカルのモック検証専用。ワークフローでは設定しない
const MAX_REQ = 3; // 第2弾の7回と合わせて合計10回以内
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


// ================= 解析 =================
function dailyFromUtc(bars) {
  return aggregateToNySessions(bars.map((b) => ({ datetime: isoLabel(nyWallMs(b.ms)), open: b.o, high: b.h, low: b.l, close: b.c })));
}
function analyzeDay(name, values) {
  const rows = values.map((v) => ({ date: v.datetime.slice(0, 10), open: +v.open, high: +v.high, low: +v.low, close: +v.close, rc: v.close }));
  const seen = new Map(); let wk = 0;
  for (const r of rows) {
    const w = dowOf(r.date) === 0 || dowOf(r.date) === 6;
    if (w) wk++;
    else if (!seen.has(r.date)) seen.set(r.date, r);
  }
  const dec = decimalsOf(rows);
  out(`${name}: 行数=${rows.length} / 土日の行=${wk}件 / 土日と重複を除いた平日=${seen.size}件 / 小数桁=${dec}`);
  return { map: seen, unit: Math.pow(10, -dec), dec };
}

function boundarySearch(tag, bars, day, from, to) {
  const unit = day.unit;
  const cEnd = new Map(), oStart = new Map();
  for (const b of bars) { cEnd.set(b.ms + HR, b.c); oStart.set(b.ms, b.o); }
  const dates = [...day.map.keys()].filter((d) => d >= from && d <= to).sort();
  const find = (map, t0, target, tol) => { const r = []; for (let off = -24; off <= 24; off++) { const v = map.get(t0 + off * HR); if (v !== undefined && Math.abs(v - target) <= tol) r.push(off); } return r; };
  const cls = (arr) => (arr.length === 1 ? String(arr[0]) : arr.length === 0 ? "なし" : arr.includes(0) ? "0を含む複数" : "複数");
  const H = { exact: { close: {}, open: {} }, near: { close: {}, open: {} } };
  const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const monthly = {}, runs = [], samples = [];
  for (const D of dates) {
    const d = day.map.get(D);
    const t0 = nyLocalToUtcMs(lbl(D) + 17 * HR);
    const ce = find(cEnd, t0, d.close, unit * 0.5), oe = find(oStart, t0 - 24 * HR, d.open, unit * 0.5);
    const cn = find(cEnd, t0, d.close, unit * 1.5), on = find(oStart, t0 - 24 * HR, d.open, unit * 1.5);
    inc(H.exact.close, cls(ce)); inc(H.exact.open, cls(oe)); inc(H.near.close, cls(cn)); inc(H.near.open, cls(on));
    const m = D.slice(0, 7);
    monthly[m] = monthly[m] || { close: {}, open: {} };
    inc(monthly[m].close, cls(ce)); inc(monthly[m].open, cls(oe));
    const label = cls(ce);
    const last = runs[runs.length - 1];
    if (last && last.label === label) { last.to = D; last.n++; } else runs.push({ from: D, to: D, label, n: 1 });
    if (samples.length < 4 && ce.length === 1) samples.push(`${D}: 1dayの終値=${d.close} は 1時間足の「終了時刻」が NY17:00${ce[0] >= 0 ? "+" : ""}${ce[0]}h(UTC ${isoLabel(t0 + ce[0] * HR).slice(5, 16)})の価格と一致`);
  }
  out(`[${tag}] 対象=${from}〜${to} の1day平日 ${dates.length}件（1時間足のデータがある日のみ一致を数える）`);
  out(`  1dayの終値が、1時間足の「終了時刻=NY17:00から何時間ずれた時刻」の価格と一致するか（0ならNY17:00区切り）。完全一致: ${JSON.stringify(H.exact.close)} / ±1.5単位まで許容: ${JSON.stringify(H.near.close)}`);
  out(`  1dayの始値が、1時間足の「開始時刻=前日NY17:00から何時間ずれた時刻」の価格と一致するか。完全一致: ${JSON.stringify(H.exact.open)} / ±1.5単位まで許容: ${JSON.stringify(H.near.open)}`);
  for (const s of samples) out(`  例 ${s}`);
  out(`  月別（終値・完全一致）: ${Object.entries(monthly).map(([m, v]) => `${m}=${JSON.stringify(v.close)}`).join(" / ")}`);
  out(`  月別（始値・完全一致）: ${Object.entries(monthly).map(([m, v]) => `${m}=${JSON.stringify(v.open)}`).join(" / ")}`);
  out(`  終値の一致時刻が続く区間（最大40件）: ${runs.slice(0, 40).map((r) => `${r.from}〜${r.to}[${r.label}]×${r.n}`).join(" ")}${runs.length > 40 ? ` …他${runs.length - 40}区間` : ""}`);
}

function continuity(tag, day, from, to) {
  const unit = day.unit;
  const ds = [...day.map.keys()].filter((d) => d >= from && d <= to).sort();
  let n = 0, eq = 0, nF = 0, eqF = 0, sum = 0;
  for (let i = 0; i + 1 < ds.length; i++) {
    const a = day.map.get(ds[i]), b = day.map.get(ds[i + 1]);
    const gap = (lbl(ds[i + 1]) - lbl(ds[i])) / DAY;
    const diff = Math.abs(b.open - a.close) / unit;
    if (gap === 1) { n++; sum += diff; if (diff < 0.5) eq++; } else if (gap === 3) { nF++; if (diff < 0.5) eqF++; }
  }
  out(`[${tag}] 1dayの連続性: 月〜木→翌日の「始値＝前日終値」が完全一致 ${pct(eq, n)}（平均差 ${(sum / Math.max(n, 1)).toFixed(1)}単位）/ 金→月 ${pct(eqF, nF)}`);
}

function mismatchRuns(tag, built, day, from) {
  const unit = day.unit;
  const mode = modeOf(built.map((s) => s.bars));
  const seq = built.filter((s) => s.bars === mode && s.date >= from && day.map.has(s.date)).map((s) => {
    const d = day.map.get(s.date);
    return { date: s.date, ok: ["open", "high", "low", "close"].every((f) => Math.round(Math.abs(s[f] - d[f]) / unit) === 0) };
  });
  const runs = [];
  for (const x of seq) { const l = runs[runs.length - 1]; if (l && l.ok === x.ok) { l.to = x.date; l.n++; } else runs.push({ from: x.date, to: x.date, ok: x.ok, n: 1 }); }
  out(`[${tag}] NY17区切りで作った日足と1dayの一致/不一致が続く区間（4つ全部一致=○）: ${runs.slice(0, 40).map((r) => `${r.from}〜${r.to}[${r.ok ? "○" : "×"}]×${r.n}`).join(" ")}${runs.length > 40 ? ` …他${runs.length - 40}区間` : ""}`);
}

// ================= 実行 =================
async function main() {
  out(`probe3: 開始 ${new Date().toISOString()} / EURUSDのみ・追加3回（第2弾の7回と合わせて合計10回）/ 間隔${SPACING_MS}ms以上`);
  await waitStartWindow();
  const t0 = new Date();
  out(`probe3: API呼び出し開始 ${t0.toISOString()}`);
  const OLD = { start_date: "2023-10-02 00:00:00", end_date: "2024-03-22 23:59:59", outputsize: "5000" };
  const plan = [
    ["E_UTC_OLD", "EUR/USD", { interval: "1h", ...OLD, timezone: "UTC" }],
    ["E_1D", "EUR/USD", { interval: "1day", start_date: "2023-09-25", outputsize: "5000", timezone: "America/New_York" }],
    ["E_UTC_NEW", "EUR/USD", { interval: "1h", outputsize: "5000", timezone: "UTC" }],
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
  const B = {};
  B.old = safe("概要old", () => fetchSummary("E_UTC_OLD", R.E_UTC_OLD));
  B.new = safe("概要new", () => fetchSummary("E_UTC_NEW", R.E_UTC_NEW));
  const day = isOk(R.E_1D) ? safe("1day", () => analyzeDay("EURUSD 1day", R.E_1D.json.values)) : null;
  if (!day) out("E_1D: データなし");
  const todayD = new Date().toISOString().slice(0, 10);

  out(""); out("【A】1dayの終値・始値は、1時間足のどの時刻の価格か（EURUSD。値そのものの一致で時刻を逆算）");
  if (day && B.old) safe("境界old", () => boundarySearch("2023-10〜2024-03", B.old, day, "2023-10-03", "2024-03-22"));
  if (day && B.new) safe("境界new", () => boundarySearch("直近5000本の期間", B.new, day, "2026-03-12", todayD));

  out(""); out("【B】1dayの連続性（始値＝前日終値か）");
  if (day) {
    safe("連続old", () => continuity("2023-10〜2024-03", day, "2023-10-03", "2024-03-22"));
    safe("連続new", () => continuity("2026-03〜", day, "2026-03-12", todayD));
    safe("連続mid", () => continuity("2024-04〜2026-02", day, "2024-04-01", "2026-02-28"));
  }

  out(""); out("【C】NY17区切りで作った日足と1dayの一致が崩れる区間");
  if (day && B.new) safe("一致new", () => mismatchRuns("直近5000本の期間", dailyFromUtc(B.new), day, "2026-03-12"));
  if (day && B.old) safe("一致old", () => mismatchRuns("2023-10〜2024-03", dailyFromUtc(B.old), day, "2023-10-03"));

  out(""); out(`probe3: API呼び出し期間 ${t0.toISOString()} 〜 ${t1.toISOString()} （UTC）`);
  out(`probe3: この実行の使用リクエスト数 ${used}（第2弾の7回と合わせて ${used + 7}/10）`);
  out(`probe3: リクエスト一覧 ${JSON.stringify(reqLog)}`);
}
main().catch((e) => { out(`ERROR: ${e.message}`); process.exit(1); });
