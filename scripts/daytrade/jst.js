"use strict";

/**
 * 日本時間（JST, UTC+9, 夏時間なし）の道具。時刻の文字列は "YYYY-MM-DDTHH:MM:SS+09:00"（ISO）または
 * h1-bars.json と同じ "YYYY-MM-DD HH:MM"（開始時刻・JST）。
 */
const MIN = 60000;
const HR = 3600000;
const DAY = 86400000;
const JST_OFFSET = 9 * HR;

const pad = (n, w = 2) => String(n).padStart(w, "0");

// epoch(ms) → JST の壁時計を UTC フィールドで持つ Date
const jstWall = (ms) => new Date(ms + JST_OFFSET);

function jstIso(ms) {
  const d = jstWall(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+09:00`;
}
const jstDate = (ms) => jstIso(ms).slice(0, 10);
const jstHm = (ms) => jstIso(ms).slice(11, 16);
const jstDow = (ms) => jstWall(ms).getUTCDay(); // 0=日 … 6=土
const jstHour = (ms) => jstWall(ms).getUTCHours();

// "2026-10-08T17:30:00+09:00"（任意のオフセットつきISO）→ epoch(ms)。不正なら NaN
function parseIso(s) {
  if (typeof s !== "string") return NaN;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/.test(s)) return NaN;
  return Date.parse(s);
}

// h1-bars.json の time_jst "YYYY-MM-DD HH:MM"（JST・足の開始時刻）→ epoch(ms)。不正なら NaN
function parseJstLabel(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - JST_OFFSET;
}
const jstLabel = (ms) => jstIso(ms).slice(0, 16).replace("T", " ");

// JST の日付 "YYYY-MM-DD" と時刻 "HH:MM" から epoch(ms)
function jstAt(dateStr, hm = "00:00") {
  return parseJstLabel(`${dateStr} ${hm}`);
}
const addDaysJst = (dateStr, k) => jstDate(jstAt(dateStr) + k * DAY);

module.exports = { MIN, HR, DAY, JST_OFFSET, pad, jstIso, jstDate, jstHm, jstDow, jstHour, parseIso, parseJstLabel, jstLabel, jstAt, addDaysJst };
