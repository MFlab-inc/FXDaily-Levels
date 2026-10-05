"use strict";

const HR = 3600000;
const DAY = 86400000;

const nyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

// UTC時刻(ms) → ニューヨークの壁時計（UTCとして表した値）。夏時間・冬時間は時刻帯データベースに従う
function nyWallMs(utcMs) {
  const p = {};
  for (const x of nyFmt.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

function parseUtcDatetime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/.exec(String(s));
  if (!m) throw new Error(`日時の形式が不正です: ${s}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoDatetime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

function addDays(dateStr, k) {
  return isoDate(parseUtcDatetime(dateStr) + k * DAY);
}

// 月=1 … 日=7
function dowIso(dateStr) {
  const d = new Date(parseUtcDatetime(dateStr)).getUTCDay();
  return d === 0 ? 7 : d;
}
const isWeekday = (dateStr) => dowIso(dateStr) <= 5;

// 直近に確定したセッションの日付（NY現地17時未満なら前日扱い、土日は金曜まで戻す）。fetch.js と同じ規則
function lastCompletedSessionDate(nowMs) {
  const wall = nyWallMs(nowMs);
  let d = isoDate(new Date(wall).getUTCHours() < 17 ? wall - DAY : wall);
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}

function toJstIso(ms) {
  const j = new Date(ms + 9 * HR).toISOString().slice(0, 19);
  return `${j}+09:00`;
}

module.exports = { HR, DAY, nyWallMs, parseUtcDatetime, isoDate, isoDatetime, hhmm, addDays, dowIso, isWeekday, lastCompletedSessionDate, toJstIso };
