"use strict";

/**
 * 方向の門（仕様 2-1）。mtf-feed.json の確定の向き。
 *  3/3 または 2/3 で向きがそろった銘柄だけ候補（Up=買い、Down=売り）。0/3・1/3・Mixed は『監視のみ』。
 *  mtf-feed の status が ok でない、または data_base_date が前営業日でないときは、候補を出さず『方向根拠なし』（全銘柄）。
 *  『前営業日』は NY17時区切りで直近に確定した営業日（mtf/lib の lastCompletedSessionDate と同じ定義 [Q15]）。
 *  mtf-feed に無い銘柄（NZDUSD）は『方向根拠なし（MTF未収録）』[Q05]。
 *  2/3 で残り1本が逆向きのものは候補にしない（監視のみ）[Q04]。
 */
const SCORE_RE = /^([23])\/3 (Up|Down)$/;
const UP = "↑";
const DOWN = "↓";

function globalMtfStatus(mtf, expectedSession) {
  if (!mtf || typeof mtf !== "object" || !Array.isArray(mtf.symbols)) return { ok: false, reason: "mtf-feed.json がありません" };
  if (mtf.status !== "ok") return { ok: false, reason: `mtf-feed の status が ok ではありません（${mtf.status}）` };
  if (mtf.data_base_date !== expectedSession) {
    return { ok: false, reason: `mtf-feed の data_base_date（${mtf.data_base_date}）が直近に確定した営業日（${expectedSession}）ではありません` };
  }
  return { ok: true, reason: null };
}

// 返り値: { ok, side, strength, alignment, dirs } または { ok:false, kind:'no_basis'|'watch', reason, alignment, dirs }
function symbolDirection(mtf, code, globalStatus) {
  if (!globalStatus.ok) return { ok: false, kind: "no_basis", reason: globalStatus.reason };
  const s = mtf.symbols.find((x) => x.symbol === code);
  if (!s) return { ok: false, kind: "no_basis", reason: "MTF未収録", alignment: null };
  const dirs = [s.monthly?.direction, s.weekly?.direction, s.daily?.direction];
  const alignment = s.alignment_score;
  const m = SCORE_RE.exec(String(alignment));
  if (!m) return { ok: false, kind: "watch", reason: `監視のみ（${alignment}）`, alignment, dirs };
  const side = m[2] === "Up" ? "buy" : "sell";
  const opposite = side === "buy" ? DOWN : UP;
  if (dirs.some((d) => d === opposite)) {
    return { ok: false, kind: "watch", reason: `監視のみ（${alignment} だが逆向きの時間足あり）`, alignment, dirs };
  }
  return { ok: true, side, strength: Number(m[1]), alignment, dirs };
}

module.exports = { globalMtfStatus, symbolDirection, UP, DOWN };
