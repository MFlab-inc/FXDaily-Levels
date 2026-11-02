"use strict";

/**
 * 取引可否の指標（自前の定義）の設定値。仕様は risk/SPEC.md。
 * いまは VIX 順位とイベント警戒。MOVE・HY OAS の代わりは試し運転中（TRIAL）。中立の数は、定義が決まってから足す。
 */

// ---- VIX（SPEC 2節・3節）----
const VIX = {
  // Cboe の公式ページ「VIX Index Historical Data」にある「VIX Index data for 1990 to present (Updated Daily)」のリンク
  url: "https://cdn-api.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv",
  pageUrl: "https://www.cboe.com/tradable_products/vix/vix_historical_data",
  // 順位を数える範囲（当日を含む直近の営業日の数。およそ1年）
  window: 252,
  // 止める基準（%）。swing-flow の SPEC 3-6「VIX順位70%以上」と同じ値。ここで変えても記事の判定は変わらない
  thresholdPct: 70,
  // risk.json に残す、過去の日ごとの順位の数（GPT の値との照合用）
  historyDays: 60,
  // 想定外の値の検出（この範囲の外の終値があれば、ファイルの形式が変わったとみなして失敗にする）。
  // VIX の終値の過去最高は 82.69（2020-03-16）。余裕をみて200未満とする
  closeMinExclusive: 0,
  closeMaxExclusive: 200,
};

// ---- イベント警戒（SPEC 5節。2026-10-30 ユーザー決定：7日以内に2件以上で High）----
const EVENT = {
  // 数える予定の種類。tz は発表元の現地の時間帯（予定表の tz 列がこれと違えば失敗にする）
  kinds: {
    FOMC: { name: "米FOMC（政策金利）", tz: "America/New_York" },
    ECB: { name: "ECB理事会（政策金利）", tz: "Europe/Berlin" },
    BOJ: { name: "日銀 金融政策決定会合", tz: "Asia/Tokyo" },
    BOE: { name: "英中銀MPC（政策金利）", tz: "Europe/London" },
    RBA: { name: "豪中銀（政策金利）", tz: "Australia/Sydney" },
    BOC: { name: "カナダ中銀（政策金利）", tz: "America/Toronto" },
    NFP: { name: "米雇用統計", tz: "America/New_York" },
    CPI: { name: "米消費者物価指数（CPI）", tz: "America/New_York" },
  },
  // 基準時刻：日本時間のその日の9:00（記事を作る朝）。ここから windowDays 日（168時間）以内を数える
  baseJstHour: 9,
  windowDays: 7,
  // この件数以上なら High、未満なら Normal
  highCount: 2,
  // 時刻の記載が無い予定は、現地のこの時刻とみなす
  dateOnlyLocalTime: "12:00",
  // 予定表の終わりがこの日数以内に迫ったら、更新を促す警告を出す
  coverageWarnDays: 60,
};

// ---- 試し運転の指標（SPEC 10節。記事にはまだ使わない。2026-11-02 ユーザー決定）----
const TRIAL = {
  // ② MOVE の代わり：米国債の金利の実際の値動きの大きさ（自前の定義）
  ratesVol: {
    // 米財務省 Daily Treasury Par Yield Curve Rates の年ごとのCSV（rates/ と同じ取得先）
    csvUrl: (year) =>
      `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all` +
      `?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`,
    pageUrl: "https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics",
    tenors: ["2 Yr", "5 Yr", "10 Yr", "30 Yr"],
    lookback: 20,      // 直近20営業日の1日の変化
    window: 252,       // 順位を数える範囲
    thresholdPct: 80,  // swing-flow SPEC 3-6 の MOVE の基準と同じ（切り替える前に試し運転で確かめる）
    historyN: 60,
  },
  // ③ HY OAS の代わり（候補1）：FRB の短期社債（CP）の金利差。A2/P2 − AA、非金融・30日物
  cpSpread: {
    zipUrl: "https://www.federalreserve.gov/releases/cp/data/FRB_CP_xml.zip",
    pageUrl: "https://www.federalreserve.gov/releases/cp/",
    low: "RIFSPPNA2P2D30_N.B",   // 30-Day A2/P2 Nonfinancial（FRED では RIFSPPNA2P2D30NB）
    high: "RIFSPPNAAD30_N.B",    // 30-Day AA Nonfinancial（FRED では RIFSPPNAAD30NB）
    window: 252,
    thresholdPct: 70,  // swing-flow SPEC 3-6 の HY OAS の基準と同じ
    historyN: 60,
  },
  // ③ HY OAS の代わり（候補2）：シカゴ連銀 NFCI の信用の部分（週1回）。商用で使う前に許可の問い合わせが必要
  nfciCredit: {
    csvUrl: "https://www.chicagofed.org/-/media/publications/nfci/nfci-data-series-csv.csv",
    pageUrl: "https://www.chicagofed.org/research/data/nfci/current-data",
    column: "Credit",
    window: 52,        // 週1回の値なので、過去1年＝52週
    thresholdPct: 70,
    historyN: 13,
  },
  // 1日の中で取り直す間隔の下限（分）。米国債の値の公表待ちのとき、起動のたびに取りに行かないように
  minRefetchMinutes: 60,
};

// ---- 時刻（SPEC 4節）----
// VIX の終値は米東部16:15に確定する。CSV がいつ更新されるかは未確認のため、米東部18:00を過ぎたら
// その日の値があるはずとみなして取りに行き始める（--if-stale）。
const READY_ET_MIN = 18 * 60;
// 期待する日の値が、上の時刻からこの時間を過ぎても無いときだけ「古い」（--check-fresh が失敗）とする。
// 16時間＝米東部の翌朝10:00（日本時間の夜）。それまでは「更新待ち」。
const STALE_AFTER_HOURS = 16;
// 規則では決まらない休場（国の追悼の日など）。NYSE が発表したら日付（YYYY-MM-DD）を足す。
const EXTRA_CLOSED_DATES = [];

// ---- 取得 ----
const HTTP = {
  timeoutMs: 30000,
  retries: 2,
  backoffMs: [2000, 6000],
  userAgent: "FXDaily-Levels-risk/1.0 (+https://github.com/MFlab-inc/FXDaily-Levels)",
};

// ---- 出典（SPEC 6節）----
const PROCESSOR_NAME = "MFlab-inc／FXDaily-Levels";
const CITATIONS = {
  vix: `出典：Cboe「VIX Index Historical Data」（${VIX.pageUrl}）の日次終値。` +
    `過去1年（${VIX.window}営業日）での順位は${PROCESSOR_NAME}が計算`,
  event: "予定の日付：FRB・ECB・日本銀行・イングランド銀行・オーストラリア準備銀行・カナダ銀行・米労働統計局の公式日程" +
    `（各URLは risk/events.csv）。件数の集計は${PROCESSOR_NAME}`,
};

module.exports = { VIX, EVENT, TRIAL, READY_ET_MIN, STALE_AFTER_HOURS, EXTRA_CLOSED_DATES, HTTP, PROCESSOR_NAME, CITATIONS };
