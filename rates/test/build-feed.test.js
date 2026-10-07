"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { run } = require("../run-daily");
const H = require("./helpers");

const REPO = path.join(__dirname, "..", "..");

// build-feed.js と、必要な部品だけを一時フォルダへ写して実行する（リポジトリの data/ は書き換えない）
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rates-feed-"));
  fs.copyFileSync(path.join(REPO, "build-feed.js"), path.join(root, "build-feed.js"));
  fs.cpSync(path.join(REPO, "rates"), path.join(root, "rates"), { recursive: true, filter: (src) => !src.includes(`${path.sep}test`) });
  fs.mkdirSync(path.join(root, "mtf", "lib"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "mtf", "lib", "ny-time.js"), path.join(root, "mtf", "lib", "ny-time.js"));
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data", "daily-levels.json"), JSON.stringify({
    as_of: "2026-10-07T06:20:19+09:00", market_sentiment: { dxy: 102, dxy_change_pct: 0.1, us2y: 4.6, us2y_change: 0, us10y: 5.2, us10y_change: 0, vix: 15, vix_change_pct: 0 }, pairs: {},
  }));
  return root;
}
const build = (root) => {
  const r = spawnSync(process.execPath, ["build-feed.js"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const d = (n) => fs.readFileSync(path.join(root, "data", n), "utf8");
  return { txt: d("gpt-feed.txt"), html: d("gpt-feed.html"), stderr: r.stderr };
};

test("rates.json が無いときは、日米2年金利の区画もヘッダも出さない（既存のフィードは変わらない）", () => {
  const { txt, html } = build(makeRoot());
  for (const t of [txt, html]) {
    assert.ok(!t.includes("JP-US 2Y Rates"));
    assert.ok(!t.includes("rates as_of"));
    assert.ok(!t.includes("Raw: rates.json"));
  }
});

test("rates.json があるときは、ヘッダ・サマリーの区画（判定・出典）・Raw が入る（txt・html とも）", async () => {
  const root = makeRoot();
  const fetchImpl = async (url) => {
    if (url.includes("daily-treasury-rates.csv")) return new Response(H.usCsvText());
    if (url.includes("pages/xml")) return new Response(H.usXmlText());
    if (url.includes("jgbcm_all.csv")) return new Response(H.mofAllBytes());
    if (url.includes("jgbcm.csv")) return new Response(H.mofMonthBytes());
    if (url.includes("syukujitsu.csv")) return new Response(fs.readFileSync(path.join(H.ROOT, "jp-holidays.csv")));
    return new Response("", { status: 404 });
  };
  await run({ argv: [], nowMs: H.jst("2026-10-07 10:00"), fetchImpl, sleep: async () => {}, dataDir: path.join(root, "data"), log: () => {}, env: {} });
  const { txt, html } = build(root);
  // 実行した時刻によって「いま」の鮮度は変わる（古ければ判定できません）。ここでは構成だけを確かめる
  for (const t of [txt, html]) {
    assert.match(t, /rates as_of: 2026-10-07T10:00:00\+09:00/);
    assert.match(t, /【JP-US 2Y Rates】/);
    assert.match(t, /判定: (はっきりしない|円高方向|円安方向|判定できません)/);
    assert.ok(t.includes("PDL1.0"));
    assert.ok(t.includes("出典：米財務省 Daily Treasury Par Yield Curve Rates"));
    assert.match(t, /Raw: rates\.json/);
  }
  // 区画の位置：Market Sentiment の後、Pairs の前
  assert.ok(txt.indexOf("【Market Sentiment】") < txt.indexOf("【JP-US 2Y Rates】"));
  assert.ok(txt.indexOf("【JP-US 2Y Rates】") < txt.indexOf("【Pairs】"));
});

test("rates.json が壊れていても、フィードは作る（区画だけ出さない）", () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "data", "rates.json"), "{ broken");
  const { txt } = build(root);
  assert.ok(!txt.includes("JP-US 2Y Rates"));
  assert.ok(txt.includes("【Market Sentiment】"));
});
