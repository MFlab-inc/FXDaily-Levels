"use strict";

/**
 * 取得した系列から rates.json の中身（値・5営業日差・判定・鮮度）を作る。ネットワークは使わない純関数。
 * 「古い」「stale」「確かめられない」ときは、判定を「判定できません」にする（SPEC 4・5節）。
 */
const cfg = require("../config");
const { LABELS, THRESHOLD_BP, LOOKBACK_BUSINESS_DAYS } = cfg;
const cal = require("./calendar");
const { valued, spreadSeries, changeOver, classify, toBp, milliToNumber } = require("./calc");

const RULE_TEXT =
  `金利差（米2年 − 日2年。両方に値がある日だけ）の${LOOKBACK_BUSINESS_DAYS}営業日差が −${THRESHOLD_BP}bp 以下なら「${LABELS.yen_strong}」、` +
  `+${THRESHOLD_BP}bp 以上なら「${LABELS.yen_weak}」、その間は「${LABELS.unclear}」（境界を含む）。` +
  `米・日のどちらかが最新でない／取得できていないときは「${LABELS.unavailable}」`;

const TAIL_WINDOW = 30; // 履歴の穴を調べる直近の行数

const lastOf = (rows) => (rows.length ? rows[rows.length - 1] : null);
const minDate = (a, b) => (a < b ? a : b);

// 期待する最新日と、実際の最新日の比較。祝日表が足りない等で決められないときは issue を返し、古い扱いにする。
// 古いかどうかは「金利差を作れる最新の営業日」＝米の期待する最新日と日の期待する最新日の古い方（required）で見る。
// 例：日2年は翌営業日9:30頃に公表されるため、公表前や週末は、米2年だけ新しい日があっても金利差は作れない。
// 米のほうが先に新しくなる時間帯（米東部18:30〜日本の公表まで）を、米が古いとは数えない。
function evaluateFreshness({ usLatest, jpLatest, usDates, nowMs, holidays }) {
  let expUs = null, expJp = null, issue = null;
  try {
    expJp = cal.expectedJpLatest(nowMs, holidays, cfg.JP_READY_JST_MIN);
    expUs = cal.expectedUsLatest(nowMs, usDates, {
      readyMin: cfg.US_READY_ET_MIN, uncertainClosedAfterHours: cfg.UNCERTAIN_US_CLOSED_AFTER_HOURS,
    });
  } catch (e) {
    if (!(e instanceof cal.CalendarError)) throw e;
    issue = e.message;
  }
  const required = expUs && expJp ? minDate(expUs, expJp) : null;
  return {
    us: { latest: usLatest, expected: expUs, required, fresh: !!(usLatest && required && usLatest >= required) },
    jp: { latest: jpLatest, expected: expJp, required, fresh: !!(jpLatest && required && jpLatest >= required) },
    issue,
  };
}

// 財務省のCSVとXMLを突き合わせる。共通の日付で値が違えば mismatch。判定に使う日付（requiredDates＝最新日と
// 5営業日前の日）がXMLに無ければ、照合できていないので incomplete（match にしない）。
function crossCheck(csvRows, xmlRows, requiredDates = []) {
  const xml = new Map(xmlRows.map((r) => [r.date, r.milli]));
  let compared = 0;
  const mismatches = [];
  for (const r of csvRows) {
    if (!xml.has(r.date)) continue;
    compared++;
    if (xml.get(r.date) !== r.milli) mismatches.push({ date: r.date, csv: r.milli === null ? null : milliToNumber(r.milli), xml: xml.get(r.date) === null ? null : milliToNumber(xml.get(r.date)) });
  }
  const missing = requiredDates.filter((d) => d && !xml.has(d));
  const status = mismatches.length ? "mismatch" : (compared === 0 || missing.length) ? "incomplete" : "match";
  const out = { status, compared, mismatches: mismatches.slice(0, 5) };
  if (missing.length) out.missing_in_xml = missing;
  return out;
}

function carry(prevBlock) {
  return prevBlock ? { ...prevBlock, stale: true } : null;
}

/**
 * @param {object} p
 *   nowMs, holidays（Set）, prev（前回の rates.json または null）
 *   us: { rows, xml: { rows } | { error } , fetchedAt } | { error }
 *   jp: { rows, lastModified, fetchedAt } | { error }
 * @returns { us2y, jp2y, spread, change_5d, judgment, freshness, errors }
 */
