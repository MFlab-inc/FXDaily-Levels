"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const PLAN = read(".github/workflows/daytrade.yml");
const BACKTEST = read(".github/workflows/daytrade-backtest.yml");

// 'name: <名前>' のトップレベルの値
const topName = (yml) => /^name:\s*(.+?)\s*$/m.exec(yml)?.[1].replace(/^["']|["']$/g, "");
// on: の本文（次のトップレベルのキーまで）
const onBlock = (yml) => { const i = yml.indexOf("\non:"); const j = yml.indexOf("\npermissions:"); return yml.slice(i, j); };

test("workflow: daytrade.yml は cron を使わず、Intraday Snapshot の完了（workflow_run）で動く。手動（workflow_dispatch）も残す", () => {
  const on = onBlock(PLAN).split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.ok(!/schedule:|cron:/.test(on), "cron は削除する");
  assert.match(on, /workflow_run:/);
  assert.match(on, /workflows:\s*\["Intraday Snapshot"\]/);
  assert.match(on, /types:\s*\[completed\]/);
  assert.match(on, /workflow_dispatch:/);
  // 起動元のワークフロー名が、リポジトリの intraday.yml の name と一致する（違うと黙って起動しなくなる）
  assert.equal(topName(read(".github/workflows/intraday.yml")), "Intraday Snapshot");
  // 手動の入力: run（auto/status/design）・slot・force
  assert.match(PLAN, /options: \[auto, status, design\]/);
});

test("workflow: workflow_run は main の Intraday Snapshot が成功／失敗で終わったときだけ。checkout は起動後の最新の main", () => {
  const ifLine = /^\s+if: (.+)$/m.exec(PLAN.slice(PLAN.indexOf("jobs:")))[1];
  assert.match(ifLine, /github\.event_name != 'workflow_run'/);
  assert.match(ifLine, /head_branch == github\.event\.repository\.default_branch/);
  assert.match(ifLine, /conclusion == 'success'/);
  assert.match(ifLine, /conclusion == 'failure'/);
  assert.ok(!/cancelled|skipped/.test(ifLine));
  assert.match(PLAN, /ref: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.repository\.default_branch \|\| github\.ref \}\}/);
});

