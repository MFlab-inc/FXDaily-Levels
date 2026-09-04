/**
 * FX Daily Data Fetcher v2
 * 毎朝8:30 JST（GitHub Actions）に実行される想定。
 * - Twelve Data: 7ペアの日足OHLC → ADR20 / ATR14 / 前日高安 / Pivot(R2/R1/P/S1/S2) / NY終値
 * - Yahoo Finance: DXY / 米10年債利回り / VIX
 * - Forex Factory: 当日の経済指標・要人発言（JST変換済み）
 * 出力:
 *   data/YYYY-MM-DD.json, data/latest.json, data/index.json  … ダッシュボード用（従来通り）
 *   data/daily-levels.json      … GPT等の外部AI用（機械可読スキーマ）
 *   data/economic-calendar.json … GPT等の外部AI用（当日イベント）
 */

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.TWELVE_DATA_API_KEY;
if (!API_KEY) {
  console.error("ERROR: 環境変数 TWELVE_DATA_API_KEY が設定されていません");
  process.exit(1);
}

// ---- 対象ペア ----
const PAIRS = [
  { code: "USDJPY", td: "USD/JPY", pip: 0.01,   digits: 3 },
  { code: "EURUSD", td: "EUR/USD", pip: 0.0001, digits: 5 },
  { code: "GBPUSD", td: "GBP/USD", pip: 0.0001, digits: 5 },
  { code: "EURJPY", td: "EUR/JPY", pip: 0.01,   digits: 3 },
  { code: "AUDUSD", td: "AUD/USD", pip: 0.0001, digits: 5 },
  { code: "EURGBP", td: "EUR/GBP", pip: 0.0001, digits: 5 },
  { code: "USDCAD", td: "USD/CAD", pip: 0.0001, digits: 5 },
  { code: "USDCHF", td: "USD/CHF", pip: 0.0001, digits: 5 },
  { code: "NZDUSD", td: "NZD/USD", pip: 0.0001, digits: 5 },
  { code: "AUDNZD", td: "AUD/NZD", pip: 0.0001, digits: 5 },
  // 金と原油は「スポット」の意味が異なるため srcNote で明示的に区別する。
  //   金  : 実物の連続市場（ロンドン現物・LBMA のOTC）が存在し、その価格そのもの。COMEX金先物とは別物。
  //   原油: 実物WTIに連続的な取引レートは存在せず、期近先物から作られた連続価格。
  //         MT4/MT5 の USOIL と同性質。限月指定の NYMEX CL1!（清算値）とは別物。
  { code: "XAUUSD", td: "XAU/USD", pip: 0.1,    digits: 2, srcNote: "ロンドン現物スポット" }, // 0.1ドル=1pip
  { code: "USOIL",  td: "WTI/USD", pip: 0.01,   digits: 2, srcNote: "WTI期近先物連動" },     // 0.01ドル=1pip（MT4/MT5と誤差0.01ドルで実測検証済み）
];

// ---- 株価指数3種（Yahoo現物系列・sourceで自己記述。US500はh1-bars.jsonのチャートと同一ソース）----
// ^DJI/^GSPC/^NDX はそれぞれ YM=F/ES=F/NQ=F と同一指数の現物。^IXIC(ナスダック総合)は別指数のため使用しない。
// 生成物の完全性チェック(isDailyLevelsFresh)と生成ループの両方が参照するため、モジュール直下に置く。
const INDICES = [
  { code: "US500", yahoo: "^GSPC", digits: 2 },
  { code: "US30",  yahoo: "^DJI",  digits: 0 },
  { code: "US100", yahoo: "^NDX",  digits: 2 },
];

// ---- 市場心理（Yahoo Finance 非公式API）----
const SENTIMENT = [
  { code: "DXY",   symbol: "DX-Y.NYB", label: "ドル指数", divisor: 1,  digits: 2 },
  { code: "US2Y",  symbol: "custom",   label: "米2年債利回り", divisor: 1,  digits: 3 }, // fetchUS2Yで特別処理
  { code: "US10Y", symbol: "^TNX",     label: "米10年債利回り", divisor: 10, digits: 3 },
  { code: "VIX",   symbol: "^VIX",     label: "VIX", divisor: 1,  digits: 2 },
];

// ---- 経済指標カレンダー設定 ----
const FF_CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CAL_CURRENCIES = ["USD", "JPY", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF", "CNY"]; // 対象通貨
const CAL_IMPACTS = ["High", "Medium"]; // 対象重要度

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d) => Number(n.toFixed(d));

