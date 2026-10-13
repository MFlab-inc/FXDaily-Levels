"use strict";
const fs = require("fs");
const path = require("path");

/**
 * 直前の取得から間もないときは、Twelve Data を呼ばずに終わる（intraday.js・daytrade.js 用。fetch.js の --if-stale と同じ考え方）。
 *
 * 背景: Intraday Snapshot は、外部cron（毎時 :05・:23・:35・:50）、GitHub の schedule（:02・:17・:32・:47。遅れて届くことがある）、
 * Daily FX Data 完了時の workflow_run から起動する。同じ分に重なると、1回あたり約31クレジット（intraday.js の /quote 7 ＋ daytrade.js の
 * time_series 24）が二重に使われ、Twelve Data の1分あたりの上限（55）を超える（2026-10-13 05:50 JST に1分57クレジット）。
 *
 * 判定（decide）— 次をすべて満たすときだけ「スキップ」:
 *   ・前回の取得（データファイルの as_of）から 5分未満（時計の小さなずれで as_of が未来に見えても、30秒までは今と同じ扱い）
 *   ・前回の取得が健全（期待する銘柄がすべて揃い、errors が空）— 失敗した取得は、5分以内でもやり直す
 *   ・日次レベル（daily-levels.json）が前回の取得より新しくなく、前回の取得が『いまの日次レベル』を使っている — Daily FX Data の完了直後の
 *     再取得（workflow_run）は、新しい日次レベルとの突き合わせ（h1-bars.json の consistency_check など）を更新するためのものなので、スキップしない
 *     （daytrade.js は consistency_check.checked_against.daily_as_of が daily-levels.json の as_of と同じこと、intraday.js は session_date が同じこと）
 *   ・日付（JST）が前回の取得と同じ — 日付が変わったら、経済カレンダー（intraday.js が当日分に書き換える）などを新しくするため取得する。
 *     intraday.js は economic-calendar.json の date が当日であることも見る
 * 読めない・足りないものがあれば、スキップしない（これまでどおり取得する）。--force を付ければ常に取得する。
 * データファイルの形式は変えない（as_of は、どちらの台本も今まで書いていた項目）。
 */
const SKIP_WITHIN_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const parseTime = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/.test(v) ? Date.parse(v) : NaN);

// JST の日付（YYYY-MM-DD）
const jstDate = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);

