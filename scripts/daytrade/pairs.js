"use strict";

/**
 * 対象10銘柄（仕様 2-4）。pip と digits は fetch.js の PAIRS と同じ値（既存の慣習に合わせる）。
 *   pip: 1pip の価格幅（円ペア 0.01 / ドルストレート等 0.0001 / XAUUSD 0.1）
 *   base / quote: 通貨の向き（買い=base買い・quote売り）。XAUUSD の base は "XAU"
 *   priority: 表示の優先順位（仕様 2-4: AUDUSD・EURJPY ＞ GBPUSD・EURUSD ＞ その他）。小さいほど優先
 *   note: 仕様 2-4「USDJPY は『過去の実績が悪い』の注記を付けて出す（落とさない）」。XAUUSD はマージした日から発注の対象外（下の live。論点 c、2026-11-09 本人決定）なので、ライブの候補には出ない
 *   live: false = 発注の対象外（論点 c、2026-11-09 本人決定）。案はこれまでどおり同じ規則（SL下限(a)・障害(a)）で作り、並行記録（shadow-log.csv の variant=xau_paper）に記録・採点するが、
 *         ライブの候補（plan.json の candidates・plan.txt の候補・通知・log.csv）には出さず、上限ロットも計算しない。省略（または true）はライブの対象。
 *         **ここ（XAUUSD の live: false を消す）1か所を戻せば、元どおりのライブの出力になる。** バックテスト（backtest.js）は live を見ない（XAUUSD を含めたまま）。
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
  { code: "XAUUSD", td: "XAU/USD", base: "XAU", quote: "USD", pip: 0.1, digits: 2, priority: 3, note: "過去の実績が悪い", live: false },
];

const BY_CODE = new Map(PAIRS.map((p) => [p.code, p]));
const pairOf = (code) => BY_CODE.get(code) || null;
// ライブ（発注の対象）の銘柄か。live が false のものだけ対象外
const isLive = (pair) => Boolean(pair) && pair.live !== false;

module.exports = { PAIRS, pairOf, isLive };
