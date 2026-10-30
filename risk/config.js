"use strict";

/**
 * 取引可否の指標（自前の定義）の設定値。仕様は risk/SPEC.md。
 * いまは VIX 順位とイベント警戒。MOVE・HY OAS・中立の数は、定義が決まってから足す。
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

module.exports = { VIX, EVENT, READY_ET_MIN, STALE_AFTER_HOURS, EXTRA_CLOSED_DATES, HTTP, PROCESSOR_NAME, CITATIONS };
