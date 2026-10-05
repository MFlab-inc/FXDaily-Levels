"use strict";
const { addDays, dowIso, isWeekday, isoDate } = require("./ny-time");

/**
 * MTF判定の計算（仕様 v1.0 第2節・第3節）。入力は NY17時区切りの確定日足（古い順）。
 *   rows: [{ date, open, high, low, close, bars, last_bar_ny? }]
 * 判定は丸める前の値で行う（3-6）。浮動小数点の誤差で「等しい」「60ちょうど」が崩れないよう、
 * 比較は EPS（1e-9）の許容つき。価格の最小刻みや比率の最小の差は EPS より十分大きい
 * （例: 5桁通貨の50日平均との差は最小でも 1e-5/50 = 2e-7）ので、本物の差を潰すことはない。
 */

const UP = "↑";
const DOWN = "↓";
const FLAT = "→";
const INSUFFICIENT = "Insufficient Data";
const EPS = 1e-9;

// 必要な本数
const N = { dma50: 50, dma200: 200, d20: 20, w9: 9, w20: 20, w26: 26, w52: 52, m6: 6, m12: 12, m24: 24 };

const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => sum(a) / a.length;
const last = (a, n) => a.slice(a.length - n);

// a と b の大小。EPS 以内なら 0（等しい）
function cmp(a, b) {
  const d = a - b;
  if (Math.abs(d) <= EPS) return 0;
  return d > 0 ? 1 : -1;
}
const aboveLabel = (c) => (c > 0 ? "Above" : c < 0 ? "Below" : "Equal");

// ---------- 2-1 日足 ----------
// rows の末尾（最新の確定日足）の構造を返す。本数が足りない項目は null
function dailyStructure(rows) {
  const n = rows.length;
  const closes = rows.map((r) => r.close);
  const cur = rows[n - 1];
  const out = {
    date: cur.date,
    close: cur.close,
    dma50: null, dma200: null,
    close_vs_50dma: INSUFFICIENT, close_vs_200dma: INSUFFICIENT,
    high_20d: null, low_20d: null, range_position_20d: null,
    direction: INSUFFICIENT,
    bars_available: n,
    bars_used: Math.min(n, N.dma200),
  };
  if (n >= N.dma50) {
    out.dma50 = mean(last(closes, N.dma50));
    out.close_vs_50dma = aboveLabel(cmp(cur.close, out.dma50));
  }
  if (n >= N.dma200) {
    out.dma200 = mean(last(closes, N.dma200));
    out.close_vs_200dma = aboveLabel(cmp(cur.close, out.dma200));
  }
  if (n >= N.d20) {
    const w = last(rows, N.d20);
    out.high_20d = Math.max(...w.map((r) => r.high));
    out.low_20d = Math.min(...w.map((r) => r.low));
    out.range_position_20d = rangePosition(cur.close, out.low_20d, out.high_20d);
  }
  if (n >= N.dma200) {
    const a50 = cmp(cur.close, out.dma50);
    const a200 = cmp(cur.close, out.dma200);
    out.direction = a50 > 0 && a200 > 0 ? UP : a50 < 0 && a200 < 0 ? DOWN : FLAT;
  }
  return out;
}

// (終値 − 安値) ÷ (高値 − 安値) × 100。分母が0なら50（2-1 の A19、6か月でも同じ扱い: 3-3）
function rangePosition(close, low, high) {
  const den = high - low;
  if (cmp(high, low) === 0) return 50;
  return ((close - low) / den) * 100;
}

// ---------- 週・月のまとめ方（3-8）----------
// 週: 月曜〜金曜の DATE_NY をまとめ、キーはその週の金曜日。週が月をまたいでもよい
function fridayOf(dateStr) {
  return addDays(dateStr, 5 - dowIso(dateStr));
}
// 月: DATE_NY の暦の月
const monthOf = (dateStr) => dateStr.slice(0, 7);

// 月内の最後の平日（月〜金）。3-4: 月はこの日のNY終値で確定する（月末が週末ならその直前の金曜）
function lastWeekdayOfMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  let d = isoDate(Date.UTC(y, m, 0)); // その月の末日
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}

function aggregateGroups(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r.date);
    const g = groups.get(k);
    if (!g) {
      groups.set(k, { key: k, end_date: r.date, high: r.high, low: r.low, close: r.close, days: 1 });
    } else {
      g.high = Math.max(g.high, r.high);
      g.low = Math.min(g.low, r.low);
      g.end_date = r.date; // rows は古い順なので、最後に来た日が「データがある最後の営業日」
      g.close = r.close;
      g.days += 1;
    }
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const buildWeeks = (rows) => aggregateGroups(rows, fridayOf);
const buildMonths = (rows) => aggregateGroups(rows, monthOf);

