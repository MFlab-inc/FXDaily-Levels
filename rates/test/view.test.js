"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSnapshot } = require("../lib/snapshot");
const view = require("../lib/view");
const cfg = require("../config");
const H = require("./helpers");

const holidays = H.holidays();
const us = H.usRows(), usXml = H.usXmlRows(), jp = H.jpRows();

// 10/7（水）10:00 に取得した、健全な rates.json 相当
function stored(over = {}) {
  const snap = buildSnapshot({
    nowMs: H.jst("2026-10-07 10:00"), holidays, prev: null,
    us: { rows: us, xml: { rows: usXml }, fetchedAt: "2026-10-07T10:00:00+09:00" },
    jp: { rows: jp, lastModified: "Tue, 06 Oct 2026 23:30:14 GMT", fetchedAt: "2026-10-07T10:00:00+09:00" },
  });
  return {
    schema: view.SCHEMA, as_of: "2026-10-07T10:00:00+09:00", timezone: "Asia/Tokyo",
    us2y: snap.us2y, jp2y: snap.jp2y, spread: snap.spread, change_5d: snap.change_5d, judgment: snap.judgment,
    generation: { status: "ok", complete: true, errors: [], retry_expected: false },
    ...over,
  };
}

test("取得した日のうちに見れば ok。判定はそのまま", () => {
  const r = view.evaluate(stored(), H.jst("2026-10-07 11:00"), holidays);
  assert.equal(r.state, "ok");
  assert.equal(r.view.judgment.label, "はっきりしない");
  assert.equal(r.view.effective_at, "2026-10-07T11:00:00+09:00");
});

test("翌営業日の朝（日2年の10/7分が公表された後）に、rates.json が更新されていなければ、古い：判定は「判定できません」", () => {
  const early = view.evaluate(stored(), H.jst("2026-10-08 10:00"), holidays);
  assert.equal(early.state, "pending");                                // 10:30まではまだ公表待ち（赤にしない）
  assert.equal(early.view.judgment.label, "判定できません");          // ただし判定は出さない
  const r = view.evaluate(stored(), H.jst("2026-10-08 10:35"), holidays);
  assert.equal(r.state, "stale");
  assert.equal(r.view.judgment.available, false);
  assert.equal(r.view.judgment.label, "判定できません");
  assert.match(r.view.judgment.reason, /米2年が最新の営業日（期待 2026-10-07）まで更新されていません（最新 2026-10-06）/);
  assert.match(r.view.judgment.reason, /日2年が最新の営業日（期待 2026-10-07）まで更新されていません（最新 2026-10-06）/);
  assert.equal(r.view.us2y.fresh, false); assert.equal(r.view.jp2y.fresh, false);
});

test("公表前（9:40前）は、前日の値のままでも古くない（米は前日夜に出ているので期待も前日）", () => {
  // 10/8 09:30 JST：米東部 10/7 20:30 → 米の期待は 10/7。10/7 の米2年が無ければ米は古い
  const r = view.evaluate(stored(), H.jst("2026-10-08 09:30"), holidays);
  assert.equal(r.view.jp2y.expected_date, "2026-10-06"); // 日は10/7分の公表前
  assert.equal(r.view.jp2y.fresh, true);
  assert.equal(r.view.us2y.expected_date, "2026-10-07");
  assert.equal(r.view.us2y.fresh, false);
});

test("公表待ち（pending）：日本の営業日の10:30より前で取得の問題が無ければ、赤にしない。10:30以降は stale", () => {
  const gen = { status: "pending", complete: false, errors: [], retry_expected: true };
  const doc = stored({ generation: gen });
  assert.equal(view.evaluate(doc, H.jst("2026-10-08 10:00"), holidays).state, "pending");
  assert.equal(view.evaluate(doc, H.jst("2026-10-08 10:29"), holidays).state, "pending");
  assert.equal(view.evaluate(doc, H.jst("2026-10-08 10:30"), holidays).state, "stale");
});