function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒` : `${s}秒`;
}

// 純関数。lastAsOf: 前回の取得の as_of（複数あれば古い方を渡す）、dailyAsOf: daily-levels.json の as_of、healthy: { ok, reason }
function decide({ nowMs, lastAsOf, dailyAsOf, healthy = { ok: true }, withinMs = SKIP_WITHIN_MS }) {
  const last = parseTime(lastAsOf);
  if (!Number.isFinite(last)) return { skip: false, reason: "前回の取得時刻（as_of）が読めない" };
  const age = nowMs - last;
  if (age <= -CLOCK_SKEW_MS) return { skip: false, reason: `前回の取得時刻が未来（${fmtAge(-age)}先）` };
  if (age >= withinMs) return { skip: false, reason: `前回の取得から ${fmtAge(age)} 経っている（${withinMs / 60000}分以上）`, ageMs: age };
  if (!healthy.ok) return { skip: false, reason: `前回の取得が不完全（${healthy.reason}）`, ageMs: age };
  if (jstDate(last) !== jstDate(nowMs)) return { skip: false, reason: `日付（JST）が前回の取得（${jstDate(last)}）から変わった（${jstDate(nowMs)}）`, ageMs: age };
  const daily = parseTime(dailyAsOf);
  if (!Number.isFinite(daily)) return { skip: false, reason: "日次レベル（daily-levels.json）の as_of が読めない", ageMs: age };
  if (daily > last) return { skip: false, reason: "日次レベルが前回の取得より新しい（新しい日次との突き合わせのため再取得）", ageMs: age };
  return { skip: true, reason: `前回の取得（${lastAsOf}）から ${fmtAge(Math.max(0, age))}（${withinMs / 60000}分未満）で、取得は健全・日次レベルも更新されていない`, ageMs: age };
}

// intraday.js: data/intraday.json（as_of・pairs・errors）。期待する全銘柄の pairs があり、quote のバッチ失敗が無いこと
// （センチメント〔Yahoo〕の失敗は Twelve Data のクレジットと無関係なので、健全さには数えない）
function checkIntraday({ dataDir, nowMs, codes }) {
  const cur = readJson(path.join(dataDir, "intraday.json"));
  const daily = readJson(path.join(dataDir, "daily-levels.json"));
  if (!cur) return { skip: false, reason: "intraday.json が無い／読めない" };
  const missing = codes.filter((c) => !cur.pairs || !cur.pairs[c]);
  const batch = (Array.isArray(cur.errors) ? cur.errors : []).filter((e) => String(e).startsWith("quote_batch"));
  const cal = readJson(path.join(dataDir, "economic-calendar.json"));
  const healthy = missing.length ? { ok: false, reason: `銘柄が欠けている: ${missing.join(",")}` }
    : batch.length ? { ok: false, reason: batch[0] }
      // 前回の取得が、いまと同じセッションの日次レベルで計算されていること（日次が入れ替わった直後は再取得する）
      : !daily || cur.session_date !== daily.session_date ? { ok: false, reason: `session_date が日次レベルと違う（${cur.session_date} ／ ${daily && daily.session_date}）` }
        // economic-calendar.json は intraday.js だけが当日分に書き換える。当日のものでなければ（日付が変わった・前回の更新失敗）取得して更新する
        : !cal || cal.date !== jstDate(nowMs) ? { ok: false, reason: `経済カレンダーが当日（${jstDate(nowMs)}）のものではない（${cal ? cal.date : "無い／読めない"}）` }
          : { ok: true };
  return decide({ nowMs, lastAsOf: cur.as_of, dailyAsOf: daily && daily.as_of, healthy });
}

// daytrade.js: data/h1-bars.json と data/daytrade-context.json（どちらも as_of・pairs・errors）。両方が健全で、古い方の as_of で判定する
function checkDaytrade({ dataDir, nowMs, codes }) {
  const h1 = readJson(path.join(dataDir, "h1-bars.json"));
  const ctx = readJson(path.join(dataDir, "daytrade-context.json"));
  const daily = readJson(path.join(dataDir, "daily-levels.json"));
  if (!h1 || !ctx) return { skip: false, reason: "h1-bars.json／daytrade-context.json が無い／読めない" };
  const problems = [];
  for (const [name, f] of [["h1-bars.json", h1], ["daytrade-context.json", ctx]]) {
    const missing = codes.filter((c) => !f.pairs || !f.pairs[c]);
    if (missing.length) problems.push(`${name}: 銘柄が欠けている ${missing.join(",")}`);
    if (Array.isArray(f.errors) && f.errors.length) problems.push(`${name}: errors ${f.errors.length}件`);
  }
  // 前回の取得が、いまの日次レベルとの突き合わせを済ませていること（Daily FX Data の保存と push の間に始まった取得は、古い日次を使っている）
  const used = h1.consistency_check && h1.consistency_check.checked_against && h1.consistency_check.checked_against.daily_as_of;
  if (!daily || !used || used !== daily.as_of) problems.push(`h1-bars.json の突き合わせが、いまの日次レベルのものではない（${used || "なし"} ／ ${daily ? daily.as_of : "日次なし"}）`);
  const t1 = parseTime(h1.as_of), t2 = parseTime(ctx.as_of);
  const lastAsOf = Number.isFinite(t1) && Number.isFinite(t2) ? (t1 <= t2 ? h1.as_of : ctx.as_of) : null;
  return decide({ nowMs, lastAsOf, dailyAsOf: daily && daily.as_of, healthy: problems.length ? { ok: false, reason: problems.join(" ／ ") } : { ok: true } });
}

module.exports = { SKIP_WITHIN_MS, CLOCK_SKEW_MS, parseTime, fmtAge, decide, checkIntraday, checkDaytrade };
