"use strict";
const { SCHEMES } = require("./evaluate");

/**
 * 並行記録（参考の案。発注の対象外）の評価。ライブ（SL下限 (a)・障害 (a)）は変えず、別の評価を足すだけ。
 * ライブの生成器が SL下限・障害の定義を指定するのは、このファイルだけ（axes.test.js が、ほかのファイルに指定が無いことを確かめている）。
 *   SL下限 (b) = SL を max(k×ATR, 10pips) にしてから外側へ 0.5pip 単位に丸め、SL幅では落とさない（evaluate() の opts.slFloor='widen'。バックテストの比較と同じ）。
 * 障害の定義は (a) のまま。
 */
const SHADOW_OPTS = Object.freeze({ slFloor: "widen" });

// evaluate は呼び出しのたびに読む（試験が差し替えられるように）
function evaluateShadow(ctx, setup) {
  return require("./evaluate").evaluate(ctx, setup, SHADOW_OPTS);
}

/**
 * ライブ (a) では不採用だが (b) なら通る案。res0 = ライブ (a) の評価（出し直しの抑え〔■3〕の前のもの）、sres = (b) の評価。
 * 返り値: null（無い）、または { sres, onlyB }。onlyB = (b) だけで通る案（A／B案）の名前。件数の単位は『案』（型×銘柄×A/B案）。
 */
function shadowOf(res0, sres) {
  if (!sres || sres.outcome !== "candidate") return null;
  const onlyB = SCHEMES.map((s) => s.name).filter((n) => sres.schemes?.[n]?.pass && !res0.schemes?.[n]?.pass);
  return onlyB.length ? { sres, onlyB } : null;
}

module.exports = { SHADOW_OPTS, evaluateShadow, shadowOf };
