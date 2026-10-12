"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClient, createMemoryClient, GithubError } = require("../notify/github");
const { main } = require("../../daytrade-notify");
const D = require("../notify/detect");
const J = require("../jst");
const { plan: basePlan, intraday, iso } = require("./notify-fixture");
// 設計①②が済んだ16時台の計画（設計の窓の異常が出ない状態）
const plan = (mut) => basePlan((q) => { q.designs = [{ slot: 1, generated_at: "2026-10-08T06:10:00+09:00", inputs_ok: true }, { slot: 2, generated_at: "2026-10-08T15:30:00+09:00", inputs_ok: true }]; if (mut) mut(q); });

const TOKEN = "ghs_SECRET_TOKEN_123";
const REPO = "MFlab-inc/FXDaily-Levels";
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")) });
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => { const c = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined }; calls.push(c); return handler(c, calls.length); };
  f.calls = calls;
  return f;
}
const mk = (handler, o = {}) => { const f = fakeFetch(handler); return { f, client: createClient({ token: TOKEN, repo: REPO, fetchImpl: f, sleep: async () => {}, ...o }) }; };

test("REST: Issue の一覧・作成・コメント・クローズ・ラベル。ヘッダはトークンだけを持ち、権限は issues のみ", async () => {
  const issues = [{ number: 5, title: "デイトレ 2026-10-08（木）", state: "open", body: "b", comments: 2, html_url: "u", created_at: "t" }, { number: 4, title: "PR", state: "open", pull_request: {}, body: "x" }];
  const { f, client } = mk((c) => {
    if (c.method === "GET" && c.url.includes("/issues?labels=")) return res(200, issues);
    if (c.method === "POST" && c.url.endsWith("/issues")) return res(201, { number: 6, title: c.body.title, state: "open", body: c.body.body });
    if (c.method === "GET" && c.url.includes("/issues/5/comments")) return res(200, [{ id: 1, body: "c1", created_at: "t" }]);
    if (c.method === "POST" && c.url.endsWith("/issues/5/comments")) return res(201, { id: 2, body: c.body.body, created_at: "t" });
    if (c.method === "PATCH") return res(200, {});
    if (c.url.includes("/labels/daytrade")) return res(404, { message: "Not Found" });
    if (c.method === "POST" && c.url.endsWith("/labels")) return res(201, {});
    return res(500, "?");
  });
  const list = await client.findIssues({ label: "daytrade" });
  assert.deepEqual(list.map((i) => i.number), [5]); // PR は除く
  assert.equal(f.calls[0].url, `https://api.github.com/repos/${REPO}/issues?labels=daytrade&state=all&sort=created&direction=desc&per_page=100&page=1`);
  const made = await client.createIssue({ title: "T", body: "B", labels: ["daytrade"] });
  assert.equal(made.number, 6);
  assert.deepEqual(f.calls[1].body, { title: "T", body: "B", labels: ["daytrade"] });
  assert.deepEqual((await client.listComments(5)).map((c) => c.id), [1]);
  assert.equal((await client.addComment(5, "hello")).id, 2);
  assert.deepEqual(f.calls.at(-1).body, { body: "hello" });
  await client.closeIssue(5);
  const patch = f.calls.at(-1);
  assert.equal(patch.method, "PATCH"); assert.ok(patch.url.endsWith("/issues/5")); assert.deepEqual(patch.body, { state: "closed", state_reason: "completed" });
  await client.ensureLabel("daytrade", "0e8a16", "d"); // 無ければ作る
  assert.equal(f.calls.at(-1).method, "POST"); assert.ok(f.calls.at(-1).url.endsWith("/labels"));
  for (const c of f.calls) {
    assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(c.headers.Accept, "application/vnd.github+json");
    assert.ok(c.url.startsWith(`https://api.github.com/repos/${REPO}/`));
  }
});

