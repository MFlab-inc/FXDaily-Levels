"use strict";
const fs = require("fs");
const path = require("path");

/**
 * 日足の保存（data/mtf/ny-daily-<銘柄>.csv）。
 * 列: date_ny,open,high,low,close,bars,last_bar_ny
 *   仕様の列（date_ny〜bars）に、金曜の最終足の開始時刻（NY現地 HH:MM）を足している。
 *   3-7「金曜の最後の1時間足が16時台より前」を後から判定するために必要（本数だけでは分からない）。
 */
const HEADER = "date_ny,open,high,low,close,bars,last_bar_ny";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const csvPath = (dataDir, code) => path.join(dataDir, "mtf", `ny-daily-${code}.csv`);

function parseCsv(text, label = "csv") {
  const lines = String(text).split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length || lines[0] !== HEADER) throw new Error(`${label}: 見出し行が想定と違います（期待: ${HEADER}）`);
  const rows = [];
  lines.slice(1).forEach((line, i) => {
    const f = line.split(",");
    const at = `${label}:${i + 2}行目`;
    if (f.length !== 7) throw new Error(`${at}: 列数が7ではありません`);
    const [date, o, h, l, c, bars, lastBar] = f;
    if (!DATE_RE.test(date)) throw new Error(`${at}: 日付の形式が不正です（${date}）`);
    const nums = [o, h, l, c].map(Number);
    if (nums.some((x) => !Number.isFinite(x)) || [o, h, l, c].some((x) => x === "")) throw new Error(`${at}: 価格が数値ではありません`);
    const nb = Number(bars);
    if (!Number.isInteger(nb) || nb < 1) throw new Error(`${at}: bars が正の整数ではありません`);
    if (lastBar !== "" && !/^\d{2}:\d{2}$/.test(lastBar)) throw new Error(`${at}: last_bar_ny の形式が不正です`);
    const prev = rows[rows.length - 1];
    if (prev && prev.date >= date) throw new Error(`${at}: 日付が昇順・重複なしになっていません（${prev.date} → ${date}）`);
    rows.push({ date, open: nums[0], high: nums[1], low: nums[2], close: nums[3], bars: nb, last_bar_ny: lastBar });
  });
  return rows;
}

function toCsv(rows) {
  const body = rows.map((r) => [r.date, r.open, r.high, r.low, r.close, r.bars, r.last_bar_ny || ""].join(","));
  return [HEADER, ...body].join("\n") + "\n";
}

// 無ければ null。壊れていれば例外（黙って空扱いにしない）
function readRows(dataDir, code) {
  const p = csvPath(dataDir, code);
  if (!fs.existsSync(p)) return null;
  return parseCsv(fs.readFileSync(p, "utf8"), path.relative(dataDir, p));
}

/**
 * 既存の履歴に、取り直した日足をつなぐ。
 *   ・既存に無い日は追加する（最新日の追記、取りこぼした日の穴埋め）。ただし履歴の先頭より古い日は足さない
 *   ・既存にある日は、既存の直近 overwriteLast 日分だけ取り直した値で上書きする（最後の足が遅れて入る場合への備え）
 *   ・それより古い日は触らない
 */
function mergeRows(existing, fetched, { overwriteLast = 3 } = {}) {
  const byDate = new Map(existing.map((r) => [r.date, r]));
  const first = existing.length ? existing[0].date : "";
  const overwriteFrom = existing.length ? existing[Math.max(0, existing.length - overwriteLast)].date : "";
  let added = 0, updated = 0;
  for (const r of fetched) {
    if (r.date < first) continue;
    const cur = byDate.get(r.date);
    if (!cur) { byDate.set(r.date, r); added += 1; continue; }
    if (r.date >= overwriteFrom && !sameRow(cur, r)) { byDate.set(r.date, r); updated += 1; }
  }
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { rows, added, updated };
}
const sameRow = (a, b) =>
  a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.bars === b.bars && (a.last_bar_ny || "") === (b.last_bar_ny || "");

/**
 * 複数ファイルをまとめて書く。いったん dataDir の外（同じ階層の一時フォルダ）に全部書き、
 * 全部書けてから所定の場所へ rename する。途中で止まっても、data/ には中途半端なファイルが残らない
 * （同じジョブの後続手順が `git add data/` で保存してしまうため）。
 * entries: [{ file: <dataDir からの相対パス>, content }]
 */
function writeAll(dataDir, entries) {
  if (!entries.length) return [];
  const base = path.dirname(path.resolve(dataDir));
  const tmp = fs.mkdtempSync(path.join(base, ".mtf-tmp-"));
  try {
    const staged = entries.map((e, i) => {
      const t = path.join(tmp, `${i}.tmp`);
      fs.writeFileSync(t, e.content, "utf8");
      return { tmp: t, dest: path.join(dataDir, e.file) };
    });
    for (const s of staged) fs.mkdirSync(path.dirname(s.dest), { recursive: true });
    for (const s of staged) fs.renameSync(s.tmp, s.dest);
    return staged.map((s) => s.dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function existingCsvFiles(dataDir) {
  const dir = path.join(dataDir, "mtf");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^ny-daily-.*\.csv$/.test(f)).sort();
}

module.exports = { HEADER, csvPath, parseCsv, toCsv, readRows, mergeRows, writeAll, existingCsvFiles };
