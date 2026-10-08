"use strict";
const { MIN } = require("./jst");
const { jstDate, parseIso } = require("./jst");

/**
 * イベント停止（仕様 1-1・2-3）。data/economic-calendar.json を直接読む。
 *  対象: その銘柄の通貨（config/daytrade-rules.json の pair_currencies）に該当する High・Medium。
 *  停止時間: datetime_jst の15分前〜30分後（両端を含む。既存 daytrade.js の判定と同じ）。停止中は新規のみ禁止。
 *  既存の daytrade.js のゲート（High±15分、Medium は警告のみ、中銀 前30/後60 など）とは別のルール。統合しない。
 *  ファイルが無い／date が当日（JST）でない／as_of が20分より古い、のときは『イベント未取得』として停止なしで生成する。
 */
const BEFORE_MIN = 15;
const AFTER_MIN = 30;
const STALE_MIN = 20;

function calendarStatus(cal, nowMs) {
  if (!cal || typeof cal !== "object") return { ok: false, reason: "data/economic-calendar.json がありません" };
  if (!Array.isArray(cal.events)) return { ok: false, reason: "economic-calendar.json の events がありません" };
  const today = jstDate(nowMs);
  if (cal.date !== today) return { ok: false, reason: `カレンダーの date（${cal.date}）が当日（${today}）ではありません` };
  const asOf = parseIso(cal.as_of);
  if (!Number.isFinite(asOf)) return { ok: false, reason: "economic-calendar.json の as_of が読めません" };
  const age = Math.round((nowMs - asOf) / MIN);
  if (nowMs - asOf > STALE_MIN * MIN) return { ok: false, reason: `カレンダーの as_of が${age}分前（${STALE_MIN}分超）です` };
  return { ok: true, reason: null, age_min: age };
}

// 銘柄の停止時間の一覧（カレンダーが使えるときだけ）。currencies は pair_currencies[銘柄]
function stopWindows(cal, currencies, calStatus) {
  if (!calStatus.ok || !Array.isArray(currencies)) return [];
  const out = [];
  for (const ev of cal.events) {
    if (!currencies.includes(ev.currency)) continue;
    if (ev.impact !== "High" && ev.impact !== "Medium") continue;
    const t = parseIso(ev.datetime_jst);
    if (!Number.isFinite(t)) continue;
    out.push({
      currency: ev.currency, impact: ev.impact, event: ev.event, datetime_jst: ev.datetime_jst,
      start: t - BEFORE_MIN * MIN, end: t + AFTER_MIN * MIN, time_jst: ev.time_jst,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

const activeStops = (windows, nowMs) => windows.filter((w) => nowMs >= w.start && nowMs <= w.end);

module.exports = { BEFORE_MIN, AFTER_MIN, STALE_MIN, calendarStatus, stopWindows, activeStops };
