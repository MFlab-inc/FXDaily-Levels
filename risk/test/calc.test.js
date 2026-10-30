"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { rankAt, vixSnapshot } = require("../lib/calc");
const H = require("./helpers");

test("順位＝当日を含む直近252個のうち、当日以下の個数÷252×100（小数第1位）", () => {
  const asc = Array.from({ length: 252 }, (_, i) => i + 1);
  assert.deepEqual(rankAt(asc, 251, 252), { count_le: 252, rank_pct: 100 });           // 最高
  const desc = [...asc].reverse();
  assert.deepEqual(rankAt(desc, 251, 252), { count_le: 1, rank_pct: 0.4 });           // 最低（自分だけ）
  // 当日以下が6個 → 2.4（GPT の値 2.4 と同じ丸め）、17個 → 6.7、129個 → 51.2
  for (const [c, pct] of [[6, 2.4], [17, 6.7], [48, 19.0], [129, 51.2], [206, 81.7], [190, 75.4]]) {
    const v = Array.from({ length: 251 }, (_, i) => (i < c - 1 ? 1 : 100));
    v.push(50);
    assert.equal(rankAt(v, 251, 252).rank_pct, pct, `count=${c}`);
  }
});

test("同じ値（同順位）は「以下」に数える", () => {
  const v = Array(252).fill(20);
  assert.equal(rankAt(v, 251, 252).rank_pct, 100);
});

test("過去分が252個に足りなければ null", () => {
  assert.equal(rankAt(Array(251).fill(1), 250, 252), null);
});

test("0〜252個の全ての個数で、四捨五入の端数がちょうど0.5にならない（丸め方式による差が出ない）", () => {
  for (let c = 0; c <= 252; c++) {
    const x = (c * 1000) / 252;
    assert.notEqual(Math.abs(x - Math.floor(x) - 0.5) < 1e-9, true, `count=${c}`);
  }
});

test("vixSnapshot：最新日の順位と直近60日の履歴を、別に書いた素朴な計算と全日で一致させる", () => {
  const rows = H.syntheticRows("2024-06-03", "2026-10-29");
  const s = vixSnapshot(rows, { window: 252, thresholdPct: 70, historyDays: 60 });
  const closes = rows.map((r) => r.close);
  assert.equal(s.date, "2026-10-29");
  assert.equal(s.rank_pct, H.naiveRank(closes, closes.length - 1, 252));
  assert.equal(s.window, 252);
  assert.equal(s.window_start, rows[rows.length - 252].date);
  assert.equal(s.over_threshold, s.rank_pct >= 70);
  assert.equal(s.history.length, 60);
  assert.equal(s.history[59].date, "2026-10-29");
  s.history.forEach((h, k) => {
    const i = rows.length - 60 + k;
    assert.equal(h.date, rows[i].date);
    assert.equal(h.rank_pct, H.naiveRank(closes, i, 252));
  });
});

test("vixSnapshot：基準ちょうどは基準超え（SPEC 3-6「70%以上」）", () => {
  const rows = H.syntheticRows("2024-06-03", "2026-10-29");
  const r = vixSnapshot(rows, { window: 252, thresholdPct: 70, historyDays: 1 }).rank_pct;
  assert.equal(vixSnapshot(rows, { window: 252, thresholdPct: r, historyDays: 1 }).over_threshold, true);
  assert.equal(vixSnapshot(rows, { window: 252, thresholdPct: r + 0.1, historyDays: 1 }).over_threshold, false);
});

test("vixSnapshot：252日分に足りなければ error", () => {
  const rows = H.syntheticRows("2026-01-02", "2026-10-29");
  assert.match(vixSnapshot(rows, { window: 252, thresholdPct: 70, historyDays: 60 }).error, /足りません/);
});
