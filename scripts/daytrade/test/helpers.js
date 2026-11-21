"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pairOf, PAIRS } = require("../pairs");
const { SCHEME_LIVE } = require("../evaluate");
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
    accounts: { A: { equity_jpy: 500000 }, B: { equity_jpy: 3000000 } }, riskPct: 0.5,
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

/**
 * 発注の対象外の銘柄（pairs.js の live:false。今は XAUUSD）をライブに戻す／対象外にする（試験用。この関数が直接書き換えるのは PAIRS の1項目だけ）。
 * 『銘柄を問わないライブの規則』の試験（候補・ログ・通知・Issue など）は、模擬の場面で XAUUSD もライブの候補になる前提（4件の候補など）で書かれているので、
 * ファイルの先頭で setXauLive(true) として、live:false を外した状態（＝今までと同じ出力）で動かす。その状態で今までの期待値が変わらないことが、
 * 『live を戻せば元どおり』の確認を兼ねる。既定（XAUUSD が対象外）の動きは xau-paper.test.js。
 * node --test はファイルごとに別のプロセスで動くので、ほかのファイルには影響しない。元に戻す関数を返す。
 */
function setXauLive(live) {
  const p = PAIRS.find((x) => x.code === "XAUUSD");
  const had = Object.prototype.hasOwnProperty.call(p, "live");
  const prev = p.live;
  if (live) delete p.live; else p.live = false;
  return () => { if (had) p.live = prev; else delete p.live; };
}

/**
 * 型×SL案ごとの対象外（evaluate.js の SCHEME_LIVE。今は型B×A案）をライブに戻す／対象外にする（試験用。直接書き換えるのは設定の1項目だけ）。
 * 型Bの A案がライブの候補・log.csv に出る前提（型Bの案に A案・B案の両方が付く）で書かれた試験は、ファイルの先頭で setSchemeLive("B", "A", true) として、今までと同じ出力で動かす。
 * その状態で今までの期待値が変わらないことが、『設定を戻せば元どおり』の確認を兼ねる。既定（型B×A案は対象外）の動きは typeb-a-paper.test.js。元に戻す関数を返す。
 */
function setSchemeLive(setup, scheme, live) {
  const x = SCHEME_LIVE.find((y) => y.setup === setup && y.scheme === scheme);
  if (!x) throw new Error(`SCHEME_LIVE に ${setup}×${scheme} がありません`);
  const prev = x.live;
  x.live = Boolean(live);
  return () => { x.live = prev; };
}

module.exports = { tmpDir, rm, DAILY, NO_GROUPS, OK_DIR, evalCtx, stairBars, toH1Json, jstAt, parseIso, HR, setXauLive, setSchemeLive };
