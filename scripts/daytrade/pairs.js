"use strict";

/**
 * 対象10銘柄（仕様 2-4）。pip と digits は fetch.js の PAIRS と同じ値（既存の慣習に合わせる）。
 *   pip: 1pip の価格幅（円ペア 0.01 / ドルストレート等 0.0001 / XAUUSD 0.1）
 *   base / quote: 通貨の向き（買い=base買い・quote売り）。XAUUSD の base は "XAU"
 *   priority: 表示の優先順位（仕様 2-4: AUDUSD・EURJPY ＞ GBPUSD・EURUSD ＞ その他）。小さいほど優先
 *   note: 仕様 2-4「USDJPY・XAUUSDは『過去の実績が悪い』の注記を付けて出す（落とさない）」
 */
const PAIRS = [
  { code: "USDJPY", td: "USD/JPY", base: "USD", quote: "JPY", pip: 0.01, digits: 3, priority: 3, note: "過去の実績が悪い" },
  { code: "EURUSD", td: "EUR/USD", base: "EUR", quote: "USD", pip: 0.0001, digits: 5, priority: 2, note: null },
  { code: "GBPUSD", td: "GBP/USD", base: "GBP", quote: "USD", pip: 0.0001, digits: 5, priority: 2, note: null },
  { code: "AUDUSD", td: "AUD/USD", base: "AUD", quote: "USD", pip: 0.0001, digits: 5, priority: 1, note: null },
  { code: "NZDUSD", td: "NZD/USD", base: "NZD", quote: "USD", pip: 0.0001, digits: 5, priority: 3, note: null },
  { code: "USDCAD", td: "USD/CAD", base: "USD", quote: "CAD", pip: 0.0001, digits: 5, priority: 3, note: null },
  { code: "USDCHF", td: "USD/CHF", base: "USD", quote: "CHF", pip: 0.0001, digits: 5, priority: 3, note: null },
  { code: "EURJPY", td: "EUR/JPY", base: "EUR", quote: "JPY", pip: 0.01, digits: 3, priority: 1, note: null },
  { code: "EURGBP", td: "EUR/GBP", base: "EUR", quote: "GBP", pip: 0.0001, digits: 5, priority: 3, note: null },
  { code: "XAUUSD", td: "XAU/USD", base: "XAU", quote: "USD", pip: 0.1, digits: 2, priority: 3, note: "過去の実績が悪い" },
];

const BY_CODE = new Map(PAIRS.map((p) => [p.code, p]));
const pairOf = (code) => BY_CODE.get(code) || null;

module.exports = { PAIRS, pairOf };
