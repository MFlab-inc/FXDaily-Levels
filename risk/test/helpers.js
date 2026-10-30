"use strict";
/**
 * 試験用の補助。VIX の値は試験のために作ったもの（実データではない）。日付は NYSE の営業日（risk/lib/calendar.js）に合わせる。
 */
const fs = require("fs");
const path = require("path");
const { isOpen } = require("../lib/calendar");
const { addDays } = require("../../mtf/lib/ny-time");

const ROOT = path.join(__dirname, "..");
const EVENTS_PATH = path.join(ROOT, "events.csv");
const eventsText = () => fs.readFileSync(EVENTS_PATH, "utf8");

// 日本時間の日時（"2026-10-30 10:00"）→ UTCミリ秒
const jst = (s) => Date.parse(`${s.replace(" ", "T")}:00+09:00`);

// from〜to（両端含む）の NYSE の営業日に、決まった式で終値を割り当てる。{date, close} の配列（古い順）
function syntheticRows(from, to) {
  const rows = [];
  let i = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isOpen(d)) continue;
    // 12〜30 の範囲で上下する値（小数6桁で丸めて、CSV と同じ精度にする）
    const v = 20 + 6 * Math.sin(i / 9) + 3 * Math.sin(i / 2.3) + ((i * 7) % 11) / 10;
    rows.push({ date: d, close: Math.round(v * 1e6) / 1e6 });
    i++;
  }
  return rows;
}

// Cboe の VIX_History.csv と同じ形の文字列
function toCboeCsv(rows) {
  const mmdd = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
  const f = (x) => x.toFixed(6);
  return ["DATE,OPEN,HIGH,LOW,CLOSE", ...rows.map((r) => `${mmdd(r.date)},${f(r.close)},${f(r.close + 1)},${f(r.close - 1)},${f(r.close)}`)].join("\n") + "\n";
}

// 素朴な計算（試験の答え合わせ用。本体の calc.js とは別に書く）
function naiveRank(closes, i, window) {
  const w = closes.slice(i - window + 1, i + 1);
  const c = w.filter((x) => x <= closes[i]).length;
  return Number(((c / window) * 100).toFixed(1));
}

module.exports = { ROOT, EVENTS_PATH, eventsText, jst, syntheticRows, toCboeCsv, naiveRank };
