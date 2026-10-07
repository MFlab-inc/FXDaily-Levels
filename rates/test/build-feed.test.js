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
  fs.copyFileSync(path.join(H.FIX, "feed-golden", "daily-levels.json"), path.join(root, "data", "daily-levels.json"));
  return root;
}
const FAKENOW = path.join(__dirname, "fakenow.js");
const build = (root, nowMs) => {
  const args = nowMs ? ["-r", FAKENOW, "build-feed.js"] : ["build-feed.js"];
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env: { ...process.env, FAKE_NOW_MS: nowMs ? String(nowMs) : "" } });
  assert.equal(r.status, 0, r.stderr);
  const d = (n) => fs.readFileSync(path.join(root, "data", n), "utf8");
  return { txt: d("gpt-feed.txt"), html: d("gpt-feed.html"), csv: d("feed.csv"), history: d("history.csv"), stderr: r.stderr };
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

const GOLD = path.join(H.FIX, "feed-golden");
const stripGenerated = (t) => t.split("\n").filter((l) => !l.includes("feed_generated_at")).join("\n");

test("rates.json が無いときは、フィードが従来（rates/ を足す前の build-feed.js）の出力とバイトまで一致する", () => {
  const out = build(makeRoot());
  assert.equal(stripGenerated(out.txt), fs.readFileSync(path.join(GOLD, "gpt-feed.txt"), "utf8"));
  assert.equal(stripGenerated(out.html), fs.readFileSync(path.join(GOLD, "gpt-feed.html"), "utf8"));
  assert.equal(out.csv, fs.readFileSync(path.join(GOLD, "feed.csv"), "utf8"));
  assert.equal(out.history, fs.readFileSync(path.join(GOLD, "history.csv"), "utf8"));
});

async function rootWithRates() {
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
  return root;
}

test("フィードの判定は「いま」で見直す：取得の翌日（まだ最新）は判定が出て、日が進んで古くなれば「判定できません」になる", async () => {
  const root = await rootWithRates();
  const fresh = build(root, H.jst("2026-10-07 11:00"));
  assert.match(fresh.txt, /判定: はっきりしない（金利差の5営業日差 -5\.4bp/);
  assert.match(fresh.txt, /表示時点: 2026-10-07T11:00:00\+09:00/);
  const stale = build(root, H.jst("2026-10-12 10:40"));   // 10/12 は祝日。10/8・10/9分が取れていない状態
  assert.match(stale.txt, /判定: 判定できません（理由: /);
  assert.ok(!/判定: はっきりしない/.test(stale.txt));
  assert.match(stale.html, /判定: 判定できません/);
  assert.match(stale.txt, /"label": "判定できません"/);   // Raw の judgment も、見直した値
});

test("ヘッダ（daily as_of の行）に rates as_of が付く。txt は3行目、html は <p> の行", async () => {
  const root = await rootWithRates();
  const { txt, html } = build(root, H.jst("2026-10-07 11:00"));
  const line = txt.split("\n")[2];
  assert.ok(line.startsWith("daily as_of: ") && line.endsWith(" | rates as_of: 2026-10-07T10:00:00+09:00"), line);
  assert.match(html, /<p>daily as_of: [^\n]* \| rates as_of: 2026-10-07T10:00:00\+09:00<\/p>/);
});

test("形式は正しいが中身が欠けた rates.json（judgment.basis なし）でも、フィードは作る。区画だけ出さず、警告を出す", () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "data", "rates.json"), JSON.stringify({
    schema: "fxdaily-levels/rates/v1", as_of: "2026-10-07T10:00:00+09:00",
    us2y: { date: "2026-10-06", value: 4.79 }, jp2y: { date: "2026-10-06", value: 1.93 },
    judgment: { available: true, label: "はっきりしない", threshold_bp: 10 }, generation: { errors: [] },
  }));
  const out = build(root, H.jst("2026-10-07 11:00"));
  assert.ok(!out.txt.includes("JP-US 2Y Rates"));
  assert.ok(out.txt.includes("【Market Sentiment】"));
  assert.match(out.stderr, /日米2年金利の区画は出しません/);
});
