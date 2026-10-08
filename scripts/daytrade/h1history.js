"use strict";
const fs = require("fs");
const path = require("path");
const { fetchRange } = require("../../mtf/lib/twelvedata");
const { nyWallMs } = require("../../mtf/lib/ny-time");
const { HR, parseJstLabel, jstLabel } = require("./jst");
const { pairOf } = require("./pairs");

/**
 * バックテスト用のH1履歴（仕様 6-2）。data/history/h1-<銘柄>.csv に、1回だけ保存する（既にあれば再取得しない）。
 *  1行目 `# timezone=Asia/Tokyo`、2行目が見出し `time_jst,o,h,l,c`。時刻は足の開始時刻（h1-bars.json と同じ日本時間表記）[Q35]。
 *  取得は mtf/lib/twelvedata.js の createClient と fetchRange を流用（変更しない）。fetchRange は timezone を UTC に固定しているので、
 *  client を包んで timezone=Asia/Tokyo に上書きする。
 *  daytrade.js の h1-bars.json と同じく、FXの休場帯（金17:00 NY〜日17:00 NY）の足と、進行中の足は含めない。
 */
const TZ_LINE = "# timezone=Asia/Tokyo";
const HEADER = "time_jst,o,h,l,c";

const csvPath = (dataDir, code) => path.join(dataDir, "history", `h1-${code}.csv`);

// FX休場帯（金17:00 NY 以降〜日17:00 NY 未満）。足の開始時刻（epoch ms）で判定。daytrade.js の isFxClosed と同じ
function isFxClosedMs(ms) {
  const w = new Date(nyWallMs(ms));
  const dow = w.getUTCDay(), h = w.getUTCHours();
  return (dow === 5 && h >= 17) || dow === 6 || (dow === 0 && h < 17);
}

function toCsv(bars, pair) {
  const f = (v) => v.toFixed(pair.digits);
  return [TZ_LINE, HEADER, ...bars.map((b) => `${jstLabel(b.t)},${f(b.o)},${f(b.h)},${f(b.l)},${f(b.c)}`)].join("\n") + "\n";
}

function parseCsv(text, label = "h1 csv") {
  const lines = String(text).split(/\r?\n/).filter((l) => l.length);
  if (lines[0] !== TZ_LINE) throw new Error(`${label}: 1行目が「${TZ_LINE}」ではありません（時刻の基準が分からないため読みません）`);
  if (lines[1] !== HEADER) throw new Error(`${label}: 見出し行が想定と違います`);
  const bars = [];
  lines.slice(2).forEach((ln, i) => {
    const f = ln.split(",");
    const t = parseJstLabel(f[0]);
    const v = f.slice(1).map(Number);
    if (f.length !== 5 || !Number.isFinite(t) || !v.every(Number.isFinite)) throw new Error(`${label}:${i + 3}行目が読めません`);
    if (bars.length && t <= bars[bars.length - 1].t) throw new Error(`${label}:${i + 3}行目: 時刻が昇順・重複なしになっていません`);
    bars.push({ t, o: v[0], h: v[1], l: v[2], c: v[3] });
  });
  return bars;
}

function readH1(dataDir, code) {
  const p = csvPath(dataDir, code);
  return fs.existsSync(p) ? parseCsv(fs.readFileSync(p, "utf8"), path.basename(p)) : null;
}
const existingCodes = (dataDir) => {
  const dir = path.join(dataDir, "history");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => /^h1-(.+)\.csv$/.exec(f)?.[1]).filter(Boolean).sort();
};

// timezone=Asia/Tokyo に上書きするラッパー（fetchRange は UTC 固定なので）
const tokyoClient = (client) => ({ timeSeries: (p) => client.timeSeries({ ...p, timezone: "Asia/Tokyo" }), stats: client.stats });

/**
 * 1銘柄のH1を取得。startLabel は JST の "YYYY-MM-DD HH:MM:SS"。確定足（開始+1時間 ≤ nowMs）だけ、休場帯を除く。
 */
async function fetchH1(client, pair, { startLabel, nowMs, pageSize, log = () => {} }) {
  const raw = await fetchRange(tokyoClient(client), pair.td, startLabel, { pageSize, log });
  const byT = new Map();
  for (const r of raw) {
    const t = parseJstLabel(r.datetime);
    if (!Number.isFinite(t) || t + HR > nowMs || isFxClosedMs(t)) continue;
    byT.set(t, { t, o: r.open, h: r.high, l: r.low, c: r.close });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/**
 * 取得した足と、ライブの h1-bars.json（同じ日本時間表記）の重なりをOHLCで突き合わせる。
 * 時刻の解釈（日付パラメータと timezone）がずれていないかの自己検証 [Q35]。
 */
function verifyAgainstLive(bars, liveBars, pair) {
  const live = new Map(liveBars.map((b) => [b.t, b]));
  const tol = pair.pip / 10 / 2; // 価格の最小刻みの半分
  let overlap = 0, mismatch = 0;
  const sample = [];
  for (const b of bars) {
    const l = live.get(b.t);
    if (!l) continue;
    overlap++;
    if (["o", "h", "l", "c"].some((k) => Math.abs(b[k] - l[k]) > tol)) { mismatch++; if (sample.length < 3) sample.push({ t: jstLabel(b.t), fetched: [b.o, b.h, b.l, b.c], live: [l.o, l.h, l.l, l.c] }); }
  }
  return { overlap, mismatch, sample };
}

// 3〜40時間の抜け（週末・休日の長い休みと、普通の連続の間）の数。参考情報
function gapReport(bars) {
  const gaps = [];
  for (let i = 1; i < bars.length; i++) {
    const h = (bars[i].t - bars[i - 1].t) / HR;
    if (h > 3 && h < 40) gaps.push({ from: jstLabel(bars[i - 1].t), hours: h });
  }
  return gaps;
}

module.exports = { TZ_LINE, HEADER, csvPath, isFxClosedMs, toCsv, parseCsv, readH1, existingCodes, fetchH1, verifyAgainstLive, gapReport, tokyoClient, pairOf };