test("REST: 100件ごとにページを送る。コメントは最大10ページ", async () => {
  const page = (n, count) => Array.from({ length: count }, (_, i) => ({ number: n * 1000 + i, title: `t${n}-${i}`, state: "open", body: "" }));
  const { f, client } = mk((c) => (c.url.endsWith("page=1") ? res(200, page(1, 100)) : c.url.endsWith("page=2") ? res(200, page(2, 100)) : res(200, page(3, 7))));
  assert.equal((await client.findIssues({ label: "daytrade" })).length, 207);
  assert.equal(f.calls.length, 3);
  const { f: f2, client: c2 } = mk((c) => res(200, Array.from({ length: 100 }, (_, i) => ({ id: i, body: "" }))));
  assert.equal((await c2.listComments(1)).length, 1000);
  assert.equal(f2.calls.length, 10);
});

test("REST: 5xx・429・接続エラーは待ってやり直す（最大2回）。認証・権限・入力のエラーはやり直さない。エラー文にトークンを出さない", async () => {
  let n = 0;
  const waits = [];
  const { f, client } = mk(() => (++n < 3 ? res(502, "bad gateway") : res(200, [])), { sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await client.findIssues({ label: "x" }), []);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(waits, [2000, 4000]);
  const bad = mk(() => res(403, `forbidden ${TOKEN}`));
  await assert.rejects(bad.client.findIssues({ label: "x" }), (e) => { assert.ok(e instanceof GithubError); assert.equal(e.status, 403); assert.ok(!e.message.includes(TOKEN)); assert.match(e.message, /HTTP 403/); return true; });
  assert.equal(bad.f.calls.length, 1);
  const down = mk(() => { throw new Error(`connect ECONNRESET ${TOKEN}`); });
  await assert.rejects(down.client.findIssues({ label: "x" }), (e) => { assert.equal(down.f.calls.length, 3); return e.status === 0; });
  const rl = mk(() => res(429, "slow down"));
  await assert.rejects(rl.client.findIssues({ label: "x" }), /HTTP 429/);
  assert.equal(rl.f.calls.length, 3);
});

test("REST: トークンやリポジトリ名が無ければ作らない（接続しない）", () => {
  assert.throws(() => createClient({ token: "", repo: REPO, fetchImpl: () => assert.fail("接続しない") }), /GITHUB_TOKEN/);
  assert.throws(() => createClient({ token: TOKEN, repo: "no-slash", fetchImpl: () => assert.fail("接続しない") }), /GITHUB_REPOSITORY/);
});

test("メモリ上の Issue: 本物と同じ形で動き、呼び出しを記録する（dry-run・試験用）", async () => {
  const m = createMemoryClient();
  const i = await m.createIssue({ title: "T", body: "B", labels: ["daytrade"] });
  await m.addComment(i.number, "c");
  assert.deepEqual((await m.findIssues({ label: "daytrade" })).map((x) => [x.number, x.comments]), [[1, 1]]);
  assert.deepEqual(await m.findIssues({ label: "other" }), []);
  await m.closeIssue(1);
  assert.equal(m.state().issues[0].state, "closed");
  assert.deepEqual(m.ops.map((o) => o.op), ["create_issue", "comment", "close"]);
  const again = createMemoryClient(m.state());
  assert.equal((await again.createIssue({ title: "T2", body: "", labels: ["daytrade"] })).number, 2);
  await assert.rejects(again.addComment(99, "x"), /#99/);
});

// ---- CLI ----
function dataDirWith(planObj, nowMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-cli-"));
  fs.mkdirSync(path.join(dir, "daytrade"), { recursive: true });
  fs.writeFileSync(path.join(dir, "daytrade-plan.json"), JSON.stringify(planObj));
  fs.writeFileSync(path.join(dir, "intraday.json"), JSON.stringify(intraday(nowMs, { EURUSD: 1.1041 })));
  for (const n of ["h1-bars.json", "daytrade-context.json"]) fs.writeFileSync(path.join(dir, n), JSON.stringify({ as_of: J.jstIso(nowMs - 120000), pairs: {} }));
  return dir;
}
const out = () => { const lines = []; return { lines, io: { log: (m) => lines.push(String(m)) } }; };

test("CLI --dry-run: GitHub に接続せず（トークンが無くても動く）、Issue を作らず、書く予定の本文を出す。マーカーは出力から除く", async () => {
  const nowMs = iso("2026-10-08T16:35:00+09:00");
  const dir = dataDirWith(plan(), nowMs);
  try {
    const o = out();
    const r = await main(["--dry-run", `--data-dir=${dir}`, "--now=2026-10-08T16:35:00+09:00"], {}, o.io, {
      createClient: () => assert.fail("dry-run では本物のクライアントを作らない"), fetchImpl: () => assert.fail("dry-run では接続しない"),
    });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.ops.map((x) => x.op), ["create_issue", "comment"]); // Issue（4案は本文に）＋帯に入ったEURUSD
    const text = o.lines.join("\n");
    assert.match(text, /=== \[dry-run\] Issue を作る（ラベル daytrade）: デイトレ 2026-10-08（木） ===/);
    assert.match(text, /EURUSD 売り：帯に到達（現在値 1\.10410）/);
    assert.match(text, /Issue は作っていません/);
    assert.ok(!/daytrade-notify key=/.test(text));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI --dry-run --state/--save-state: 続きの状態を引き継げる（同じ通知を二重に出さない）", async () => {
  const nowMs = iso("2026-10-08T16:35:00+09:00");
  const dir = dataDirWith(plan(), nowMs);
  const st = path.join(dir, "state.json");
  try {
    const base = ["--dry-run", `--data-dir=${dir}`, `--state=${st}`, `--save-state=${st}`];
    const r1 = await main([...base, "--now=2026-10-08T16:35:00+09:00"], {}, out().io);
    assert.ok(r1.ops.length >= 1);
    const r2 = await main([...base, "--now=2026-10-08T16:50:00+09:00"], {}, out().io);
    assert.deepEqual(r2.ops, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI 本番: トークンと GITHUB_REPOSITORY を環境変数から読み、REST で書く。失敗は警告の行にして、結果の errors に入れる", async () => {
  const nowMs = iso("2026-10-08T16:35:00+09:00");
  const dir = dataDirWith(plan(), nowMs);
  try {
    const calls = [];
    const f = fakeFetch((c) => { calls.push(c); if (c.method === "GET" && c.url.includes("/issues?labels=")) return res(200, []); if (c.url.includes("/labels")) return res(200, {}); if (c.method === "POST" && c.url.endsWith("/issues")) return res(403, "denied"); return res(200, {}); });
    const o = out();
    const r = await main([`--data-dir=${dir}`, "--now=2026-10-08T16:35:00+09:00"], { GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO }, o.io, { fetchImpl: f });
    assert.equal(f.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(f.calls[0].url.includes(`/repos/${REPO}/`));
    assert.equal(r.errors.length, 1);
    assert.match(o.lines.join("\n"), /::warning::daytrade-notify: 今日の計画: POST \/issues: HTTP 403/);
    assert.ok(!o.lines.join("\n").includes(TOKEN));
    // トークンが無ければ例外（ワークフローでは continue-on-error）
    await assert.rejects(main([`--data-dir=${dir}`], { GITHUB_REPOSITORY: REPO }, out().io), /GITHUB_TOKEN/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI --failure: 失敗の通知だけを出す（実行 URL を添える）", async () => {
  const nowMs = iso("2026-10-08T10:20:00+09:00");
  const dir = dataDirWith(plan(), nowMs);
  try {
    const o = out();
    const r = await main(["--dry-run", "--failure", "--run-url=https://github.com/o/r/actions/runs/7", `--data-dir=${dir}`, "--now=2026-10-08T10:20:00+09:00"], {}, o.io);
    assert.deepEqual(r.ops.map((x) => x.op), ["create_issue", "comment"]);
    assert.match(o.lines.join("\n"), /Daytrade Plan が失敗しました[\s\S]*実行: https:\/\/github\.com\/o\/r\/actions\/runs\/7/);
    assert.equal(r.ops.filter((x) => x.op === "comment").length, 1); // コメントは失敗の通知だけ（新しい案・帯の通知は出さない）
    assert.ok(D.LABEL === "daytrade");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
