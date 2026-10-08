"use strict";

/**
 * 日米2年金利フィードの設定値（仕様は rates/SPEC.md）。
 * 判定のしきい値・出典の文言・取得先URLは、すべてここに置く。
 */

// ---- 判定（SPEC 4節）----
// 金利差（米2年 − 日2年）の5営業日差が −THRESHOLD_BP 以下なら円高方向、+THRESHOLD_BP 以上なら円安方向
// （境界を含む）。その間ははっきりしない。
const THRESHOLD_BP = 10;
const LOOKBACK_BUSINESS_DAYS = 5;
const LABELS = {
  yen_strong: "円高方向",
  yen_weak: "円安方向",
  unclear: "はっきりしない",
  unavailable: "判定できません",
};

// ---- 取得先（SPEC 2節）----
const treasuryCsvUrl = (year) =>
  `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all` +
  `?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
const treasuryXmlUrl = (year) =>
  "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml" +
  `?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;
const URLS = {
  treasuryCsv: treasuryCsvUrl,
  treasuryXml: treasuryXmlUrl,
  mofMonth: "https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv",
  mofAll: "https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv",
  caoHolidays: "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv",
};

// ---- 時刻（SPEC 5節）----
// 日2年は「翌営業日午前9時30分頃」の公表（財務省FAQ）。公表前に取りに行かない／公表前を「古い」と
// 数えないため、9時40分を「公表済みとみなす時刻」にする。
const JP_READY_JST_MIN = 9 * 60 + 40;
// 公表済みのはずの時刻から、この時刻までは「更新待ち（pending）」として赤にしない。
const PENDING_UNTIL_JST_MIN = 10 * 60 + 30;
// rates.yml の schedule による同日中の再試行が残っている最終の時（JST）。schedule の最終時刻を変えたら揃えること。
// なお rates.yml は、intraday.yml・daily.yml の完了（workflow_run）でも起動するため、この時刻を過ぎても再取得は続きうる。
// retry_expected=false は「自動の再試行が無い」ことを意味しない（SPEC 5-2・8-2）。
const SAME_DAY_RETRY_UNTIL_JST_HOUR = 14;
// 米財務省は「通常、米東部18:00までに掲載」。その後の余裕を含めて18:30（米東部）を「掲載済みのはず」の時刻にする。
const US_READY_ET_MIN = 18 * 60 + 30;
// 米国の休場かどうか規則だけでは決まらない日（聖金曜・土曜の祝日の振替の金曜）に、行が無いまま
// この時間（掲載済みのはずの時刻から）が過ぎたら、休場だったと見なす。
const UNCERTAIN_US_CLOSED_AFTER_HOURS = 24;

// 前回値の引き継ぎ・判定に使う、過去分が足りているかの下限（財務省の月次ファイルが短い月初に全期間ファイルを取る）
const MOF_MONTH_MIN_ROWS = 12;
const US_YEAR_MIN_ROWS = 20;

// ---- 取得（SPEC 5節）----
const HTTP = {
  timeoutMs: 20000,
  largeTimeoutMs: 90000, // 全期間ファイル（約1.2MB）用
  retries: 2,
  backoffMs: [2000, 6000],
  userAgent: "FXDaily-Levels-rates/1.0 (+https://github.com/MFlab-inc/FXDaily-Levels)",
};

// ---- 出典（SPEC 6節）----
// 財務省（日本）は公共データ利用規約（第1.0版）PDL1.0。加工した旨とその主体を書く（PDL1.0 の出典記載の規定）。
// 加工の主体の名称は PROCESSOR_NAME で変える。
const PROCESSOR_NAME = "MFlab-inc／FXDaily-Levels";
const CITATIONS = {
  us: "出典：米財務省 Daily Treasury Par Yield Curve Rates" +
    "（https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics）",
  jp: "出典：財務省「国債金利情報」（https://www.mof.go.jp/jgbs/reference/interest_rate/index.htm）、" +
    "PDL1.0（https://www.digital.go.jp/resources/open_data/public_data_license_v1.0）を加工して作成" +
    `（5営業日の差と金利差の計算：${PROCESSOR_NAME}）`,
};

module.exports = {
  THRESHOLD_BP, LOOKBACK_BUSINESS_DAYS, LABELS, URLS,
  JP_READY_JST_MIN, PENDING_UNTIL_JST_MIN, SAME_DAY_RETRY_UNTIL_JST_HOUR,
  US_READY_ET_MIN, UNCERTAIN_US_CLOSED_AFTER_HOURS,
  MOF_MONTH_MIN_ROWS, US_YEAR_MIN_ROWS,
  HTTP, PROCESSOR_NAME, CITATIONS,
};
