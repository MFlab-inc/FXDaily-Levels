"use strict";
const { SYMBOLS, VERSION } = require("../config");
const { toJstIso } = require("./ny-time");
const calc = require("./calc");

/**
 * 出力（仕様 第4節）。data/mtf-feed.json と data/mtf-feed.txt を同じ内容から作る。
 *   ・向きの判定は丸める前の値で済んでいる（calc.js）。ここでは表示用に丸めるだけ（3-6）
 *     移動平均・一目均衡表の値は価格の桁数+1桁、価格そのもの（終値・高安）は価格の桁数、位置（%）は小数2桁
 *   ・形成途中の足（WTD／MTD）は出力しない（calc.js が確定足だけを渡す）
 */
const PRICE_TYPE = "NY17時区切り日足の終値（Twelve Data の1時間足を UTC で取得し、NY時間に換算して作成）";
const DAILY_BOUNDARY = "ニューヨーク時間17時";
const EXCLUDED = "形成途中の足（WTD／MTD）は除外（確定した足だけで判定）";

const round = (x, d) => (x === null || x === undefined ? null : Number(x.toFixed(d)));

function symbolBlock(sym, item, asOf) {
  const base = {
    symbol: sym.code,
    source: `twelvedata:${sym.td}`,
    price_type: PRICE_TYPE,
    updated_at: item.updatedAt || null,
  };
  if (!item.rows || !item.rows.length) {
    return { ...base, status: "error", error: item.error || "日足の履歴がありません", data_date: null };
  }
  const st = calc.computeStructure(item.rows, { asOf });
  if (!st) return { ...base, status: "error", error: item.error || `基準日 ${asOf} 以前の日足がありません`, data_date: null };
  const p = (x) => round(x, sym.digits);
  const a = (x) => round(x, sym.digits + 1);
  const rp = (x) => round(x, 2);
  const d = st.daily, w = st.weekly, m = st.monthly;
  const stale = d.date < asOf;
  const shortDays = calc.shortBarDays(st.rows, sym.standardBars);
  // 判定に使う終値の日（日足の日・週の最終営業日・月の最終営業日）が本数不足なら、その行にも印を付ける
  const flagOf = (date) => shortDays.find((x) => x.date === date) || null;
  return {
    ...base,
    status: item.error ? "error" : stale ? "stale" : "ok",
    ...(item.error ? { error: item.error } : {}),
    data_date: d.date,
    monthly: m ? {
      date: m.date, direction: m.direction, close: p(m.close),
      mma12: a(m.mma12), mma24: a(m.mma24),
      high_6m: p(m.high_6m), low_6m: p(m.low_6m), range_position_6m: rp(m.range_position_6m),
      data_status: m.data_status, bars_used: m.bars_used, bars_available: m.bars_available,
      close_day_short_bars: flagOf(m.date),
    } : {
      date: null, direction: calc.INSUFFICIENT, close: null, mma12: null, mma24: null, high_6m: null, low_6m: null, range_position_6m: null,
      data_status: calc.INSUFFICIENT, bars_used: 0, bars_available: 0, close_day_short_bars: null,
    },
    weekly: w ? {
      date: w.date, direction: w.direction, close: p(w.close),
      tenkan: a(w.tenkan), kijun: a(w.kijun), span_a: a(w.span_a), span_b: a(w.span_b),
      cloud_top: a(w.cloud_top), cloud_bottom: a(w.cloud_bottom),
      close_vs_cloud: w.close_vs_cloud, tenkan_vs_kijun: w.tenkan_vs_kijun,
      high_20w: p(w.high_20w), low_20w: p(w.low_20w),
      bars_used: w.bars_used, bars_available: w.bars_available,
      close_day_short_bars: flagOf(w.date),
    } : {
      date: null, direction: calc.INSUFFICIENT, close: null, tenkan: null, kijun: null, span_a: null, span_b: null, cloud_top: null, cloud_bottom: null,
      close_vs_cloud: calc.INSUFFICIENT, tenkan_vs_kijun: calc.INSUFFICIENT, high_20w: null, low_20w: null,
      bars_used: 0, bars_available: 0, close_day_short_bars: null,
    },
    daily: {
      date: d.date, direction: d.direction, close: p(d.close),
      dma50: a(d.dma50), dma200: a(d.dma200),
      close_vs_50dma: d.close_vs_50dma, close_vs_200dma: d.close_vs_200dma,
      high_20d: p(d.high_20d), low_20d: p(d.low_20d), range_position_20d: rp(d.range_position_20d),
      bars_used: d.bars_used, bars_available: d.bars_available,
      close_day_short_bars: flagOf(d.date),
    },
    alignment_score: st.alignment_score,
    swing_status: st.swing_status,
    history: calc.dailyHistory(st.rows, 10).map((h) => ({
      date: h.date, close: p(h.close), dma50: a(h.dma50), dma200: a(h.dma200),
      direction: h.direction, close_vs_50dma: h.close_vs_50dma,
    })),
    missing_dates: calc.missingWeekdays(st.rows, asOf),
    short_bar_days: shortDays,
  };
}

