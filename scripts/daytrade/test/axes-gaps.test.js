"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate } = require("../evaluate");
const { runBacktestModes, aggregate, floorBreakdown, obstacleBreakdown, BACKTEST_MODES, BASE_MODE } = require("../backtest");
const { toMarkdown } = require("../report");
const { evalCtx, DAILY } = require("./helpers");
const { allSynth } = require("./bt-data");
const J = require("../jst");

/**
 * 変異試験で見つかった穴を塞ぐ試験。
 *  - obstacle_changed は『TP1』で比べる（ラベルが違うだけで価格が同じなら TP1 は変わらないので false）。比べる障害は基準水準（Entry）から見たもの
 *  - runBacktestModes の stats は先頭の方式（ライブと同じ SL下限 (a)×障害 (a)）のもの
 *  - md の比較表・方式別の詳細・2つの内訳表・条件の行は、その方式の行・件数から出る（方式の取り違えを見つける）
 */

test("障害の定義 forward: 選ばれた障害のラベルだけが違い価格が同じなら『変わっていない』（obstacle_changed=false、TP1 も同じ）", () => {
  // 売り・Entry 1.1040。逆側の高値群と進行方向側の安値群が同じ価格（近い端 1.097）。'both' は先に並ぶ高値群、'forward' は安値群を選ぶ
  const groups = { highs: [{ min: 1.0960, max: 1.0970, count: 2 }], lows: [{ min: 1.0950, max: 1.0970, count: 2 }], window: 24 };
  const b = evaluate(evalCtx({ groups }), "A");
  const f = evaluate(evalCtx({ groups }), "A", { obstacle: "forward" });
  assert.deepEqual(b.obstacle, { label: "H1高値群", price: 1.097 });
  assert.deepEqual(f.obstacle, { label: "H1安値群", price: 1.097 });
  assert.equal(f.obstacle_changed, false);
  assert.equal(f.schemes.A.tp, b.schemes.A.tp);
});

test("障害の定義 forward: obstacle_changed は基準水準（Entry）から見た障害どうしで比べる。現在値と基準水準のあいだの水準も数える", () => {
  // 売り・現在値 1.0990、基準水準 Pivot 1.1040。S1 1.1000 は現在値と基準水準のあいだ。'both' も 'forward' も最初の障害は S1（変わらない）
  const ctx = evalCtx({ price: 1.0990, daily: { ...DAILY, s1: 1.1000 } });
  const b = evaluate(ctx, "A");
  const f = evaluate(ctx, "A", { obstacle: "forward" });
  assert.deepEqual(b.ref, { label: "Pivot", price: 1.104 });
  assert.deepEqual(b.obstacle, { label: "S1", price: 1.1 });
  assert.deepEqual(f.obstacle, b.obstacle);
  assert.equal(f.obstacle_changed, false);
  assert.equal(f.schemes.A.tp, b.schemes.A.tp);
});

