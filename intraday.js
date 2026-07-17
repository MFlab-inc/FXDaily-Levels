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
  { code: "XAUUSD", td: "XAU/USD", digits: 2 },
];

const round = (n, d) => Number(n.toFixed(d));

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
  const symbols = PAIRS.map((p) => p.td).join(",");
  const res = await fetch(
    `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols)}&apikey=${API_KEY}`
  );
  const json = await res.json();

  const out = {
    as_of: jstIso(now),
    timezone: "Asia/Tokyo",
    session_date: daily.session_date || null,
    note: "事実データのみ。トレード判定は含まない。ADRはdaily-levels.jsonのADR20基準。",
    market_session: sessionInfo(now),
    pairs: {},
    errors: [],
  };

  for (const p of PAIRS) {
    const q = json[p.td];
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

  fs.writeFileSync(path.join(dataDir, "intraday.json"), JSON.stringify(out, null, 2));
  console.log("保存完了: data/intraday.json");
  if (Object.keys(out.pairs).length === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
