"use strict";
const N = require("./num");
const { referenceLevel, firstObstacle, OBSTACLE_MODES } = require("./levels");
const { pipValueJpy, costThresholdPips, tpMarginPips, lotRaw, lotCap } = require("./sizing");

/**
 * 門（仕様 2節）→ 型A・型B（3節）の評価。純関数。ライブの生成器とバックテストが同じ関数を使う（別実装を作らない）。
 *
 * ctx = {
 *   pair, price, atr (H1 ATR14, 価格単位), adr: { used_pct, remaining (価格単位) } | null,
 *   daily: { pivot, r1, r2, s1, s2, prev_high, prev_low }, groups: h1Groups(),
 *   direction: symbolDirection() の結果, tokyo: tokyoRange() の結果（型B のみ）,
 *   rates: { USDJPY, USDCAD, USDCHF, GBPUSD }, accounts: { <口座>: { equity_jpy } }, riskPct
 * }
 *
 * 不採用の理由（1案につき最初に当たったもの1つ）の評価順は 4節の列挙順 [Q12]:
 *   方向根拠なし → 届かない → SL幅不足 → RR不足 → コスト不足 → ADR消化超過
 * 6分類に載らない理由（基準水準なし・障害なし・入力欠落）は別枠。
 *
 * opts.slFloor（SL下限方式。バックテストの比較用。ライブは既定の 'reject' のまま使う）:
 *   'reject'（既定）= 丸めた後のSL幅が 10pips 未満なら『SL幅不足』で不採用（現行の規則）。
 *   'widen'         = SL幅を max(係数×ATR, 10pips) にしてから外側へ 0.5pip 単位に丸め、SL幅では落とさない。
 *                     RR・コスト上限・ロット（広げた後のSL幅で計算、B案の半分の規則も同じ）は広げた後のSL幅で求める。届く・ADR消化はSL幅に依らないので変わらない。
 *                     SLが下限で決まった（= 現行の規則なら『SL幅不足』になる）案には sl_floored: true を付ける。
 * opts.obstacle（障害の定義。バックテストの比較用。ライブは既定の 'both' のまま使う）:
 *   'both'（既定）  = TP1 の障害に日次レベル7本＋H1高値群・安値群の両方を使う（現行の規則）。
 *   'forward'       = 日次レベル7本＋進行方向側の群だけ（売りは安値群、買いは高値群）。基準水準の選び方は変えない。
 *                     結果に obstacle_changed を付ける（'both' の定義で置く TP1 と違うとき true。障害が無くなって TP1 が置けなくなるときも true。
 *                     障害の価格が違っても、TP1 を 0.5pip 単位に丸めると同じになるときは false）。
 * opts は省略できる（undefined／null）。オブジェクト以外や、定義に無い値（空文字・0・null なども）は例外にする（ライブの定義に黙って落とさない）。
 */
const SCHEMES = [{ name: "A", k: 0.5 }, { name: "B", k: 1.0 }];
const SL_MIN_PIPS = 10;
const RR_MIN = 1.0;
const RR_TARGET = 1.5;
const RR_COST_DIV = 2.5;
const ADR_MAX_PCT = 80;
const BAND_ATR = 0.1;

const REASONS = {
  no_direction: "方向根拠なし", unreachable: "届かない", sl_narrow: "SL幅不足",
  rr_low: "RR不足", cost_low: "コスト不足", adr_over: "ADR消化超過",
  no_reference: "基準水準なし", no_obstacle: "障害なし", no_data: "入力欠落",
};
const COUNTED = ["no_direction", "unreachable", "sl_narrow", "rr_low", "cost_low", "adr_over"];

const px = (ticks, pair) => N.fromTicks(ticks, pair);
const SL_FLOOR_OPTIONS = ["reject", "widen"];

// opts の1項目を読む。省略（undefined）なら既定。opts がオブジェクトでない、値が定義に無いときは呼び出し側で例外にする
function optionOf(opts, key, def) {
  if (opts === undefined || opts === null) return def;
  if (typeof opts !== "object") throw new Error(`evaluate: opts はオブジェクトです（${String(opts)}）`);
  return opts[key] === undefined ? def : opts[key];
}

