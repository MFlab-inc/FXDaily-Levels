"use strict";
const { EPS } = require("./num");

/**
 * 基準水準・障害の材料（仕様 3節・2-2）。
 *  日次レベル: Pivot・R1・R2・S1・S2・前日高値・前日安値（data/daily-levels.json）
 *  H1群 [Q02]: 直近24本の確定H1の高値（安値）を昇順に並べ、隣り合う差が 0.2×ATR 以内でつながった2本以上の塊。
 *              高値群は最大値、安値群は最小値が「上端／下端」。窓は直近24本（仕様が本数を書く唯一の箇所 2-2）
 */
const DAILY_LEVELS = [
  ["Pivot", "pivot"], ["R1", "r1"], ["R2", "r2"], ["S1", "s1"], ["S2", "s2"], ["前日高値", "prev_high"], ["前日安値", "prev_low"],
];
const GROUP_WINDOW = 24;
const GROUP_TOL_ATR = 0.2;

function chainClusters(values, tol) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length >= 2) out.push({ min: cur[0], max: cur[cur.length - 1], count: cur.length }); };
  for (const x of v) {
    if (cur.length && x - cur[cur.length - 1] <= tol + EPS) cur.push(x);
    else { flush(); cur = [x]; }
  }
  flush();
  return out;
}

// bars: 古い順の確定H1 {h,l}。最後の24本から高値群・安値群を作る
function h1Groups(bars, atr) {
  const w = bars.slice(-GROUP_WINDOW);
  const tol = GROUP_TOL_ATR * atr;
  return { highs: chainClusters(w.map((b) => b.h), tol), lows: chainClusters(w.map((b) => b.l), tol), window: w.length };
}

function dailyLevelList(daily) {
  const out = [];
  for (const [label, key] of DAILY_LEVELS) if (Number.isFinite(daily?.[key])) out.push({ label, price: daily[key] });
  return out;
}

/**
 * 型A: 売り=現在値より上で最も近い {Pivot・R1・R2・前日高値・H1高値群の上端}、買い=現在値より下で最も近い
 * {Pivot・S1・S2・前日安値・H1安値群の下端}。現在値と同値のものは「上／下」ではないので採らない。
 */
function referenceLevel(side, price, daily, groups) {
  const cands = [];
  const pick = (label, key) => { if (Number.isFinite(daily?.[key])) cands.push({ label, price: daily[key] }); };
  if (side === "sell") {
    pick("Pivot", "pivot"); pick("R1", "r1"); pick("R2", "r2"); pick("前日高値", "prev_high");
    for (const g of groups.highs) cands.push({ label: "H1高値群の上端", price: g.max });
    const above = cands.filter((c) => c.price - price > EPS);
    return above.length ? above.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  }
  pick("Pivot", "pivot"); pick("S1", "s1"); pick("S2", "s2"); pick("前日安値", "prev_low");
  for (const g of groups.lows) cands.push({ label: "H1安値群の下端", price: g.min });
  const below = cands.filter((c) => price - c.price > EPS);
  return below.length ? below.reduce((a, b) => (b.price > a.price ? b : a)) : null;
}

/**
 * TP1 の障害 [Q03]: Entry（最悪Entry）から進行方向（売り=下、買い=上）に、Entry を含まず最初にある
 * {日次レベル7本・H1群}。群は Entry に近い端（売り=最大値、買い=最小値）。最も近いものを返す。
 * mode（バックテストの『障害の定義』の軸。ライブは常に 'both'）:
 *   'both'    = 現行。H1高値群・H1安値群の両方を障害に含める。
 *   'forward' = 進行方向側の群だけ。売り（下へ進む）は安値群、買い（上へ進む）は高値群。日次レベル7本は同じ。
 */
const OBSTACLE_MODES = ["both", "forward"];
function firstObstacle(side, entry, daily, groups, mode = "both") {
  if (!OBSTACLE_MODES.includes(mode)) throw new Error(`firstObstacle: mode は 'both' か 'forward' です（${String(mode)}）`);
  const cands = dailyLevelList(daily).map((l) => ({ label: l.label, price: l.price }));
  const nearEnd = (g) => (side === "sell" ? g.max : g.min);
  if (mode === "both" || side === "buy") for (const g of groups.highs) cands.push({ label: "H1高値群", price: nearEnd(g) });
  if (mode === "both" || side === "sell") for (const g of groups.lows) cands.push({ label: "H1安値群", price: nearEnd(g) });
  if (side === "sell") {
    const below = cands.filter((c) => entry - c.price > EPS);
    return below.length ? below.reduce((a, b) => (b.price > a.price ? b : a)) : null;
  }
  const above = cands.filter((c) => c.price - entry > EPS);
  return above.length ? above.reduce((a, b) => (b.price < a.price ? b : a)) : null;
}

module.exports = { DAILY_LEVELS, GROUP_WINDOW, GROUP_TOL_ATR, OBSTACLE_MODES, chainClusters, h1Groups, dailyLevelList, referenceLevel, firstObstacle };
