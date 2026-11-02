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

// ---------- 試し運転の指標の試験用データ（どれも試験のために作った値。実データではない） ----------
const zlib = require("zlib");
const { addDays: addD } = require("../../mtf/lib/ny-time");
const isWeekdayIso = (d) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; };

// 平日の米国債の金利（2・5・10・30年）。bp の整数で、日ごとに決まった式で動く
function syntheticYields(from, to) {
  const rows = [];
  let i = 0;
  for (let d = from; d <= to; d = addD(d, 1)) {
    if (!isWeekdayIso(d)) continue;
    const base = { "2 Yr": 420, "5 Yr": 440, "10 Yr": 470, "30 Yr": 500 };
    const bp = {};
    for (const [t, b] of Object.entries(base)) {
      bp[t] = b + Math.round(25 * Math.sin(i / 17 + b) + 6 * Math.sin(i / 3.1) * (1 + (i % 40) / 40));
    }
    rows.push({ date: d, bp });
    i++;
  }
  return rows;
}
// 米財務省のCSVと同じ形（新しい日付が先頭、列名は引用符つき）。year を指定するとその年の行だけ
function toTreasuryCsv(rows, year) {
  const cols = ["1 Mo", "2 Mo", "3 Mo", "6 Mo", "1 Yr", "2 Yr", "3 Yr", "5 Yr", "7 Yr", "10 Yr", "20 Yr", "30 Yr"];
  const head = ["Date", ...cols.map((c) => `"${c}"`)].join(",");
  const pick = year ? rows.filter((r) => r.date.startsWith(String(year))) : rows;
  if (!pick.length) return "";
  const body = [...pick].reverse().map((r) => {
    const mmdd = `${r.date.slice(5, 7)}/${r.date.slice(8, 10)}/${r.date.slice(0, 4)}`;
    return [mmdd, ...cols.map((c) => (r.bp[c] !== undefined ? (r.bp[c] / 100).toFixed(2) : "4.00"))].join(",");
  });
  return [head, ...body].join("\n") + "\n";
}

// FRB の CP の XML（SDMX 風）。A2/P2 と AA の30日物（非金融）。n.a. の日を混ぜられる
function syntheticCpXml(from, to, { naDates = [] } = {}) {
  const obs = (fn) => {
    const out = [];
    let i = 0;
    for (let d = from; d <= to; d = addD(d, 1)) {
      if (!isWeekdayIso(d)) continue;
      const v = naDates.includes(d) ? "-9999" : fn(i).toFixed(2);
      out.push(`<frb:Obs OBS_STATUS="A" OBS_VALUE="${v}" TIME_PERIOD="${d}"/>`);
      i++;
    }
    return out.join("\n");
  };
  const ser = (name, fn) => `<kf:Series CURRENCY="NA" FREQ="9" SERIES_NAME="${name}" UNIT="Percent">\n<frb:Annotations/>\n${obs(fn)}\n</kf:Series>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<frb:DataSet id="CP">\n` +
    ser("RIFSPPNAAD30_N.B", (i) => 4.0 + 0.2 * Math.sin(i / 30)) + "\n" +
    ser("RIFSPPNA2P2D30_N.B", (i) => 4.0 + 0.2 * Math.sin(i / 30) + 0.15 + 0.1 * Math.abs(Math.sin(i / 7))) + "\n" +
    ser("RIFSPPFAAD30_N.B", () => 4.1) + "\n</frb:DataSet>\n";
}

// ZIP を作る（読み取り側は CRC を確かめないため、CRC は 0 のまま）
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data, store } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = store ? data : zlib.deflateRawSync(data);
    const method = store ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// シカゴ連銀 NFCI の CSV（金曜ごと）
function syntheticNfciCsv(from, to) {
  const out = ["Friday_of_Week,NFCI,Risk,Credit,Leverage,Nonfinancial Leverage"];
  let i = 0;
  for (let d = from; d <= to; d = addD(d, 1)) {
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 5) continue;
    const mdy = `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}/${d.slice(0, 4)}`;
    out.push(`${mdy},-0.5,-0.3,${(-0.4 + 0.3 * Math.sin(i / 5)).toFixed(4)},0.1,-0.2`);
    i++;
  }
  return out.join("\n") + "\n";
}

module.exports.syntheticYields = syntheticYields;
module.exports.toTreasuryCsv = toTreasuryCsv;
module.exports.syntheticCpXml = syntheticCpXml;
module.exports.makeZip = makeZip;
module.exports.syntheticNfciCsv = syntheticNfciCsv;