function evaluate(ctx, setup, opts = {}) {
  const slFloor = optionOf(opts, "slFloor", "reject");
  if (!SL_FLOOR_OPTIONS.includes(slFloor)) throw new Error(`evaluate: slFloor は 'reject' か 'widen' です（${String(slFloor)}）`);
  const widen = slFloor === "widen";
  const obstacleMode = optionOf(opts, "obstacle", "both");
  if (!OBSTACLE_MODES.includes(obstacleMode)) throw new Error(`evaluate: obstacle は 'both' か 'forward' です（${String(obstacleMode)}）`);
  const { pair } = ctx;
  const base = { setup, symbol: pair.code, side: null, schemes: {} };
  const rejectAll = (reason, detail, extra = {}) => ({
    ...base, ...extra, outcome: "rejected", symbolReason: reason, detail,
    schemes: Object.fromEntries(SCHEMES.map((s) => [s.name, { name: s.name, k: s.k, pass: false, reason }])),
  });

  if (!Number.isFinite(ctx.price) || !Number.isFinite(ctx.atr) || !(ctx.atr > 0) || !ctx.adr || !Number.isFinite(ctx.adr.used_pct) || !Number.isFinite(ctx.adr.remaining)) {
    return rejectAll("no_data", "現在値・H1 ATR14・ADR消化率のいずれかが取れません");
  }

  // 1) 方向（2-1）。型B は『MTFの向きと一致したブレイク』が条件なので、向きが無ければ成立しない（数えない）
  const dir = ctx.direction;
  if (!dir.ok) {
    if (setup === "B") return { ...base, outcome: "not_formed", detail: `MTFの向きなし（${dir.reason}）` };
    return { ...rejectAll("no_direction", dir.reason, { alignment: dir.alignment ?? null, dirs: dir.dirs ?? null }), outcome: dir.kind === "watch" ? "watch" : "rejected" };
  }
  const side = dir.side;
  const sgn = side === "sell" ? -1 : 1; // 進行方向（売り=下）
  const common = { ...base, side, strength: dir.strength ?? null, alignment: dir.alignment, dirs: dir.dirs };

  // 2) 基準水準 L とEntry帯
  let ref, band;
  const atrT = N.toTicks(ctx.atr, pair); // ATR をティックで（小数のまま）
  if (setup === "A") {
    ref = referenceLevel(side, ctx.price, ctx.daily, ctx.groups);
    if (!ref) return rejectAll("no_reference", `現在値より${side === "sell" ? "上" : "下"}に基準水準がありません`, common);
  } else {
    const t = ctx.tokyo;
    if (!t || !t.complete) return { ...common, outcome: "not_formed", detail: "東京レンジ（9:00〜14:00の6本）が確定していません" };
    if (t.breakUp && t.breakDown) return { ...common, outcome: "not_formed", detail: "同日に両方向へブレイク" };
    if (!t.breakUp && !t.breakDown) return { ...common, outcome: "not_formed", detail: "ブレイク未成立（15:00開始以降のH1が終値でレンジ外に確定していない）" };
    const breakSide = t.breakDown ? "sell" : "buy";
    if (breakSide !== side) return { ...common, outcome: "not_formed", detail: `ブレイク方向（${breakSide === "sell" ? "下" : "上"}）がMTFの向きと不一致` };
    ref = side === "sell" ? { label: "東京レンジ安値", price: t.low } : { label: "東京レンジ高値", price: t.high };
  }
  const Lt = N.toTicks(ref.price, pair);
  const bandT = Math.round(BAND_ATR * atrT);
  const bandLowT = side === "sell" ? Lt : Lt - bandT;
  const bandHighT = side === "sell" ? Lt + bandT : Lt;
  band = { low: px(bandLowT, pair), high: px(bandHighT, pair) };
  const priceT = N.toTicks(ctx.price, pair);

  if (setup === "B") {
    // ブレイク後に価格がレンジ内へ戻り済みなら不成立 [Q10]。売り=帯の上端より上、買い=帯の下端より下
    const back = side === "sell" ? N.gt(priceT, bandHighT) : N.lt(priceT, bandLowT);
    if (back) return { ...common, outcome: "not_formed", detail: "ブレイク後に価格がレンジ内へ戻り済み", ref: { label: ref.label, price: px(Lt, pair) } };
  }

  const tpPip = N.ticksPerPip(pair);
  const distTicks = Math.abs(Lt - priceT);
  const distancePips = distTicks / tpPip;
  const remainingT = N.toTicks(ctx.adr.remaining, pair);
  const unreachable = N.gt(distTicks, remainingT);
  const adrOver = N.gt(ctx.adr.used_pct, ADR_MAX_PCT);

  // 3) TP1（最初の障害の手前）
  const obstacle = firstObstacle(side, ref.price, ctx.daily, ctx.groups, obstacleMode);
  const marginT = tpMarginPips(pair) * tpPip;
  // 『手前』= Entry 側。売りは障害の上、買いは障害の下。Entry 側へ0.5pip単位で丸める [Q11]
  const tpOf = (ob) => {
    if (!ob) return null;
    const o = N.toTicks(ob.price, pair);
    return side === "sell" ? N.ceilTo(o + marginT) : N.floorTo(o - marginT);
  };
  const tpT = tpOf(obstacle);
  // 'forward' のとき、現行の定義（'both'）で置く TP1 と違うか（障害の価格が違っても、丸めた TP1 が同じなら false）
  const obstacleChanged = obstacleMode === "forward" ? tpOf(firstObstacle(side, ref.price, ctx.daily, ctx.groups, "both")) !== tpT : undefined;
  const profitPips = tpT === null ? null : (sgn * (tpT - Lt)) / tpPip;

  // 4) 案ごと
  const pipVal = pipValueJpy(pair, ctx.rates);
  const threshold = costThresholdPips(pair);
  const rawA = {};
  const schemes = {};
  const slFloorT = SL_MIN_PIPS * tpPip; // 10pips をティックで
  const roundSl = (distT) => (side === "sell" ? N.ceilTo(Lt + distT) : N.floorTo(Lt - distT)); // 外側（損切りが遠い側）へ 0.5pip 単位
  for (const s of SCHEMES) {
    const slT0 = roundSl(s.k * atrT); // 下限なしのSL（現行の規則）
    const slT = widen ? roundSl(Math.max(s.k * atrT, slFloorT)) : slT0;
    const slPips = Math.abs(slT - Lt) / tpPip;
    const res = { name: s.name, k: s.k, sl: px(slT, pair), sl_pips: slPips, pass: false, reason: null };
    if (widen) res.sl_floored = slT !== slT0;
    if (tpT !== null) {
      res.tp = px(tpT, pair);
      res.profit_pips = profitPips;
      res.rr = slPips > 0 ? profitPips / slPips : null;
      res.cost_cap_pips = (profitPips - RR_TARGET * slPips) / RR_COST_DIV;
      res.cost_threshold_pips = threshold;
    }
    // 理由（4節の列挙順）
    if (unreachable) res.reason = "unreachable";
    else if (!widen && N.lt(slPips, SL_MIN_PIPS)) res.reason = "sl_narrow";
    else if (tpT === null) res.reason = "no_obstacle";
    else if (N.lt(profitPips, RR_MIN * slPips)) res.reason = "rr_low";
    else if (N.lt(res.cost_cap_pips, threshold)) res.reason = "cost_low";
    else if (adrOver) res.reason = "adr_over";
    res.pass = res.reason === null;
    // ロット上限（口座ごとに独立）。B案は式をB案のSL幅で計算した値と、A案の式の値の半分のうち小さい方 [Q07]
    res.lots = {};
    for (const [acct, a] of Object.entries(ctx.accounts || {})) {
      const raw = pipVal === null ? null : lotRaw(a.equity_jpy, ctx.riskPct, slPips, pipVal);
      if (s.name === "A") rawA[acct] = raw;
      let cap = lotCap(raw);
      if (s.name === "B" && cap !== null && rawA[acct] !== null && rawA[acct] !== undefined) cap = Math.min(cap, lotCap(rawA[acct] * 0.5));
      res.lots[acct] = cap;
    }
    schemes[s.name] = res;
  }
  const any = Object.values(schemes).some((x) => x.pass);
  return {
    ...common,
    outcome: any ? "candidate" : "rejected",
    ref: { label: ref.label, price: px(Lt, pair) },
    band, worst_entry: px(Lt, pair),
    price: ctx.price, distance_pips: distancePips, atr: ctx.atr, atr_pips: ctx.atr / pair.pip,
    adr_used_pct: ctx.adr.used_pct, adr_remaining_pips: ctx.adr.remaining / pair.pip,
    obstacle, ...(obstacleChanged === undefined ? {} : { obstacle_changed: obstacleChanged }), pip_value_jpy: pipVal,
    schemes,
  };
}

module.exports = { evaluate, SCHEMES, REASONS, COUNTED, SL_MIN_PIPS, ADR_MAX_PCT, BAND_ATR, SL_FLOOR_OPTIONS, OBSTACLE_MODES };