/**
 * items: [{ code, rows|null, updatedAt, error? }]（SYMBOLS の順）
 * 返り値: { json, text }
 */
function buildFeed({ asOf, nowMs, items, attempt = 1 }) {
  const byCode = new Map(items.map((i) => [i.code, i]));
  const symbols = SYMBOLS.map((s) => symbolBlock(s, byCode.get(s.code) || { error: "取得対象に含まれていません" }, asOf));
  const dates = symbols.map((s) => s.data_date).filter(Boolean).sort();
  const complete = symbols.filter((s) => s.status === "ok").length;
  const json = {
    generated_at: toJstIso(nowMs),
    // 最新の確定日足の日付。銘柄ごとに違うときは最も古い日付を出す（古い銘柄があれば、止める条件に掛かるように）
    data_base_date: dates.length ? dates[0] : null,
    as_of: asOf,
    status: complete === symbols.length ? "ok" : "partial",
    coverage: `${complete}/${symbols.length}銘柄が基準日(${asOf})まで更新済み`,
    attempt,
    version: VERSION,
    daily_boundary: DAILY_BOUNDARY,
    excluded: EXCLUDED,
    symbols,
  };
  return { json, text: renderText(json) };
}

// ---------- テキスト ----------
const dash = (x) => (x === null || x === undefined ? "-" : String(x));
const fx = (x, d) => (x === null || x === undefined ? "-" : x.toFixed(d));
const blank = (x, d) => (x === null || x === undefined ? "" : x.toFixed(d)); // 24MMA だけは仕様 §4 のとおり、無ければ空
const flag = (f) => (f ? ` ※足の本数不足(${f.bars}/${f.standard}本${f.reasons.includes("friday_last_bar_before_16") ? `,金曜の最終足${f.last_bar_ny}` : ""})` : "");

