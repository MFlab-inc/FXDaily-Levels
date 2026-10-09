"use strict";
const { floorLot } = require("./num");

/**
 * 1pip の円価値（1ロット、仕様 2-2）。
 *  円決済（USDJPY・EURJPY）=1,000円 / 米ドル決済（EURUSD・GBPUSD・AUDUSD・NZDUSD・XAUUSD）=10ドル×ドル円 /
 *  ドル以外の決済通貨は対円レートから換算: USDCAD=10×USDJPY÷USDCAD、USDCHF=10×USDJPY÷USDCHF、EURGBP=10×GBPUSD×USDJPY
 *  レートは intraday.json の現在値。必要なレートが無ければ null。 [Q06]
 */
function pipValueJpy(pair, rates) {
  const { USDJPY, USDCAD, USDCHF, GBPUSD } = rates || {};
  switch (pair.quote) {
    case "JPY": return 1000;
    case "USD": return Number.isFinite(USDJPY) ? 10 * USDJPY : null;
    case "CAD": return Number.isFinite(USDJPY) && Number.isFinite(USDCAD) ? (10 * USDJPY) / USDCAD : null;
    case "CHF": return Number.isFinite(USDJPY) && Number.isFinite(USDCHF) ? (10 * USDJPY) / USDCHF : null;
    case "GBP": return Number.isFinite(GBPUSD) && Number.isFinite(USDJPY) ? 10 * GBPUSD * USDJPY : null;
    default: return null;
  }
}

// 追加コスト上限の閾値（pips）: 米ドル決済=1.2、それ以外=1.6 [Q06]
const costThresholdPips = (pair) => (pair.quote === "USD" ? 1.2 : 1.6);
// TP1 の手前幅（pips）: 円決済=0.7、それ以外=0.5 [Q06]
const tpMarginPips = (pair) => (pair.quote === "JPY" ? 0.7 : 0.5);

/**
 * 上限ロット = equity × risk_pct(%) ÷ (SL幅pips × 1pipの円価値)、0.01単位に切り捨て。口座ごとに独立。
 * 返り値は切り捨て前の値（rawLots）も持つ（B案の『半分』の計算 [Q07] に使う）。
 */
function lotRaw(equityJpy, riskPct, slPips, pipVal) {
  if (!Number.isFinite(equityJpy) || !Number.isFinite(riskPct) || !(slPips > 0) || !(pipVal > 0)) return null;
  return (equityJpy * riskPct) / 100 / (slPips * pipVal);
}
const lotCap = (raw) => (raw === null ? null : floorLot(raw));

module.exports = { pipValueJpy, costThresholdPips, tpMarginPips, lotRaw, lotCap };
