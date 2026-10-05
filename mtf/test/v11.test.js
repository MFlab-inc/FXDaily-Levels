"use strict";
// 仕様 v1.1 の 3-7・第4節の変更部分の境界:
//   ・最後の1時間足が NY 16時台でない日の印は、曜日を問わず付ける
//   ・テキストの SHORT_BAR_DAYS は、直近200営業日のうち「最後の1時間足が16時台でない日」だけを日付つき、それ以外は件数だけ（JSON は全期間）
//   ・XAUUSD の標準本数は23本のまま（下限）
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../lib/calc");
const { buildFeed } = require("../lib/feed");
const { SYMBOLS } = require("../config");
const { mkRows, weekdaysFrom, scenarioRows } = require("./helpers");

const NOW = Date.UTC(2026, 9, 6, 21, 25, 0);
const dateAt = (rows, i) => rows[i].date;

// 250営業日の履歴（最後の日 = ASOF）を作り、指定した行番号の日に本数・最終足を設定する
function history(code, { patch = {}, n = 250 } = {}) {
  const dates = weekdaysFrom("2025-09-01", n);
  const rows = mkRows(dates, (i) => 100 + i * 0.01).map((r, i) => ({ ...r, ...(patch[i] || {}) }));
  return { rows, asOf: rows[rows.length - 1].date, code };
}
const run = (h) => buildFeed({ asOf: h.asOf, nowMs: NOW, items: [{ code: h.code, rows: h.rows, updatedAt: "x" }] });
const line = (text, code) => {
  const block = text.split(/\n(?=## )/).find((b) => b.startsWith(`## ${code}`));
  return block.split("\n").find((l) => l.startsWith("SHORT_BAR_DAYS"));
};

test("3-7(v1.1): 月曜の22本は『本数が少ないだけ』（最後の足は16時台）。火曜の最終足が15時台は『16時台でない日』。両方あれば両方", () => {
  const h = history("USDJPY", { patch: { 249: { bars: 22 }, 248: { last_bar_ny: "15:00" }, 247: { bars: 20, last_bar_ny: "13:00" } } });
  const days = C.shortBarDays(h.rows, 24);
  assert.deepEqual(days.map((x) => [x.date, x.reasons]), [
    [dateAt(h.rows, 247), ["bars", "last_bar_not_16"]],
    [dateAt(h.rows, 248), ["last_bar_not_16"]],
    [dateAt(h.rows, 249), ["bars"]],
  ]);
  // 曜日: 247〜249 は連続する3営業日（曜日は混在）。月曜・火曜を含む構成も確かめる
  const dows = [247, 248, 249].map((i) => new Date(`${dateAt(h.rows, i)}T00:00:00Z`).getUTCDay());
  assert.equal(new Set(dows).size, 3);
});

test("4(v1.1): テキストは『最後の1時間足が16時台でない日』だけ日付つき、それ以外は件数だけ。月曜の22本の日付はテキストに出ない。JSONは全期間", () => {
  // 月曜(i=%5==0 の日)を 22本にする
  const patch = {};
  for (let i = 0; i < 250; i++) if (i % 5 === 0) patch[i] = { bars: 22 };
  patch[248] = { last_bar_ny: "15:00" }; // 火〜金のどれか。最後の足が15時台
  const h = history("USDJPY", { patch });
  const { json, text } = run(h);
  const s = json.symbols.find((x) => x.symbol === "USDJPY");
  // JSON は全期間（月曜の22本 50日 + 15時台の1日）
  assert.equal(s.short_bar_days.length, 51);
  assert.ok(s.short_bar_days.some((x) => x.date === dateAt(h.rows, 0)));
  // テキスト
  const l = line(text, "USDJPY");
  assert.ok(l.includes(`${dateAt(h.rows, 248)}(最終足15:00,24本)`), l);
  assert.match(l, /最後の1時間足がNY16時台でない日=2026-\d\d-\d\d\(最終足15:00,24本\) \//);
  // 直近200営業日(i=50..249)の月曜(i%5==0: 50,55,...,245 = 40日)が件数だけ
  assert.match(l, /それ以外の本数の少ない日=40日（件数のみ。終値には影響しない）/);
  // 範囲より前(i=0..49)の月曜 10日は『直近200営業日より前』の件数
  assert.match(l, /直近200営業日より前: 最後の足が16時台でない日0日・それ以外10日/);
  // 月曜の日付はテキストに出さない
  for (const i of [0, 5, 55, 100, 245]) assert.ok(!l.includes(dateAt(h.rows, i)), `月曜 ${dateAt(h.rows, i)} がテキストに出ている`);
  assert.match(l, /足の本数の下限は24本/);
  assert.match(l, /日付の全期間の一覧は JSON/);
});

test("4(v1.1): 200営業日の境目 — 範囲の最古の日(200番目)は日付つきで出し、その1つ前(201番目)は件数だけ", () => {
  const n = 250;
  // 直近200営業日 = 行 50..249。50 = 範囲の最古、49 = 範囲の1つ前
  const h = history("EURUSD", { n, patch: { 50: { last_bar_ny: "15:00" }, 49: { last_bar_ny: "15:00" }, 249: { last_bar_ny: "14:00" } } });
  const { json, text } = run(h);
  const s = json.symbols.find((x) => x.symbol === "EURUSD");
  assert.equal(s.short_bar_window.from, dateAt(h.rows, 50));
  assert.equal(s.short_bar_window.to, dateAt(h.rows, 249));
  assert.equal(s.short_bar_window.rows, 200);
  assert.equal(s.short_bar_days.length, 3); // JSON は全期間
  const l = line(text, "EURUSD");
  assert.ok(l.includes(`${dateAt(h.rows, 50)}(最終足15:00`), "範囲の最古の日は日付つき");
  assert.ok(l.includes(`${dateAt(h.rows, 249)}(最終足14:00`));
  assert.ok(!l.includes(dateAt(h.rows, 49)), "範囲の1つ前の日は日付を出さない");
  assert.match(l, /直近200営業日より前: 最後の足が16時台でない日1日・それ以外0日/);
  // 履歴が200日に満たなければ、全期間が範囲
  const short = history("EURUSD", { n: 120, patch: { 0: { last_bar_ny: "15:00" } } });
  const j2 = run(short).json.symbols.find((x) => x.symbol === "EURUSD");
  assert.deepEqual([j2.short_bar_window.from, j2.short_bar_window.rows], [dateAt(short.rows, 0), 120]);
});

test("4(v1.1): 該当が無ければ『なし』・件数0日。直近200営業日より前の記述は、前の分が無いときは出さない", () => {
  const h = history("GBPUSD", { n: 210 });
  const l = line(run(h).text, "GBPUSD");
  assert.match(l, /最後の1時間足がNY16時台でない日=なし \/ それ以外の本数の少ない日=0日（件数のみ。終値には影響しない）（日付の全期間の一覧は JSON）/);
  assert.ok(!l.includes("直近200営業日より前"));
});

test("3-7(v1.1): XAUUSD の標準本数は23本のまま（下限）— 24本の日は印なし、23本は印なし、22本は印あり。FXの23本は印あり", () => {
  const xau = SYMBOLS.find((s) => s.code === "XAUUSD");
  assert.equal(xau.standardBars, 23);
  assert.ok(SYMBOLS.filter((s) => s.code !== "XAUUSD").every((s) => s.standardBars === 24));
  const h = history("XAUUSD", { patch: { 244: { bars: 24 }, 245: { bars: 23 }, 246: { bars: 22 }, 247: { bars: 24 }, 248: { bars: 23 } } });
  assert.deepEqual(C.shortBarDays(h.rows, 23).map((x) => [x.date, x.bars]), [[dateAt(h.rows, 246), 22]]);
  // 同じ履歴を FX（標準24本）として見れば、24本以外（23・22・23本）が印あり
  assert.deepEqual(C.shortBarDays(h.rows, 24).map((x) => x.bars), [23, 22, 23]);
  const { json, text } = run(h);
  const s = json.symbols.find((x) => x.symbol === "XAUUSD");
  assert.deepEqual(s.short_bar_days.map((x) => [x.date, x.bars, x.standard]), [[dateAt(h.rows, 246), 22, 23]]);
  assert.match(line(text, "XAUUSD"), /足の本数の下限は23本/);
});

test("3-7(v1.1): 火曜の最終足が15時台の日が、基準日の日足そのものなら status=stale（最後の足の未着の可能性）。曜日を問わない", () => {
  for (const idx of [0, 1, 2, 3, 4]) {
    const dates = weekdaysFrom("2025-09-01", 230);
    // 基準日(最後の行)が月〜金のどれになるように開始位置を動かす
    const cut = dates.length - idx;
    const rows = mkRows(dates.slice(0, cut), (i) => 100 + i * 0.01).map((r, i, a) => (i === a.length - 1 ? { ...r, last_bar_ny: "15:00" } : r));
    const asOf = rows[rows.length - 1].date;
    const s = buildFeed({ asOf, nowMs: NOW, items: [{ code: "USDJPY", rows, updatedAt: "x" }] }).json.symbols.find((x) => x.symbol === "USDJPY");
    assert.equal(s.status, "stale", `${asOf}(曜日${new Date(`${asOf}T00:00:00Z`).getUTCDay()})`);
    assert.match(s.status_note, /最終の1時間足が 15:00/);
  }
});
