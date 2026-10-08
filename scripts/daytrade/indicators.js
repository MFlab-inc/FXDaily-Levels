"use strict";

/**
 * H1 ATR14。fetch.js の computeIndicators（日足 ATR14）と同じ方式（Wilder）を H1 足に当てる:
 *   TR = max(高値−安値, |高値−前足終値|, |安値−前足終値|)、最初の ATR は最初の14個の TR の単純平均、
 *   以降は (ATR×13 + TR) ÷ 14。bars は古い順。15本未満は null。
 */
function atrWilder(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

module.exports = { atrWilder };
