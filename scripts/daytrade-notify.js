"use strict";
/**
 * デイトレプランの通知（GitHub Issue）。daytrade.yml の各実行の最後に動かす。ファイルは読むだけで、書くのは Issue だけ（コミットしない）。
 *   node scripts/daytrade-notify.js [--now=<ISO>] [--data-dir=<dir>]
 *   --dry-run             Issue を作らない・書かない。GitHub に接続せず、メモリ上の Issue に対して『書く予定の本文』を標準出力へ出す
 *   --state=<file>        （dry-run）メモリ上の Issue の初期状態（JSON）。--save-state=<file> で終了時の状態を保存（続きの試験用）
 *   --failure             ワークフローの失敗の通知だけを出す（失敗した手順から呼ぶ）。--run-url=<URL> を本文に付ける
 * 環境変数: GITHUB_TOKEN（ワークフローの github.token。権限は issues: write）、GITHUB_REPOSITORY（owner/repo）、GITHUB_SERVER_URL
 * 通知の中身と重複防止の仕組みは scripts/daytrade/notify/detect.js、文面は format.js。口座の資金は読まない・書かない（Issue は公開される）。
 */
const fs = require("fs");
const path = require("path");
const { parseArgs, dataDir: defaultDataDir } = require("./daytrade/cli");
const { parseIso, jstIso } = require("./daytrade/jst");
const { createClient, createMemoryClient } = require("./daytrade/notify/github");
const { runNotify } = require("./daytrade/notify/run");

const stripMarkers = (s) => String(s).replace(/\n*<!-- daytrade-notify key=.*? -->/g, "");

async function main(argv = process.argv.slice(2), env = process.env, io = { log: console.log }, deps = {}) {
  const args = parseArgs(argv);
  const nowMs = args.now ? parseIso(args.now) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`--now が読めません: ${args.now}`);
  const dataDir = args["data-dir"] ? path.resolve(args["data-dir"]) : defaultDataDir;
  const dry = Boolean(args["dry-run"]);
  const repoUrl = env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}` : null;
  let client;
  if (dry) {
    const seed = args.state && fs.existsSync(args.state) ? JSON.parse(fs.readFileSync(args.state, "utf8")) : null;
    client = createMemoryClient(seed);
  } else {
    client = (deps.createClient || createClient)({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, fetchImpl: deps.fetchImpl || globalThis.fetch, log: io.log });
  }
  const failure = args.failure ? { run_url: typeof args["run-url"] === "string" ? args["run-url"] : null } : null;
  const r = await runNotify({ dataDir, nowMs, client, failure, repoUrl, log: io.log });
  if (dry) {
    for (const op of client.ops) {
      if (op.op === "create_issue") io.log(`\n=== [dry-run] Issue を作る（ラベル ${op.labels.join(",")}）: ${op.title} ===\n${stripMarkers(op.body)}`);
      else if (op.op === "comment") io.log(`\n=== [dry-run] コメントを書く → ${op.title} ===\n${stripMarkers(op.body)}`);
      else if (op.op === "close") io.log(`\n=== [dry-run] Issue を閉じる → ${op.title} ===`);
    }
    if (args["save-state"]) fs.writeFileSync(args["save-state"], JSON.stringify(client.state(), null, 2));
    io.log(`\n[notify] dry-run（${jstIso(nowMs)}）: 操作 ${client.ops.length}件。Issue は作っていません`);
  } else {
    io.log(`[notify] ${jstIso(nowMs)} 完了${r.errors.length ? `（失敗 ${r.errors.length}件）` : ""}`);
  }
  for (const e of r.errors) io.log(`::warning::daytrade-notify: ${e}`);
  return { ...r, ops: client.ops || null };
}

if (require.main === module) {
  main().then((r) => { if (r.errors.length) process.exit(1); }).catch((e) => { console.error(`::warning::daytrade-notify: ${String(e.message || e).slice(0, 300)}`); process.exit(1); });
}
module.exports = { main, stripMarkers };
