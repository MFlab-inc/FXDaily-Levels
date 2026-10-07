"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../lib/calc");

test("判定：境界ちょうどを含む。しきい値が小数でも、ミリ%の整数にして比べる", () => {
  assert.equal(C.classify(-100, 10), "円高方向");
  assert.equal(C.classify(-99, 10), "はっきりしない");
  assert.equal(C.classify(100, 10), "円安方向");
  assert.equal(C.classify(99, 10), "はっきりしない");
  assert.equal(C.classify(0, 10), "はっきりしない");
  assert.equal(C.classify(3, 0.3), "円安方向");   // 0.3bp＝3ミリ%（0.3*10 は浮動小数で 3.0000000000000004 になりうる）
  assert.equal(C.classify(-3, 0.3), "円高方向");
});

test("表示：整数だけで作る。符号は表示した桁に0以外があるときだけ付ける（-0.00 を出さない）", () => {
  assert.equal(C.fmtMilli(4790, 2), "4.79");
  assert.equal(C.fmtMilli(1930, 3), "1.930");
  assert.equal(C.fmtMilli(2860, 3, true), "+2.860");
  assert.equal(C.fmtMilli(-2860, 3, true), "-2.860");
  assert.equal(C.fmtMilli(0, 3, true), "0.000");
  assert.equal(C.fmtMilli(-5, 2), "0.00");        // 小数第2位まででは0なので符号なし
  assert.equal(C.fmtMilli(-5, 3), "-0.005");
  assert.equal(C.toBp(-54), -5.4);
  assert.equal(C.toBp(0), 0);
  assert.equal(Object.is(C.toBp(-0), -0), false);
  assert.equal(C.fmtBp(-54), "-5.4bp"); assert.equal(C.fmtBp(154), "+15.4bp"); assert.equal(C.fmtBp(0), "0.0bp");
});

test("全範囲：ミリ%の整数 ⇔ 表示が往復する（浮動小数の誤差が入らない）", () => {
  for (let m = -30000; m <= 200000; m += 7) {
    const text = C.fmtMilli(m, 3, true);
    const back = Math.round(Number(text) * 1000);
    assert.equal(back, m, `${m} → ${text}`);
  }
});
