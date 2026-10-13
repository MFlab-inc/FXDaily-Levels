"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
// intraday.js・daytrade.js の PAIRS（12銘柄）と同じ
const CODES = ["USDJPY", "EURUSD", "GBPUSD", "EURJPY", "AUDUSD", "EURGBP", "USDCAD", "USDCHF", "NZDUSD", "AUDNZD", "XAUUSD", "USOIL"];

const pad = (n) => String(n).padStart(2, "0");
// epoch(ms) → "YYYY-MM-DDTHH:MM:SS+09:00"（JST）
function jstIso(ms) {
  const d = new Date(ms + 9 * 3600000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+09:00`;
}

const pairsOf = (codes, v = {}) => Object.fromEntries(codes.map((c) => [c, { price: 1, ...v }]));

/**
 * data/ の模擬一式。各ファイルの as_of は『nowMs から何ミリ秒前か』で指定（ageMs）。
 * 既定: すべて 2分前に取得済み・健全、日次レベルは 3時間前。
 */
function dataFiles(nowMs, o = {}) {
  const at = (ageMs) => jstIso(nowMs - ageMs);
  const min = 60000;
  const files = {
    "daily-levels.json": { as_of: at(o.dailyAge ?? 180 * min), session_date: "2026-10-12", errors: [], pairs: pairsOf(CODES, { adr20: 1 }) },
    "intraday.json": { as_of: at(o.intradayAge ?? 2 * min), session_date: "2026-10-12", errors: o.intradayErrors ?? [], pairs: pairsOf((o.intradayCodes ?? CODES)) },
    "h1-bars.json": { as_of: at(o.h1Age ?? 2 * min), errors: o.h1Errors ?? [], consistency_check: { checked_against: null, results: {} }, pairs: pairsOf(o.h1Codes ?? [...CODES, "US500"], {}) },
    "daytrade-context.json": { as_of: at(o.ctxAge ?? 2 * min), errors: o.ctxErrors ?? [], pairs: pairsOf(o.ctxCodes ?? CODES) },
    "economic-calendar.json": { as_of: at(2 * min), date: "2026-10-13", events: [] },
  };
  for (const k of o.omit || []) delete files[k];
  return files;
}

function writeData(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), JSON.stringify(v, null, 2));
}

// intraday.js・daytrade.js を一時フォルダに複製して使う（__dirname の data/ を読むため。リポジトリの data/ には触れない）
function tmpRoot(nowMs, o) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recent-fetch-"));
  for (const f of ["intraday.js", "daytrade.js"]) fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  fs.mkdirSync(path.join(root, "lib"));
  fs.copyFileSync(path.join(ROOT, "lib", "recent-fetch.js"), path.join(root, "lib", "recent-fetch.js"));
  fs.mkdirSync(path.join(root, "config"));
  fs.copyFileSync(path.join(ROOT, "config", "daytrade-rules.json"), path.join(root, "config", "daytrade-rules.json"));
  writeData(path.join(root, "data"), dataFiles(nowMs, o));
  return { root, dataDir: path.join(root, "data"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));

module.exports = { ROOT, CODES, jstIso, dataFiles, writeData, tmpRoot, snapshot };
