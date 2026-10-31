"use strict";

/**
 * risk.yml の起動条件が壊れていないかの確認（外部へは接続しない。rates/test/workflows.test.js と同じ読み方：
 * YAML の読み込みライブラリは使わず、必要な行だけを読む）。
 * on: workflow_run は、そのファイルが main にあるときだけ効くので、PR の段階では実際に起動して確かめられない。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WF_DIR = path.join(__dirname, "..", "..", ".github", "workflows");
const read = (f) => fs.readFileSync(path.join(WF_DIR, f), "utf8");

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).replace(/\s+$/, "");
  }
  return line;
}
const clean = (text) => text.replace(/\r\n/g, "\n").split("\n").map(stripComment).filter((l) => l.trim() !== "").join("\n");
const topName = (text) => {
  const m = clean(text).match(/^name:\s*(.+?)\s*$/m);
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
};
function blockOf(text, header, indent) {
  const lines = text.split("\n");
  const head = `${" ".repeat(indent)}${header}`;
  const start = lines.findIndex((l) => l === head || l.startsWith(`${head} `));
  if (start < 0) throw new Error(`${header} が見つかりません`);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].match(/^ */)[0].length <= indent) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}
const listOf = (block, key) => {
  const m = block.match(new RegExp(`^\\s*${key}:\\s*\\[(.*?)\\]\\s*$`, "m"));
  if (!m) throw new Error(`${key}: [a, b] が見つかりません`);
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
};

const RISK = read("risk.yml");
const R = clean(RISK);
const ON = blockOf(R, "on:", 0);

test("workflow_run の上流は Intraday Snapshot と Daily FX Data（各ファイルの name: と一致）。自分自身は含めない", () => {
  const wr = blockOf(ON, "workflow_run:", 2);
  assert.deepEqual(listOf(wr, "workflows").sort(), ["Daily FX Data", "Intraday Snapshot"]);
  assert.equal(topName(read("intraday.yml")), "Intraday Snapshot");
  assert.equal(topName(read("daily.yml")), "Daily FX Data");
  assert.deepEqual(listOf(wr, "types"), ["completed"]);
  assert.deepEqual(listOf(wr, "branches"), ["main"]);
  assert.ok(!listOf(wr, "workflows").includes(topName(RISK)));
});

test("schedule：日本時間の月〜土の朝（UTC の曜日のずれを含めて）", () => {
  const s = blockOf(ON, "schedule:", 2);
  assert.match(s, /^\s*-\s*cron:\s*"10,40 22-23 \* \* 0-5"\s*$/m);
  assert.match(s, /^\s*-\s*cron:\s*"10,40 0-1 \* \* 1-6"\s*$/m);
});

test("取得の式：手動実行で if_stale がオフのときだけ常に取得、それ以外は --if-stale", () => {
  const step = blockOf(R, "- name: Update risk metrics", 6);
  const m = step.match(/^\s*run:\s*node risk\/run-daily\.js \$\{\{ (.+?) \}\}\s*$/m);
  assert.ok(m, "run: node risk/run-daily.js ${{ … }} が見つかりません");
  const evaluate = (eventName, ifStale) =>
    new Function("github", "inputs", `return (${m[1]});`)({ event_name: eventName }, ifStale === undefined ? {} : { if_stale: ifStale });
  assert.equal(evaluate("schedule"), "--if-stale");
  assert.equal(evaluate("workflow_run"), "--if-stale");
  assert.equal(evaluate("workflow_dispatch", true), "--if-stale");
  assert.equal(evaluate("workflow_dispatch", false), "");
});

test("コミットするのは data/risk.json だけ。取得が失敗してもコミットと鮮度の確認は動く", () => {
  const adds = R.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("git add "));
  assert.deepEqual(adds, ["git add data/risk.json"]);
  assert.match(blockOf(R, "- name: Commit and push risk", 6), /^\s*if:\s*\$\{\{ !cancelled\(\) \}\}\s*$/m);
  assert.match(blockOf(R, "- name: Assert risk freshness", 6), /^\s*run:\s*node risk\/run-daily\.js --check-fresh\s*$/m);
});

test("concurrency は risk-data（rates-data とは別）、checkout は ref を明示、permissions は contents: write", () => {
  assert.match(blockOf(R, "concurrency:", 0), /^\s*group:\s*risk-data\s*$/m);
  assert.match(blockOf(R, "concurrency:", 0), /^\s*cancel-in-progress:\s*false\s*$/m);
  assert.match(blockOf(R, "- name: Checkout", 6), /^\s*ref:\s*\$\{\{ github\.ref \}\}\s*$/m);
  assert.match(blockOf(R, "permissions:", 0), /^\s*contents:\s*write\s*$/m);
});
