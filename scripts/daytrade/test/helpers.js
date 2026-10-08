"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pairOf } = require("../pairs");
const { jstAt, parseIso, HR, jstIso } = require("../jst");

/**
 * 試験用の模擬データ。実データは使わない（数字を手で決めて、期待値を自分で計算できるようにする）。
 * 基本の場面: EURUSD（pip 0.0001）、H1 ATR14 = 20pips、現在値 1.1000。
 */
const tmpDir = (prefix = "daytrade-test-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

const DAILY = {
  pivot: 1.1040, r1: 1.1150, r2: 1.1250, s1: 1.0900, s2: 1.0800, prev_high: 1.1200, prev_low: 1.0850,
};
const NO_GROUPS = { highs: [], lows: [], window: 24 };
const OK_DIR = (side = "sell", strength = 3) => ({
  ok: true, side, strength, alignment: `${strength}/3 ${side === "sell" ? "Down" : "Up"}`,
  dirs: side === "sell" ? ["↓", "↓", "↓"] : ["↑", "↑", "↑"],
});

// evaluate() の ctx（EURUSD の売り場面）。overrides で上書き
function evalCtx(overrides = {}) {
  const pair = overrides.pair || pairOf("EURUSD");
  return {
    pair, price: 1.1000, atr: 0.0020, adr: { used_pct: 50, remaining: 0.0060 },
    daily: { ...DAILY }, groups: NO_GROUPS, direction: OK_DIR("sell"), tokyo: null,
    rates: { USDJPY: 150, USDCAD: 1.35, USDCHF: 0.9, GBPUSD: 1.25 },
    accounts: { 701620: { equity_jpy: 610273 }, 702449: { equity_jpy: 4682566 } }, riskPct: 0.5,
    ...overrides,
  };
}

// 時刻つきの H1 足（古い順）。mid(i) = start + i*step で、各足は mid±range/2、始値=終値=mid（TR は range と同じになる）
function stairBars({ endMs, n = 60, range = 0.0020, step = 0.0006, start = 1.0800, edit = null }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = endMs - (n - i) * HR; // 最後の足の開始 = endMs - 1時間（endMs = 最後の足の終了）
    const mid = Number((start + i * step).toFixed(5));
    let b = { t, o: mid, h: Number((mid + range / 2).toFixed(5)), l: Number((mid - range / 2).toFixed(5)), c: mid };
    if (edit) b = edit(b, i) || b;
    out.push(b);
  }
  return out;
}

const toH1Json = (barsByCode) => Object.fromEntries(Object.entries(barsByCode).map(([code, bars]) => [code, bars.map((b) => ({
  time_jst: jstIso(b.t).slice(0, 16).replace("T", " "), o: b.o, h: b.h, l: b.l, c: b.c,
}))]));

module.exports = { tmpDir, rm, DAILY, NO_GROUPS, OK_DIR, evalCtx, stairBars, toH1Json, jstAt, parseIso, HR };
