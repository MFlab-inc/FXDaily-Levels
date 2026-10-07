"use strict";

/**
 * 営業日と「最新のはずの日付」（SPEC 5節）。
 *   日本：土日・国民の祝日（内閣府CSV）・12/31・1/1〜1/3 は債券市場の営業日でない。財務省の日2年は
 *         2023-01〜2026-10 の全行がこの規則と一致する（試験で確認）。
 *   米国：連邦の祝日などは規則で決められるが、聖金曜と、土曜の祝日の振替の金曜は、年によって
 *         開いたり閉じたりする（2023-04-07・2023-11-10・2026-04-03は開、2024-03-29・2025-04-18は閉）。
 *         この2種類は「不確か」とし、行が出ないまま一定時間が過ぎたら休場だったと見なす。
 */
const { nyWallMs, parseUtcDatetime, isoDate, addDays, dowIso, HR } = require("../../mtf/lib/ny-time");

class CalendarError extends Error {}

const MIN = 60000;

// ---- 日本 ----
const holidayYears = new WeakMap();
function yearsOf(holidays) {
  if (!holidayYears.has(holidays)) holidayYears.set(holidays, new Set([...holidays].map((d) => Number(d.slice(0, 4)))));
  return holidayYears.get(holidays);
}

// 祝日表にその年が無いと、営業日かどうかを決められない（祝日表の更新が必要）
function assertJpCovered(date, holidays) {
  const y = Number(date.slice(0, 4));
  if (!yearsOf(holidays).has(y)) throw new CalendarError(`祝日表に${y}年が無いため、日本の営業日を決められません（内閣府の祝日CSVの更新が必要）`);
}

function isJpBusinessDay(date, holidays) {
  assertJpCovered(date, holidays);
  if (dowIso(date) >= 6 || holidays.has(date)) return false;
  const md = date.slice(5);
  return !(md === "12-31" || md === "01-01" || md === "01-02" || md === "01-03");
}

function prevJpBusinessDay(date, holidays) {
  let d = addDays(date, -1);
  for (let i = 0; i < 20; i++, d = addDays(d, -1)) if (isJpBusinessDay(d, holidays)) return d;
  throw new CalendarError(`${date} より前の日本の営業日が見つかりません`);
}

