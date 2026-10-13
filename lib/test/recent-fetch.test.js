"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../recent-fetch");
const { CODES, jstIso, dataFiles, writeData } = require("./helpers");

const NOW = Date.parse("2026-10-13T05:50:30+09:00");
const MIN = 60000, SEC = 1000;
const withDir = (files, f) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
  try { writeData(dir, files); return f(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test("5分未満ならスキップ、5分ちょうど以上は取得する（境界）", () => {
  const at = (ms) => R.decide({ nowMs: NOW, lastAsOf: jstIso(NOW - ms), dailyAsOf: jstIso(NOW - 3600000) });
  assert.equal(at(0).skip, true);
  assert.equal(at(4 * MIN + 59 * SEC).skip, true);
  assert.equal(at(5 * MIN).skip, false);
  assert.match(at(5 * MIN).reason, /5分以上/);
  assert.equal(at(15 * MIN).skip, false);
  assert.equal(R.SKIP_WITHIN_MS, 5 * MIN);
  assert.match(at(2 * MIN).reason, /2分00秒（5分未満）/);
});

test("時計のずれ: as_of が未来に見えても 30秒までは『今』と同じ扱い。それより先なら取得する", () => {
  const at = (ms) => R.decide({ nowMs: NOW, lastAsOf: jstIso(NOW + ms), dailyAsOf: jstIso(NOW - 3600000) });
  assert.equal(at(10 * SEC).skip, true);
  assert.equal(at(29 * SEC).skip, true);
  assert.equal(at(30 * SEC).skip, false);
  assert.match(at(5 * MIN).reason, /未来/);
});

test("読めない・足りない・不完全なものがあれば、スキップしない（これまでどおり取得する）", () => {
  const base = { nowMs: NOW, lastAsOf: jstIso(NOW - MIN), dailyAsOf: jstIso(NOW - 3600000) };
  assert.equal(R.decide(base).skip, true);
  for (const bad of [undefined, null, "", "garbage", "2026-10-13 05:49:30", 12345, "2026-10-13T05:49:30"]) assert.equal(R.decide({ ...base, lastAsOf: bad }).skip, false, String(bad));
  for (const bad of [undefined, null, "garbage"]) assert.equal(R.decide({ ...base, dailyAsOf: bad }).skip, false, String(bad));
  const r = R.decide({ ...base, healthy: { ok: false, reason: "銘柄が欠けている: USOIL" } });
  assert.equal(r.skip, false);
  assert.match(r.reason, /不完全（銘柄が欠けている: USOIL）/);
});

test("日次レベル（daily-levels.json）が前回の取得より新しければ、5分以内でも取得する（Daily FX Data 完了直後の workflow_run の再取得を残す）。同時刻なら新しくない", () => {
  const last = NOW - 3 * MIN;
  const at = (dailyAt) => R.decide({ nowMs: NOW, lastAsOf: jstIso(last), dailyAsOf: jstIso(dailyAt) });
  assert.equal(at(last - 1000).skip, true);
  assert.equal(at(last).skip, true);
  assert.equal(at(last + 1000).skip, false);
  assert.match(at(last + 1000).reason, /日次レベルが前回の取得より新しい/);
  assert.equal(at(NOW - 10 * SEC).skip, false); // 前回の取得の2分50秒後に日次が更新された
});

test("intraday: 全銘柄そろい quote のバッチ失敗が無ければ健全。センチメント（Yahoo）などの失敗は数えない", () => {
  const check = (o, now = NOW) => withDir(dataFiles(now, o), (dir) => R.checkIntraday({ dataDir: dir, nowMs: now, codes: CODES }));
  assert.equal(check({}).skip, true);
  assert.equal(check({ intradayErrors: ["DXY: fetch failed", "US2Y: HTTP 500"] }).skip, true);
  const missing = check({ intradayCodes: CODES.filter((c) => c !== "USOIL") });
  assert.equal(missing.skip, false);
  assert.match(missing.reason, /銘柄が欠けている: USOIL/);
  const batch = check({ intradayErrors: ["quote_batch: HTTP 429 (twelvedata:quote)"] });
  assert.equal(batch.skip, false);
  assert.match(batch.reason, /quote_batch/);
  assert.equal(check({ intradayAge: 5 * MIN }).skip, false);
  assert.equal(check({ intradayAge: 4 * MIN }).skip, true);
  assert.equal(check({ dailyAge: MIN, intradayAge: 3 * MIN }).skip, false); // 日次（1分前）のほうが前回の取得（3分前）より新しい → 取得
  assert.equal(check({ dailyAge: 4 * MIN, intradayAge: 3 * MIN }).skip, true); // 日次（4分前）は前回の取得（3分前）より古い → スキップ
});

test("intraday: daily が前回より新しければ取得（日次は1分前、前回は3分前）。ファイルが無い・壊れている・日次が無いときは取得", () => {
  const files = dataFiles(NOW, { dailyAge: MIN, intradayAge: 3 * MIN });
  assert.equal(withDir(files, (dir) => R.checkIntraday({ dataDir: dir, nowMs: NOW, codes: CODES })).skip, false);
  assert.equal(withDir(dataFiles(NOW, { omit: ["intraday.json"] }), (dir) => R.checkIntraday({ dataDir: dir, nowMs: NOW, codes: CODES })).skip, false);
  assert.equal(withDir(dataFiles(NOW, { omit: ["daily-levels.json"] }), (dir) => R.checkIntraday({ dataDir: dir, nowMs: NOW, codes: CODES })).skip, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
  try {
    writeData(dir, dataFiles(NOW, {}));
    fs.writeFileSync(path.join(dir, "intraday.json"), "{ broken");
    assert.equal(R.checkIntraday({ dataDir: dir, nowMs: NOW, codes: CODES }).skip, false);
    assert.equal(R.checkIntraday({ dataDir: path.join(dir, "nope"), nowMs: NOW, codes: CODES }).skip, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("daytrade: h1-bars.json と daytrade-context.json の両方が健全で、古い方の as_of が5分未満のときだけスキップ", () => {
  const check = (o) => withDir(dataFiles(NOW, o), (dir) => R.checkDaytrade({ dataDir: dir, nowMs: NOW, codes: CODES }));
  assert.equal(check({}).skip, true);
  assert.equal(check({ h1Codes: [...CODES, "US500", "EXTRA"] }).skip, true); // h1-bars は13銘柄でよい（期待の12が揃っていれば）
  assert.equal(check({ h1Age: MIN, ctxAge: 5 * MIN }).skip, false); // 片方が古い
  assert.equal(check({ h1Age: 5 * MIN, ctxAge: MIN }).skip, false);
  assert.equal(check({ h1Age: 4 * MIN, ctxAge: 3 * MIN }).skip, true);
  const e1 = check({ h1Errors: ["FAIL(H1系列): US500 - fetch failed"] });
  assert.equal(e1.skip, false); assert.match(e1.reason, /h1-bars\.json: errors 1件/);
  const e2 = check({ ctxErrors: ["USDJPY: M5データ不足(3本)"] });
  assert.equal(e2.skip, false); assert.match(e2.reason, /daytrade-context\.json: errors 1件/);
  const m = check({ ctxCodes: CODES.slice(1) });
  assert.equal(m.skip, false); assert.match(m.reason, /daytrade-context\.json: 銘柄が欠けている USDJPY/);
  assert.equal(check({ omit: ["h1-bars.json"] }).skip, false);
  assert.equal(check({ omit: ["daytrade-context.json"] }).skip, false);
  // 日次が新しい（Daily FX Data の完了直後）→ 突き合わせを更新するため取得
  assert.equal(check({ dailyAge: MIN, h1Age: 3 * MIN, ctxAge: 3 * MIN }).skip, false);
  assert.equal(check({ dailyAge: 4 * MIN, h1Age: 3 * MIN, ctxAge: 3 * MIN }).skip, true); // 日次が取得より古ければスキップ
});

test("表示用の経過時間", () => {
  assert.equal(R.fmtAge(0), "0秒"); assert.equal(R.fmtAge(42 * SEC), "42秒"); assert.equal(R.fmtAge(61 * SEC), "1分01秒"); assert.equal(R.fmtAge(14 * MIN + 59 * SEC), "14分59秒");
  assert.ok(Number.isNaN(R.parseTime("x"))); assert.equal(R.parseTime("2026-10-13T05:50:30+09:00"), NOW); assert.equal(R.parseTime("2026-10-12T20:50:30Z"), NOW);
});
