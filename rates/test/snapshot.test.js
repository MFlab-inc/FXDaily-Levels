"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSnapshot } = require("../lib/snapshot");
const C = require("../lib/calc");
const H = require("./helpers");

const holidays = H.holidays();
const NOW = H.jst("2026-10-07 10:00"); // 水曜の朝。米2年・日2年とも 10/6 分が最新のはず
const us = H.usRows(), usXml = H.usXmlRows(), jp = H.jpRows();
const input = (over = {}) => ({
  nowMs: NOW, holidays, prev: null,
  us: { rows: us, xml: { rows: usXml }, fetchedAt: "t" },
  jp: { rows: jp, lastModified: "Tue, 06 Oct 2026 23:30:14 GMT", fetchedAt: "t" },
  ...over,
});

test("平常：米・日とも 10/6 まで揃い、判定できる（10/6 は金利差の5営業日差 −5.4bp → はっきりしない）", () => {
  const s = buildSnapshot(input());
  assert.deepEqual(s.errors, []);
  assert.equal(s.us2y.date, "2026-10-06"); assert.equal(s.us2y.value, 4.79);
  assert.equal(s.jp2y.date, "2026-10-06"); assert.equal(s.jp2y.value, 1.93);
  assert.equal(s.us2y.fresh, true); assert.equal(s.jp2y.fresh, true);
  assert.equal(s.us2y.xml_check.status, "match");
  assert.deepEqual(s.spread, { date: "2026-10-06", value: 2.86, unit: "%pt", definition: "米2年 − 日2年（両方に値がある日だけ）" });
  assert.equal(s.change_5d.us.value_bp, -10); assert.equal(s.change_5d.jp.value_bp, -4.6); assert.equal(s.change_5d.spread.value_bp, -5.4);
  assert.equal(s.change_5d.spread.base_date, "2026-09-29");
  assert.deepEqual(
    { available: s.judgment.available, label: s.judgment.label, threshold_bp: s.judgment.threshold_bp },
    { available: true, label: "はっきりしない", threshold_bp: 10 },
  );
});

// 判定の境界：金利差の5営業日差を、最新日の米2年を動かして −10.0 / −9.9 / +10.0 / +9.9bp にする
test("境界（±10bp、境界を含む）：−10.0bp は円高方向、−9.9bp ははっきりしない、+10.0bp は円安方向、+9.9bp ははっきりしない", () => {
  const base = buildSnapshot(input()).change_5d.spread; // −5.4bp（−54ミリ%）
  assert.equal(base.value_bp, -5.4);
  const label = (shiftMilli) => {
    const rows = us.map((r) => (r.date === "2026-10-06" ? { ...r, milli: r.milli + shiftMilli } : r));
    const s = buildSnapshot(input({ us: { rows, xml: { rows: usXml.map((r) => (r.date === "2026-10-06" ? { ...r, milli: r.milli + shiftMilli } : r)) }, fetchedAt: "t" } }));
    return [s.change_5d.spread.value_bp, s.judgment.label];
  };
  assert.deepEqual(label(-46), [-10, "円高方向"]);        // −54 −46 = −100ミリ% = −10.0bp
  assert.deepEqual(label(-45), [-9.9, "はっきりしない"]);
  assert.deepEqual(label(154), [10, "円安方向"]);         // −54 +154 = +100ミリ% = +10.0bp
  assert.deepEqual(label(153), [9.9, "はっきりしない"]);
  assert.equal(C.classify(-100, 10), "円高方向"); assert.equal(C.classify(100, 10), "円安方向");
  assert.equal(C.classify(-99, 10), "はっきりしない"); assert.equal(C.classify(99, 10), "はっきりしない");
});

test("日2年が古い（10/5まで）：判定は「判定できません」。値と日付は出し、理由に期待する日付を書く", () => {
  const s = buildSnapshot(input({ jp: { rows: jp.filter((r) => r.date <= "2026-10-05"), lastModified: null, fetchedAt: "t" } }));
  assert.equal(s.judgment.available, false);
  assert.equal(s.judgment.label, "判定できません");
  assert.match(s.judgment.reason, /日2年が最新の営業日（期待 2026-10-06）まで更新されていません（最新 2026-10-05）/);
  assert.equal(s.jp2y.fresh, false); assert.equal(s.us2y.fresh, true);
  assert.equal(s.jp2y.date, "2026-10-05");
  assert.deepEqual(s.errors, []); // 取得の失敗ではない（公表待ちの候補）
  assert.equal(s.notFresh, true);
});

test("米2年が古い（10/5まで）：判定は「判定できません」", () => {
  const s = buildSnapshot(input({ us: { rows: us.filter((r) => r.date <= "2026-10-05"), xml: { rows: usXml }, fetchedAt: "t" } }));
  assert.equal(s.judgment.label, "判定できません");
  assert.match(s.judgment.reason, /米2年が最新の営業日（期待 2026-10-06）まで更新されていません（最新 2026-10-05）/);
});

