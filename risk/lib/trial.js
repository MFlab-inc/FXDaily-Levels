"use strict";

/**
 * 試し運転の指標（SPEC 10節。記事にはまだ使わない）。2026-11-02 ユーザー決定：
 *   ② MOVE の代わり … 米国債の金利の「実際の値動きの大きさ」（米財務省の金利表から自前で計算）
 *   ③ HY OAS の代わり … 2つを試算して比べてから決める
 *        - FRB の短期社債（CP）の金利差：A2/P2 格（格付けの低い側）− AA 格、どちらも非金融・30日物
 *        - シカゴ連銀の金融環境指数（NFCI）の信用の部分（週1回）。商用で使う前に許可の問い合わせが必要
 * ここにあるのはネットワークに接続しない純関数だけ（読み取り・計算）。取得は run-daily.js。
 */
const zlib = require("zlib");
const { parseMilli, splitCsvLine } = require("../../rates/lib/parse");
const { rankAt } = require("./calc");

class TrialError extends Error {}

const pad2 = (n) => String(n).padStart(2, "0");
function isRealDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// ---------- 米財務省 Daily Treasury Par Yield Curve Rates（CSV） ----------
// 返り値：古い順の [{ date, bp: { "2 Yr": 479, ... } }]。値は bp（0.01%＝1）の整数。空欄・N/A は null
function parseParYieldCsv(text, tenors, { allowEmpty = false } = {}) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) { if (allowEmpty) return []; throw new TrialError("財務省CSV: 中身が空です"); }
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const iDate = header.indexOf("Date");
  const idx = tenors.map((t) => header.indexOf(t));
  if (iDate < 0 || idx.some((i) => i < 0)) {
    throw new TrialError(`財務省CSV: 列名に Date・${tenors.join("・")} のどれかがありません（形式が変わった可能性）`);
  }
  const rows = new Map();
  lines.slice(1).forEach((line, k) => {
    const c = splitCsvLine(line);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((c[iDate] || "").trim());
    if (!m || !isRealDate(+m[3], +m[1], +m[2])) throw new TrialError(`財務省CSV: ${k + 2}行目の日付の形式が想定外です`);
    const bp = {};
    tenors.forEach((t, j) => {
      const raw = (c[idx[j]] || "").trim();
      if (raw === "" || raw === "N/A") { bp[t] = null; return; }
      const milli = parseMilli(raw);
      if (milli === null || milli % 10 !== 0) throw new TrialError(`財務省CSV: ${k + 2}行目の ${t} の値が読めません`);
      bp[t] = milli / 10;
    });
    rows.set(`${m[3]}-${m[1]}-${m[2]}`, bp);
  });
  if (!rows.size) { if (allowEmpty) return []; throw new TrialError("財務省CSV: データ行がありません"); }
  return [...rows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, bp]) => ({ date, bp }));
}

// 実際の値動きの大きさ（自前の定義）：
//   各年限の金利の1日の変化（bp）を、直近 lookback 日分ならべた二乗平均平方根（RMS）。それを年限で単純平均する。
//   4つの年限すべてに値がある日だけを使う（前の日も、4つすべてに値がある日を数える）。
// 返り値：古い順の [{ date, value }]（value は bp。丸めない）
function realizedVolSeries(rows, tenors, lookback) {
  const ok = rows.filter((r) => tenors.every((t) => Number.isInteger(r.bp[t])));
  const out = [];
  for (let i = lookback; i < ok.length; i++) {
    let sum = 0;
    for (const t of tenors) {
      let ss = 0;
      for (let j = i - lookback + 1; j <= i; j++) {
        const d = ok[j].bp[t] - ok[j - 1].bp[t];
        ss += d * d;
      }
      sum += Math.sqrt(ss / lookback);
    }
    out.push({ date: ok[i].date, value: sum / tenors.length });
  }
  return out;
}

// 系列（古い順の {date, value}）の最新の順位と、直近 historyN 個の日ごとの順位
function rankSnapshot(series, { window, thresholdPct, historyN, keepValue }) {
  const values = series.map((s) => s.value);
  const last = series.length - 1;
  if (last < 0) return { error: "値がありません" };
  const latest = rankAt(values, last, window);
  if (!latest) return { error: `値が${series.length}個しかなく、順位に必要な${window}個に足りません` };
  const history = [];
  for (let i = Math.max(window - 1, series.length - historyN); i <= last; i++) {
    const h = { date: series[i].date, rank_pct: rankAt(values, i, window).rank_pct };
    if (keepValue) h.value = round2(series[i].value);
    history.push(h);
  }
  const snap = {
    date: series[last].date,
    rank_pct: latest.rank_pct,
    count_le: latest.count_le,
    window,
    window_start: series[last - window + 1].date,
    threshold_pct: thresholdPct,
    over_threshold: latest.rank_pct >= thresholdPct,
    history,
  };
  if (keepValue) snap.value = round2(series[last].value);
  return snap;
}
const round2 = (x) => Math.round(x * 100) / 100;