// ---- HTTP取得（タイムアウト＋分類つきリトライ）----
// 外部APIの一時的な障害で、その銘柄が丸ごとdaily-levels.jsonから欠落するのを防ぐ。
//
// 重要な順序: リトライより先にタイムアウトが必須。素のfetch()はundiciの既定で
// ヘッダ待ち300秒まで無反応になり得るため、タイムアウト無しでリトライを足すと
// 「1本のハングで5分」が「15分」に悪化する。必ずsignalとセットで使うこと。
//
// リトライ上限は1実行あたりの総数でも縛る。レート制限(429)は全銘柄で同時に起きるため、
// 「1リクエストにつき2回」だけだと12銘柄×3回=36リクエストが制限中のAPIに殺到し、
// 一時的なスロットリングをキー停止に悪化させかねない。
const RETRY_BUDGET = { left: 8 };          // 1実行あたりの総リトライ回数の上限
// 同日リトライcron(daily.yml)の最終枠。daily.ymlのcronを変えたらここも揃えること。
// daily-levels.json の generation.retry_expected の算出に使う。
const SAME_DAY_RETRY_UNTIL_JST_HOUR = 13;
const BACKOFF_MS = [2000, 6000];           // 指数バックオフ（+ジッタ）
const RATE_LIMIT_WAIT_MS = 20000;          // 429でRetry-After未提供時の待機

// 再試行して意味がある一時障害か（読み取り専用GETのみなので再送自体は常に安全）
function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}
function isRetryableTransport(e) {
  const code = e?.cause?.code || e?.code || "";
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
       "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"].includes(code)) return true;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return true;
  return /fetch failed|terminated|socket hang up|network/i.test(e?.message || "");
}

/**
 * GETしてJSON(またはテキスト)を返す。タイムアウトと分類つきリトライを内包する。
 * validate(json) は「HTTP 200だが本文がエラー」を判定するコールバック。
 *   → null なら正常、{ message, retryable } を返すとその場で失敗扱い。
 *   Twelve Dataは枯渇・レート制限をHTTP 200 + {"status":"error","code":429} で返すため、
 *   本文検査もリトライループの内側に置く必要がある。
 */
async function fetchWithRetry(url, { label, timeoutMs = 15000, headers, retries = 2, asText = false, validate } = {}) {
  for (let attempt = 0; ; attempt++) {
    let err = null;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        err = new Error(`HTTP ${res.status} (${label})`);
        err.retryable = isRetryableStatus(res.status);
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) err.waitMs = Math.min(60000, ra * 1000);
        else if (res.status === 429) err.waitMs = RATE_LIMIT_WAIT_MS;
        throw err;
      }
      const body = asText ? await res.text() : await res.json();
      const bad = validate ? validate(body) : null;
      if (bad) {
        err = new Error(`${bad.message} (${label})`);
        err.retryable = !!bad.retryable;
        if (bad.retryable) err.waitMs = RATE_LIMIT_WAIT_MS;
        throw err;
      }
      return body;
    } catch (e) {
      err = e;
      // res.json()のSyntaxError = 途中で切れた本文やCDNのHTMLエラーページ。再試行の価値あり
      const retryable = e.retryable !== undefined ? e.retryable
        : (e instanceof SyntaxError ? true : isRetryableTransport(e));
      if (!retryable || attempt >= retries) throw e;
      if (RETRY_BUDGET.left <= 0) {
        e.message += "（1実行あたりのリトライ上限に到達したため再試行せず）";
        throw e;
      }
      RETRY_BUDGET.left--;
      const waitMs = (e.waitMs ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)])
        + Math.floor(Math.random() * 500); // ジッタ（全銘柄が同時に再送するのを崩す）
      console.warn(`  再試行 ${attempt + 1}/${retries} (${label}): ${e.message} → ${Math.round(waitMs / 1000)}秒待機`);
      await sleep(waitMs);
    }
  }
}

// ---- 日付ユーティリティ ----
function lastCompletedSessionDate(now = new Date()) {
  const nyStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const ny = new Date(nyStr);
  let d = new Date(ny);
  if (ny.getHours() < 17) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return fmtDateLocal(d);
}

function fmtDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function jstToday(now = new Date()) {
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return fmtDateLocal(jst);
}

// JSTのISO文字列（例: 2026-07-15T08:30:00+09:00）
function jstIso(now = new Date()) {
  const s = now.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
  return s.replace(" ", "T") + "+09:00";
}

