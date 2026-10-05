"use strict";
const { parseUtcDatetime, isoDatetime, HR } = require("./ny-time");

/**
 * Twelve Data time_series（1時間足・UTC）の取得。
 *   ・呼び出しの間隔を空ける（spacingMs）。さらに直近60秒の呼び出し数が maxPerMinute を超えないように待つ
 *   ・429（HTTP 429 も、HTTP 200 + {"code":429} も）は次の暦の分まで待って再試行。5xx・通信失敗も短い待ちで再試行
 *   ・APIキーは、エラー文・ログのどこにも出さない（scrub）
 *   ・fetch / sleep / now は差し替え可能（模擬データでの試験用）
 */
const API_BASE = "https://api.twelvedata.com/time_series";
const DEFAULT_PAGE = 5000;

function createClient({
  apiKey,
  fetchImpl = (...a) => fetch(...a),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  spacingMs = 2500,
  maxPerMinute = 30,
  maxAttempts = 4,
  timeoutMs = 60000,
  beforeRequest = null, // async () => void。他ワークフローとの重なり回避などの確認を、呼び出しの直前に挟む
  deadlineAt = null, // 全体の時間制限（ms, エポック）。過ぎたら新しい呼び出しも再試行の待ちもせず失敗にする
  log = () => {},
} = {}) {
  if (!apiKey) throw new Error("TWELVE_DATA_API_KEY が設定されていません");
  const scrub = (s) => String(s).split(apiKey).join("***").replace(/apikey=[^&\s"']+/gi, "apikey=***");
  const stats = { requests: 0, retries: 0, rateLimited: 0 };
  const stamps = [];
  let lastStart = 0;

  async function pace() {
    for (;;) {
      const t = now();
      while (stamps.length && t - stamps[0] >= 60000) stamps.shift();
      const spacingWait = lastStart ? lastStart + spacingMs - t : 0;
      const windowWait = stamps.length >= maxPerMinute ? stamps[0] + 60000 - t + 50 : 0;
      const wait = Math.max(spacingWait, windowWait);
      if (wait <= 0) return;
      await sleep(wait);
    }
  }

  // 1回分。成功なら値の配列（新しい順のまま）、失敗なら { retryable, waitMs, message } を投げる
  async function once(params) {
    if (beforeRequest) await beforeRequest();
    await pace();
    if (deadlineAt && now() >= deadlineAt) throw Object.assign(new Error("時間切れ（内部の時間制限を超えました）"), { retryable: false });
    const q = new URLSearchParams({ ...params, apikey: apiKey });
    stats.requests += 1;
    lastStart = now();
    stamps.push(lastStart);
    let res, text;
    try {
      const limit = deadlineAt ? Math.max(1000, Math.min(timeoutMs, deadlineAt - now())) : timeoutMs;
      res = await fetchImpl(`${API_BASE}?${q.toString()}`, { signal: AbortSignal.timeout(limit) });
      text = await res.text();
    } catch (e) {
      throw Object.assign(new Error(`通信失敗: ${scrub(e.name)}: ${scrub(e.message)}`), { retryable: true, waitMs: 5000 });
    }
    let body = null;
    try { body = JSON.parse(text); } catch { /* 下で判定 */ }
    const code = body && body.status === "error" ? Number(body.code) : null;
    if (res.status === 429 || code === 429) {
      stats.rateLimited += 1;
      // 暦の分ごとに戻る上限なので、次の分の頭まで待つ（+1秒）
      const t = now();
      throw Object.assign(new Error("レート制限(429)"), { retryable: true, waitMs: 60000 - (t % 60000) + 1000 });
    }
    if (res.status >= 500 || (code !== null && code >= 500 && code <= 599)) {
      throw Object.assign(new Error(`サーバーエラー(HTTP ${res.status}${code ? `, code ${code}` : ""})`), { retryable: true, waitMs: 8000 });
    }
    if (code !== null) {
      // 範囲を遡りきった最後のページなど「データなし」は空として扱う
      if (/no data is available|no data found/i.test(String(body.message))) return [];
      throw Object.assign(new Error(`APIエラー code=${code}: ${scrub(body.message)}`), { retryable: false });
    }
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: res.status === 408 || res.status === 425, waitMs: 5000 });
    if (!body || !Array.isArray(body.values)) throw Object.assign(new Error("応答に values がありません"), { retryable: true, waitMs: 5000 });
    return body.values;
  }

  async function timeSeries(params) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return parseValues(await once(params), scrub);
      } catch (e) {
        lastErr = e;
        if (!e.retryable || attempt === maxAttempts) break;
        if (deadlineAt && now() + (e.waitMs || 5000) >= deadlineAt) break; // 待つと時間制限を超える
        stats.retries += 1;
        log(`[twelvedata] ${params.symbol}: ${e.message} → ${Math.round((e.waitMs || 5000) / 1000)}秒後に再試行(${attempt}/${maxAttempts - 1})`);
        await sleep(e.waitMs || 5000);
      }
    }
    throw new Error(`${params.symbol}: ${scrub(lastErr.message)}`);
  }

  return { timeSeries, stats };
}