// ---------- ZIP（FRB の XML は ZIP で配られる）。ZIP64・暗号化は扱わない ----------
function readZip(buf) {
  const EOCD = 0x06054b50;
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) { e = i; break; }
  }
  if (e < 0) throw new TrialError("ZIP: 終わりの目印が見つかりません（ZIPではない可能性）");
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const files = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new TrialError("ZIP: 目次の形式が想定外です");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    if (csize === 0xffffffff || local === 0xffffffff) throw new TrialError("ZIP: ZIP64 は扱えません");
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new TrialError(`ZIP: ${name} の見出しの形式が想定外です`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new TrialError(`ZIP: ${name} の圧縮方式 ${method} は扱えません`);
    files.push({ name, data });
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

// ---------- FRB の短期社債（CP）の金利（SDMX の XML） ----------
const normName = (s) => String(s).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const attr = (s, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(s); return m ? m[1] : null; };

// 指定した系列（名前の英数字だけで照合）の { date → ミリ% } を返す。値の無い日（数値でない）は入れない
function parseCpXml(xml, wanted) {
  const want = new Map(wanted.map((w) => [normName(w), w]));
  const found = new Map();
  const names = [];
  const re = /<([\w.-]+:)?Series\b([^>]*)>([\s\S]*?)<\/\1?Series>/g;
  let m;
  while ((m = re.exec(xml))) {
    const nm = attr(m[2], "SERIES_NAME");
    if (!nm) continue;
    names.push(nm);
    const key = want.get(normName(nm));
    if (!key) continue;
    const obs = new Map();
    const ro = /<(?:[\w.-]+:)?Obs\b([^>]*)\/?>/g;
    let o;
    while ((o = ro.exec(m[3]))) {
      const d = attr(o[1], "TIME_PERIOD"), v = attr(o[1], "OBS_VALUE");
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d) || v === null) continue;
      const milli = parseMilli(v);
      if (milli === null || milli < 0) continue; // n.a.（取引が少なく計算されない日）など
      obs.set(d, milli);
    }
    found.set(key, obs);
  }
  for (const w of wanted) {
    if (!found.has(w)) {
      throw new TrialError(`FRBのCPのXML: 系列 ${w} が見つかりません（見つかった系列の数 ${names.length}${names.length ? `、例 ${names.slice(0, 5).join("・")}` : ""}）`);
    }
  }
  return found;
}

// 金利差（bp）＝ 低い格付け − 高い格付け。両方に値がある日だけ
function cpSpreadSeries(found, low, high) {
  const a = found.get(low), b = found.get(high);
  const out = [];
  for (const [d, v] of a) if (b.has(d)) out.push({ date: d, value: (v - b.get(d)) / 10 });
  return out.sort((x, y) => (x.date < y.date ? -1 : 1));
}

// ---------- シカゴ連銀 NFCI（CSV）。日付の列と、信用の部分（Credit）の列を読む ----------
function parseNfciCsv(text, column) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new TrialError("NFCIのCSV: データ行がありません");
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const ic = header.findIndex((h) => h.toLowerCase() === column.toLowerCase());
  if (ic < 0) throw new TrialError(`NFCIのCSV: 列 ${column} がありません（列名：${header.slice(0, 8).join("・")}）`);
  const out = [];
  lines.slice(1).forEach((line, k) => {
    const c = splitCsvLine(line);
    const s = (c[0] || "").trim();
    let iso = null, m;
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)) && isRealDate(+m[3], +m[1], +m[2])) iso = `${m[3]}-${pad2(m[1])}-${pad2(m[2])}`;
    else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)) && isRealDate(+m[1], +m[2], +m[3])) iso = s;
    if (!iso) throw new TrialError(`NFCIのCSV: ${k + 2}行目の日付の形式が想定外です`);
    const v = Number((c[ic] || "").trim());
    if ((c[ic] || "").trim() === "" || !Number.isFinite(v)) return; // 値の無い週は飛ばす
    out.push({ date: iso, value: v });
  });
  if (!out.length) throw new TrialError(`NFCIのCSV: 列 ${column} に値がありません`);
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

module.exports = {
  TrialError, parseParYieldCsv, realizedVolSeries, rankSnapshot, readZip, parseCpXml, cpSpreadSeries, parseNfciCsv,
};
