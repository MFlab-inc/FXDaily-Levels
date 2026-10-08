"use strict";

/**
 * rates.yml の起動条件が壊れていないかの確認（外部へは接続しない。YAML の読み込みライブラリは使わず、必要な行だけを読む）。
 *
 * on: workflow_run は、そのファイルが既定ブランチ（main）にあるときだけ効くので、PR の段階では実際に起動して確かめられない。
 * 上流の name: を変えたり、書き間違えたりすると、エラーも出さずに起動しなくなる。そこをここで見張る。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WF_DIR = path.join(__dirname, "..", "..", ".github", "workflows");
const read = (f) => fs.readFileSync(path.join(WF_DIR, f), "utf8");

const topName = (text) => {
  const m = text.match(/^name:\s*(.+?)\s*$/m);
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
};

// `header` の行（行頭から indent 個の空白 + header）の下で、それより深くインデントされた行（空行・コメント行を含む）
function blockOf(text, header, indent) {
  const lines = text.split("\n");
  const head = `${" ".repeat(indent)}${header}`;
  const start = lines.findIndex((l) => l === head || l.startsWith(`${head} `));
  assert.ok(start >= 0, `${header} が見つかりません`);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || /^\s*#/.test(l)) { out.push(l); continue; }
    const depth = l.match(/^ */)[0].length;
    if (depth <= indent) break;
    out.push(l);
  }
  return out.join("\n");
}

const listOf = (block, key) => {
  const m = block.match(new RegExp(`^\\s*${key}:\\s*\\[(.*?)\\]\\s*$`, "m"));
  assert.ok(m, `${key}: [...] が見つかりません`);
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
};

const rates = read("rates.yml");
const onBlock = blockOf(rates, "on:", 0);

test("workflow_run：上流は Intraday Snapshot と Daily FX Data で、各ワークフローの name: と一致する", () => {
  const wr = blockOf(onBlock, "workflow_run:", 2);
  const upstream = listOf(wr, "workflows");
  assert.deepEqual([...upstream].sort(), ["Daily FX Data", "Intraday Snapshot"]);
  assert.equal(topName(read("intraday.yml")), "Intraday Snapshot");
  assert.equal(topName(read("daily.yml")), "Daily FX Data");
  for (const name of upstream) {
    assert.ok([topName(read("intraday.yml")), topName(read("daily.yml"))].includes(name), `${name} に対応するワークフローがありません`);
  }
});

test("workflow_run：完了のたび（types: completed）で、main だけ。自分自身（JP-US 2Y Rates）は上流に入れない", () => {
  const wr = blockOf(onBlock, "workflow_run:", 2);
  assert.deepEqual(listOf(wr, "types"), ["completed"]);
  assert.deepEqual(listOf(wr, "branches"), ["main"]);
  assert.ok(!listOf(wr, "workflows").includes(topName(rates)), "自分自身の完了で起動すると無限に続きます");
});

test("schedule と workflow_dispatch（if_stale）は残っている", () => {
  const schedule = blockOf(onBlock, "schedule:", 2);
  assert.match(schedule, /- cron: "40,55 0 \* \* 1-5"/);
  assert.match(schedule, /- cron: "\*\/15 1-4 \* \* 1-5"/);
  const dispatch = blockOf(onBlock, "workflow_dispatch:", 2);
  const inputBlock = blockOf(dispatch, "if_stale:", 6);
  assert.match(inputBlock, /type: boolean/);
  assert.match(inputBlock, /default: false/);
});

test("concurrency は rates-data のまま、実行中の run を取り消さない", () => {
  const c = blockOf(rates, "concurrency:", 0);
  assert.match(c, /group: rates-data\s*$/m);
  assert.match(c, /cancel-in-progress: false\s*$/m);
});

test("取得の式：手動実行（if_stale オフ）以外は、すべて --if-stale になる", () => {
  const m = rates.match(/run: node rates\/run-daily\.js \$\{\{ (.+?) \}\}\s*$/m);
  assert.ok(m, "Fetch JP-US 2Y rates の式が見つかりません");
  // GitHub の式の && と || と != は、ここで使う範囲では JavaScript と同じ意味（空文字列・null・false は偽）
  const evaluate = (eventName, ifStale) =>
    new Function("github", "inputs", `return (${m[1]});`)({ event_name: eventName }, ifStale === undefined ? {} : { if_stale: ifStale });
  assert.equal(evaluate("schedule"), "--if-stale");
  assert.equal(evaluate("workflow_run"), "--if-stale");
  assert.equal(evaluate("workflow_dispatch", true), "--if-stale");
  assert.equal(evaluate("workflow_dispatch", false), "");
  assert.equal(evaluate("workflow_call"), "--if-stale", "将来足すイベントでも、毎回の全取得にならない");
});

test("checkout は ref を明示して、待たされた run でも最新のブランチを読む", () => {
  const checkout = blockOf(rates, "- name: Checkout", 6);
  assert.match(checkout, /uses: actions\/checkout@v4/);
  assert.match(checkout, /ref: \$\{\{ github\.ref \}\}/);
});

test("rates.yml がコミットするのは data/rates.json だけ（gpt-feed.* は daily.yml と intraday.yml だけが書く）", () => {
  const adds = rates.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("git add "));
  assert.deepEqual(adds, ["git add data/rates.json"]);
});