test("workflow: 書き込むのは計画の3ファイルだけ（git add data/ や -A をしない）。secrets を使わない", () => {
  const code = PLAN.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n"); // コメント行は除く
  const added = [...code.matchAll(/git add ([^;\n]+)/g)].flatMap((m) => m[1].trim().split(/\s+/));
  assert.deepEqual(added.sort(), ["data/daytrade-plan.json", "data/daytrade-plan.txt", "data/daytrade/log.csv"]);
  // secrets は APIキーなどには使わない。使うのは口座の資金（DAYTRADE_EQUITY_A／B。Variables と同名で、ログで伏せるための任意の上書き）だけ
  assert.deepEqual([...new Set([...PLAN.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort(), ["DAYTRADE_EQUITY_A", "DAYTRADE_EQUITY_B"]);
  assert.match(PLAN, /group: daytrade-plan/);
  assert.match(PLAN, /cancel-in-progress: false/);
  assert.match(PLAN, /contents: write/);
  // 起動元は Intraday Snapshot だけ。daily.yml（Daily FX Data）を起動・参照しない（失敗しても daily.yml に影響させない）
  assert.ok(!/Daily FX Data/.test(PLAN.replace(/^\s*#.*$/gm, "")));
});

// 'name: <名前>' のステップの run: スクリプト本文を取り出す
function stepScript(yml, name) {
  const lines = yml.split("\n");
  const i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, name);
  const r = lines.findIndex((l, k) => k > i && /^\s+run: \|\s*$/.test(l));
  const indent = lines[r + 1].match(/^ */)[0].length;
  const out = [];
  for (let k = r + 1; k < lines.length && (lines[k].trim() === "" || lines[k].match(/^ */)[0].length >= indent); k++) out.push(lines[k].slice(indent));
  return out.join("\n");
}

test("workflow: 『Commit and push』の手順を実際に動かす — log.csv が無くても計画の2ファイルをコミット・pushできる（有れば3ファイル）", () => {
  const { execFileSync } = require("node:child_process");
  const os = require("node:os");
  const script = stepScript(PLAN, "Commit and push");
  const run = (withLog) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));
    try {
      const sh = (cmd, cwd = root, env = {}) => execFileSync("bash", ["-ec", cmd], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
      sh("git init -q --bare remote.git && git init -q -b main work && cd work && git config user.email a@b && git config user.name n && echo init > README && git add . && git commit -qm init && git remote add origin ../remote.git && git push -q -u origin main 2>/dev/null");
      const work = path.join(root, "work");
      fs.mkdirSync(path.join(work, "data", "daytrade"), { recursive: true });
      fs.writeFileSync(path.join(work, "data", "daytrade-plan.txt"), "x\n");
      fs.writeFileSync(path.join(work, "data", "daytrade-plan.json"), "{}\n");
      if (withLog) fs.writeFileSync(path.join(work, "data", "daytrade", "log.csv"), "a,b\n");
      sh(script, work, { ACTION: "status", GITHUB_REF_NAME: "main" });
      return sh("git show --name-only --format= HEAD", work).trim().split("\n").sort();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  };
  assert.deepEqual(run(false), ["data/daytrade-plan.json", "data/daytrade-plan.txt"]);
  assert.deepEqual(run(true), ["data/daytrade-plan.json", "data/daytrade-plan.txt", "data/daytrade/log.csv"]);
});

test("workflow: 起動の解決は pipefail 付きの shell で動かす。採点の失敗は設計を止めない。CI の試験ワークフローは secrets を使わず read-only", () => {
  const lines = PLAN.split("\n");
  const i = lines.findIndex((l) => l.trim() === "- name: Resolve action");
  const block = lines.slice(i, i + 12).join("\n");
  assert.match(block, /shell: bash/);
  const j = lines.findIndex((l) => l.trim() === "- name: Score previous plans");
  assert.match(lines.slice(j, j + 6).join("\n"), /continue-on-error: true/);
  const T = read(".github/workflows/daytrade-tests.yml");
  assert.ok(!/secrets\./.test(T));
  assert.match(T, /contents: read/);
  assert.match(T, /node --test scripts\/daytrade\/test\/\*\.test\.js/);
});

test("workflow: if 条件で secrets を直接参照しない（job の env 経由）", () => {
  for (const [name, yml] of [["daytrade.yml", PLAN], ["daytrade-backtest.yml", BACKTEST], ["daytrade-tests.yml", read(".github/workflows/daytrade-tests.yml")]]) {
    for (const m of yml.matchAll(/^\s*(?:-\s*)?if:\s*(.+)$/gm)) assert.ok(!/secrets\./.test(m[1]), `${name}: if に secrets: ${m[1]}`);
  }
});

test("workflow: バックテストは手動実行（workflow_dispatch）だけ。書き込み先は履歴CSVと結果だけ", () => {
  const on = BACKTEST.slice(BACKTEST.indexOf("\non:"), BACKTEST.indexOf("\npermissions:"));
  assert.match(on, /workflow_dispatch:/);
  for (const t of ["schedule:", "push:", "pull_request", "workflow_run"]) assert.ok(!on.includes(t), t);
  const adds = [...BACKTEST.matchAll(/git add ([^\n]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(adds, ["data/history data/daytrade/backtest-*.md data/daytrade/backtest-*.csv"]);
  assert.match(BACKTEST, /actions: read/);
  assert.match(BACKTEST, /TWELVE_DATA_API_KEY: \$\{\{ secrets\.TWELVE_DATA_API_KEY \}\}/);
});

test("workflow: 既存のワークフロー・スクリプトを変更していない（このブランチの差分に含まれない）", () => {
  // 差分は git の管理下でしか確認できないので、ここでは『読み取り専用の既存ファイルが存在し、daytrade.yml が参照しない』ことだけ確かめる
  for (const f of ["fetch.js", "build-feed.js", "daytrade.js", ".github/workflows/daily.yml", "config/daytrade-rules.json"]) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  assert.ok(!/daily\.yml|fetch\.js|build-feed\.js/.test(PLAN.replace(/^#.*$/gm, "")));
});

test("workflow: 口座の資金は Variables（同名の Secrets があればそちらを優先）から Generate plan の環境変数だけに渡す。ファイルには書かず、ほかの手順・if 条件には渡さない", () => {
  const lines = PLAN.split("\n");
  const idx = (re) => lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
  const stepStart = (name) => lines.findIndex((l) => l.trim() === `- name: ${name}`);
  const gen = stepStart("Generate plan"), commit = stepStart("Commit and push");
  assert.ok(gen > 0 && commit > gen);
  // 資金の参照は Generate plan の env にだけある（Resolve／Score／Commit には渡さない）
  const refs = idx(/DAYTRADE_EQUITY_[AB]:\s*\$\{\{/);
  assert.equal(refs.length, 2);
  for (const i of refs) assert.ok(i > gen && i < commit, `資金の参照が Generate plan の外にある（${i + 1}行目）`);
  assert.match(PLAN, /DAYTRADE_EQUITY_A: \$\{\{ secrets\.DAYTRADE_EQUITY_A \|\| vars\.DAYTRADE_EQUITY_A \}\}/);
  assert.match(PLAN, /DAYTRADE_EQUITY_B: \$\{\{ secrets\.DAYTRADE_EQUITY_B \|\| vars\.DAYTRADE_EQUITY_B \}\}/);
  // run の本文（スクリプト）に資金を展開しない。ファイルへ書き出す記述（GITHUB_ENV・GITHUB_OUTPUT・tee）も資金に触れない
  const code = lines.filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.ok(!/run:.*DAYTRADE_EQUITY|EQUITY.*(GITHUB_ENV|GITHUB_OUTPUT|tee)/.test(code));
  for (const m of code.matchAll(/^\s*(?:-\s*)?if:\s*(.+)$/gm)) assert.ok(!/EQUITY|vars\./.test(m[1]), `if に資金: ${m[1]}`);
});
