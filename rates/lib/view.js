"use strict";

/**
 * 保存済みの rates.json を「いま見たらどうか」に直す（SPEC 5・7節）。
 *   ・鮮度は、取得した時点ではなく表示する時点の時刻で判定し直す（取得に失敗して rates.json が更新されないまま
 *     日が進んでも、古い判定が「新しいもの」として出続けない）。
 *   ・古い／stale／取得の問題が残っているときは、判定を「判定できません」にする。
 * フィード（build-feed.js）と、鮮度の確認（--check-fresh）が、この同じ関数を使う。
 */
const cfg = require("../config");
const { LABELS, THRESHOLD_BP } = cfg;
const cal = require("./calendar");
const { evaluateFreshness } = require("./snapshot");
const { fmtMilli } = require("./calc");
const { toJstIso } = require("../../mtf/lib/ny-time");

const SCHEMA = "fxdaily-levels/rates/v1";

function unavailable(base, reason) {
  return { ...base, available: false, label: LABELS.unavailable, basis: null, reason };
}

// rates: 保存済みの rates.json。返り値: { view, state, reasons }
//   state: "ok"（判定できる状態）| "pending"（公表待ち。取得の問題は無い）| "stale"（古い／取得の問題が残っている）
function evaluate(rates, nowMs, holidays) {
  if (!rates || rates.schema !== SCHEMA) {
    return { view: null, state: "stale", reasons: ["rates.json がない、または形式が想定と違います"] };
  }
  const us = rates.us2y, jp = rates.jp2y;
  const fr = evaluateFreshness({
    usLatest: us?.date ?? null, jpLatest: jp?.date ?? null,
    usDates: new Set(us?.date ? [us.date] : []), nowMs, holidays,
  });
  const usFresh = fr.us.fresh && !us?.stale, jpFresh = fr.jp.fresh && !jp?.stale;
  const reasons = [];
  const genErrors = rates.generation?.errors || [];
  if (genErrors.length) reasons.push(...genErrors);
  if (fr.issue) reasons.push(fr.issue);
  for (const [label, blk, f, ok] of [["米2年", us, fr.us, usFresh], ["日2年", jp, fr.jp, jpFresh]]) {
    if (!blk) reasons.push(`${label}の値がありません`);
    else if (blk.stale) reasons.push(`${label}は取得に失敗したため前回の値のまま（日付 ${blk.date}）`);
    else if (!ok) reasons.push(`${label}が最新の営業日（期待 ${f.expected ?? "不明"}）まで更新されていません（最新 ${blk.date}）`);
  }

  const view = {
    ...rates,
    effective_at: toJstIso(nowMs),
    us2y: us && { ...us, expected_date: fr.us.expected, fresh: usFresh },
    jp2y: jp && { ...jp, expected_date: fr.jp.expected, fresh: jpFresh },
  };
  // 判定：取得時に「判定できない」だったもの、いま古いもの、取得の問題が残るものは、すべて判定できません
  if (!rates.judgment?.available) {
    view.judgment = unavailable(rates.judgment || { threshold_bp: THRESHOLD_BP }, rates.judgment?.reason || reasons.join("／") || "判定に必要な値がありません");
  } else if (reasons.length) {
    view.judgment = unavailable(rates.judgment, reasons.join("／"));
  }

  // 状態：問題が無ければ ok。取得の問題が無く、公表待ちの時間帯なら pending。それ以外は stale
  if (!reasons.length) return { view, state: "ok", reasons };
  const { date: today, min } = cal.jstParts(nowMs);
  let pending = false;
  try {
    pending = !genErrors.length && !fr.issue && cal.isJpBusinessDay(today, holidays) &&
      min < cfg.PENDING_UNTIL_JST_MIN && !us?.stale && !jp?.stale;
  } catch (e) { if (!(e instanceof cal.CalendarError)) throw e; }
  return { view, state: pending ? "pending" : "stale", reasons };
}

// フィードに載せる区画（複数行の文字列。判定と出典を含む）
function sectionText(view) {
  const L = [];
  L.push(`【JP-US 2Y Rates】(rates as_of: ${view.as_of} / 表示時点: ${view.effective_at})`);
  L.push("日米2年金利。「判定」は、金利差の5営業日差を機械的に分類した結果で、トレード判定ではありません。");
  const side = (name, blk, basis, extra) => {
    if (!blk) return `${name}: 値なし`;
    const stale = blk.stale ? "［stale：取得に失敗したため前回の値のまま］" : "";
    const old = !blk.stale && blk.fresh === false ? `［古い：期待 ${blk.expected_date ?? "不明"} に対し最新 ${blk.date}］` : "";
    return `${name}: ${fmtPct(blk.value, name === "米2年" ? 2 : 3)}%（${blk.date}・${basis}${extra}）${stale}${old}`;
  };
  L.push(side("米2年", view.us2y, "米東部基準／米財務省 par yield", view.us2y?.xml_check ? `／XML照合 ${xmlText(view.us2y.xml_check)}` : ""));
  L.push(side("日2年", view.jp2y, "東京基準／財務省", "、翌営業日午前9時30分頃公表"));
  if (view.spread) L.push(`金利差（米2年 − 日2年。両方に値がある直近日 ${view.spread.date}）: ${fmtPct(view.spread.value, 3, true)}%pt`);
  const c = view.change_5d;
  if (c) {
    const part = (name, m) => (m ? `${name} ${fmtBp(m.value_bp)}（${m.base_date}比）` : `${name} 計算不可`);
    L.push(`${c.business_days}営業日差: ${part("米2年", c.us)}／${part("日2年", c.jp)}／${part("金利差", c.spread)}`);
  }
  const j = view.judgment;
  const rule = `しきい値 ±${j.threshold_bp}bp、境界を含む。−${j.threshold_bp}bp以下＝${LABELS.yen_strong}／+${j.threshold_bp}bp以上＝${LABELS.yen_weak}／その間＝${LABELS.unclear}`;
  if (j.available) L.push(`判定: ${j.label}（${j.basis.metric} ${fmtBp(j.basis.value_bp)}、${j.basis.base_date}→${j.basis.date}。${rule}）`);
  else L.push(`判定: ${j.label}（理由: ${j.reason}。${rule}）`);
  L.push("※観測の時刻が違います（日本は東京、米国は米東部。約13時間ずれます）。");
  L.push(cfg.CITATIONS.us);
  L.push(cfg.CITATIONS.jp);
  return L.join("\n");
}

const fmtBp = (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}bp`;
function fmtPct(v, digits, signed = false) {
  // JSONの数値（4.79 など）→ 表示。浮動小数の丸めを避けるため、ミリ%の整数に直してから整数で書く
  return fmtMilli(Math.round(v * 1000), digits, signed);
}
function xmlText(x) {
  if (x.status === "match") return `一致（${x.compared}日）`;
  if (x.status === "mismatch") return `不一致（${x.mismatches.length}日）`;
  return "未実施";
}

// build-feed.js が使う部品：表示時点で見直した rates.json、ヘッダに足す文字列、サマリーの区画
function feedParts(ratesRaw, nowMs, holidays) {
  if (!ratesRaw) return null;
  const { view } = evaluate(ratesRaw, nowMs, holidays);
  if (!view) return null;
  return { view, header: ` | rates as_of: ${view.as_of}`, section: sectionText(view) };
}

module.exports = { SCHEMA, evaluate, sectionText, feedParts };
