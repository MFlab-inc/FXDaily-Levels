"use strict";

/**
 * 価格の計算はティック（価格の最小刻み = 10^-digits）の数で行う。浮動小数点の「ちょうど」境界
 * （SL幅10pips・利益幅/SL幅1.0・コスト閾値・ADR80%・距離=ADR残り）で、1ティック違いの誤判定をしないため。
 * pip = 10 ティック（円ペア 0.01 / 0.001、ドルストレート 0.0001 / 0.00001、XAUUSD 0.1 / 0.01）。
 */
const EPS = 1e-9;

const tickSize = (pair) => 10 ** -pair.digits;
const toTicks = (price, pair) => price / tickSize(pair); // 小数のまま持つ（丸めは用途ごと）
const fromTicks = (ticks, pair) => Number((Math.round(ticks) * tickSize(pair)).toFixed(pair.digits));
const ticksPerPip = (pair) => Math.round(pair.pip / tickSize(pair)); // 10

// 丸め単位（ティック）。仕様 2-2「ドル建て0.00005、円0.005」= 0.5pip = 5ティック。XAUUSD も同じ 0.5pip（0.05）とする [Q06]
const ROUND_UNIT_TICKS = 5;

// x（ティック）を unit の倍数へ。「ちょうど」の値は動かさない（誤差が EPS 以内なら四捨五入で整数倍とみなす）
function ceilTo(x, unit = ROUND_UNIT_TICKS) {
  const n = x / unit, r = Math.round(n);
  return (Math.abs(n - r) < EPS ? r : Math.ceil(n)) * unit;
}
function floorTo(x, unit = ROUND_UNIT_TICKS) {
  const n = x / unit, r = Math.round(n);
  return (Math.abs(n - r) < EPS ? r : Math.floor(n)) * unit;
}

// 比較（EPS 許容）。a>=b / a<b など「ちょうど」を含む判定に使う
const gte = (a, b) => a - b > -EPS;
const lt = (a, b) => !gte(a, b);
const lte = (a, b) => a - b < EPS;
const gt = (a, b) => !lte(a, b);

// 0.01 ロット単位へ切り捨て（ちょうどは動かさない）
function floorLot(x) {
  const n = x / 0.01, r = Math.round(n);
  const k = Math.abs(n - r) < 1e-7 ? r : Math.floor(n);
  return Math.max(0, k) / 100;
}

module.exports = { EPS, tickSize, toTicks, fromTicks, ticksPerPip, ROUND_UNIT_TICKS, ceilTo, floorTo, gte, lt, lte, gt, floorLot };
