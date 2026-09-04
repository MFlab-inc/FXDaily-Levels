/**
 * FX Intraday Snapshot
 * 平日9:00〜23:00 JSTに1時間ごと実行される想定（GitHub Actions）。
 * Twelve Data /quote（バッチ1回=7クレジット）で当日の現在値・高安を取得し、
 * data/daily-levels.json のADR20・Pivotレベルと突き合わせて事実データを出力する。
 * 判定（トレード可否等）は行わない。判定はGPT側のプロンプトの責務。
 *
 * 出力: data/intraday.json
 */

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.TWELVE_DATA_API_KEY;
if (!API_KEY) {
  console.error("ERROR: 環境変数 TWELVE_DATA_API_KEY が設定されていません");
  process.exit(1);
}

const PAIRS = [
  { code: "USDJPY", td: "USD/JPY", digits: 3 },
  { code: "EURUSD", td: "EUR/USD", digits: 5 },
  { code: "GBPUSD", td: "GBP/USD", digits: 5 },
  { code: "EURJPY", td: "EUR/JPY", digits: 3 },
  { code: "AUDUSD", td: "AUD/USD", digits: 5 },
  { code: "EURGBP", td: "EUR/GBP", digits: 5 },
  { code: "USDCAD", td: "USD/CAD", digits: 5 },
  { code: "USDCHF", td: "USD/CHF", digits: 5 },
  { code: "NZDUSD", td: "NZD/USD", digits: 5 },
  { code: "AUDNZD", td: "AUD/NZD", digits: 5 },
  { code: "XAUUSD", td: "XAU/USD", digits: 2 },
  { code: "USOIL",  td: "WTI/USD", digits: 2 },
];

const round = (n, d) => Number(n.toFixed(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- HTTP取得（タイムアウト＋分類つきリトライ）----
// fetch.jsの同名ヘルパーと同じ設計（詳細はそちら参照）。この台本は15分毎に
// 走るため、fetch.jsより小さめの予算・待機時間にしてある：1回の実行が長引いて
// 次のスケジュール実行と重ならないようにするため。ダメでも次の15分サイクルで
// 自然にリトライされる。
const RETRY_BUDGET = { left: 6 };
const BACKOFF_MS = [1500, 4000];
const RATE_LIMIT_WAIT_MS = 8000;

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

async function fetchWithRetry(url, { label, timeoutMs = 12000, headers, retries = 2, asText = false, validate } = {}) {
  for (let attempt = 0; ; attempt++) {
    let err = null;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        err = new Error(`HTTP ${res.status} (${label})`);
        err.retryable = isRetryableStatus(res.status);
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) err.waitMs = Math.min(30000, ra * 1000);
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
      const retryable = e.retryable !== undefined ? e.retryable
        : (e instanceof SyntaxError ? true : isRetryableTransport(e));
      if (!retryable || attempt >= retries) throw e;
      if (RETRY_BUDGET.left <= 0) {
        e.message += "（1実行あたりのリトライ上限に到達したため再試行せず）";
        throw e;
      }
      RETRY_BUDGET.left--;
      const waitMs = (e.waitMs ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)])
        + Math.floor(Math.random() * 500);
      console.warn(`  再試行 ${attempt + 1}/${retries} (${label}): ${e.message} → ${Math.round(waitMs / 1000)}秒待機`);
      await sleep(waitMs);
    }
  }
}

// ---- 市場心理（Yahoo Finance・fetch.jsと同一仕様）----
const SENTIMENT = [
  { code: "DXY",   symbol: "DX-Y.NYB", label: "ドル指数", divisor: 1,  digits: 2 },
  { code: "US2Y",  symbol: "custom",   label: "米2年債利回り", divisor: 1,  digits: 3 }, // fetchUS2Yで特別処理
  { code: "US10Y", symbol: "^TNX",     label: "米10年債利回り", divisor: 10, digits: 3 },
  { code: "VIX",   symbol: "^VIX",     label: "VIX", divisor: 1,  digits: 2 },
  // 株価指数は現物系列。^DJI/^GSPC/^NDX は YM=F/ES=F/NQ=F と同一指数の現物。
  // ^IXIC(ナスダック総合)はナスダック100とは別指数のため使用しない。
  // label にコード名(US30等)を含めないこと。ダッシュボードが「ラベル（コード）」形式で
  // 描画するため、含めると US100(NQ100現物)（US100）のように二重表示になる。
  { code: "US30",  symbol: "^DJI",     label: "ダウ平均・現物", divisor: 1, digits: 0 },
  { code: "US500", symbol: "^GSPC",    label: "S&P500・現物", divisor: 1, digits: 2 },
  { code: "US100", symbol: "^NDX",     label: "ナスダック100・現物", divisor: 1, digits: 2 },
];

