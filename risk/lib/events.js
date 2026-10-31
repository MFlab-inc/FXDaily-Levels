"use strict";

/**
 * イベント警戒（SPEC 5節。自前の定義、2026-10-30 ユーザー決定）。
 *   基準時刻＝日本時間のその日の9:00。そこから7日（168時間）以内に発表される「最重要の予定」が
 *   2件以上なら High、それ未満なら Normal。予定表（risk/events.csv）が窓の終わりまで届いていなければ unknown。
 * 予定の発表時刻は、現地の日付・時刻・時間帯（IANA名）から日本時間に直す（夏時間は時間帯データベースに従う）。
 * 時刻の記載が無い予定は、現地の正午とみなす（日銀・英中銀。窓の判定は日本時間の9:00で区切るため、
 * 日本・欧州の日中の発表なら、正午とみなしても数え方は変わらない）。
 */
const crypto = require("crypto");
const cfg = require("../config");

class EventsError extends Error {}

const HR = 3600000;
const DAY = 24 * HR;

const fmtCache = new Map();
function partsIn(tz, ms) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
  }
  const p = {};
  for (const x of fmtCache.get(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

// 現地の日付・時刻（tz）→ UTCミリ秒。夏時間の切替の「存在しない時刻」は対象の予定に無い（発表は日中）
function zonedToUtcMs(date, hhmm, tz) {
  const wall = Date.parse(`${date}T${hhmm}:00Z`);
  let utc = wall - (partsIn(tz, wall) - wall);
  utc = wall - (partsIn(tz, utc) - utc);
  if (partsIn(tz, utc) !== wall) throw new EventsError(`${date} ${hhmm}（${tz}）を時刻に直せません`);
  return utc;
}

const toJstIso = (ms) => `${new Date(ms + 9 * HR).toISOString().slice(0, 16)}+09:00`;
const jstDate = (ms) => new Date(ms + 9 * HR).toISOString().slice(0, 10);

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// 予定表（# で始まる行は注記）を読む。想定外の行は黙って捨てず、行番号つきで失敗にする
function parseEventsCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  let header = null;
  const rows = [], seen = new Set();
  lines.forEach((raw, i) => {
    const l = raw.trim(), no = i + 1;
    if (l === "" || l.startsWith("#")) return;
    const cols = l.split(",").map((s) => s.trim());
    if (!header) {
      if (cols.join(",") !== "date,time,tz,kind") throw new EventsError(`${no}行目: 見出しが date,time,tz,kind ではありません: ${l}`);
      header = cols;
      return;
    }
    if (cols.length !== 4) throw new EventsError(`${no}行目: 列の数が4ではありません: ${l}`);
    const [date, time, tz, kind] = cols;
    const k = cfg.EVENT.kinds[kind];
    if (!k) throw new EventsError(`${no}行目: kind ${JSON.stringify(kind)} は数える予定の種類にありません`);
    if (tz !== k.tz) throw new EventsError(`${no}行目: ${kind} の時間帯は ${k.tz} のはずが ${tz} です`);
    if (!validDate(date)) throw new EventsError(`${no}行目: 日付が不正です: ${date}`);
    if (time !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new EventsError(`${no}行目: 時刻が HH:MM ではありません: ${time}`);
    const key = `${kind}|${date}`;
    if (seen.has(key)) throw new EventsError(`${no}行目: ${kind} の ${date} が重複しています`);
    seen.add(key);
    const atMs = zonedToUtcMs(date, time || cfg.EVENT.dateOnlyLocalTime, tz);
    rows.push({ date, time: time || null, tz, kind, atMs });
  });
  if (!header) throw new EventsError("見出しの行がありません");
  if (!rows.length) throw new EventsError("予定の行がありません");
  rows.sort((a, b) => a.atMs - b.atMs || (a.kind < b.kind ? -1 : 1));
  return rows;
}

// 予定表で、窓の判定に使ってよい最後の時刻＝種類ごとの最後の予定のうち、いちばん早いもの。
// それより先は、まだ載っていない種類の予定がありうる（例：2027年12月の雇用統計の次は2028年1月で、表に無い）
function coverageUntilMs(rows) {
  const lastByKind = new Map();
  for (const r of rows) lastByKind.set(r.kind, Math.max(lastByKind.get(r.kind) ?? -Infinity, r.atMs));
  for (const kind of Object.keys(cfg.EVENT.kinds)) {
    if (!lastByKind.has(kind)) throw new EventsError(`予定表に ${kind} の行がありません`);
  }
  return Math.min(...lastByKind.values());
}

// 日本時間の「その日」の9:00（nowMs が9:00より前でも、その日の9:00）
function baseMsOf(nowMs) {
  return Date.parse(`${jstDate(nowMs)}T${String(cfg.EVENT.baseJstHour).padStart(2, "0")}:00:00+09:00`);
}

function eventLevel(rows, nowMs, { calendarSha = null } = {}) {
  const base = baseMsOf(nowMs);
  const end = base + cfg.EVENT.windowDays * DAY;
  const coverage = coverageUntilMs(rows);
  const items = rows.filter((r) => r.atMs >= base && r.atMs < end).map((r) => ({
    at_jst: toJstIso(r.atMs),
    kind: r.kind,
    name: cfg.EVENT.kinds[r.kind].name,
    local: `${r.date}${r.time ? ` ${r.time}` : "（時刻の記載なし）"} ${r.tz}`,
  }));
  const covered = coverage >= end;
  // 予定表が窓の終わりまで届いていなくても、すでに2件以上あれば High は確定。Normal は言い切れないので unknown
  const level = items.length >= cfg.EVENT.highCount ? "High" : covered ? "Normal" : "unknown";
  return {
    level,
    base_jst: toJstIso(base),
    window_end_jst: toJstIso(end),
    count: items.length,
    high_count: cfg.EVENT.highCount,
    items,
    calendar: { coverage_until_jst: toJstIso(coverage), sha256: calendarSha, rows: rows.length },
    reason: level !== "unknown" ? null : `予定表が ${toJstIso(coverage)} までしかなく、窓の終わり（${toJstIso(end)}）まで数えられません。risk/events.csv の更新が必要です`,
  };
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

module.exports = { parseEventsCsv, eventLevel, coverageUntilMs, zonedToUtcMs, baseMsOf, toJstIso, jstDate, sha256, EventsError };
