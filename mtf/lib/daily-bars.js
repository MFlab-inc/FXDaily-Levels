"use strict";
const { HR, nyWallMs, parseUtcDatetime, isoDate, hhmm } = require("./ny-time");

/**
 * 1時間足（UTC表記・開始時刻）→ NY17時区切りの日足。fetch.js の aggregateToNySessions と同じ規則:
 *   NY現地の開始時刻に7時間を足した日付を DATE_NY とする（日曜夜の足は月曜に入る）。
 *   土日の DATE_NY になる足は捨てる（開場前の薄い足・週末に返る足を含む）。
 *   始値は最初の足、終値は最後の足、高値・安値は最大・最小。
 * 追加の規則（仕様 1-1）:
 *   取得範囲の左端の日（最初の足が属する日）は途中からしか足が無いので捨てる。
 *   cutoffDate より後の日（形成途中の日）は捨てる。
 * hourBars: [{ datetime: "YYYY-MM-DD HH:MM:SS"(UTC), open, high, low, close }]（数値）
 */
function aggregateHourlyToNyDaily(hourBars, { dropLeftEdge = true, cutoffDate = null } = {}) {
  const byTime = new Map();
  for (const b of hourBars) byTime.set(b.datetime, b);
  const bars = [...byTime.values()].sort((a, b) => a.datetime.localeCompare(b.datetime));

  const sessions = new Map();
  let firstBarSession = null; // 最初の足が属する日（週末なら null）
  let weekendBars = 0;
  bars.forEach((b, i) => {
    const wall = nyWallMs(parseUtcDatetime(b.datetime));
    const shifted = wall + 7 * HR;
    const dow = new Date(shifted).getUTCDay();
    if (dow === 0 || dow === 6) { weekendBars++; return; }
    const date = isoDate(shifted);
    if (i === 0) firstBarSession = date;
    const s = sessions.get(date);
    if (!s) {
      sessions.set(date, { date, open: b.open, high: b.high, low: b.low, close: b.close, bars: 1, last_bar_ny: hhmm(wall) });
    } else {
      s.high = Math.max(s.high, b.high);
      s.low = Math.min(s.low, b.low);
      s.close = b.close;
      s.bars += 1;
      s.last_bar_ny = hhmm(wall);
    }
  });

  let leftEdgeDropped = null;
  if (dropLeftEdge && firstBarSession && sessions.has(firstBarSession)) {
    sessions.delete(firstBarSession);
    leftEdgeDropped = firstBarSession;
  }
  let rows = [...sessions.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (cutoffDate) rows = rows.filter((r) => r.date <= cutoffDate);
  return { rows, leftEdgeDropped, weekendBars };
}

module.exports = { aggregateHourlyToNyDaily };