// ---- 方式の取り違えを見つける: md の数字と印 ----
const MODE_N = { "reject|both": 3, "widen|both": 5, "reject|forward": 7, "widen|forward": 11 }; // 方式ごとに違う件数（型A×A案）
function fakeRecords() {
  const out = [];
  for (const m of BACKTEST_MODES) {
    const n = MODE_N[m.key];
    for (let i = 0; i < n; i++) {
      out.push({
        sl_floor: m.slFloor, obstacle: m.obstacle, obstacle_changed: m.obstacle === "forward" && i % 2 === 0, sl_floored: m.slFloor === "widen" && i % 3 === 0,
        plan_date: "2026-10-06", slot: 1, weekday: 2, setup: "A", scheme: "A", k: 0.5, symbol: "EURUSD", side: "sell", ref: 1.104, vol: "平常",
        plan_rr: 2, sl_pips: 10, profit_pips: 20, reached: "未到達", cancelled_unreached: false,
      });
    }
  }
  return out;
}
const sec = (md, head) => md.split(head)[1].split(/\n## |\n### /)[0];
const rowsOf = (text) => text.split("\n").filter((l) => l.startsWith("|")).slice(2).map((l) => l.slice(2, -2).split(" | "));
const NOW = J.parseIso("2026-10-08T12:00:00+09:00");

function buildMd(extra = {}) {
  const records = fakeRecords();
  const rows = aggregate(records);
  const statsByMode = Object.fromEntries(BACKTEST_MODES.map((m, i) => [m.key, { designs: 9, adds: 9, evaluations: 9, incomplete: 10 + i, suppressed: 20 + i, bAdded: 30 + i, bAddDup: 40 + i }]));
  const md = toMarkdown(rows, {
    nowMs: NOW, window: { first: "2026-10-05", last: "2026-10-07" }, stats: statsByMode[BASE_MODE], statsByMode, floorRows: floorBreakdown(records), obstacleRows: obstacleBreakdown(records),
    history: [], regimeSource: "試験", noMtf: [], ...extra,
  });
  return { md, records, rows, statsByMode };
}

test("report: 比較表の n と方式の印、方式別の詳細の n は、その方式（SL下限 × 障害）の行から出る", () => {
  const { md } = buildMd();
  const cmp = rowsOf(sec(md, "## 方式の比較（全体）: SL下限方式 × 障害の定義"));
  const mine = cmp.filter((c) => c[0] === "型A × A案（ATR係数 0.5）");
  assert.deepEqual(mine.map((c) => `${c[1]}${c[2]}:${c[3]}`), [`(a)(a):3`, `(b)(a):5`, `(a)(b):7`, `(b)(b):11`]);
  // 型A×B案は件数ゼロの方式なので『—』
  assert.ok(cmp.filter((c) => c[0] === "型A × B案（ATR係数 1.0）").every((c) => c[3] === "—"));
  for (const m of BACKTEST_MODES) {
    const tag = `SL下限(${m.slFloor === "reject" ? "a" : "b"})×障害(${m.obstacle === "both" ? "a" : "b"})`;
    const total = rowsOf(md.split(`### ${tag} 型A × A案（ATR係数 0.5）`)[1].split("#### 軸: 全体")[1].split(/\n#### |\n### |\n## /)[0])[0];
    assert.equal(total[0], "全体");
    assert.equal(total[1], String(MODE_N[m.key]), `${tag} の詳細の n`);
    // 詳細の見出しの説明（label）も同じ方式のもの
    assert.ok(md.includes(`## ${tag}（詳細）: ${m.slFloor === "reject" ? "(a) 現行：丸め後のSL幅" : "(b) SL=max"}`), tag);
    assert.ok(md.split(`## ${tag}（詳細）: `)[1].split("\n")[0].endsWith(m.obstacle === "both" ? "(a) 現行：日次レベル7本＋H1高値群・安値群の両方" : "(b) 日次レベル7本＋進行方向側の群だけ（売りは安値群、買いは高値群）"), `${tag} の障害の説明`);
  }
});

test("floorBreakdown／obstacleBreakdown: 行の障害・SL下限の値と件数は、その方式の記録から数える", () => {
  const records = fakeRecords();
  const fb = floorBreakdown(records).map((r) => [r.obstacle, r.value.startsWith("10pips下限で広げた案") ? "floored" : "same", r.n]);
  assert.deepEqual(fb, [["both", "same", 3], ["both", "floored", 2], ["forward", "same", 7], ["forward", "floored", 4]]);
  const ob = obstacleBreakdown(records).map((r) => [r.sl_floor, r.value.startsWith("TP1 が変わった案") ? "changed" : "same", r.n]);
  assert.deepEqual(ob, [["reject", "same", 3], ["reject", "changed", 4], ["widen", "same", 5], ["widen", "changed", 6]]);
});

test("report: 内訳表（SL下限 (b)／障害 (b)／型B）の方式の印は、その行の方式を表す", () => {
  const { md, records } = buildMd();
  const fl = rowsOf(sec(md, "### SL下限方式 (b) の内訳"));
  const fb = floorBreakdown(records);
  assert.equal(fl.length, fb.length);
  fb.forEach((r, i) => {
    assert.equal(fl[i][0], r.obstacle === "both" ? "(a)" : "(b)", `SL下限 (b) の内訳 ${i} の障害の印`);
    assert.equal(fl[i][3], String(r.n), `SL下限 (b) の内訳 ${i} の n`);
  });
  assert.deepEqual([...new Set(fl.map((c) => c[0]))], ["(a)", "(b)"]);
  const ob = rowsOf(sec(md, "### 障害の定義 (b) の内訳"));
  const obs = obstacleBreakdown(records);
  assert.equal(ob.length, obs.length);
  obs.forEach((r, i) => {
    assert.equal(ob[i][0], r.sl_floor === "reject" ? "(a)" : "(b)", `障害 (b) の内訳 ${i} の SL下限の印`);
    assert.equal(ob[i][3], String(r.n), `障害 (b) の内訳 ${i} の n`);
  });
  assert.deepEqual([...new Set(ob.map((c) => c[0]))], ["(a)", "(b)"]);
});

test("report: 型B の内訳表は『SL下限方式』『障害の定義』の順に印を出す。条件の行は方式ごとの件数を方式の順に並べる", () => {
  const records = fakeRecords().map((r) => ({ ...r, setup: "B", slot: 4 }));
  const rows = aggregate(records);
  const statsByMode = Object.fromEntries(BACKTEST_MODES.map((m, i) => [m.key, { designs: 9, adds: 9, evaluations: 9, incomplete: 10 + i, suppressed: 20 + i, bAdded: 30 + i, bAddDup: 40 + i }]));
  const md = toMarkdown(rows, { nowMs: NOW, window: { first: "a", last: "b" }, stats: statsByMode[BASE_MODE], statsByMode, history: [], regimeSource: "試験", noMtf: [] });
  const b = rowsOf(sec(md, "### 型B の内訳："));
  assert.deepEqual(b.map((c) => `${c[0]}${c[1]}:${c[4]}`), BACKTEST_MODES.map((m) => `${m.slFloor === "reject" ? "(a)" : "(b)"}${m.obstacle === "both" ? "(a)" : "(b)"}:${MODE_N[m.key]}`));
  const seq = (base) => BACKTEST_MODES.map((m, i) => `SL下限(${m.slFloor === "reject" ? "a" : "b"})×障害(${m.obstacle === "both" ? "a" : "b"}) ${base + i}`).join("／");
  assert.ok(md.includes(`有効期限まで足がそろわず除いた版 ${seq(10)}、先の版が約定済みで数えなかった版 ${seq(20)}`), "条件の行（版の件数）");
  assert.ok(md.includes(`追加した版 ${seq(30)}、同じ銘柄・向きが既にあり追加しなかった ${seq(40)}`), "型B追加の件数");
});

test("runBacktestModes: stats は先頭の方式（ライブと同じ SL下限 (a)×障害 (a)）の件数。方式ごとの件数は statsByMode に別々に残る", () => {
  const { stats, statsByMode } = runBacktestModes({ ...allSynth(), nowMs: NOW, windowDays: 3 });
  assert.equal(stats, statsByMode[BASE_MODE]);
  assert.deepEqual(Object.keys(statsByMode), BACKTEST_MODES.map((m) => m.key));
  assert.equal(new Set(BACKTEST_MODES.map((m) => statsByMode[m.key])).size, 4); // 方式ごとに別のオブジェクト
});
