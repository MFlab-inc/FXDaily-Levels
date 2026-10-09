"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const H = require("../h1history");
const { runBacktestModes, aggregate } = require("../backtest");
const { toCsv } = require("../report");
const { PAIRS } = require("../pairs");
const store = require("../../../mtf/lib/store");
const J = require("../jst");

/**
 * 結果の固定（ゴールデン）: コミット済みの H1 履歴（data/history）と日足（data/mtf）から、コミット済みのバックテスト結果の CSV を
 * 一字も違わず再現できること。バックテストの計算（設計・型B追加の出来事、到達・先着・損益、SL下限方式 (a)(b)、集計、入力の再構成）を
 * 少しでも変えると、ここで気づく。規則を意図して変えたときは、次のコマンドで結果を作り直して、差分を確かめてからコミットする:
 *   node scripts/daytrade-backtest.js --no-fetch --now=2026-10-09T00:30:00+09:00
 * （ボラ状態の閾値は risk-feed を取りに行く。取れなければ同じ数値の既定値 50／80／95 になり、CSV は変わらない）
 */
const DATA = path.join(__dirname, "..", "..", "..", "data");
const GOLDEN = path.join(DATA, "daytrade", "backtest-2026-10-09.csv");

test("バックテスト: コミット済みの履歴から、コミット済みの結果 CSV を再現できる", { skip: !fs.existsSync(GOLDEN) }, () => {
  const barsByCode = {}, rowsByCode = {};
  for (const p of PAIRS) {
    barsByCode[p.code] = H.readH1(DATA, p.code);
    const rows = store.readRows(DATA, p.code);
    if (rows && rows.length) rowsByCode[p.code] = rows;
  }
  const { records } = runBacktestModes({ barsByCode, rowsByCode, nowMs: J.parseIso("2026-10-09T00:30:00+09:00"), windowDays: 365 });
  assert.equal(toCsv(aggregate(records)), fs.readFileSync(GOLDEN, "utf8"));
});