async function fetchYahoo(item) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=10d&interval=1d`;
  const json = await fetchWithRetry(url, {
    label: `yahoo:${item.symbol}`, timeoutMs: 12000,
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
  if (item.code === "US10Y" && value < 1) { value *= 10; prev *= 10; }
  return {
    label: item.label,
    value: round(value, item.digits),
    prev: round(prev, item.digits),
    change: round(value - prev, item.digits),
    changePct: round(((value - prev) / prev) * 100, 2),
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


// ---- 経済カレンダー再取得（日中の鮮度維持。fetch.jsと同一仕様）----
const FF_CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CAL_CURRENCIES = ["USD", "JPY", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF", "CNY"];
const CAL_IMPACTS = ["High", "Medium"];

function fmtDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function refreshCalendar(dataDir, now) {
  const todayJst = fmtDateLocal(new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" })));
  const events = await fetchWithRetry(FF_CALENDAR_URL, {
    label: "forexfactory:calendar", timeoutMs: 10000,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  const out = [];
  for (const e of events) {
    if (!CAL_CURRENCIES.includes(e.country)) continue;
    if (!CAL_IMPACTS.includes(e.impact)) continue;
    const dt = new Date(e.date);
    if (isNaN(dt.getTime())) continue;
    const jstDate = fmtDateLocal(new Date(dt.toLocaleString("en-US", { timeZone: "Asia/Tokyo" })));
    if (jstDate !== todayJst) continue;
    out.push({
      time_jst: dt.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }),
      datetime_jst: jstIso(dt),
      currency: e.country,
      impact: e.impact,
      event: e.title,
      forecast: e.forecast || null,
      previous: e.previous || null,
      scheduled_time_passed: dt.getTime() <= now.getTime(),
    });
  }
  out.sort((a, b) => a.time_jst.localeCompare(b.time_jst));
  fs.writeFileSync(path.join(dataDir, "economic-calendar.json"), JSON.stringify({
    as_of: jstIso(now),
    date: todayJst,
    timezone: "Asia/Tokyo",
    source: "Forex Factory calendar feed",
    actuals_note: "本フィードのデータ源(FF公開フィード)は実績値(actual)を含まない。scheduled_time_passed=trueのイベントの実績値は別ソースで確認すること。",
    filters: { currencies: CAL_CURRENCIES, impacts: CAL_IMPACTS },
    events: out,
  }, null, 2));
  return out.length;
}

function jstIso(now = new Date()) {
  const s = now.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
  return s.replace(" ", "T") + "+09:00";
}

// 市場セッション判定（feed生成時点の事実。夏冬時間はタイムゾーン変換で自動対応）
// 慣例: 東京 9:00-17:00 JST / ロンドン・NY は現地 8:00-17:00
function sessionInfo(now = new Date()) {
  const localInfo = (tz) => {
    const d = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    return { h: d.getHours(), day: d.getDay(), d };
  };
  const jst = localInfo("Asia/Tokyo");
  const ldn = localInfo("Europe/London");
  const nyc = localInfo("America/New_York");
  const isWd = (x) => x.day >= 1 && x.day <= 5;
  // 現地8:00がJSTで何時か（時差から算出）
  const openJst = (localDate) => {
    const diffH = Math.round((jst.d - localDate) / 3600000);
    const h = (((8 + diffH) % 24) + 24) % 24;
    return String(h).padStart(2, "0") + ":00";
  };
  return {
    as_of: jstIso(now),
    tokyo: isWd(jst) && jst.h >= 9 && jst.h < 17 ? "open" : "closed",
    london: isWd(ldn) && ldn.h >= 8 && ldn.h < 17 ? "open" : "closed",
    new_york: isWd(nyc) && nyc.h >= 8 && nyc.h < 17 ? "open" : "closed",
    opens_jst: { tokyo: "09:00", london: openJst(ldn.d), new_york: openJst(nyc.d) },
    note: "feed生成時点の判定。東京9:00-17:00 JST、ロンドン/NYは現地8:00-17:00基準。現在時刻での再判定はopens_jstを使うこと。",
  };
}

// 現在値がピボットレベルのどのゾーンにあるか（事実の区分）
function priceZone(price, lv) {
  if (price >= lv.r2) return "above_R2";
  if (price >= lv.r1) return "R1_to_R2";
  if (price >= lv.pivot) return "Pivot_to_R1";
  if (price >= lv.s1) return "S1_to_Pivot";
  if (price >= lv.s2) return "S2_to_S1";
  return "below_S2";
}

async function main() {
  const now = new Date();

  // 当日レベル（朝生成分）を読み込む
  const dataDir = path.join(__dirname, "data");
  const levelsPath = path.join(dataDir, "daily-levels.json");
  if (!fs.existsSync(levelsPath)) {
    console.error("daily-levels.json がありません（朝のDaily FX Dataを先に実行してください）");
    process.exit(1);
  }
  const daily = JSON.parse(fs.readFileSync(levelsPath, "utf8"));

  // バッチクオート取得（1リクエスト=7クレジット）
  // 取得に失敗しても process は落とさない。以前はここが素のfetch()で丸裸だったため、
  // 1回の429やネットワーク断でintraday.js全体が例外で落ち、intraday.ymlの後続ステップ
  // 「node daytrade.js」（h1-bars.json生成）まで巻き添えで止まっていた。daytrade.jsは
  // intraday.jsの出力に一切依存しない独立処理なので、この結合には根拠が無かった。
  const symbols = PAIRS.map((p) => p.td).join(",");
  let quoteJson = {};
  let quoteBatchError = null;
  try {
    quoteJson = await fetchWithRetry(
      `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols)}&apikey=${API_KEY}`,
      {
        label: "twelvedata:quote", timeoutMs: 15000,
        validate: (j) => {
          // 正常時は "USD/JPY": {...} のような銘柄キー直下のマップ。
          // レート制限等はバッチ全体が {"status":"error","code":429,...} に置き換わる。
          if (j?.status !== "error") return null;
          const code = Number(j?.code);
          return {
            message: `Twelve Data quoteバッチエラー: ${j?.message || "no data"}${code ? ` [code ${code}]` : ""}`,
            retryable: code === 429 || (code >= 500 && code <= 599),
          };
        },
      }
    );
  } catch (e) {
    console.error(`FAIL: quoteバッチ取得 - ${e.message}`);
    quoteBatchError = e.message;
    quoteJson = {}; // 全銘柄が下のループで「quote取得失敗」として一律エラー記録される
  }

  const out = {
    as_of: jstIso(now),
    timezone: "Asia/Tokyo",
    session_date: daily.session_date || null,
    note: "事実データのみ。トレード判定は含まない。ADRはdaily-levels.jsonのADR20基準。",
    market_session: sessionInfo(now),
    sentiment: {},
    pairs: {},
    errors: quoteBatchError ? [`quote_batch: ${quoteBatchError}`] : [],
  };

  for (const p of PAIRS) {
    const q = quoteJson[p.td];
    const lv = daily.pairs?.[p.code];
    if (!q || q.status === "error" || !q.close) {
      out.errors.push(`${p.code}: quote取得失敗`);
      continue;
    }
    const price = parseFloat(q.close);
    const high = parseFloat(q.high);
    const low = parseFloat(q.low);
    const entry = {
      price: round(price, p.digits),
      today_high: round(high, p.digits),
      today_low: round(low, p.digits),
      change_from_prev_close: lv ? round(price - lv.prev_close_ny, p.digits) : null,
    };
    if (lv && lv.adr20 > 0) {
      const used = high - low;
      entry.adr_used = round(used, p.digits);
      entry.adr_remaining = round(Math.max(lv.adr20 - used, 0), p.digits);
      entry.adr_used_pct = round((used / lv.adr20) * 100, 1);
      entry.price_zone = priceZone(price, lv);
      entry.dist_to_r1 = round(lv.r1 - price, p.digits);
      entry.dist_to_s1 = round(lv.s1 - price, p.digits);
      entry.dist_to_pivot = round(lv.pivot - price, p.digits);
    }
    out.pairs[p.code] = entry;
    console.log(`OK: ${p.code} price=${entry.price} adr_used=${entry.adr_used_pct ?? "-"}%`);
  }

  // 市場心理も毎回更新（Yahoo・クレジット消費なし）
  for (const s of SENTIMENT) {
    try {
      out.sentiment[s.code] = s.code === "US2Y" ? await fetchUS2Y() : await fetchYahoo(s);
      console.log(`OK: ${s.code}`);
    } catch (e) {
      console.error(`FAIL: ${s.code} - ${e.message}`);
      out.errors.push(`${s.code}: ${e.message}`);
      out.sentiment[s.code] = null;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  fs.writeFileSync(path.join(dataDir, "intraday.json"), JSON.stringify(out, null, 2));
  console.log("保存完了: data/intraday.json");

  // カレンダーも再取得（失敗しても他の出力には影響させない）
  try {
    const n = await refreshCalendar(dataDir, now);
    console.log(`カレンダー更新: ${n}件`);
  } catch (e) {
    console.error(`カレンダー更新失敗（朝の版を維持）: ${e.message}`);
  }
  if (Object.keys(out.pairs).length === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
