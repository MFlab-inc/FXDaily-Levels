"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { HR, DAY, nyWallMs, parseUtcDatetime, isoDate, isoDatetime, addDays, isWeekday } = require("../lib/ny-time");

// NY現地の壁時計(UTC表記ms) → UTC ms。夏時間・冬時間の切り替え時刻には使わない（試験データの生成用）
function nyToUtcMs(wallMs) {
  for (const off of [-4, -5]) {
    const u = wallMs - off * HR;
    if (nyWallMs(u) === wallMs) return u;
  }
  throw new Error("NY→UTC変換できません");
}

// start から n 営業日分（月〜金）の日付
function weekdaysFrom(start, n) {
  const out = [];
  for (let d = start; out.length < n; d = addDays(d, 1)) if (isWeekday(d)) out.push(d);
  return out;
}

// 日足の行を作る。closeFn(i) で終値、spread で高安の幅
function mkRows(dates, closeFn, { spread = 0.5, bars = 24, lastBar = "16:00" } = {}) {
  return dates.map((date, i) => {
    const c = closeFn(i, date);
    return { date, open: c, high: c + spread, low: c - spread, close: c, bars, last_bar_ny: lastBar };
  });
}

/**
 * 1つの NY17時区切りセッション(date)の1時間足（UTC表記・開始時刻）を作る。
 * セッションは「前日のNY17:00」から始まる（月曜は日曜17:00から）。nBars本、1時間ごと。
 * 始値=最初の足の始値、終値=最後の足の終値、高値は2本目、安値は3本目に入れる。
 */
function sessionHourBars(date, { open, high, low, close, nBars = 24, skipFirst = 0 }) {
  const startWall = Date.parse(`${addDays(date, -1)}T17:00:00Z`);
  const startUtc = nyToUtcMs(startWall) + skipFirst * HR;
  const n = nBars - skipFirst;
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = startUtc + k * HR;
    const isFirst = k === 0, isLast = k === n - 1;
    const o = isFirst ? open : (open + close) / 2;
    const c = isLast ? close : (open + close) / 2;
    let h = Math.max(o, c), l = Math.min(o, c);
    if (k === 1) h = high;
    if (k === 2) l = low;
    out.push({ datetime: isoDatetime(t), open: o, high: h, low: l, close: c });
  }
  return out;
}

// 日足の行から、1時間足の全体を作る（新しい順にして返すのは fakeTwelveData 側）
function hourBarsFromRows(rows, opts = {}) {
  const all = [];
  for (const r of rows) all.push(...sessionHourBars(r.date, { ...r, nBars: opts.nBars ? opts.nBars(r) : r.bars || 24 }));
  return all;
}

// Twelve Data の time_series を模したもの。bars は { datetime, open, high, low, close }（UTC）
function fakeTwelveData(barsByTd, { pageCap = 5000, failures = {} } = {}) {
  const calls = [];
  const fn = async (url) => {
    const u = new URL(url);
    const p = Object.fromEntries(u.searchParams);
    calls.push({ ...p, apikey: p.apikey ? "***" : undefined, at: Date.now() });
    const fail = failures[p.symbol];
    if (fail && fail.times > 0) {
      fail.times -= 1;
      if (fail.kind === "429-body") return new Response(JSON.stringify({ code: 429, status: "error", message: "limit" }), { status: 200 });
      if (fail.kind === "500") return new Response("oops", { status: 500 });
      if (fail.kind === "throw") throw new Error(`fetch failed for ${url}`);
      if (fail.kind === "401") return new Response(JSON.stringify({ code: 401, status: "error", message: `bad apikey ${p.apikey}` }), { status: 200 });
    }
    const all = barsByTd[p.symbol] || [];
    const os = Math.min(Number(p.outputsize || 30), pageCap);
    let arr = all.filter((b) => (!p.start_date || b.datetime >= p.start_date) && (!p.end_date || b.datetime <= p.end_date));
    arr = arr.sort((a, b) => b.datetime.localeCompare(a.datetime)).slice(0, os);
    if (!arr.length) return new Response(JSON.stringify({ code: 400, status: "error", message: "No data is available on the specified dates. Try setting different start/end dates." }), { status: 200 });
    const values = arr.map((b) => ({ datetime: b.datetime, open: b.open.toFixed(5), high: b.high.toFixed(5), low: b.low.toFixed(5), close: b.close.toFixed(5) }));
    return new Response(JSON.stringify({ meta: { symbol: p.symbol }, values, status: "ok" }), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

// 時計を進めるだけの偽の sleep / now
function fakeClock(startMs = Date.UTC(2026, 9, 6, 21, 10, 0)) {
  const c = { t: startMs, slept: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.slept.push(ms); c.t += ms; };
  return c;
}

function tmpData() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mtf-test-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return { root, dataDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

module.exports = { nyToUtcMs, weekdaysFrom, mkRows, sessionHourBars, hourBarsFromRows, fakeTwelveData, fakeClock, tmpData, HR, DAY, isoDate, parseUtcDatetime };

// ---- 9銘柄ぶんの模擬データ ----
const { SYMBOLS } = require("../config");
// start〜end(含む)の営業日の日足の行。銘柄ごとに少しずつ違う値動き。
function scenarioRows(code, start, end, { skip = [], bars = (d) => 24 } = {}) {
  const k = SYMBOLS.findIndex((s) => s.code === code) + 1;
  const dates = [];
  for (let d = start; d <= end; d = addDays(d, 1)) if (isWeekday(d) && !skip.includes(d)) dates.push(d);
  return dates.map((date) => {
    const n = Date.parse(date) / DAY; // 日付だけで値が決まる（開始日が違っても同じ日は同じ値）
    const c = 100 * k + 10 * Math.sin(n / 9 + k) + (n - 20000) * 0.02;
    return { date, open: c - 0.1, high: c + 0.6, low: c - 0.7, close: c, bars: bars(date) };
  });
}
// 全銘柄の 1時間足（Twelve Data のシンボル表記をキー）
function scenarioBars(start, end, opts = {}) {
  const out = {};
  for (const s of SYMBOLS) out[s.td] = hourBarsFromRows(scenarioRows(s.code, start, end, opts));
  return out;
}
module.exports.scenarioRows = scenarioRows;
module.exports.scenarioBars = scenarioBars;
