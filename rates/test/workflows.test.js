"use strict";

/**
 * rates.yml の起動条件が壊れていないかの確認（外部へは接続しない。YAML の読み込みライブラリは使わず、必要な行だけを読む）。
 *
 * on: workflow_run は、そのファイルが既定ブランチ（main）にあるときだけ効くので、PR の段階では実際に起動して確かめられない。
 * 上流の name: を変えたり、書き間違えたりすると、エラーも出さずに起動しなくなる。そこをここで見張る。
 *
 * 読める書式（試験側の前提）：字下げは2スペース、リストは1行のフロー形式 `key: [a, b]`、cron は `- cron: "…"`、
 * ステップ名は `- name: Checkout` と `- name: Fetch JP-US 2Y rates`。コメント行と行末コメントは読み飛ばし、CRLF も許す。
 * 見ないもの：YAML の文法・字下げの誤り（actionlint などで別に確かめる）、timeout・runs-on・Assert の中身、
 * push の再試行ループ、他のトリガーの追加。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WF_DIR = path.join(__dirname, "..", "..", ".github", "workflows");
const read = (f) => fs.readFileSync(path.join(WF_DIR, f), "utf8");

// 行末のコメントを取り除く（引用符の中の # は残す）
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

// CRLF を LF にし、コメントと空行を取り除いた本文
const clean = (text) => text.replace(/\r\n/g, "\n").split("\n").map(stripComment).filter((l) => l.trim() !== "").join("\n");

const topName = (text) => {
  const m = clean(text).match(/^name:\s*(.+?)\s*$/m);
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
};

// `header` の行（行頭から indent 個の空白 + header）の下で、それより深くインデントされた行
function blockOf(text, header, indent) {
  const lines = text.split("\n");
  const head = `${" ".repeat(indent)}${header}`;
  const start = lines.findIndex((l) => l === head || l.startsWith(`${head} `));
  if (start < 0) throw new Error(`${header} が見つかりません`);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const depth = lines[i].match(/^ */)[0].length;
    if (depth <= indent) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

const listOf = (block, key) => {
  const m = block.match(new RegExp(`^\\s*${key}:\\s*\\[(.*?)\\]\\s*$`, "m"));
  if (!m) throw new Error(`${key}: [a, b] の1行のフロー形式が見つかりません（この試験は1行のフロー形式だけ読めます）`);
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
};

const must = (cond, message) => { if (!cond) throw new Error(message); };

// 取得の式を JavaScript として評価する（GitHub の式の && と || と != は、ここで使う範囲では JavaScript と同じ意味。
// 空文字列・null・false は偽）
const evaluateFetchExpression = (expr, eventName, ifStale) =>
  new Function("github", "inputs", `return (${expr});`)({ event_name: eventName }, ifStale === undefined ? {} : { if_stale: ifStale });