// ---- 指標計算 ----
function computeIndicators(bars) {
  if (bars.length < 21) {
    throw new Error(`確定足が不足しています（${bars.length}本、最低21本必要）`);
  }
  const prev = bars[0];
  const prev2 = bars[1]; // 前々日（存在は本数チェック済みで保証）
  const adr20 =
    bars.slice(0, 20).reduce((s, b) => s + (b.high - b.low), 0) / 20;

  const asc = [...bars].reverse();
  const trs = [];
  for (let i = 1; i < asc.length; i++) {
    const h = asc[i].high, l = asc[i].low, pc = asc[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const period = 14;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  const P = (prev.high + prev.low + prev.close) / 3;
  const range = prev.high - prev.low;
  return {
    sessionDate: prev.date,
    prevOpen: prev.open,
    prevHigh: prev.high,
    prevLow: prev.low,
    prevClose: prev.close,
    prev2Close: prev2.close,
    prev2Date: prev2.date,
    adr20,
    atr14: atr,
    pivot: P,
    r1: 2 * P - prev.low,
    s1: 2 * P - prev.high,
    r2: P + range,
    s2: P - range,
  };
}

// ---- 週足ピボット（前週のH/L/Cから算出。日足と同じクラシック方式）----
// 週の区切りはFX週（日17:00 NY〜金17:00 NY）。日足セッションが既にNY17:00区切りで
// 月〜金ラベルになっているため、同一週の月曜ラベル〜金曜ラベルが1週間に対応する。
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 月曜まで戻す
  return fmtDateLocal(d);
}

// NY現在時刻がFX休場帯（金17:00〜日17:00）にあるか。
// 休場帯 = 直近セッションが属する週は既に閉じている、と判定できる。
// 曜日ではなく時刻で判定するため、金曜が休場（グッドフライデー等）でも正しく切り替わる。
function isFxWeekClosed(now) {
  const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dow = ny.getDay(), h = ny.getHours();
  return (dow === 5 && h >= 17) || dow === 6 || (dow === 0 && h < 17);
}

// barsDesc: 新しい順の日足セッション（computeIndicatorsと同じ入力）
function computeWeeklyPivot(barsDesc, weekClosed) {
  if (!barsDesc.length) return null;
  const latestWeek = mondayOf(barsDesc[0].date);
  let targetWeek = latestWeek;
  if (!weekClosed) {
    // 週の途中は今週が未確定のため、1つ前の週を対象にする
    const prev = barsDesc.find((b) => mondayOf(b.date) !== latestWeek);
    if (!prev) return null; // 前週分のデータが無い
    targetWeek = mondayOf(prev.date);
  }
  const week = barsDesc.filter((b) => mondayOf(b.date) === targetWeek);
  if (!week.length) return null;
  const high = Math.max(...week.map((b) => b.high));
  const low = Math.min(...week.map((b) => b.low));
  const close = week[0].close; // 新しい順なので週内の最終セッション終値
  const open = week[week.length - 1].open; // 新しい順なので配列末尾が週内の最初のセッション始値
  const P = (high + low + close) / 3;
  return {
    open,
    pivot: P,
    r1: 2 * P - low,
    s1: 2 * P - high,
    from: week[week.length - 1].date,
    to: week[0].date,
    sessions: week.length, // 祝日等で4日以下になることがある
  };
}

// ---- Twelve Data から日足を構築（1時間足→NY17:00区切りで自前集計）----
// 理由: Twelve Dataの1day足はtimezone指定が無視され取引所ローカル時間(FX=Australia/Sydney)
// 区切りになるため、NY17:00クローズの日足は1時間足(timezone有効)から集計する。
// 1時間足のtimestampはバーの開始時刻。NY時間に+7hすると 17:00以降のバーが翌セッション日に入る。
function aggregateToNySessions(hourBarsAsc) {
  const sessions = new Map(); // sessionDate -> {open,high,low,close}
  for (const b of hourBarsAsc) {
    const dt = new Date(b.datetime.replace(" ", "T")); // NY表記のローカル時刻として解釈
    const shifted = new Date(dt.getTime() + 7 * 3600000);
    const sd = fmtDateLocal(shifted);
    const dow = shifted.getDay();
    if (dow === 0 || dow === 6) continue; // 土日セッションは存在しない(混入分は除外)
    if (!sessions.has(sd)) {
      sessions.set(sd, { date: sd, open: b.open, high: b.high, low: b.low, close: b.close, bars: 1 });
    } else {
      const s = sessions.get(sd);
      s.high = Math.max(s.high, b.high);
      s.low = Math.min(s.low, b.low);
      s.close = b.close; // 昇順処理なので最後のバーのcloseが残る
      s.bars += 1;
    }
  }
  return [...sessions.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchPairBars(tdSymbol, cutoffDate) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}` +
    `&interval=1h&outputsize=1500&timezone=America/New_York&apikey=${API_KEY}`;
  // Twelve Dataはクレジット枯渇・レート制限をHTTP 200 + {"status":"error","code":429} で返す。
  // 一方 401(キー不正)/403(プラン外シンボル)/404 は何度投げても同じなので再試行しない。
  const json = await fetchWithRetry(url, {
    label: `twelvedata:${tdSymbol}`,
    timeoutMs: 20000, // outputsize=1500 は本文が大きい
    validate: (j) => {
      if (j?.status !== "error" && j?.values) return null;
      const code = Number(j?.code);
      return {
        message: `Twelve Data エラー: ${j?.message || "no data"}${code ? ` [code ${code}]` : ""}`,
        retryable: code === 429 || (code >= 500 && code <= 599),
      };
    },
  });
  const hoursAsc = json.values
    .map((v) => ({
      datetime: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse(); // APIは新しい順 → 昇順へ
  const daily = aggregateToNySessions(hoursAsc)
    .filter((b) => b.date <= cutoffDate)
    .filter((b) => b.bars >= 6); // 極端に欠けたセッション(祝日の断片等)を除外
  return daily.reverse(); // computeIndicatorsは新しい順を期待
}

// ---- Yahoo Finance から指数取得 ----
async function fetchYahoo(item) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=10d&interval=1d`;
  const json = await fetchWithRetry(url, {
    label: `yahoo:${item.symbol}`,
    timeoutMs: 12000,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo データなし (${item.symbol})`);
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(
    (c) => c !== null && c !== undefined
  );
  if (closes.length < 2) throw new Error(`Yahoo 終値不足 (${item.symbol})`);
  let value = closes[closes.length - 1] / item.divisor;
  let prev = closes[closes.length - 2] / item.divisor;
  // 米10年債のスケール自動補正（どちらの表記で来ても4.59%になる）
  if (item.code === "US10Y" && value < 1) { value *= 10; prev *= 10; }
  return {
    label: item.label,
    value: round(value, item.digits),
    prev: round(prev, item.digits),
    change: round(value - prev, item.digits),
    changePct: round(((value - prev) / prev) * 100, 2),
    source: `yahoo:${item.symbol}`,
  };
}

// ---- 米2年債利回り（Yahoo 2YY=F → 失敗時はFRED DGS2に自動フォールバック）----
async function fetchUS2Y() {
  // 第1候補: Yahoo 2YY=F（CME 2年利回り先物・ほぼリアルタイム）
  try {
    // FREDへのフォールバックがあるため再試行は1回だけ（粘るとフォールバックが遅れる）
    const json = await fetchWithRetry("https://query1.finance.yahoo.com/v8/finance/chart/2YY%3DF?range=10d&interval=1d", {
      label: "yahoo:2YY=F", timeoutMs: 12000, retries: 1,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    const closes = (json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [])
      .filter((c) => c !== null && c !== undefined);
    if (closes.length >= 2) {
      const value = closes[closes.length - 1];
      const prev = closes[closes.length - 2];
      if (value > 0.05 && value < 20 && prev > 0.05 && prev < 20) { // 妥当範囲チェック
        return {
          label: "米2年債利回り",
          value: Number(value.toFixed(3)),
          prev: Number(prev.toFixed(3)),
          change: Number((value - prev).toFixed(3)),
          changePct: Number((((value - prev) / prev) * 100).toFixed(2)),
          source: "yahoo:2YY=F",
        };
      }
    }
    // 範囲外・本数不足はFREDへ（HTTP失敗時はfetchWithRetryがthrow → 同じくcatchでFREDへ）
  } catch (e) { /* フォールバックへ */ }

  // 第2候補: FRED公式 DGS2（1営業日遅れ・確実）
  const csv = await fetchWithRetry("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2", {
    label: "fred:DGS2", timeoutMs: 10000, asText: true,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  const vals = csv.trim().split("\n").slice(1)
    .map((l) => parseFloat(l.split(",")[1]))
    .filter((v) => !isNaN(v));
  if (vals.length < 2) throw new Error("FRED DGS2 データ不足");
  const value = vals[vals.length - 1], prev = vals[vals.length - 2];
  return {
    label: "米2年債利回り",
    value: Number(value.toFixed(3)),
    prev: Number(prev.toFixed(3)),
    change: Number((value - prev).toFixed(3)),
    changePct: Number((((value - prev) / prev) * 100).toFixed(2)),
    source: "fred:DGS2(前営業日値)",
  };
}


// ---- Forex Factory カレンダー取得（当日JST分を抽出）----
async function fetchCalendar(todayJst) {
  const events = await fetchWithRetry(FF_CALENDAR_URL, {
    label: "forexfactory:calendar", timeoutMs: 10000,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  const out = [];
  for (const e of events) {
    if (!CAL_CURRENCIES.includes(e.country)) continue;
    if (!CAL_IMPACTS.includes(e.impact)) continue;
    const dt = new Date(e.date); // ISO with offset
    if (isNaN(dt.getTime())) continue;
    const jstDate = fmtDateLocal(new Date(dt.toLocaleString("en-US", { timeZone: "Asia/Tokyo" })));
    if (jstDate !== todayJst) continue;
    const jstTime = dt.toLocaleTimeString("ja-JP", {
      timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    out.push({
      time_jst: jstTime,
      datetime_jst: jstIso(dt),
      currency: e.country,
      impact: e.impact,           // High / Medium
      event: e.title,
      forecast: e.forecast || null,
      previous: e.previous || null,
      scheduled_time_passed: dt.getTime() <= Date.now(), // 発表予定時刻を過ぎたか（事実）
    });
  }
  out.sort((a, b) => a.time_jst.localeCompare(b.time_jst));
  return out;
}

// ---- メイン ----
// ---- 株価指数（Yahoo現物 1時間足→NY17区切り日足）----
// US500はh1-bars.jsonのチャートと同一系列(^GSPC)。US30/US100はdaily水準のみ(チャート化なし)
// 現物は米国立会時間(9:30-16:00 ET)のみのため1日約7本。60d≒42立会日で日足集計には十分。
async function fetchIndexDailyBars(yahooSymbol, cutoffDate) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=60m&range=60d`;
  const json = await fetchWithRetry(url, {
    label: `yahoo:${yahooSymbol}`, timeoutMs: 15000,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  const r = json?.chart?.result?.[0];
  if (!r?.timestamp) throw new Error(`Yahoo ${yahooSymbol} データなし`);
  const q = r.indicators.quote[0];
  const pad = (n) => String(n).padStart(2, "0");
  const hours = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.open[i] == null || q.close[i] == null) continue;
    // NYローカル表記に変換してaggregateToNySessionsへ渡す（Twelve Data 1h と同形式）
    const d = new Date(new Date(r.timestamp[i] * 1000).toLocaleString("en-US", { timeZone: "America/New_York" }));
    hours.push({
      datetime: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`,
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i],
    });
  }
  const daily = aggregateToNySessions(hours)
    .filter((b) => b.date <= cutoffDate)
    .filter((b) => b.bars >= 6);
  return daily.reverse(); // computeIndicatorsは新しい順を期待
}

// 既に当日分が健全に生成済みかを、外部APIを一切叩かずに判定する。
// 同日リトライ用のcronはこの判定で早期終了するため、正常な朝はAPIクレジットを消費しない。
// 「健全」の条件は3つとも満たすこと:
//   1. session_date が期待する直近確定セッションと一致（＝当日分として新しい）
//   2. errors が空（部分失敗して欠けたまま固定されるのを防ぐ）
//   3. 必須銘柄が全て揃っている（render_chart.py の REQUIRED_DAILY と同じ15銘柄）
function isDailyLevelsFresh(expectedSession, requiredCodes) {
  const p = path.join(__dirname, "data", "daily-levels.json");
  if (!fs.existsSync(p)) return { fresh: false, reason: "daily-levels.json が無い" };
  let dl;
  try { dl = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { return { fresh: false, reason: `読み込み失敗: ${e.message}` }; }
  if (dl.session_date !== expectedSession) {
    return { fresh: false, reason: `session_date=${dl.session_date ?? "なし"} / 期待=${expectedSession}` };
  }
  // errorsフィールドが無い＝本機能より前に生成された古い版。安全側に倒して再取得する
  if (!Array.isArray(dl.errors)) return { fresh: false, reason: "errorsフィールドが無い（旧版）" };
  if (dl.errors.length > 0) return { fresh: false, reason: `前回実行に${dl.errors.length}件のエラーが残っている` };
  const missing = requiredCodes.filter((c) => !dl.pairs?.[c]);
  if (missing.length) return { fresh: false, reason: `銘柄不足: ${missing.join(",")}` };
  return { fresh: true, reason: `session_date=${dl.session_date} / ${requiredCodes.length}銘柄・エラー0件` };
}

async function main() {
  const now = new Date();
  const cutoff = lastCompletedSessionDate(now);
  const today = jstToday(now);
  // 週足ピボットの対象週判定に使用（休場帯なら直近セッションの週が確定済み）
  const weekClosed = isFxWeekClosed(now);
  console.log(`実行日(JST): ${today} / 確定セッション: ${cutoff} / FX週確定: ${weekClosed}`);

  // --if-stale: 既に健全な当日分があれば何もせず終了（同日リトライcron用）。
  // 手動実行(workflow_dispatch)ではこのフラグを付けないため、常に再取得される。
  const REQUIRED_CODES = [...PAIRS.map((p) => p.code), ...INDICES.map((ix) => ix.code)];
  if (process.argv.includes("--if-stale")) {
    const f = isDailyLevelsFresh(cutoff, REQUIRED_CODES);
    if (f.fresh) {
      console.log(`既に最新のためスキップ（${f.reason}）。APIは呼び出していません`);
      return;
    }
    console.log(`再取得が必要（${f.reason}）`);
  }

  const out = {
    date: today,
    generatedAt: now.toISOString(),
    sessionDate: cutoff,
    pairs: {},
    sentiment: {},
    errors: [],
  };

  for (const p of PAIRS) {
    try {
      const bars = await fetchPairBars(p.td, cutoff);
      const ind = computeIndicators(bars);
      const wk = computeWeeklyPivot(bars, weekClosed);
      out.pairs[p.code] = {
        sessionDate: ind.sessionDate,
        weeklyOpen: wk ? round(wk.open, p.digits) : null,
        weeklyPivot: wk ? round(wk.pivot, p.digits) : null,
        weeklyR1: wk ? round(wk.r1, p.digits) : null,
        weeklyS1: wk ? round(wk.s1, p.digits) : null,
        weeklyBaseWeek: wk ? `${wk.from}〜${wk.to}` : null,
        prevOpen: round(ind.prevOpen, p.digits),
        prevHigh: round(ind.prevHigh, p.digits),
        prevLow: round(ind.prevLow, p.digits),
        prevClose: round(ind.prevClose, p.digits),
        prev2Close: round(ind.prev2Close, p.digits),
        prev2Date: ind.prev2Date,
        adr20: round(ind.adr20, p.digits),
        atr14: round(ind.atr14, p.digits),
        pivot: round(ind.pivot, p.digits),
        r1: round(ind.r1, p.digits),
        s1: round(ind.s1, p.digits),
        r2: round(ind.r2, p.digits),
        s2: round(ind.s2, p.digits),
        adr20Pips: p.pip ? Math.round(ind.adr20 / p.pip) : null,
        atr14Pips: p.pip ? Math.round(ind.atr14 / p.pip) : null,
      };
      console.log(`OK: ${p.code} (session=${ind.sessionDate})`);
    } catch (e) {
      console.error(`FAIL: ${p.code} - ${e.message}`);
      out.errors.push(`${p.code}: ${e.message}`);
    }
    await sleep(1500);
  }

  for (const s of SENTIMENT) {
    try {
      out.sentiment[s.code] = s.code === "US2Y" ? await fetchUS2Y() : await fetchYahoo(s);
      console.log(`OK: ${s.code}`);
    } catch (e) {
      console.error(`FAIL: ${s.code} - ${e.message}`);
      out.errors.push(`${s.code}: ${e.message}`);
      out.sentiment[s.code] = null;
    }
    await sleep(500);
  }

  // 経済指標カレンダー（GPT用）
  let calendar = [];
  try {
    calendar = await fetchCalendar(today);
    console.log(`OK: カレンダー ${calendar.length}件`);
  } catch (e) {
    console.error(`FAIL: カレンダー - ${e.message}`);
    out.errors.push(`calendar: ${e.message}`);
  }

  // ---- 保存 ----
  const dataDir = path.join(__dirname, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  // 1) ダッシュボード用（従来通り）
  fs.writeFileSync(path.join(dataDir, `${today}.json`), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(dataDir, "latest.json"), JSON.stringify(out, null, 2));

  const indexPath = path.join(dataDir, "index.json");
  let dates = [];
  if (fs.existsSync(indexPath)) {
    try { dates = JSON.parse(fs.readFileSync(indexPath, "utf8")).dates || []; } catch {}
  }
  if (!dates.includes(today)) dates.unshift(today);
  dates.sort().reverse();
  fs.writeFileSync(indexPath, JSON.stringify({ dates }, null, 2));

  // 2) GPT用 daily-levels.json
  const s = (c) => out.sentiment[c];
  const dailyLevels = {
    as_of: jstIso(now),
    timezone: "Asia/Tokyo",
    session_date: cutoff,
    // 生成の健全性。中身は株価指数ループの完了後（ファイル書き出し直前）に確定させるが、
    // キーの位置をここで確保しておく（JSON.stringifyは挿入順を保つため、後から代入すると
    // 巨大なpairsの後ろに埋もれて読み手が気づけない）。
    generation: null,
    errors: [],
    market_sentiment: {
      dxy: s("DXY")?.value ?? null,
      dxy_change_pct: s("DXY")?.changePct ?? null,
      us2y: s("US2Y")?.value ?? null,
      us2y_change: s("US2Y")?.change ?? null,
      us10y: s("US10Y")?.value ?? null,
      us10y_change: s("US10Y")?.change ?? null,
      vix: s("VIX")?.value ?? null,
      vix_change_pct: s("VIX")?.changePct ?? null,
      // 取得元の自己記述（pairsのsourceと同形式）。us2yはYahoo先物とFRED公式のどちらから
      // 取れたかで実行のたびに変わり得るため、fetchUS2Y()が実際に使った経路をそのまま反映する。
      source: {
        dxy: s("DXY")?.source ?? null,
        us2y: s("US2Y")?.source ?? null,
        us10y: s("US10Y")?.source ?? null,
        vix: s("VIX")?.source ?? null,
      },
    },
    pairs: {},
  };
  for (const p of PAIRS) {
    const d = out.pairs[p.code];
    if (!d) continue;
    dailyLevels.pairs[p.code] = {
      prev_open: d.prevOpen,
      prev_high: d.prevHigh,
      prev_low: d.prevLow,
      prev_close_ny: d.prevClose,
      prev2_close_ny: d.prev2Close,   // 前々日NY終値
      prev2_session_date: d.prev2Date,
      adr20: d.adr20,
      adr20_pips: d.adr20Pips,
      atr14: d.atr14,
      atr14_pips: d.atr14Pips,
      atr_sl_1_0: round(d.atr14 * 1.0, p.digits), // SL目安レンジ（事実値: ATR×1.0〜1.5）
      atr_sl_1_5: round(d.atr14 * 1.5, p.digits),
      // 前日値幅 ÷ ADR20（%）: 前日にADRをどれだけ使ったか
      previous_day_range_pct: d.adr20 > 0 ? round(((d.prevHigh - d.prevLow) / d.adr20) * 100, 1) : null,
      pivot: d.pivot,
      r1: d.r1, r2: d.r2,
      s1: d.s1, s2: d.s2,
      // 週足ピボット（前週H/L/Cのクラシック方式・R1/Pivot/S1の3点）+ 週の始値
      weekly_open: d.weeklyOpen,
      weekly_pivot: d.weeklyPivot,
      weekly_r1: d.weeklyR1,
      weekly_s1: d.weeklyS1,
      weekly_base_week: d.weeklyBaseWeek, // 算出根拠の週（監査用）
      // 出典の自己記述（株価指数と同形式）。金・原油は系列の性質を srcNote で併記する
      source: `twelvedata:${p.td}${p.srcNote ? `(${p.srcNote})` : ""}`,
    };
  }
  for (const ix of INDICES) {
    try {
      const bars = await fetchIndexDailyBars(ix.yahoo, cutoff);
      const ind = computeIndicators(bars);
      const wk = computeWeeklyPivot(bars, weekClosed);
      const dg = ix.digits;
      dailyLevels.pairs[ix.code] = {
        prev_open: round(ind.prevOpen, dg),
        prev_high: round(ind.prevHigh, dg),
        prev_low: round(ind.prevLow, dg),
        prev_close_ny: round(ind.prevClose, dg),
        prev2_close_ny: round(ind.prev2Close, dg),
        prev2_session_date: ind.prev2Date,
        adr20: round(ind.adr20, dg),
        adr20_pips: round(ind.adr20, dg === 0 ? 0 : 1), // 指数はポイント表記
        atr14: round(ind.atr14, dg),
        atr14_pips: round(ind.atr14, dg === 0 ? 0 : 1),
        atr_sl_1_0: round(ind.atr14 * 1.0, dg),
        atr_sl_1_5: round(ind.atr14 * 1.5, dg),
        previous_day_range_pct: ind.adr20 > 0 ? round(((ind.prevHigh - ind.prevLow) / ind.adr20) * 100, 1) : null,
        pivot: round(ind.pivot, dg),
        r1: round(ind.r1, dg), s1: round(ind.s1, dg),
        r2: round(ind.r2, dg), s2: round(ind.s2, dg),
        // 週足ピボット（前週H/L/Cのクラシック方式・R1/Pivot/S1の3点）+ 週の始値
        weekly_open: wk ? round(wk.open, dg) : null,
        weekly_pivot: wk ? round(wk.pivot, dg) : null,
        weekly_r1: wk ? round(wk.r1, dg) : null,
        weekly_s1: wk ? round(wk.s1, dg) : null,
        weekly_base_week: wk ? `${wk.from}〜${wk.to}` : null,
        session_date: ind.sessionDate,
        source: `yahoo:${ix.yahoo}(現物)`,
      };
      console.log(`OK: ${ix.code} levels (session=${ind.sessionDate})`);
      await sleep(300);
    } catch (e) {
      console.error(`FAIL: ${ix.code} levels - ${e.message}`);
      out.errors.push(`${ix.code}: ${e.message}`);
    }
  }

  // ---- 生成の健全性を daily-levels.json 自身に残す ----
  // これが無いと下流は「取得に失敗して欠けている」と「そもそも対象外」を区別できず、
  // 部分的に欠けたフィードが正常なものとして下流に流れてしまう。
  // 株価指数ループの後（＝out.errorsが出揃った後）に確定させること。
  const missingPairs = REQUIRED_CODES.filter((c) => !dailyLevels.pairs[c]);
  const sentimentCodes = SENTIMENT.map((s) => s.code);
  const missingSentiment = sentimentCodes.filter((c) => !out.sentiment[c]);
  const calendarOk = !out.errors.some((e) => e.startsWith("calendar:"));
  const jstHour = Number(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo", hour: "2-digit", hour12: false }));
  // 同日リトライcron（daily.yml）が残っているか。cronを変更したらここも揃えること。
  const retryExpected = out.errors.length > 0 && jstHour < SAME_DAY_RETRY_UNTIL_JST_HOUR;

  dailyLevels.errors = [...out.errors];
  dailyLevels.generation = {
    status: out.errors.length === 0 ? "ok" : "partial",
    complete: out.errors.length === 0 && missingPairs.length === 0,
    coverage: {
      pairs: { expected: REQUIRED_CODES.length, present: REQUIRED_CODES.length - missingPairs.length, missing: missingPairs },
      sentiment: { expected: sentimentCodes.length, present: sentimentCodes.length - missingSentiment.length, missing: missingSentiment },
      calendar: { ok: calendarOk, events: calendar.length },
    },
    retry_expected: retryExpected,
    retry_note: retryExpected
      ? `同日中に daily.yml の再試行cronが残っている（JST ${SAME_DAY_RETRY_UNTIL_JST_HOUR}時頃まで）。次の実行で自動的に再取得される`
      : "同日中の自動再試行は残っていない。復旧は翌営業日朝の定期実行、または daily.yml の手動実行(workflow_dispatch)",
    run_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
  };

  fs.writeFileSync(path.join(dataDir, "daily-levels.json"), JSON.stringify(dailyLevels, null, 2));

  // 3) GPT用 economic-calendar.json
  fs.writeFileSync(path.join(dataDir, "economic-calendar.json"), JSON.stringify({
    as_of: jstIso(now),
    date: today,
    timezone: "Asia/Tokyo",
    source: "Forex Factory calendar feed",
    actuals_note: "本フィードのデータ源(FF公開フィード)は実績値(actual)を含まない。scheduled_time_passed=trueのイベントの実績値は別ソースで確認すること。",
    filters: { currencies: CAL_CURRENCIES, impacts: CAL_IMPACTS },
    events: calendar,
  }, null, 2));

  console.log(`保存完了: latest.json / daily-levels.json / economic-calendar.json`);
  if (out.errors.length > 0) {
    console.warn(`警告: ${out.errors.length}件の取得エラーあり（部分的に保存済み）`);
  }
  if (Object.keys(out.pairs).length === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
