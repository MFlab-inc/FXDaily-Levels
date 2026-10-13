"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const YML = read(".github/workflows/intraday.yml");
const code = (y) => y.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n"); // コメント行を除く
const CODE = code(YML);
const step = (name) => { const i = CODE.indexOf(`- name: ${name}`); assert.ok(i >= 0, name); const j = CODE.indexOf("\n      - name:", i + 1); return CODE.slice(i, j < 0 ? undefined : j); };

test("intraday.yml: concurrency で Intraday Snapshot を同時に2本動かさない（後から来た方は待つ。走っている run は止めない）", () => {
  assert.match(CODE, /^concurrency:\n  group: intraday-snapshot\n  cancel-in-progress: false$/m);
  // トップレベル（job の中ではない）
  const top = CODE.slice(0, CODE.indexOf("\njobs:"));
  assert.match(top, /\nconcurrency:\n/);
  // schedule・workflow_dispatch・workflow_run のどれから起動しても同じグループ（イベント名などで分けていない）
  assert.ok(!/group:.*\$\{\{/.test(CODE));
  // daytrade.yml（Daytrade Plan）は別のグループ。Intraday Snapshot の完了を待つ側なので、同じグループにしない
  assert.match(read(".github/workflows/daytrade.yml"), /group: daytrade-plan/);
  assert.ok(!read(".github/workflows/daytrade.yml").includes("intraday-snapshot"));
});

test("intraday.yml: 待たされた run が詰まらないよう、job に timeout-minutes がある（通常30秒前後、直近1週間の最大 64秒）", () => {
  const job = CODE.slice(CODE.indexOf("\njobs:"));
  assert.match(job, /\n    timeout-minutes: 10\n/);
});

test("intraday.yml: 起動元（schedule の2本・workflow_dispatch・workflow_run）と job の if は今までどおり", () => {
  assert.match(CODE, /- cron: "2,17,32,47 \* \* \* 1-5"/);
  assert.match(CODE, /- cron: "2,17,32,47 21-23 \* \* 0"/);
  assert.match(CODE, /workflow_run:\n    workflows: \["Daily FX Data"\]\n    types: \[completed\]/);
  assert.match(CODE, /if: github\.event_name != 'workflow_run' \|\| github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(CODE, /^name: Intraday Snapshot$/m); // daytrade.yml・rates.yml が workflow_run で名前を参照している
  assert.match(CODE, /permissions:\n  contents: write/);
});

test("intraday.yml: 手動実行の入力 force は任意（既定オフ）。外部cronの本文 {\"ref\":\"main\"}（inputs なし）のまま起動できる", () => {
  const dispatch = CODE.slice(CODE.indexOf("  workflow_dispatch:"), CODE.indexOf("  workflow_run:"));
  assert.match(dispatch, /inputs:\n      force:\n/);
  assert.match(dispatch, /type: boolean\n        default: false/);
  assert.ok(!/required: true/.test(dispatch));
  assert.deepEqual([...dispatch.matchAll(/^      (\w+):$/gm)].map((m) => m[1]), ["force"]); // 入力は force だけ
});

test("intraday.yml: intraday.js・daytrade.js は force のときだけ --force を付ける。スキップ（終了コード0）で後続の手順が止まらない作り", () => {
  const expr = "${{ inputs.force && '--force' || '' }}";
  assert.ok(step("Fetch intraday quotes").includes(`run: node intraday.js ${expr}`));
  assert.ok(step("Build daytrade context").includes(`run: node daytrade.js ${expr}`));
  // 手順の並びと条件は今までどおり: intraday → daytrade（!cancelled()）→ GPT feed → コミット
  const names = [...CODE.matchAll(/- name: (.+)/g)].map((m) => m[1]);
  assert.deepEqual(names, ["Checkout", "Setup Node.js", "Fetch intraday quotes", "Build daytrade context", "Build GPT feed", "Commit and push data"]);
  assert.match(step("Build daytrade context"), /if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(step("Commit and push data"), /if: \$\{\{ !cancelled\(\) \}\}/);
  // スキップした run が『変更なし』でも失敗しない（コミット手順は差分が無ければ 0 で終わる）
  assert.match(step("Commit and push data"), /git diff --cached --quiet && echo "変更なし" && exit 0/);
});

test("スクリプト: 両方が lib/recent-fetch.js を使い、スキップは --force で無効にできる。スキップの経路に process.exit(非0) が無い", () => {
  for (const f of ["intraday.js", "daytrade.js"]) {
    const src = read(f);
    assert.match(src, /require\("\.\/lib\/recent-fetch"\)/);
    assert.match(src, /process\.argv\.includes\("--force"\)/);
    const block = src.slice(src.indexOf('process.argv.includes("--force")'), src.indexOf("return;", src.indexOf('process.argv.includes("--force")')) + 7);
    assert.ok(!/process\.exit\(/.test(block), `${f}: スキップの経路は return（終了コード 0）`);
  }
});

test("main() は、スキップの判定を最初の await（＝最初の取得）より前に済ませる（判定を迂回する経路が無い）", () => {
  for (const f of ["intraday.js", "daytrade.js"]) {
    const src = read(f);
    assert.equal((src.match(/async function main\(/g) || []).length, 1);
    const body = src.slice(src.indexOf("async function main("));
    const check = body.indexOf('process.argv.includes("--force")');
    const firstAwait = body.indexOf("await ");
    assert.ok(check > 0 && firstAwait > check, `${f}: 判定（${check}）は最初の await（${firstAwait}）より前`);
  }
});

test("Checkout は ref を明示する（待たされた run が、起動時点の古いコミットではなく、始まった時点の最新を取得する）", () => {
  const co = step("Checkout");
  assert.match(co, /uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.repository\.default_branch \|\| github\.ref \}\}/);
  // daytrade.yml（workflow_run で最新の main を使う）と同じ書き方
  assert.ok(read(".github/workflows/daytrade.yml").includes("ref: ${{ github.event_name == 'workflow_run' && github.event.repository.default_branch || github.ref }}"));
  // fetch-depth などで ref を打ち消していない・Checkout が最初の手順
  assert.equal([...CODE.matchAll(/- name: (.+)/g)][0][1], "Checkout");
  assert.ok(!/ref: \$\{\{ github\.sha \}\}/.test(CODE));
});

// on.<event>.paths の一覧（イベントごと）
function pathsOf(yml, event) {
  const lines = yml.split("\n");
  const i = lines.findIndex((l) => l === `  ${event}:`);
  assert.ok(i >= 0, event);
  const out = [];
  let inPaths = false;
  for (let k = i + 1; k < lines.length && (lines[k].startsWith("    ") || lines[k] === ""); k++) {
    if (/^    paths:\s*$/.test(lines[k])) { inPaths = true; continue; }
    if (inPaths) { const m = /^      - "(.+)"\s*$/.exec(lines[k]); if (m) out.push(m[1]); else break; }
  }
  return out;
}

test("CI: この試験を動かす workflow があり、外部へは接続せず secrets も使わない。試験が読むファイルを変える PR・push のどちらでも動く（paths を event ごとに確かめる）", () => {
  const ci = read(".github/workflows/intraday-tests.yml");
  assert.match(ci, /node --test lib\/test\/\*\.test\.js/);
  assert.ok(!/secrets\./.test(ci));
  assert.match(ci, /contents: read/);
  // 試験が読む（または複製して動かす）ファイル。どれかを変える PR で試験が動くこと
  const need = ["intraday.js", "daytrade.js", "lib/**", "config/daytrade-rules.json", ".github/workflows/intraday.yml", ".github/workflows/daytrade.yml", ".github/workflows/intraday-tests.yml"];
  for (const ev of ["pull_request", "push"]) assert.deepEqual(need.filter((p) => !pathsOf(ci, ev).includes(p)), [], `${ev} の paths`);
  assert.match(ci, /on:\n  pull_request:\n/);
  assert.match(ci, /  push:\n    branches: \[main\]\n/);
  // 構文の誤りは文字列検査では見つからないので、YAML として読み込む手順がある
  assert.match(ci, /ruby -ryaml -e [^\n]*YAML\.load_file[\s\S]*\.github\/workflows\/intraday\.yml/);
});

// YAML を読んだあとの run（ruby で JSON にする。ruby が無い環境では飛ばす。CI の ubuntu-latest には入っている）。
// 1行の `run: ... "ok #{f}"` のように ` #` を含めると、YAML ではそこから先がコメントになり、コマンドが途切れる（YAML としては正しいので、構文検査では見つからない）
const rubyYaml = (f) => {
  const r = spawnSync("ruby", ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV[0]))", path.join(ROOT, f)], { encoding: "utf8" });
  return r.error || r.status !== 0 ? null : JSON.parse(r.stdout);
};

test("CI: YAML 構文検査の手順のコマンドが、YAML のコメントで途切れていない（読み込んだあとの run が bash の構文として正しく、3つの workflow すべてを対象にしている）", { skip: spawnSync("ruby", ["-v"]).error ? "ruby が無い" : false }, () => {
  const doc = rubyYaml(".github/workflows/intraday-tests.yml");
  assert.ok(doc, "ruby で読めない");
  const steps = doc.jobs.test.steps.filter((s) => s.run);
  assert.ok(steps.length >= 2);
  for (const s of steps) {
    const r = spawnSync("bash", ["-n"], { input: s.run, encoding: "utf8" });
    assert.equal(r.status, 0, `${s.name}: ${r.stderr}`);
  }
  const lint = steps.find((s) => s.name === "Check workflow YAML syntax");
  assert.ok(lint);
  for (const f of ["intraday.yml", "intraday-tests.yml", "daytrade.yml"]) assert.ok(lint.run.includes(`.github/workflows/${f}`), f);
  // ruby の -e の引用符が閉じている（途切れていれば、読み込みの対象のファイル名が引数に残らない）
  assert.ok((lint.run.match(/'/g) || []).length % 2 === 0);
});