// ---------- 2-2 週足（一目均衡表。先行スパンの26期間シフトはしない）----------
// weeks: 確定済みの週（古い順）。末尾が判定の対象
function weeklyStructure(weeks) {
  const n = weeks.length;
  const cur = weeks[n - 1];
  const hl = (cnt) => {
    const w = last(weeks, cnt);
    return { high: Math.max(...w.map((x) => x.high)), low: Math.min(...w.map((x) => x.low)) };
  };
  const mid = (cnt) => { const r = hl(cnt); return (r.high + r.low) / 2; };

  const out = {
    date: cur.end_date, week_key: cur.key,
    high: cur.high, low: cur.low, close: cur.close,
    high_20w: null, low_20w: null,
    tenkan: null, kijun: null, span_a: null, span_b: null, cloud_top: null, cloud_bottom: null,
    close_vs_cloud: INSUFFICIENT, tenkan_vs_kijun: INSUFFICIENT,
    direction: INSUFFICIENT,
    bars_available: n,
    bars_used: Math.min(n, N.w52),
  };
  if (n >= N.w20) { const r = hl(N.w20); out.high_20w = r.high; out.low_20w = r.low; }
  if (n >= N.w9) out.tenkan = mid(N.w9);
  if (n >= N.w26) out.kijun = mid(N.w26);
  if (out.tenkan !== null && out.kijun !== null) {
    out.span_a = (out.tenkan + out.kijun) / 2;
    const c = cmp(out.tenkan, out.kijun);
    out.tenkan_vs_kijun = c > 0 ? "Bullish TK" : c < 0 ? "Bearish TK" : "Neutral TK";
  }
  if (n >= N.w52) out.span_b = mid(N.w52);
  if (out.span_a !== null && out.span_b !== null) {
    out.cloud_top = Math.max(out.span_a, out.span_b);
    out.cloud_bottom = Math.min(out.span_a, out.span_b);
    const aboveTop = cmp(cur.close, out.cloud_top) > 0;
    const belowBottom = cmp(cur.close, out.cloud_bottom) < 0;
    out.close_vs_cloud = aboveTop ? "Above Cloud" : belowBottom ? "Below Cloud" : "In Cloud";
    // 向きの判定は 52週そろっている（先行スパンBが出せる）ときだけ
    const tk = cmp(out.tenkan, out.kijun);
    out.direction = aboveTop && tk > 0 ? UP : belowBottom && tk < 0 ? DOWN : FLAT;
  }
  return out;
}

// ---------- 2-3 月足 ----------
function monthlyStructure(months) {
  const n = months.length;
  const cur = months[n - 1];
  const out = {
    date: cur.end_date, month: cur.key,
    high: cur.high, low: cur.low, close: cur.close,
    mma12: null, mma24: null,
    high_6m: null, low_6m: null, range_position_6m: null,
    key_support: null, key_resistance: null,
    direction: INSUFFICIENT,
    data_status: n >= N.m24 ? "OK" : n >= N.m12 ? "Partial (no 24MMA)" : INSUFFICIENT,
    bars_available: n,
    bars_used: Math.min(n, N.m24),
  };
  if (n >= N.m12) out.mma12 = mean(last(months, N.m12).map((m) => m.close));
  if (n >= N.m24) out.mma24 = mean(last(months, N.m24).map((m) => m.close));
  if (n >= N.m6) {
    const w = last(months, N.m6);
    out.high_6m = Math.max(...w.map((m) => m.high));
    out.low_6m = Math.min(...w.map((m) => m.low));
    out.range_position_6m = rangePosition(cur.close, out.low_6m, out.high_6m);
    out.key_support = out.low_6m;
    out.key_resistance = out.high_6m;
  }
  if (n >= N.m12) {
    const c = cmp(cur.close, out.mma12);
    const rp = out.range_position_6m;
    out.direction =
      c > 0 && rp - 60 >= -EPS ? UP :
      c < 0 && rp - 40 <= EPS ? DOWN : FLAT;
  }
  return out;
}

// ---------- 2-4 組み合わせ ----------
const isDir = (d) => d === UP || d === DOWN;

function alignmentScore(m, w, d) {
  const dirs = [m, w, d];
  if (dirs.some((x) => x === INSUFFICIENT)) return INSUFFICIENT;
  const up = dirs.filter((x) => x === UP).length;
  const down = dirs.filter((x) => x === DOWN).length;
  if (up === down) return up === 0 ? "0/3" : "Mixed"; // →は「そろった」に数えない（3-5）
  return up > down ? `${up}/3 Up` : `${down}/3 Down`;
}