function buildSnapshot({ nowMs, holidays, prev, us, jp }) {
  const errors = [];
  const reasons = [];

  // ---- 米2年 ----
  let usRows = null, usBlock;
  if (us.error) {
    errors.push(`us2y: ${us.error}`);
    usBlock = carry(prev?.us2y);
  } else {
    usRows = valued(us.rows);
    const latest = lastOf(usRows);
    if (!latest) { errors.push("us2y: 財務省CSVに2年の値がありません"); usBlock = carry(prev?.us2y); usRows = null; }
    else {
      let xmlCheck = { status: "unavailable", reason: us.xml?.error || "未取得" };
      if (us.xml?.rows) xmlCheck = crossCheck(us.rows, us.xml.rows, [latest.date, usRows[usRows.length - 1 - LOOKBACK_BUSINESS_DAYS]?.date]);
      if (xmlCheck.status === "mismatch") {
        errors.push(`us2y: 財務省のCSVとXMLで値が一致しません（${xmlCheck.mismatches.map((m) => `${m.date} CSV=${m.csv} XML=${m.xml}`).join(" / ")}）`);
        reasons.push("米2年の財務省CSVとXMLが一致しません");
      }
      const gaps = cal.missingBusinessDays(usRows.map((r) => r.date).slice(-TAIL_WINDOW), (d) => cal.usClosure(d) === "open");
      if (gaps.length) {
        errors.push(`us2y: 履歴に欠けた営業日があります（${gaps.join(",")}）`);
        reasons.push("米2年の履歴に欠けた営業日があり、5営業日差が正しく出せません");
      }
      usBlock = {
        date: latest.date, value: milliToNumber(latest.milli), unit: "%",
        source: "treasury_csv", source_url: cfg.URLS.treasuryCsv(latest.date.slice(0, 4)),
        xml_check: xmlCheck, fetched_at: us.fetchedAt, stale: false,
      };
    }
  }

  // ---- 日2年 ----
  let jpRows = null, jpBlock;
  if (jp.error) {
    errors.push(`jp2y: ${jp.error}`);
    jpBlock = carry(prev?.jp2y);
  } else {
    jpRows = valued(jp.rows);
    const latest = lastOf(jpRows);
    if (!latest) { errors.push("jp2y: 財務省の国債金利情報に2年の値がありません"); jpBlock = carry(prev?.jp2y); jpRows = null; }
    else {
      let gaps = [];
      try {
        gaps = cal.missingBusinessDays(jpRows.map((r) => r.date).slice(-TAIL_WINDOW), (d) => cal.isJpBusinessDay(d, holidays));
      } catch (e) { if (!(e instanceof cal.CalendarError)) throw e; }
      if (gaps.length) {
        errors.push(`jp2y: 履歴に欠けた営業日があります（${gaps.join(",")}）`);
        reasons.push("日2年の履歴に欠けた営業日があり、5営業日差が正しく出せません");
      }
      jpBlock = {
        date: latest.date, value: milliToNumber(latest.milli), unit: "%",
        source: "mof_jgbcm_csv", source_url: cfg.URLS.mofMonth,
        published_hint: "翌営業日午前9時30分頃（財務省FAQ）", last_modified: jp.lastModified || null,
        fetched_at: jp.fetchedAt, stale: false,
      };
    }
  }

  // ---- 鮮度 ----
  const usDates = new Set((usRows || []).map((r) => r.date));
  const fr = evaluateFreshness({ usLatest: usBlock?.date ?? null, jpLatest: jpBlock?.date ?? null, usDates, nowMs, holidays });
  if (usBlock?.stale) fr.us.fresh = false;
  if (jpBlock?.stale) fr.jp.fresh = false;
  for (const [label, blk, f] of [["米2年", usBlock, fr.us], ["日2年", jpBlock, fr.jp]]) {
    if (!blk) reasons.push(`${label}の値がありません`);
    else if (blk.stale) reasons.push(`${label}は取得に失敗したため前回の値のまま（stale。日付 ${blk.date}）`);
    else if (!f.fresh) reasons.push(`${label}が最新の営業日（期待 ${f.required ?? "不明"}）まで更新されていません（最新 ${blk.date}）`);
  }
  if (fr.issue) { errors.push(`calendar: ${fr.issue}`); reasons.push(fr.issue); }

  // ---- 金利差・5営業日差 ----
  let spread = null, change = null, spreadChange = null;
  if (usRows && jpRows) {
    const sp = spreadSeries(us.rows, jp.rows);
    const n = LOOKBACK_BUSINESS_DAYS;
    const cUs = changeOver(usRows, n), cJp = changeOver(jpRows, n), cSp = changeOver(sp, n);
    const last = lastOf(sp);
    if (last) spread = { date: last.date, value: milliToNumber(last.milli), unit: "%pt", definition: "米2年 − 日2年（両方に値がある日だけ）" };
    const member = (c) => c && {
      value_bp: toBp(c.deltaMilli), date: c.date, base_date: c.baseDate,
      value: milliToNumber(c.milli), base_value: milliToNumber(c.baseMilli),
    };
    change = { unit: "bp", business_days: n, us: member(cUs), jp: member(cJp), spread: member(cSp) };
    if (!cSp) {
      reasons.push("金利差の5営業日差を計算できません（両方に値がある日が足りません）");
      if (jp.partial) errors.push(`jp2y: ${jp.partial}`);
    }
    else if (fr.us.required && cSp.date < fr.us.required) {
      reasons.push(`金利差の最新日（${cSp.date}）が、期待する日付（${fr.us.required}）より古い`);
    }
    spreadChange = cSp;
  }

  // ---- 判定 ----
  const judgment = {
    available: false, label: LABELS.unavailable, threshold_bp: THRESHOLD_BP, rule: RULE_TEXT,
    basis: null, reason: null,
  };
  if (!reasons.length && spreadChange) {
    judgment.available = true;
    judgment.label = classify(spreadChange.deltaMilli, THRESHOLD_BP);
    judgment.basis = {
      metric: `金利差の${LOOKBACK_BUSINESS_DAYS}営業日差`, value_bp: toBp(spreadChange.deltaMilli),
      date: spreadChange.date, base_date: spreadChange.baseDate,
    };
  } else {
    judgment.reason = reasons.join("／") || "判定に必要な値を作れませんでした";
  }

  return {
    us2y: usBlock ? { ...usBlock, expected_date: fr.us.expected, required_date: fr.us.required, fresh: fr.us.fresh } : null,
    jp2y: jpBlock ? { ...jpBlock, expected_date: fr.jp.expected, required_date: fr.jp.required, fresh: fr.jp.fresh } : null,
    spread, change_5d: change, judgment, errors,
    // 取得・照合の失敗が無いのに古い＝公表待ち（pending）の候補
    notFresh: !(fr.us.fresh && fr.jp.fresh),
  };
}

module.exports = { buildSnapshot, evaluateFreshness, crossCheck, RULE_TEXT };