test("取得の問題が残っている（generation.errors）ときは、最新でも stale。判定は判定できません", () => {
  const doc = stored({ generation: { status: "partial", complete: false, errors: ["us2y: 履歴に欠けた営業日があります（2026-09-30）"], retry_expected: true } });
  const r = view.evaluate(doc, H.jst("2026-10-07 10:05"), holidays);
  assert.equal(r.state, "stale");
  assert.equal(r.view.judgment.label, "判定できません");
  assert.match(r.view.judgment.reason, /履歴に欠けた営業日/);
});

test("stale の値（取得失敗で前回値のまま）があれば、日付が新しくても stale", () => {
  const doc = stored();
  doc.us2y = { ...doc.us2y, stale: true };
  const r = view.evaluate(doc, H.jst("2026-10-07 11:00"), holidays);
  assert.equal(r.state, "stale");
  assert.equal(r.view.judgment.label, "判定できません");
  assert.equal(r.view.us2y.fresh, false);
});

test("rates.json が無い／形式が違うときは stale", () => {
  assert.equal(view.evaluate(null, H.jst("2026-10-07 11:00"), holidays).state, "stale");
  assert.equal(view.evaluate({ schema: "x" }, H.jst("2026-10-07 11:00"), holidays).state, "stale");
});

test("フィードの区画（健全）：値・日付・5営業日差・判定・しきい値・出典（財務省PDL1.0／米財務省）が入る", () => {
  const text = view.sectionText(view.evaluate(stored(), H.jst("2026-10-07 11:00"), holidays).view);
  assert.match(text, /^【JP-US 2Y Rates】\(rates as_of: 2026-10-07T10:00:00\+09:00 \/ 表示時点: 2026-10-07T11:00:00\+09:00\)/);
  assert.match(text, /米2年: 4\.79%（2026-10-06・米東部基準／米財務省 par yield／XML照合 一致（68日））/);
  assert.match(text, /日2年: 1\.930%（2026-10-06・東京基準／財務省、翌営業日午前9時30分頃公表）/);
  assert.match(text, /金利差（米2年 − 日2年。両方に値がある直近日 2026-10-06）: \+2\.860%pt/);
  assert.match(text, /5営業日差: 米2年 -10\.0bp（2026-09-29比）／日2年 -4\.6bp（2026-09-29比）／金利差 -5\.4bp（2026-09-29比）/);
  assert.match(text, /判定: はっきりしない（金利差の5営業日差 -5\.4bp、2026-09-29→2026-10-06。しきい値 ±10bp、境界を含む。−10bp以下＝円高方向／\+10bp以上＝円安方向／その間＝はっきりしない）/);
  // 出典：米財務省は指定の書式、財務省（日本）は PDL1.0（URL）と、加工した旨・主体
  assert.ok(text.includes("出典：米財務省 Daily Treasury Par Yield Curve Rates（https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics）"));
  assert.ok(text.includes("出典：財務省「国債金利情報」（https://www.mof.go.jp/jgbs/reference/interest_rate/index.htm）、PDL1.0（https://www.digital.go.jp/resources/open_data/public_data_license_v1.0）を加工して作成（5営業日の差と金利差の計算：" + cfg.PROCESSOR_NAME + "）"));
  assert.match(text, /トレード判定ではありません/);
});

test("フィードの区画（古い）：判定は「判定できません」、理由・しきい値・古い印を出す", () => {
  const text = view.sectionText(view.evaluate(stored(), H.jst("2026-10-08 10:00"), holidays).view);
  assert.match(text, /判定: 判定できません（理由: 米2年が最新の営業日（期待 2026-10-07）まで更新されていません（最新 2026-10-06）／日2年が/);
  assert.match(text, /しきい値 ±10bp、境界を含む/);
  assert.match(text, /米2年: 4\.79%（2026-10-06.*）［古い：期待 2026-10-07 に対し最新 2026-10-06］/);
  assert.ok(text.includes("PDL1.0")); // 出典は常に出す
});

test("フィードの区画（stale）：stale の印を出す", () => {
  const doc = stored();
  doc.jp2y = { ...doc.jp2y, stale: true };
  const text = view.sectionText(view.evaluate(doc, H.jst("2026-10-07 11:00"), holidays).view);
  assert.match(text, /日2年: 1\.930%.*［stale：取得に失敗したため前回の値のまま］/);
  assert.match(text, /判定: 判定できません/);
});