function parseValues(values, scrub = String) {
  return values.map((v) => {
    const b = { datetime: String(v.datetime), open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close) };
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(b.datetime)) throw new Error(`日時の形式が不正です: ${scrub(b.datetime)}`);
    // null・空文字は Number() で 0 になるので、先に弾く。価格は正の有限値のみ
    const raw = [v.open, v.high, v.low, v.close];
    if (raw.some((x) => x === null || x === undefined || x === "") || ![b.open, b.high, b.low, b.close].every((x) => Number.isFinite(x) && x > 0)) {
      throw new Error(`価格が正の数値ではありません（${b.datetime}）`);
    }
    return b;
  });
}

// 直近 count 本（新しい順に返る）。毎日の更新用
async function fetchRecent(client, tdSymbol, count = 1000) {
  return client.timeSeries({ symbol: tdSymbol, interval: "1h", timezone: "UTC", outputsize: String(count) });
}

/**
 * startDt（UTC, "YYYY-MM-DD HH:MM:SS"）から現在までを、pageSize 本ずつ新しい方から遡って取得する。
 * 各ページの最古の足の1秒前を次の end_date にする。重なりは呼び出し側（日足化）で重複排除される。
 */
async function fetchRange(client, tdSymbol, startDt, { pageSize = DEFAULT_PAGE, maxPages = 12, log = () => {} } = {}) {
  const all = [];
  let end = null;
  let prevOldest = null;
  for (let page = 1; page <= maxPages; page++) {
    const params = { symbol: tdSymbol, interval: "1h", timezone: "UTC", outputsize: String(pageSize), start_date: startDt };
    if (end) params.end_date = end;
    const vals = await client.timeSeries(params);
    log(`[twelvedata] ${tdSymbol} ページ${page}: ${vals.length}本${vals.length ? ` (${vals[vals.length - 1].datetime} 〜 ${vals[0].datetime})` : ""}`);
    if (!vals.length) return all;
    // ページの継ぎ目の確認: 前のページの最古の足と、このページの最新の足の間が3〜40時間空いていたら、
    // end_date の解釈（タイムゾーン）がずれて足が抜けている疑いがある（普通の継ぎ目は1時間、XAUの休止は2時間、週末・休日は40時間超）
    const newest = vals.reduce((m, b) => (b.datetime > m ? b.datetime : m), vals[0].datetime);
    if (prevOldest) {
      const gapH = (parseUtcDatetime(prevOldest) - parseUtcDatetime(newest)) / HR;
      if (gapH > 3 && gapH < 40) throw new Error(`${tdSymbol}: ページの継ぎ目で ${gapH} 時間ぶんの足が抜けています（${newest} 〜 ${prevOldest}）。end_date の時刻の解釈を確認してください`);
    }
    all.push(...vals);
    if (vals.length < pageSize) return all;
    const oldest = vals.reduce((m, b) => (b.datetime < m ? b.datetime : m), vals[0].datetime);
    prevOldest = oldest;
    end = isoDatetime(parseUtcDatetime(oldest) - 1000);
    if (end < startDt) return all;
  }
  throw new Error(`${tdSymbol}: ${maxPages}ページ取得しても範囲の先頭に届きません（pageSize=${pageSize}）`);
}

module.exports = { createClient, fetchRecent, fetchRange, DEFAULT_PAGE };
