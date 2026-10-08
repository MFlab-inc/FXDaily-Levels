"use strict";
const fs = require("fs");
const path = require("path");
const { tmpDir, stairBars, toH1Json } = require("./helpers");
const { PAIRS } = require("../pairs");
const J = require("../jst");

/**
 * 模擬の data/ 一式（既存のフィードと同じ形）。夏時間(NY)の木曜 2026-10-08、現在時刻は既定で 15:30 JST（設計②）。
 * 全銘柄の H1 ATR14 = 20pips（TR 一定の階段状の足）、ADR消化 50%・残り 60pips。
 *   売り候補: EURUSD(3/3 Down)・GBPUSD(2/3 Down)   買い候補: AUDUSD(3/3 Up)・XAUUSD(3/3 Up)
 *   監視のみ: USDJPY(2/3 Up だが日足↓)・EURJPY(Mixed)・USDCAD(0/3)・EURGBP(1/3)   MTF 未収録: NZDUSD・USDCHF
 */
const SPEC = {
  EURUSD: { price: 1.1000, side: "sell", score: "3/3 Down", dirs: ["↓", "↓", "↓"] },
  GBPUSD: { price: 1.3000, side: "sell", score: "2/3 Down", dirs: ["↓", "↓", "→"] },
  AUDUSD: { price: 0.6600, side: "buy", score: "3/3 Up", dirs: ["↑", "↑", "↑"] },
  XAUUSD: { price: 2000.0, side: "buy", score: "3/3 Up", dirs: ["↑", "↑", "↑"] },
  USDJPY: { price: 150.00, side: "buy", score: "2/3 Up", dirs: ["↑", "↑", "↓"] },
  EURJPY: { price: 160.00, side: "sell", score: "Mixed", dirs: ["↑", "↓", "→"] },
  USDCAD: { price: 1.3500, side: "buy", score: "0/3", dirs: ["→", "→", "→"] },
  EURGBP: { price: 0.8500, side: "sell", score: "1/3 Down", dirs: ["↓", "→", "→"] },
  NZDUSD: { price: 0.6000, side: "buy", score: null, dirs: null },
  USDCHF: { price: 0.8800, side: "sell", score: null, dirs: null },
};
const PAIR_CURRENCIES = {
  USDJPY: ["USD", "JPY"], EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], EURJPY: ["EUR", "JPY"], AUDUSD: ["AUD", "USD"],
  EURGBP: ["EUR", "GBP"], USDCAD: ["USD", "CAD"], USDCHF: ["USD", "CHF"], NZDUSD: ["NZD", "USD"], XAUUSD: ["USD"],
};

const rnd = (v, d) => Number(v.toFixed(d));

function levelsFor(pair, price, side) {
  const p = pair.pip;
  const o = (pips) => rnd(price + pips * p, pair.digits);
  return side === "sell"
    ? { pivot: o(40), r1: o(150), r2: o(250), prev_high: o(200), s1: o(-100), s2: o(-200), prev_low: o(-150) }
    : { pivot: o(-40), r1: o(100), r2: o(200), prev_high: o(150), s1: o(-150), s2: o(-250), prev_low: o(-200) };
}

// 1時間足の階段（ATR14 = 20pips、隣り合う高値の間隔 6pips で H1群ができない）。dir: "up"（既定）| "down"
function barsFor(pair, endMs, { price, dir = "up", n = 60 }) {
  const k = pair.pip / 0.0001; // 20pips = 0.0020 × k
  const range = 0.0020 * k, step = 0.0006 * k * (dir === "down" ? -1 : 1);
  const start = price - step * (n - 1);
  return stairBars({ endMs, n, range, step, start });
}

function makeScenario(o = {}) {
  const nowIso = o.nowIso || "2026-10-08T15:30:00+09:00";
  const nowMs = J.parseIso(nowIso);
  const lag = (m) => J.jstIso(nowMs - m * J.MIN);
  const dataDir = path.join(tmpDir(), "data");
  const repoRoot = path.dirname(dataDir);
  const spec = Object.fromEntries(Object.entries(SPEC).map(([k, v]) => [k, { ...v, ...(o.spec?.[k] || {}) }]));
  const endMs = Math.floor(nowMs / J.HR) * J.HR; // 直前に確定した足の終了 = 今の時間の頭

  const intraday = { as_of: lag(o.intradayLagMin ?? 5), session_date: "2026-10-07", pairs: {}, errors: [] };
  const daily = { as_of: lag(600), session_date: o.dailySession || "2026-10-07", errors: o.dailyErrors || [], pairs: {} };
  const h1 = { as_of: lag(o.h1LagMin ?? 5), pairs: {} };
  const ctx = { as_of: lag(o.ctxLagMin ?? 5), pairs: {} };
  const mtfSymbols = [];
  const barsByCode = {};
  for (const pair of PAIRS) {
    const s = spec[pair.code];
    intraday.pairs[pair.code] = { price: s.price, adr_used_pct: s.adr_used_pct ?? 50, adr_remaining: rnd(60 * pair.pip, pair.digits + 1) };
    daily.pairs[pair.code] = levelsFor(pair, s.price, s.side);
    barsByCode[pair.code] = barsFor(pair, endMs, { price: s.price, dir: s.bars?.dir, n: s.bars?.n });
    ctx.pairs[pair.code] = { gate: { state: "OK" } };
    if (s.score) mtfSymbols.push({ symbol: pair.code, alignment_score: s.score, monthly: { direction: s.dirs[0] }, weekly: { direction: s.dirs[1] }, daily: { direction: s.dirs[2] } });
  }
  if (o.barsEdit) for (const [code, f] of Object.entries(o.barsEdit)) barsByCode[code] = f(barsByCode[code]);
  h1.pairs = toH1Json(barsByCode);
  const mtf = { generated_at: lag(600), data_base_date: o.mtfBase || "2026-10-07", as_of: "2026-10-07", status: o.mtfStatus || "ok", symbols: mtfSymbols };
  const calendar = { as_of: lag(o.calLagMin ?? 5), date: o.calDate || J.jstDate(nowMs), timezone: "Asia/Tokyo", events: o.events || [] };

  const write = (rel, obj) => {
    const p = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  };
  const files = { "intraday.json": intraday, "daily-levels.json": daily, "h1-bars.json": h1, "daytrade-context.json": ctx, "mtf-feed.json": mtf, "economic-calendar.json": calendar };
  if (o.tweak) o.tweak(files);
  for (const [f, v] of Object.entries(files)) if (v !== null) write(f, v);
  write("daytrade/accounts.json", {
    accounts: { 701620: { equity_jpy: 610273, role: "daytrade" }, 702449: { equity_jpy: 4682566, role: "swing_daytrade" } },
    commission_per_lot_jpy: 1013, risk_pct: 0.5, daily_loss_pct: 1.5,
  });
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "daytrade-rules.json"), JSON.stringify({ pair_currencies: PAIR_CURRENCIES }));
  return { dataDir, repoRoot, nowMs, nowIso, barsByCode, files };
}

const sha = (p) => require("crypto").createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const snapshot = (dir, names) => Object.fromEntries(names.map((n) => [n, sha(path.join(dir, n))]));

module.exports = { makeScenario, SPEC, PAIR_CURRENCIES, levelsFor, barsFor, snapshot };
