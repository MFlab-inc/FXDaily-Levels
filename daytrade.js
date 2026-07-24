/**
 * Daytrade Context Builder (V2-A)
 * intraday.js の直後に実行される想定（15分ごと）。
 * - Twelve Data: 11ペアのM5足（timezone=Asia/Tokyo指定・約5.5日分）
 * - M15/H1へ集計 → 直近確定足・スイング高安（左右Nフラクタル）
 * - セッション別高安（東京9-17 JST / ロンドン・NYは現地8-17を動的にJST換算）
 * - 当日高安（NY17:00区切り・M5から自前集計 = Phase B解決）
 * - イベントゲート（TRADE_OK / WAIT / NO_DATA）… data/economic-calendar.json + config
 * 出力: data/daytrade-context.json（事実データ+機械判定のみ。売買推奨は含まない）
 */

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.TWELVE_DATA_API_KEY;
if (!API_KEY) { console.error("ERROR: TWELVE_DATA_API_KEY 未設定"); process.exit(1); }

const dataDir = path.join(__dirname, "data");
const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "daytrade-rules.json"), "utf8"));

const PAIRS = [
  { code: "USDJPY", td: "USD/JPY", digits: 3 },
  { code: "EURUSD", td: "EUR/USD", digits: 5 },
  { code: "GBPUSD", td: "GBP/USD", digits: 5 },
  { code: "EURJPY", td: "EUR/JPY", digits: 3 },
  { code: "AUDUSD", td: "AUD/USD", digits: 5 },
  { code: "EURGBP", td: "EUR/GBP", digits: 5 },
  { code: "USDCAD", td: "USD/CAD", digits: 5 },
  { code: "USDCHF", td: "USD/CHF", digits: 5 },
  { code: "NZDUSD", td: "NZD/USD", digits: 5 },
  { code: "AUDNZD", td: "AUD/NZD", digits: 5 },
  { code: "XAUUSD", td: "XAU/USD", digits: 2 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d) => Number(n.toFixed(d));

// ---- 時刻ユーティリティ（JST基準）----
function jstNow(now = new Date()) {
  return new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
}
function jstIso(now = new Date()) {
  return now.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(" ", "T") + "+09:00";
}
function fmtHM(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fmtDT(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${fmtHM(d)}`;
}
// 他タイムゾーンの「現地h時」がJSTで何時かを動的算出（夏冬時間自動対応）
function localHourInJst(tz, localHour, now = new Date()) {
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const jst = jstNow(now);
  const diffH = Math.round((jst - local) / 3600000);
  return (((localHour + diffH) % 24) + 24) % 24;
}

// ---- Twelve Data M5取得（JST表記で返させる）----
async function fetchM5(tdSymbol) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}` +
    `&interval=5min&outputsize=1700&timezone=Asia/Tokyo&apikey=${API_KEY}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status === "error" || !json.values) {
    throw new Error(`Twelve Data エラー (${tdSymbol}): ${json.message || "no data"}`);
  }
  return json.values.map((v) => ({
    t: new Date(v.datetime.replace(" ", "T")), // JSTローカルとして解釈
    o: parseFloat(v.open), h: parseFloat(v.high),
    l: parseFloat(v.low),  c: parseFloat(v.close),
  })).reverse(); // 昇順へ
}

// ---- M5 → 上位足へ集計（JSTの区切り、確定足のみ）----
function aggregate(m5Asc, minutes, nowJst) {
  const buckets = new Map();
  for (const b of m5Asc) {
    const ms = b.t.getTime();
    const bucketStart = ms - (ms % (minutes * 60000));
    if (!buckets.has(bucketStart)) {
      buckets.set(bucketStart, { t: new Date(bucketStart), o: b.o, h: b.h, l: b.l, c: b.c });
    } else {
      const x = buckets.get(bucketStart);
      x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c;
    }
  }
  // 確定足のみ（バケット終了時刻が現在以前）
  return [...buckets.values()]
    .filter((x) => x.t.getTime() + minutes * 60000 <= nowJst.getTime())
    .sort((a, b) => a.t - b.t);
}

// ---- スイング高安（左右Nフラクタル、直近のもの）----
function lastSwings(barsAsc, left, right, digits) {
  let swingHigh = null, swingLow = null;
  for (let i = barsAsc.length - 1 - right; i >= left; i--) {
    const b = barsAsc[i];
    if (!swingHigh) {
      let ok = true;
      for (let k = 1; k <= left; k++) if (barsAsc[i - k].h >= b.h) { ok = false; break; }
      if (ok) for (let k = 1; k <= right; k++) if (barsAsc[i + k].h >= b.h) { ok = false; break; }
      if (ok) swingHigh = { price: round(b.h, digits), time_jst: fmtDT(b.t) };
    }
    if (!swingLow) {
      let ok = true;
      for (let k = 1; k <= left; k++) if (barsAsc[i - k].l <= b.l) { ok = false; break; }
      if (ok) for (let k = 1; k <= right; k++) if (barsAsc[i + k].l <= b.l) { ok = false; break; }
      if (ok) swingLow = { price: round(b.l, digits), time_jst: fmtDT(b.t) };
    }
    if (swingHigh && swingLow) break;
  }
  return { swing_high: swingHigh, swing_low: swingLow };
}

// ---- セッション別高安 ----
function sessionLevels(m5Asc, nowJst, digits) {
  const today0 = new Date(nowJst); today0.setHours(0, 0, 0, 0);
  const lonOpen = localHourInJst("Europe/London", 8);
  const lonClose = localHourInJst("Europe/London", 17);
  const nyOpen = localHourInJst("America/New_York", 8);
  const nyClose = localHourInJst("America/New_York", 17);

  const mk = (startH, endH) => {
    // endH <= startH の場合は日跨ぎ（例: ロンドン16→翌1時）
    const start = new Date(today0); start.setHours(startH);
    const end = new Date(today0); end.setHours(endH);
    if (endH <= startH) end.setDate(end.getDate() + 1);
    return { start, end };
  };
  const defs = {
    tokyo: mk(9, 17),
    london: mk(lonOpen, lonClose),
    ny: mk(nyOpen, nyClose),
  };

  const out = {};
  for (const [name, w] of Object.entries(defs)) {
    let high = null, low = null;
    for (const b of m5Asc) {
      if (b.t >= w.start && b.t < w.end) {
        high = high === null ? b.h : Math.max(high, b.h);
        low = low === null ? b.l : Math.min(low, b.l);
      }
    }
    const status = nowJst < w.start ? "not_started" : nowJst >= w.end ? "closed" : "open";
    out[name] = {
      high: high !== null ? round(high, digits) : null,
      low: low !== null ? round(low, digits) : null,
      status,
      window_jst: `${fmtHM(w.start)}-${fmtHM(w.end)}`,
    };
  }
  return out;
}

// ---- 当日高安（NY17:00区切り・M5から自前集計）----
function todayRange(m5Asc, nowJst, digits) {
  const boundaryHourJst = localHourInJst("America/New_York", 17); // 夏6時/冬7時
  const boundary = new Date(nowJst);
  boundary.setHours(boundaryHourJst, 0, 0, 0);
  if (nowJst < boundary) boundary.setDate(boundary.getDate() - 1);
  let high = null, low = null;
  for (const b of m5Asc) {
    if (b.t >= boundary) {
      high = high === null ? b.h : Math.max(high, b.h);
      low = low === null ? b.l : Math.min(low, b.l);
    }
  }
  return {
    session_start_jst: fmtDT(boundary),
    high: high !== null ? round(high, digits) : null,
    low: low !== null ? round(low, digits) : null,
  };
}

// ---- イベントゲート ----
function loadTodayEvents() {
  const p = path.join(dataDir, "economic-calendar.json");
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf8")).events || []; } catch { return []; }
}

function windowFor(ev) {
  const cb = RULES.central_bank;
  if (cb && new RegExp(cb.match, "i").test(ev.event)) {
    return { before: cb.before_min, after: cb.after_min, kind: "central_bank" };
  }
  for (const sp of RULES.special_events || []) {
    if (ev.impact === "High" && new RegExp(sp.match, "i").test(ev.event)) {
      return { before: sp.before_min, after: sp.after_min, kind: "special" };
    }
  }
  const w = RULES.stop_windows?.[ev.impact];
  if (w && w.mode !== "warn_only") return { before: w.before_min, after: w.after_min, kind: ev.impact };
  return null; // 停止対象外（Medium等は警告のみ）
}

function buildGate(pairCode, events, now) {
  const curs = RULES.pair_currencies[pairCode] || [];
  const reasons = [], warnings = [];
  let nextEvent = null;
  for (const ev of events) {
    if (!curs.includes(ev.currency)) continue;
    const evTime = new Date(ev.datetime_jst);
    if (isNaN(evTime.getTime())) continue;
    const w = windowFor(ev);
    const diffMin = (evTime - now) / 60000; // 正=これから
    if (w) {
      const inWindow = diffMin <= w.before && diffMin >= -w.after;
      if (inWindow) {
        reasons.push(`${ev.time_jst} [${ev.currency}] ${ev.event}（${w.kind}: 前${w.before}分〜後${w.after}分停止）`);
      } else if (diffMin > 0 && diffMin <= (RULES.next_event_lookahead_hours || 10) * 60) {
        if (!nextEvent || evTime < new Date(nextEvent.datetime_jst)) {
          nextEvent = {
            time_jst: ev.time_jst, datetime_jst: ev.datetime_jst,
            currency: ev.currency, impact: ev.impact, event: ev.event,
            stop_from_jst: fmtHM(jstNow(new Date(evTime.getTime() - w.before * 60000))),
            stop_until_jst: fmtHM(jstNow(new Date(evTime.getTime() + w.after * 60000))),
          };
        }
      }
    } else if (ev.impact === "Medium" && Math.abs(diffMin) <= 30) {
      warnings.push(`${ev.time_jst} [${ev.currency}] ${ev.event}（Medium・参考）`);
    }
  }
  return {
    state: reasons.length > 0 ? "WAIT" : "TRADE_OK",
    reasons, warnings,
    next_gated_event: nextEvent,
  };
}

// ---- メイン ----
async function main() {
  const now = new Date();
  const nJst = jstNow(now);
  const events = loadTodayEvents();
  const fr = RULES.fractal || { left: 2, right: 2 };

  const out = {
    as_of: jstIso(now),
    timezone: "Asia/Tokyo",
    note: "事実データと機械判定のみ。売買推奨は含まない。gateはイベント時間ルール(config/daytrade-rules.json)による判定。",
    rules_summary: {
      stale_min: RULES.stale_min,
      fractal: fr,
      high_stop: RULES.stop_windows?.High,
      special_stop: (RULES.special_events || [])[0] ? { before_min: RULES.special_events[0].before_min, after_min: RULES.special_events[0].after_min } : null,
      central_bank_stop: { before_min: RULES.central_bank.before_min, after_min: RULES.central_bank.after_min },
    },
    pairs: {},
    errors: [],
  };

  for (const p of PAIRS) {
    try {
      const m5 = await fetchM5(p.td);
      if (m5.length < 100) throw new Error(`M5データ不足(${m5.length}本)`);
      const last = m5[m5.length - 1];
      const ageMin = Math.round((nJst - last.t) / 60000) - 5; // バー開始時刻+5分=確定時刻基準
      const stale = ageMin > (RULES.stale_min || 20);

      const m15 = aggregate(m5, 15, nJst);
      const h1 = aggregate(m5, 60, nJst);
      const lastBar = (arr) => {
        const b = arr[arr.length - 1];
        return { time_jst: fmtDT(b.t), o: round(b.o, p.digits), h: round(b.h, p.digits), l: round(b.l, p.digits), c: round(b.c, p.digits) };
      };

      const gate = buildGate(p.code, events, now);
      const entry = {
        price: round(last.c, p.digits),
        price_time_jst: fmtDT(last.t),
        bar_age_min: Math.max(ageMin, 0),
        data_status: stale ? "STALE" : "OK",
        today: todayRange(m5, nJst, p.digits),
        sessions_today: sessionLevels(m5, nJst, p.digits),
        m15: { last_closed: lastBar(m15), ...lastSwings(m15, fr.left, fr.right, p.digits) },
        h1: { last_closed: lastBar(h1), ...lastSwings(h1, fr.left, fr.right, p.digits) },
        gate: stale ? { ...gate, state: "NO_DATA", reasons: [`データ鮮度${ageMin}分（閾値${RULES.stale_min}分超）`, ...gate.reasons] } : gate,
      };
      out.pairs[p.code] = entry;
      console.log(`OK: ${p.code} gate=${entry.gate.state} age=${entry.bar_age_min}分`);
    } catch (e) {
      console.error(`FAIL: ${p.code} - ${e.message}`);
      out.errors.push(`${p.code}: ${e.message}`);
      out.pairs[p.code] = { data_status: "NO_DATA", gate: { state: "NO_DATA", reasons: [e.message], warnings: [], next_gated_event: null } };
    }
    await sleep(400);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "daytrade-context.json"), JSON.stringify(out, null, 2));
  console.log("保存完了: data/daytrade-context.json");
  if (Object.keys(out.pairs).length === 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