function swingStatus(m, w, d) {
  if ([m, w, d].some((x) => x === INSUFFICIENT)) return "Insufficient Data";
  if (isDir(m) && m === w && w === d) return "Swing Main Candidate";
  if (isDir(w) && w === d && isDir(m) && m !== w) return "Counter-trend Caution";
  if (isDir(w) && w === d) return "Conditional Swing Candidate";
  if ((isDir(m) && m === w) || (isDir(m) && m === d)) return "Conditional Swing Candidate";
  return "No Swing / Excluded";
}

// ---------- 2-5 確定足だけで判定 ----------
/**
 * rows: 日足（古い順）。asOf: 判定の基準日（その日の NY 17時までの確定足。既定は rows の最後の日）
 * asOf より後の行は無視する。週は金曜（キー）が最新の日足の日付以前なら確定、
 * 月は月内の最後の平日が最新の日足の日付以前なら確定（3-4）。最新の日足が基準日に届いていなければ、その分だけ確定が遅れる。
 */
function computeStructure(allRows, { asOf = null } = {}) {
  const limit = asOf || (allRows.length ? allRows[allRows.length - 1].date : null);
  const rows = allRows.filter((r) => r.date <= limit);
  if (!rows.length) return null;
  // 週・月の確定は「データが実際にそこまで届いているか」で判定する（最新の日足の日付 = rows の最後の日）。
  // 基準日(asOf)の足がまだ届いていないのに、途中までの日で作った週足・月足を「確定」として出さないため。
  const reached = rows[rows.length - 1].date;

  const daily = dailyStructure(rows);
  const weeks = buildWeeks(rows).filter((w) => w.key <= reached);
  const months = buildMonths(rows).filter((m) => lastWeekdayOfMonth(m.key) <= reached);
  const weekly = weeks.length ? weeklyStructure(weeks) : null;
  const monthly = months.length ? monthlyStructure(months) : null;
  const md = monthly ? monthly.direction : INSUFFICIENT;
  const wd = weekly ? weekly.direction : INSUFFICIENT;

  return {
    as_of: limit,
    daily, weekly, monthly,
    alignment_score: alignmentScore(md, wd, daily.direction),
    swing_status: swingStatus(md, wd, daily.direction),
    rows,
  };
}

// ---------- 履歴・品質 ----------
// 直近10営業日（データのある日）の、終値・50DMA・200DMA・日足の向き・CLOSE_vs_50DMA
function dailyHistory(rows, count = 10) {
  const out = [];
  for (let i = Math.max(0, rows.length - count); i < rows.length; i++) {
    const s = dailyStructure(rows.slice(0, i + 1));
    out.push({
      date: s.date, close: s.close, dma50: s.dma50, dma200: s.dma200,
      direction: s.direction, close_vs_50dma: s.close_vs_50dma,
    });
  }
  return out;
}

// 平日（月〜金）なのに日足が無い日（先頭の日〜until の範囲）。0や前日の値で埋めない
function missingWeekdays(rows, until = null) {
  if (!rows.length) return [];
  const have = new Set(rows.map((r) => r.date));
  const end = until && until > rows[rows.length - 1].date ? until : rows[rows.length - 1].date;
  const out = [];
  for (let d = rows[0].date; d <= end; d = addDays(d, 1)) {
    if (isWeekday(d) && !have.has(d)) out.push(d);
  }
  return out;
}

// 足の本数が標準より少ない日。金曜で最後の1時間足が NY 16時台より前に始まっている日も印を付ける（3-7）
function shortBarDays(rows, standardBars) {
  const out = [];
  for (const r of rows) {
    const reasons = [];
    if (r.bars < standardBars) reasons.push("bars");
    if (dowIso(r.date) === 5 && r.last_bar_ny && r.last_bar_ny < "16:00") reasons.push("friday_last_bar_before_16");
    if (reasons.length) out.push({ date: r.date, bars: r.bars, standard: standardBars, last_bar_ny: r.last_bar_ny || null, reasons });
  }
  return out;
}

module.exports = {
  UP, DOWN, FLAT, INSUFFICIENT, EPS, N,
  cmp, rangePosition, fridayOf, monthOf, lastWeekdayOfMonth,
  buildWeeks, buildMonths, dailyStructure, weeklyStructure, monthlyStructure,
  alignmentScore, swingStatus, computeStructure, dailyHistory, missingWeekdays, shortBarDays,
};