// rates.yml の本文から問題の一覧を返す（空なら問題なし）
function validate(ratesText, intradayText, dailyText) {
  const problems = [];
  const check = (name, fn) => { try { fn(); } catch (e) { problems.push(`${name}：${e.message}`); } };
  const rates = clean(ratesText);
  let onBlock = "";
  check("on:", () => { onBlock = blockOf(rates, "on:", 0); });

  check("workflow_run の上流名", () => {
    const upstream = listOf(blockOf(onBlock, "workflow_run:", 2), "workflows");
    must(JSON.stringify([...upstream].sort()) === JSON.stringify(["Daily FX Data", "Intraday Snapshot"]),
      `上流が Intraday Snapshot と Daily FX Data ではありません: ${upstream}`);
    must(topName(intradayText) === "Intraday Snapshot", "intraday.yml の name: が Intraday Snapshot ではありません");
    must(topName(dailyText) === "Daily FX Data", "daily.yml の name: が Daily FX Data ではありません");
  });
  check("workflow_run の types・branches・自己参照", () => {
    const wr = blockOf(onBlock, "workflow_run:", 2);
    must(JSON.stringify(listOf(wr, "types")) === JSON.stringify(["completed"]), "types が [completed] ではありません");
    must(JSON.stringify(listOf(wr, "branches")) === JSON.stringify(["main"]), "branches が [main] ではありません");
    must(!listOf(wr, "workflows").includes(topName(ratesText)), "自分自身の完了で起動すると無限に続きます");
  });
  check("schedule", () => {
    const schedule = blockOf(onBlock, "schedule:", 2);
    must(/^\s*-\s*cron:\s*["']40,55 0 \* \* 1-5["']\s*$/m.test(schedule), 'cron "40,55 0 * * 1-5" がありません');
    must(/^\s*-\s*cron:\s*["']\*\/15 1-4 \* \* 1-5["']\s*$/m.test(schedule), 'cron "*/15 1-4 * * 1-5" がありません');
  });
  check("workflow_dispatch の if_stale", () => {
    const input = blockOf(blockOf(onBlock, "workflow_dispatch:", 2), "if_stale:", 6);
    must(/^\s*type:\s*boolean\s*$/m.test(input), "if_stale の type が boolean ではありません");
    must(/^\s*default:\s*false\s*$/m.test(input), "if_stale の default が false ではありません");
  });
  check("concurrency", () => {
    const c = blockOf(rates, "concurrency:", 0);
    must(/^\s*group:\s*["']?rates-data["']?\s*$/m.test(c), "group が rates-data ではありません");
    must(/^\s*cancel-in-progress:\s*false\s*$/m.test(c), "cancel-in-progress が false ではありません");
  });
  check("permissions", () => {
    must(/^\s*contents:\s*write\s*$/m.test(blockOf(rates, "permissions:", 0)), "contents: write ではありません");
  });
  check("ジョブ直下に if: が無い", () => {
    must(!/^ {4}if:/m.test(blockOf(rates, "rates:", 2)), "ジョブ直下の if: は、条件しだいで黙って実行をスキップします");
  });
  check("checkout は ref を明示", () => {
    const checkout = blockOf(rates, "- name: Checkout", 6);
    must(/^\s*uses:\s*actions\/checkout@\S+\s*$/m.test(checkout), "actions/checkout を使っていません");
    must(/^\s*ref:\s*["']?\$\{\{\s*github\.ref\s*\}\}["']?\s*$/m.test(checkout), "ref: ${{ github.ref }} がありません");
  });
  check("取得の式", () => {
    const step = blockOf(rates, "- name: Fetch JP-US 2Y rates", 6);
    const m = step.match(/^\s*run:\s*node rates\/run-daily\.js \$\{\{ (.+?) \}\}\s*$/m);
    must(m, "run: node rates/run-daily.js ${{ … }} が見つかりません");
    const cases = [
      ["schedule", undefined, "--if-stale"], ["workflow_run", undefined, "--if-stale"],
      ["workflow_dispatch", true, "--if-stale"], ["workflow_dispatch", false, ""],
      ["workflow_call", undefined, "--if-stale"],   // 将来足すイベントでも、毎回の全取得にならない
    ];
    for (const [ev, ifStale, expected] of cases) {
      const got = evaluateFetchExpression(m[1], ev, ifStale);
      must(got === expected, `${ev}${ifStale === undefined ? "" : `（if_stale=${ifStale}）`} で ${JSON.stringify(got)}（期待 ${JSON.stringify(expected)}）`);
    }
  });
  check("コミットするのは data/rates.json だけ", () => {
    const adds = rates.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("git add "));
    must(JSON.stringify(adds) === JSON.stringify(["git add data/rates.json"]), `git add が ${JSON.stringify(adds)} です`);
  });
  return problems;
}

const RATES = read("rates.yml");
const INTRADAY = read("intraday.yml");
const DAILY = read("daily.yml");

test("rates.yml の起動条件に問題が無い（上流名・types・branches・schedule・dispatch・concurrency・permissions・ref・取得の式・git add）", () => {
  assert.deepEqual(validate(RATES, INTRADAY, DAILY), []);
});

// 改悪を入れると検出される。文字列の置き換えが効いていること（元と同じにならないこと）も確かめる
const MUTATIONS = [
  ["上流名の誤記（Daily FX Datum）", (s) => s.replace('"Daily FX Data"', '"Daily FX Datum"')],
  ["上流から Intraday Snapshot を落とす", (s) => s.replace('workflows: ["Intraday Snapshot", "Daily FX Data"]', 'workflows: ["Daily FX Data"]')],
  ["自分自身を上流に入れる（無限に続く）", (s) => s.replace('"Daily FX Data"]', '"Daily FX Data", "JP-US 2Y Rates"]')],
  ["branches に dev を足す", (s) => s.replace(/^( *)branches: \[main\]$/m, "$1branches: [main, dev]")],
  ["types を requested に", (s) => s.replace(/^( *)types: \[completed\]$/m, "$1types: [requested]")],
  ["式：workflow_run の扱いを外した旧式", (s) => s.replace("(github.event_name != 'workflow_dispatch' || inputs.if_stale)", "(github.event_name == 'schedule' || inputs.if_stale)")],
  ["式：毎回、全取得", (s) => s.replace("(github.event_name != 'workflow_dispatch' || inputs.if_stale) && '--if-stale' || ''", "''")],
  ["式：正しい式をコメントにして、別の式を置く", (s) => s.replace(/^( *)run: (node rates\/run-daily\.js \$\{\{ \(github\.event_name != .*)$/m, "$1# run: $2\n$1run: node rates/run-daily.js ${{ '' }}")],
  ["checkout の ref を消す", (s) => s.replace("        with:\n          ref: ${{ github.ref }}\n", "")],
  ["checkout の ref をコメントにして残す", (s) => s.replace("          ref: ${{ github.ref }}", "          # ref: ${{ github.ref }}")],
  ["checkout の ref を別の式に", (s) => s.replace("ref: ${{ github.ref }}", "ref: ${{ github.sha }}")],
  ["git add data/ にする", (s) => s.replace("git add data/rates.json", "git add data/")],
  ["cancel-in-progress を true に", (s) => s.replace("cancel-in-progress: false", "cancel-in-progress: true")],
  ["concurrency の group を変える", (s) => s.replace("group: rates-data", "group: rates-data-2")],
  ["cron をコメントアウトする", (s) => s.replace('    - cron: "*/15 1-4 * * 1-5"', '    # - cron: "*/15 1-4 * * 1-5"')],
  ["cron を変えて、旧い値を行末コメントに残す", (s) => s.replace('- cron: "40,55 0 * * 1-5"', '- cron: "41,55 0 * * 1-5"  # "40,55 0 * * 1-5"')],
  ["workflow_dispatch の if_stale の既定を true に", (s) => s.replace("default: false", "default: true")],
  ["ジョブ直下に if: を足す（黙ってスキップ）", (s) => s.replace("    runs-on: ubuntu-latest", "    if: ${{ false }}\n    runs-on: ubuntu-latest")],
  ["permissions を read に", (s) => s.replace("contents: write", "contents: read")],
];
for (const [name, mutate] of MUTATIONS) {
  test(`改悪を検出する：${name}`, () => {
    const mutated = mutate(RATES);
    assert.notEqual(mutated, RATES, "置き換えが効いていません（試験側の書き間違い）");
    assert.ok(validate(mutated, INTRADAY, DAILY).length > 0, "検出できていません");
  });
}

// 意味が同じ書き換え（コメント・改行コード・引用符・バージョン）では誤検出しない
const BENIGN = [
  ["行末コメントを足す", (s) => s.replace("workflows: [", "workflows: [").replace(/^(\s*(?:workflows|types|branches): \[.*\])$/gm, "$1  # メモ").replace(/^(name: .*)$/m, "$1  # メモ")],
  ["コメント行を足す", (s) => s.replace("  workflow_run:\n", "  workflow_run:\n    # メモ\n")],
  ["改行コードを CRLF に", (s) => s.replace(/\n/g, "\r\n")],
  ["cron の引用符を単引用符に", (s) => s.replace(/- cron: "([^"]+)"/g, "- cron: '$1'")],
  ["group に引用符を付ける", (s) => s.replace("group: rates-data", 'group: "rates-data"')],
  ["checkout のバージョンを上げる", (s) => s.replace("actions/checkout@v4", "actions/checkout@v5")],
  ["ref に引用符を付ける", (s) => s.replace("ref: ${{ github.ref }}", 'ref: "${{ github.ref }}"')],
];
for (const [name, mutate] of BENIGN) {
  test(`誤検出しない：${name}`, () => {
    const changed = mutate(RATES);
    assert.notEqual(changed, RATES, "置き換えが効いていません（試験側の書き間違い）");
    assert.deepEqual(validate(changed, INTRADAY, DAILY), []);
  });
}