function renderText(feed) {
  const L = [];
  L.push("# MTF判定フィード");
  L.push(`generated_at: ${feed.generated_at}`);
  L.push(`data_base_date: ${feed.data_base_date || "なし"}（最新の確定日足の日付。銘柄ごとに違うときは最も古い日付。この日付が前営業日でなければ古い）`);
  L.push(`as_of: ${feed.as_of}（今回の更新で確定しているはずの日付）`);
  L.push(`status: ${feed.status}（${feed.coverage}）`);
  L.push(`version: ${feed.version}`);
  L.push(`daily_boundary: ${feed.daily_boundary}`);
  L.push(`excluded: ${feed.excluded}`);
  L.push("dates: 全ての date / data_base_date / as_of は NY17時区切りの日付（DATE_NY）。generated_at だけが日本時間");
  L.push("legend: 向き ↑上向き・↓下向き・→どちらでもない / Above・Below・Equal は終値が基準より上・下・同じ / 値が空欄または - は本数不足で計算できない項目 / bars_used は日足・週足・月足の本数（保有=持っている本数）、SHORT_BAR_DAYS の「本」は1日の中の1時間足の本数");
  for (const s of feed.symbols) {
    const sym = SYMBOLS.find((x) => x.code === s.symbol);
    const dg = sym.digits;
    L.push("");
    L.push(`## ${s.symbol}`);
    L.push(`source: ${s.source}`);
    L.push(`price_type: ${s.price_type}`);
    L.push(`updated_at: ${s.updated_at || "なし"}`);
    L.push(`status: ${s.status}${s.error ? `（${s.error}）` : s.status === "stale" ? `（最新の確定日足が ${s.data_date} で、基準日 ${feed.as_of} に届いていません）` : ""}`);
    if (!s.daily) continue;
    const m = s.monthly, w = s.weekly, d = s.daily;
    L.push(`MONTHLY: date=${dash(m.date)} direction=${m.direction} close=${fx(m.close, dg)} 12MMA=${fx(m.mma12, dg + 1)} 24MMA=${blank(m.mma24, dg + 1)} 6M_HIGH=${fx(m.high_6m, dg)} 6M_LOW=${fx(m.low_6m, dg)} 6M_RANGE_POSITION=${fx(m.range_position_6m, 2)} DATA_STATUS=${m.data_status} bars_used=${m.bars_used} (保有${m.bars_available})${flag(m.close_day_short_bars)}`);
    L.push(`WEEKLY: date=${dash(w.date)} direction=${w.direction} close=${fx(w.close, dg)} Tenkan=${fx(w.tenkan, dg + 1)} Kijun=${fx(w.kijun, dg + 1)} SpanA=${fx(w.span_a, dg + 1)} SpanB=${fx(w.span_b, dg + 1)} Cloud_Top=${fx(w.cloud_top, dg + 1)} Cloud_Bottom=${fx(w.cloud_bottom, dg + 1)} CLOSE_vs_CLOUD=${dash(w.close_vs_cloud)} TENKAN_vs_KIJUN=${dash(w.tenkan_vs_kijun)} 20W_HIGH=${fx(w.high_20w, dg)} 20W_LOW=${fx(w.low_20w, dg)} bars_used=${w.bars_used} (保有${w.bars_available})${flag(w.close_day_short_bars)}`);
    L.push(`DAILY: date=${d.date} direction=${d.direction} close=${fx(d.close, dg)} 50DMA=${fx(d.dma50, dg + 1)} 200DMA=${fx(d.dma200, dg + 1)} CLOSE_vs_50DMA=${d.close_vs_50dma} CLOSE_vs_200DMA=${d.close_vs_200dma} 20D_HIGH=${fx(d.high_20d, dg)} 20D_LOW=${fx(d.low_20d, dg)} 20D_RANGE_POSITION=${fx(d.range_position_20d, 2)} bars_used=${d.bars_used} (保有${d.bars_available})${flag(d.close_day_short_bars)}`);
    L.push(`ALIGNMENT_SCORE: ${s.alignment_score}`);
    L.push(`SWING_STATUS: ${s.swing_status}`);
    L.push("HISTORY（直近10営業日。日付 / 終値 / 50DMA / 200DMA / 日足の向き / CLOSE_vs_50DMA）:");
    for (const h of s.history) L.push(`  ${h.date} / ${fx(h.close, dg)} / ${fx(h.dma50, dg + 1)} / ${fx(h.dma200, dg + 1)} / ${h.direction} / ${h.close_vs_50dma}`);
    L.push(`MISSING_DATES（平日で日足が無い日）: ${s.missing_dates.length ? s.missing_dates.join(", ") : "なし"}`);
    L.push(`SHORT_BAR_DAYS（足の本数が標準${sym.standardBars}本より少ない日。金曜で最後の足がNY16時前の日を含む）: ${
      s.short_bar_days.length
        ? s.short_bar_days.map((x) => `${x.date}(${x.bars}本${x.reasons.includes("friday_last_bar_before_16") ? `,金曜の最終足${x.last_bar_ny}` : ""})`).join(", ")
        : "なし"}`);
  }
  return L.join("\n") + "\n";
}

module.exports = { buildFeed, renderText, PRICE_TYPE };