test("片方の取得に失敗：前回の値を stale として残し、判定は「判定できません」。成功した側は更新する", () => {
  const prev = buildSnapshot(input({ nowMs: H.jst("2026-10-06 10:00"), us: { rows: us.filter((r) => r.date <= "2026-10-05"), xml: { rows: usXml }, fetchedAt: "prev" }, jp: { rows: jp.filter((r) => r.date <= "2026-10-05"), lastModified: null, fetchedAt: "prev" } }));
  assert.equal(prev.judgment.available, true); // 前日の朝は健全だった
  const s = buildSnapshot(input({ prev, us: { error: "米財務省CSVの取得・解析に失敗: HTTP 503" } }));
  assert.equal(s.us2y.stale, true);
  assert.equal(s.us2y.date, "2026-10-05");           // 前回の値のまま
  assert.equal(s.us2y.fetched_at, "prev");
  assert.equal(s.jp2y.date, "2026-10-06");            // 日は更新された
  assert.equal(s.jp2y.stale, false);
  assert.equal(s.judgment.available, false);
  assert.match(s.judgment.reason, /米2年は取得に失敗したため前回の値のまま/);
  assert.match(s.errors.join("\n"), /us2y: 米財務省CSVの取得・解析に失敗/);
  assert.equal(s.spread, null); assert.equal(s.change_5d, null);
});

test("失敗した側に前回の値が無ければ、値なし（null）で判定できません", () => {
  const s = buildSnapshot(input({ jp: { error: "財務省の国債金利情報の取得・解析に失敗: HTTP 404" } }));
  assert.equal(s.jp2y, null);
  assert.equal(s.judgment.label, "判定できません");
  assert.match(s.judgment.reason, /日2年の値がありません/);
});

test("財務省のCSVとXMLで値が違えば、判定できません（照合の不一致）", () => {
  const bad = usXml.map((r) => (r.date === "2026-10-06" ? { ...r, milli: 4800 } : r));
  const s = buildSnapshot(input({ us: { rows: us, xml: { rows: bad }, fetchedAt: "t" } }));
  assert.equal(s.us2y.xml_check.status, "mismatch");
  assert.deepEqual(s.us2y.xml_check.mismatches, [{ date: "2026-10-06", csv: 4.79, xml: 4.8 }]);
  assert.equal(s.judgment.label, "判定できません");
  assert.match(s.errors.join("\n"), /CSVとXMLで値が一致しません/);
});

test("XMLを取得できなかった場合は照合を「未実施」と記録する（CSVの採用は止めない）", () => {
  const s = buildSnapshot(input({ us: { rows: us, xml: { error: "HTTP 500" }, fetchedAt: "t" } }));
  assert.equal(s.us2y.xml_check.status, "unavailable");
  assert.equal(s.judgment.available, true);
});

test("履歴に穴（開いているはずの日の行が無い）があれば、5営業日差が正しく出せないので判定できません", () => {
  const s = buildSnapshot(input({ jp: { rows: jp.filter((r) => r.date !== "2026-09-30"), lastModified: null, fetchedAt: "t" } }));
  assert.equal(s.judgment.label, "判定できません");
  assert.match(s.errors.join("\n"), /jp2y: 履歴に欠けた営業日があります（2026-09-30）/);
  const s2 = buildSnapshot(input({ us: { rows: us.filter((r) => r.date !== "2026-09-30"), xml: { rows: usXml }, fetchedAt: "t" } }));
  assert.match(s2.errors.join("\n"), /us2y: 履歴に欠けた営業日があります（2026-09-30）/);
});

test("祝日表に今年が無ければ、営業日を決められず判定できません（取得の問題として記録する）", () => {
  const s = buildSnapshot(input({ nowMs: H.jst("2028-01-05 10:00") }));
  assert.equal(s.judgment.label, "判定できません");
  assert.match(s.errors.join("\n"), /calendar: 祝日表に2028年が無い/);
});

test("祝日をまたぐ週（10/12 は日米の休場）：10/13 の朝は、米2年が10/9、日2年が10/9 でも最新と判定する", () => {
  // 実データは 10/6 までなので、10/7〜10/9 の行を合成して、10/13（火）の朝の状態を作る
  const addUs = [["2026-10-07", 4790], ["2026-10-08", 4800], ["2026-10-09", 4810]].map(([date, milli]) => ({ date, milli }));
  const addJp = [["2026-10-07", 1940], ["2026-10-08", 1950], ["2026-10-09", 1960]].map(([date, milli]) => ({ date, milli }));
  const s = buildSnapshot(input({
    nowMs: H.jst("2026-10-13 10:00"),
    us: { rows: [...us, ...addUs], xml: { rows: [...usXml, ...addUs] }, fetchedAt: "t" },
    jp: { rows: [...jp, ...addJp], lastModified: null, fetchedAt: "t" },
  }));
  assert.deepEqual(s.errors, []);
  assert.equal(s.us2y.expected_date, "2026-10-09"); assert.equal(s.jp2y.expected_date, "2026-10-09");
  assert.equal(s.judgment.available, true);
  // 月曜 10/12 の朝は、日2年の10/9分はまだ出ていない（10/13 9:30頃に公表）。期待は 10/8
  const mon = buildSnapshot(input({
    nowMs: H.jst("2026-10-12 10:00"),
    us: { rows: [...us, ...addUs], xml: { rows: [...usXml, ...addUs] }, fetchedAt: "t" },
    jp: { rows: [...jp, ...addJp.filter((r) => r.date <= "2026-10-08")], lastModified: null, fetchedAt: "t" },
  }));
  assert.equal(mon.jp2y.expected_date, "2026-10-08"); assert.equal(mon.us2y.expected_date, "2026-10-09");
  assert.equal(mon.judgment.available, true);
  assert.equal(mon.spread.date, "2026-10-08"); // 金利差は両方に値がある日（日2年の最新）
});
