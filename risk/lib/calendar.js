"use strict";

/**
 * VIX の営業日（NYSE の休場日の規則）と「最新のはずの日付」（SPEC 4節）。
 *
 * VIX は Cboe の S&P500 オプションの値から計算され、米国の株式市場（NYSE）と同じ日に休む。
 * 休場日は NYSE の規則（NYSE「Holidays & Trading Hours」、2026〜2028年の発表〔2025-12-23〕で確認）：
 *   元日（日曜なら翌月曜。土曜なら前の金曜は休まない＝2028年は休場なし）、キング牧師の日（1月第3月曜）、
 *   ワシントン誕生日（2月第3月曜）、聖金曜、戦没将兵追悼記念日（5月最終月曜）、ジューンティーンス（2022年から）、
 *   独立記念日、労働者の日（9月第1月曜）、感謝祭（11月第4木曜）、クリスマス。
 *   ジューンティーンス・独立記念日・クリスマスは、土曜なら前の金曜、日曜なら翌月曜が休場。
 * コロンブス・デー、退役軍人の日は株式市場は開いている（債券市場とは違う。rates/lib/calendar.js とは別の規則）。
 * 規則で決まらない休場（国の追悼の日など）は config の EXTRA_CLOSED_DATES に足す。
 */
const { nyWallMs, isoDate, addDays, dowIso } = require("../../mtf/lib/ny-time");

function nthWeekday(year, month, isoDow, n) {
  let d = isoDate(Date.UTC(year, month - 1, 1)), count = 0;
  for (let i = 0; i < 31; i++, d = addDays(d, 1)) {
    if (dowIso(d) === isoDow && ++count === n) return d;
  }
  throw new Error("nthWeekday");
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

const holidaysByYear = new Map();
// その年の NYSE の休場日（土日を除く）
function nyseHolidays(year) {
  if (holidaysByYear.has(year)) return holidaysByYear.get(year);
  const s = new Set();
  // 土曜なら前の金曜、日曜なら翌月曜
  const observed = (month, day) => {
    const d = isoDate(Date.UTC(year, month - 1, day)), dow = dowIso(d);
    s.add(dow === 6 ? addDays(d, -1) : dow === 7 ? addDays(d, 1) : d);
  };
  // 元日：日曜なら翌月曜。土曜なら休場なし（前の年の12/31は開く）
  const ny = isoDate(Date.UTC(year, 0, 1)), nyDow = dowIso(ny);
  if (nyDow === 7) s.add(addDays(ny, 1));
  else if (nyDow !== 6) s.add(ny);
  s.add(nthWeekday(year, 1, 1, 3));          // キング牧師の日
  s.add(nthWeekday(year, 2, 1, 3));          // ワシントン誕生日
  s.add(addDays(easterSunday(year), -2));    // 聖金曜
  s.add(lastWeekday(year, 5, 1));            // 戦没将兵追悼記念日
  if (year >= 2022) observed(6, 19);         // ジューンティーンス
  observed(7, 4);                            // 独立記念日
  s.add(nthWeekday(year, 9, 1, 1));          // 労働者の日
  s.add(nthWeekday(year, 11, 4, 4));         // 感謝祭
  observed(12, 25);                          // クリスマス
  holidaysByYear.set(year, s);
  return s;
}

function isOpen(date, extraClosed = []) {
  if (dowIso(date) >= 6) return false;
  if (extraClosed.includes(date)) return false;
  return !nyseHolidays(Number(date.slice(0, 4))).has(date);
}

// 「いま」CSV に入っているはずの最新の営業日。米東部の現地時刻で readyMin を過ぎていれば現地の今日から、
// 前なら前日から数え、休場の日は飛ばす。
function expectedLatest(nowMs, { readyMin, extraClosed = [] }) {
  const wall = nyWallMs(nowMs);
  const nyMin = new Date(wall).getUTCHours() * 60 + new Date(wall).getUTCMinutes();
  let d = nyMin >= readyMin ? isoDate(wall) : addDays(isoDate(wall), -1);
  for (let i = 0; i < 14; i++, d = addDays(d, -1)) if (isOpen(d, extraClosed)) return d;
  throw new Error("米国の営業日が見つかりません");
}

// 並び（古い順の日付）の最初〜最後の間で、開いているはずなのに行が無い日
function missingOpenDays(dates, extraClosed = []) {
  if (dates.length < 2) return [];
  const have = new Set(dates), out = [];
  for (let d = dates[0]; d < dates[dates.length - 1]; d = addDays(d, 1)) if (!have.has(d) && isOpen(d, extraClosed)) out.push(d);
  return out;
}

module.exports = { nyseHolidays, isOpen, expectedLatest, missingOpenDays, easterSunday };
