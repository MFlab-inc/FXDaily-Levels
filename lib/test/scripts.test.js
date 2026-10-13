"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { tmpRoot, snapshot } = require("./helpers");

/**
 * intraday.js・daytrade.js を、一時フォルダに複製して実際に動かす（リポジトリの data/ には触れない）。
 * fetch はブロックして、呼ばれたら記録して終了コード 86 で止める（ネットワークには出ない）。
 *   終了コード 0 ＋ 記録なし = スキップ（API を呼ばず成功）／ 86 ＝ 取得しようとした（スキップしなかった）
 */
const BLOCK = path.join(__dirname, "fixtures", "block-fetch.js");
const MIN = 60000;

function run(t, script, args = [], env = {}) {
  const log = path.join(t.root, "fetch.log");
  const r = spawnSync(process.execPath, ["--require", BLOCK, path.join(t.root, script), ...args], {
    cwd: t.root, encoding: "utf8", timeout: 60000,
    env: { PATH: process.env.PATH, TWELVE_DATA_API_KEY: "dummy-key", FETCH_LOG: log, ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [] };
}
const withRoot = (o, f) => { const t = tmpRoot(Date.now(), o); try { return f(t); } finally { t.cleanup(); } };

for (const [script, name, ageKey, firstCall] of [["intraday.js", "intraday", "intradayAge", "api.twelvedata.com/quote"], ["daytrade.js", "daytrade", "h1Age", "api.twelvedata.com/time_series"]]) {
  test(`${script}: 直前の取得から5分未満なら API を呼ばず、終了コード 0 で終わる。data/ は1バイトも変わらない`, () => {
    withRoot({}, (t) => {
      const before = snapshot(t.dataDir);
      const r = run(t, script);
      assert.equal(r.status, 0, r.err);
      assert.deepEqual(r.calls, []);
      assert.match(r.out, new RegExp(`\\[${name}\\] スキップ（API を呼びません）: 前回の取得`));
      assert.match(r.out, /--force/);
      assert.deepEqual(snapshot(t.dataDir), before);
    });
  });

  test(`${script}: 5分以上前なら、スキップせず取得する（${firstCall}）`, () => {
    withRoot({ intradayAge: 6 * MIN, h1Age: 6 * MIN, ctxAge: 6 * MIN }, (t) => {
      const r = run(t, script);
      assert.equal(r.status, 86);
      assert.ok(r.calls[0].includes(firstCall), r.calls[0]);
      assert.match(r.out, new RegExp(`\\[${name}\\] 取得します: 前回の取得から 6分`));
      assert.ok(!/スキップ/.test(r.out));
    });
  });

  test(`${script}: --force なら、5分未満でも取得する`, () => {
    withRoot({}, (t) => {
      const r = run(t, script, ["--force"]);
      assert.equal(r.status, 86);
      assert.ok(r.calls[0].includes(firstCall));
      assert.ok(!/スキップ/.test(r.out) && !/取得します/.test(r.out)); // 判定そのものをしない
    });
  });

  test(`${script}: 日次レベルが前回の取得より新しければ（Daily FX Data の完了直後）、5分未満でも取得する`, () => {
    withRoot({ dailyAge: MIN, intradayAge: 3 * MIN, h1Age: 3 * MIN, ctxAge: 3 * MIN }, (t) => {
      const r = run(t, script);
      assert.equal(r.status, 86);
      assert.match(r.out, /日次レベルが前回の取得より新しい/);
    });
  });

  test(`${script}: 前回の取得が不完全（銘柄の欠け・errors）なら、5分未満でもやり直す`, () => {
    const bad = script === "intraday.js"
      ? [{ intradayErrors: ["quote_batch: HTTP 429 (twelvedata:quote)"] }, { intradayCodes: ["USDJPY"] }]
      : [{ h1Errors: ["FAIL(H1系列): US500 - fetch failed"] }, { ctxErrors: ["USDJPY: M5データ不足(3本)"] }, { ctxCodes: ["USDJPY"] }];
    for (const o of bad) withRoot(o, (t) => {
      const r = run(t, script);
      assert.equal(r.status, 86, JSON.stringify(o));
      assert.match(r.out, /前回の取得が不完全/);
    });
  });

  test(`${script}: 前回のファイルが無い・壊れていれば、これまでどおり取得に進む`, () => {
    withRoot({ omit: ["intraday.json", "h1-bars.json", "daytrade-context.json"] }, (t) => {
      const r = run(t, script);
      assert.equal(r.status, 86);
      assert.match(r.out, /取得します/);
    });
    withRoot({}, (t) => {
      for (const f of ["intraday.json", "h1-bars.json", "daytrade-context.json"]) fs.writeFileSync(path.join(t.dataDir, f), "{ broken");
      const r = run(t, script);
      assert.equal(r.status, 86);
    });
  });
}

test("intraday.js: daily-levels.json が無いときの動作は今までどおり（API を呼ばず、エラーで終了コード 1）", () => {
  withRoot({ omit: ["daily-levels.json"] }, (t) => {
    const r = run(t, "intraday.js");
    assert.equal(r.status, 1);
    assert.match(r.err, /daily-levels\.json がありません/);
    assert.deepEqual(r.calls, []);
  });
});

test("intraday.js と daytrade.js は別々に判定する（片方だけ古ければ、その片方だけ取得する）", () => {
  withRoot({ intradayAge: 6 * MIN }, (t) => {
    assert.equal(run(t, "intraday.js").status, 86);
    assert.equal(run(t, "daytrade.js").status, 0);
  });
  withRoot({ h1Age: 6 * MIN }, (t) => {
    assert.equal(run(t, "intraday.js").status, 0);
    assert.equal(run(t, "daytrade.js").status, 86);
  });
});

test("スキップは API キーを読む前の処理ではない（キーが無ければ今までどおり終了コード 1）", () => {
  withRoot({}, (t) => {
    const r = run(t, "intraday.js", [], { TWELVE_DATA_API_KEY: "" });
    assert.equal(r.status, 1);
    assert.match(r.err, /TWELVE_DATA_API_KEY/);
  });
});