// 日本時間の（日付, 0時からの分）
function jstParts(nowMs) {
  const t = new Date(nowMs + 9 * HR);
  return { date: t.toISOString().slice(0, 10), min: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

// 日2年が「最新のはず」の日付。D日の値は、次の営業日の午前9時30分頃に公表される（財務省FAQ）。
// ＝ いま公表済みの営業日（今日が営業日で公表済みの時刻なら今日、そうでなければ直前の営業日）の、1つ前の営業日。
function expectedJpLatest(nowMs, holidays, readyMin) {
  const { date: today, min } = jstParts(nowMs);
  const published = isJpBusinessDay(today, holidays) && min >= readyMin ? today : prevJpBusinessDay(today, holidays);
  return prevJpBusinessDay(published, holidays);
}

// ---- 米国 ----
function nthWeekday(year, month, isoDow, n) {
  let d = isoDate(Date.UTC(year, month - 1, 1)), count = 0;
  for (let i = 0; i < 31; i++, d = addDays(d, 1)) {
    if (dowIso(d) === isoDow && ++count === n) return d;
  }
  throw new CalendarError("nthWeekday");
}
function lastWeekday(year, month, isoDow) {
  let d = isoDate(Date.UTC(year, month, 0)); // その月の末日
  while (dowIso(d) !== isoDow) d = addDays(d, -1);
  return d;
}
// 復活祭（グレゴリオ暦）
function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDate(Date.UTC(y, month - 1, day));
}

const usEntriesByYear = new Map();
// その年の「閉」「不確か」の日付 → 種別
function usEntries(year) {
  if (usEntriesByYear.has(year)) return usEntriesByYear.get(year);
  const m = new Map();
  const closed = (d) => m.set(d, "closed");
  // 固定日の祝日：日曜なら翌月曜が閉。土曜なら前の金曜は不確か（開く年がある）
  const fixed = (month, day) => {
    const d = isoDate(Date.UTC(year, month - 1, day)), dow = dowIso(d);
    if (dow === 6) m.set(addDays(d, -1), "uncertain");
    else if (dow === 7) closed(addDays(d, 1));
    else closed(d);
  };
  fixed(1, 1);                              // 元日
  closed(nthWeekday(year, 1, 1, 3));        // キング牧師の日（1月第3月曜）
  closed(nthWeekday(year, 2, 1, 3));        // 大統領の日（2月第3月曜）
  closed(lastWeekday(year, 5, 1));          // 戦没将兵追悼記念日（5月最終月曜）
  if (year >= 2022) fixed(6, 19);           // ジューンティーンス（債券市場は2022年から休場）
  fixed(7, 4);                              // 独立記念日
  closed(nthWeekday(year, 9, 1, 1));        // 労働者の日（9月第1月曜）
  closed(nthWeekday(year, 10, 1, 2));       // コロンブス・デー（10月第2月曜）
  fixed(11, 11);                            // 退役軍人の日
  closed(nthWeekday(year, 11, 4, 4));       // 感謝祭（11月第4木曜）
  fixed(12, 25);                            // クリスマス
  const gf = addDays(easterSunday(year), -2);
  if (!m.has(gf)) m.set(gf, "uncertain");   // 聖金曜
  usEntriesByYear.set(year, m);
  return m;
}

// "closed"（休場）| "uncertain"（開く年も閉じる年もある）| "open"
function usClosure(date) {
  if (dowIso(date) >= 6) return "closed";
  const y = Number(date.slice(0, 4));
  const own = usEntries(y).get(date);
  if (own) return own;
  if (date.slice(5, 7) === "12") { const next = usEntries(y + 1).get(date); if (next) return next; } // 翌年の元日が土曜 → 12/31
  return "open";
}

// 米2年が「最新のはず」の日付。ニューヨークの現地時刻で readyMin（既定18:30。財務省は通常18:00までに掲載）を
// 過ぎていれば現地の今日、前なら前日から数え、休場の日は飛ばす。
// presentDates＝いま持っているデータにある日付（不確かな日が実際に開いていたかの確認に使う）
function expectedUsLatest(nowMs, presentDates, { readyMin, uncertainClosedAfterHours }) {
  const wall = nyWallMs(nowMs);
  const nyDate = isoDate(wall);
  const nyMin = new Date(wall).getUTCHours() * 60 + new Date(wall).getUTCMinutes();
  let d = nyMin >= readyMin ? nyDate : addDays(nyDate, -1);
  for (let i = 0; i < 14; i++) {
    const c = usClosure(d);
    if (c === "closed") { d = addDays(d, -1); continue; }
    if (c === "uncertain" && !presentDates.has(d)) {
      const ageHours = (wall - (parseUtcDatetime(d) + readyMin * MIN)) / HR;
      if (ageHours >= uncertainClosedAfterHours) { d = addDays(d, -1); continue; }
    }
    return d;
  }
  throw new CalendarError("米国の営業日が見つかりません");
}

// 並び（古い順の日付）の最初〜最後の間で、開いているはずなのに行が無い日。5営業日前との差に穴の影響が出るため調べる。
function missingBusinessDays(dates, isOpen) {
  if (dates.length < 2) return [];
  const have = new Set(dates), out = [];
  for (let d = dates[0]; d < dates[dates.length - 1]; d = addDays(d, 1)) if (!have.has(d) && isOpen(d)) out.push(d);
  return out;
}

module.exports = {
  CalendarError, isJpBusinessDay, prevJpBusinessDay, jstParts, expectedJpLatest, assertJpCovered,
  usClosure, expectedUsLatest, missingBusinessDays, easterSunday,
};
