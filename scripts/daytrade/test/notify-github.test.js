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
const { plan: basePlan, intraday, iso, by } = require("./notify-fixture");
// 設計①②が済んだ16時台の計画（設計の窓の異常が出ない状態）
const plan = (mut) => basePlan((q) => { q.designs = [{ slot: 1, generated_at: "2026-10-08T06:10:00+09:00", inputs_ok: true }, { slot: 2, generated_at: "2026-10-08T15:30:00+09:00", inputs_ok: true }]; if (mut) mut(q); });

const TOKEN = "ghs_SECRET_TOKEN_123";
const REPO = "MFlab-inc/FXDaily-Levels";
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")) });
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => { const c = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal }; calls.push(c); return handler(c, calls.length); };
  f.calls = calls;
  return f;
}
const mk = (handler, o = {}) => { const f = fakeFetch(handler); return { f, client: createClient({ token: TOKEN, repo: REPO, fetchImpl: f, sleep: async () => {}, ...o }) }; };

test("REST: Issue の一覧・作成・コメント・クローズ・ラベル。ヘッダはトークンだけを持ち、権限は issues のみ", async () => {
  const issues = [{ number: 5, title: "デイトレ 2026-10-08（木）", state: "open", body: "b", comments: 2, html_url: "u", created_at: "t", user: { login: "github-actions[bot]", type: "Bot", id: 41898282 } }, { number: 4, title: "PR", state: "open", pull_request: {}, body: "x" }];
  const { f, client } = mk((c) => {
    if (c.method === "GET" && c.url.includes("/issues?labels=")) return res(200, issues);
    if (c.method === "POST" && c.url.endsWith("/issues")) return res(201, { number: 6, title: c.body.title, state: "open", body: c.body.body });
    if (c.method === "GET" && c.url.includes("/issues/5/comments")) return res(200, [{ id: 1, body: "c1", created_at: "t", user: { login: "someone", type: "User" } }]);
    if (c.method === "POST" && c.url.endsWith("/issues/5/comments")) return res(201, { id: 2, body: c.body.body, created_at: "t" });
    if (c.method === "PATCH") return res(200, {});
    if (c.url.includes("/labels/daytrade")) return res(404, { message: "Not Found" });
    if (c.method === "POST" && c.url.endsWith("/labels")) return res(201, {});
    return res(500, "?");
  });
  const list = await client.findIssues({ label: "daytrade" });
  assert.deepEqual(list.map((i) => i.number), [5]); // PR は除く
  assert.equal(list[0].comments, 2); // コメントの件数（マーカーを読むかどうかを決める）
  assert.deepEqual(list[0].user, { login: "github-actions[bot]", type: "Bot" }); // 書いた人（マーカーを信用してよいか）。余計な項目は持たない
  assert.equal(f.calls[0].url, `https://api.github.com/repos/${REPO}/issues?labels=daytrade&state=all&sort=created&direction=desc&per_page=100&page=1`);
  const made = await client.createIssue({ title: "T", body: "B", labels: ["daytrade"] });
  assert.equal(made.number, 6);
  assert.deepEqual(f.calls[1].body, { title: "T", body: "B", labels: ["daytrade"] });
  const cm = await client.listComments(5);
  assert.deepEqual(cm.map((c) => [c.id, c.user.login, c.user.type]), [[1, "someone", "User"]]);
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

test("REST: 100件ごとにページを送る。Issue は最大500件（新しい順なので古い方が落ちるだけ）。コメントは3000件まで、それを超えるなら読み切れないとして例外（読み落として二重に通知しない）", async () => {
  const page = (n, count) => Array.from({ length: count }, (_, i) => ({ number: n * 1000 + i, title: `t${n}-${i}`, state: "open", body: "" }));
  const { f, client } = mk((c) => (c.url.endsWith("page=1") ? res(200, page(1, 100)) : c.url.endsWith("page=2") ? res(200, page(2, 100)) : res(200, page(3, 7))));
  assert.equal((await client.findIssues({ label: "daytrade" })).length, 207);
  assert.equal(f.calls.length, 3);
  const full = mk(() => res(200, Array.from({ length: 100 }, (_, i) => ({ number: i, title: "t", state: "open", body: "" }))));
  assert.equal((await full.client.findIssues({ label: "daytrade" })).length, 500); // 5ページで打ち切り（エラーにしない）
  assert.equal(full.f.calls.length, 5);
  const some = mk((c) => (c.url.endsWith("page=3") ? res(200, Array.from({ length: 50 }, (_, i) => ({ id: i, body: "" }))) : res(200, Array.from({ length: 100 }, (_, i) => ({ id: i, body: "" })))));
  assert.equal((await some.client.listComments(1)).length, 250);
  const over = mk(() => res(200, Array.from({ length: 100 }, (_, i) => ({ id: i, body: "" }))));
  await assert.rejects(over.client.listComments(1), /3000件を超えていて読み切れません/);
  assert.equal(over.f.calls.length, 30);
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

test("REST: 作る操作（POST: Issue・コメント・ラベル）は再送しない（サーバーで作られたあとに応答だけ失敗しても二重に作らない）。状態の変更（PATCH）は再送する", async () => {
  for (const act of [(c) => c.createIssue({ title: "T", body: "B", labels: ["daytrade"] }), (c) => c.addComment(5, "x")]) {
    const a = mk(() => res(502, "bad gateway"));
    await assert.rejects(act(a.client), /HTTP 502/);
    assert.equal(a.f.calls.length, 1);
    assert.equal(a.f.calls[0].method, "POST");
    const b = mk(() => { throw new Error("socket hang up"); });
    await assert.rejects(act(b.client), (e) => e.status === 0);
    assert.equal(b.f.calls.length, 1);
  }
  let n = 0;
  const p = mk(() => (++n < 2 ? res(503, "x") : res(200, {})));
  await p.client.closeIssue(5);
  assert.deepEqual(p.f.calls.map((c) => c.method), ["PATCH", "PATCH"]);
  const lab = mk((c) => (c.method === "GET" ? res(404, "nf") : res(500, "boom")));
  await assert.rejects(lab.client.ensureLabel("daytrade", "0e8a16", "d"), /HTTP 500/);
  assert.deepEqual(lab.f.calls.map((c) => c.method), ["GET", "POST"]);
});

test("REST: どの要求にもタイムアウトの signal を付ける（止まった接続で Notify の手順が居座らない）。タイムアウトも接続エラーとして扱う", async () => {
  const a = mk(() => res(200, []));
  await a.client.findIssues({ label: "x" });
  await a.client.addComment(1, "c").catch(() => {});
  for (const c of a.f.calls) assert.ok(c.signal instanceof AbortSignal, `${c.method} ${c.url}`);
  const t = mk(() => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }, { timeoutMs: 5 });
  await assert.rejects(t.client.findIssues({ label: "x" }), (e) => e.status === 0 && /timeout/.test(e.message));
  assert.equal(t.f.calls.length, 3); // GET はやり直す
  // 実際に fetch が signal で中断される（AbortSignal.timeout のタイマーは unref なので、本物の接続の代わりにタイマーでイベントループを保つ）
  const keep = setInterval(() => {}, 10);
  try {
    const slow = createClient({ token: TOKEN, repo: REPO, timeoutMs: 20, retries: 0, fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason))) });
    await assert.rejects(slow.findIssues({ label: "x" }), (e) => e.status === 0);
  } finally { clearInterval(keep); }
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

// ================= REST のクライアントと runNotify を通した結合（本物と同じ形を返す偽の GitHub） =================
const { spawnSync } = require("child_process");
const BOT_USER = { login: "github-actions[bot]", type: "Bot", id: 41898282, site_admin: false };
function fakeGithub() {
  const issues = []; let nextIssue = 1, nextComment = 1;
  const labels = new Set();
  const posts = [];
  const handler = (c) => {
    const u = new URL(c.url);
    const p = u.pathname.slice(`/repos/${REPO}`.length);
    const page = Number(u.searchParams.get("page") || 1), per = Number(u.searchParams.get("per_page") || 30);
    const slice = (arr) => arr.slice((page - 1) * per, page * per);
    const view = (i) => ({ number: i.number, title: i.title, state: i.state, body: i.body, comments: i.comments.length, html_url: `https://github.com/${REPO}/issues/${i.number}`, created_at: "2026-10-08T00:00:00Z", user: i.user, labels: i.labels.map((name) => ({ name })) });
    if (c.method === "GET" && p === "/issues") { const want = u.searchParams.get("labels"); return res(200, slice(issues.filter((i) => i.labels.includes(want)).map(view).reverse())); }
    if (c.method === "POST" && p === "/issues") { posts.push(["issue", c.body.title]); const i = { number: nextIssue++, title: c.body.title, body: c.body.body, state: "open", labels: c.body.labels || [], comments: [], user: BOT_USER }; issues.push(i); return res(201, view(i)); }
    let m = /^\/issues\/(\d+)\/comments$/.exec(p);
    if (m && c.method === "GET") return res(200, slice(issues.find((i) => i.number === Number(m[1])).comments));
    if (m && c.method === "POST") { posts.push(["comment", c.body.body]); const cm = { id: nextComment++, body: c.body.body, created_at: "2026-10-08T00:00:00Z", user: BOT_USER }; issues.find((i) => i.number === Number(m[1])).comments.push(cm); return res(201, cm); }
    m = /^\/issues\/(\d+)$/.exec(p);
    if (m && c.method === "PATCH") { posts.push(["patch", c.body.state]); issues.find((i) => i.number === Number(m[1])).state = c.body.state; return res(200, {}); }
    if (p.startsWith("/labels")) { if (c.method === "GET") return labels.has("daytrade") ? res(200, {}) : res(404, { message: "Not Found" }); labels.add(c.body.name); return res(201, {}); }
    return res(404, { message: `unhandled ${c.method} ${p}` });
  };
  return { issues, posts, labels, fetchImpl: fakeFetch(handler) };
}
function fileWorld(nowIsoStr, planObj, prices) {
  const nowMs = iso(nowIsoStr);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-e2e-"));
  fs.mkdirSync(path.join(dir, "daytrade"), { recursive: true });
  fs.writeFileSync(path.join(dir, "daytrade-plan.json"), JSON.stringify(planObj));
  fs.writeFileSync(path.join(dir, "intraday.json"), JSON.stringify(intraday(nowMs, prices)));
  for (const n of ["h1-bars.json", "daytrade-context.json"]) fs.writeFileSync(path.join(dir, n), JSON.stringify({ as_of: J.jstIso(nowMs - 120000), pairs: {} }));
  return dir;
}

test("結合: 偽の GitHub に本物の REST クライアントで3回以上流しても、Issue もコメントも増えない（コメントの件数でマーカーを読む仕組みが効いている）", async () => {
  const gh = fakeGithub();
  const env = { GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO };
  const run = (iso_, planObj, prices) => { const dir = fileWorld(iso_, planObj, prices); return main([`--data-dir=${dir}`, `--now=${iso_}`], env, out().io, { fetchImpl: gh.fetchImpl }).finally(() => fs.rmSync(dir, { recursive: true, force: true })); };
  const d1 = { slot: 1, generated_at: "2026-10-08T06:10:00+09:00", inputs_ok: true }, d2 = { slot: 2, generated_at: "2026-10-08T15:30:00+09:00", inputs_ok: true };
  const p1 = plan((q) => { q.designs = [d1]; q.candidates = q.candidates.filter((c) => ["EURUSD", "AUDUSD"].includes(c.symbol)); });
  const p2 = plan((q) => { q.designs = [d1, d2]; });
  // 設計①: Issue を1つ作る（ラベルを用意してから）
  let r = await run("2026-10-08T06:15:00+09:00", p1, { EURUSD: 1.1000 });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(gh.posts.map((x) => x[0]), ["issue"]);
  assert.equal(gh.issues[0].title, "デイトレ 2026-10-08（木）");
  assert.deepEqual(gh.issues[0].labels, ["daytrade"]);
  assert.ok(gh.labels.has("daytrade"));
  // 何度流しても増えない
  for (const t of ["2026-10-08T06:30:00+09:00", "2026-10-08T06:45:00+09:00", "2026-10-08T07:00:00+09:00"]) { await run(t, p1, { EURUSD: 1.1000 }); }
  assert.equal(gh.posts.length, 1);
  // 設計② + 価格が帯に入る → 新しい案のコメントと帯のコメント（2件）
  await run("2026-10-08T16:35:00+09:00", p2, { EURUSD: 1.1041 });
  assert.deepEqual(gh.posts.map((x) => x[0]), ["issue", "comment", "comment"]);
  assert.equal(gh.issues[0].comments.length, 2);
  // 以後、何度流しても増えない（コメントの件数が Issue の一覧から読まれ、マーカーが読まれている）
  for (const t of ["2026-10-08T16:50:00+09:00", "2026-10-08T17:05:00+09:00", "2026-10-08T17:20:00+09:00"]) { r = await run(t, p2, { EURUSD: 1.1041 }); assert.deepEqual(r.errors, []); }
  assert.equal(gh.posts.length, 3);
  // 他の人が偽のマーカーを書いても、読まれない（AUDUSD の帯の通知は出る）
  gh.issues[0].comments.push({ id: 999, body: D.markerOf(D.K.near(D.versionKey(by(p2, "AUDUSD")))), user: { login: "someone", type: "User" } });
  await run("2026-10-08T17:35:00+09:00", p2, { AUDUSD: 0.6559 });
  assert.equal(gh.posts.length, 4);
  assert.match(gh.posts[3][1], /AUDUSD 買い：帯に到達/);
  // 期限後: まとめ → 閉じる。その後は何もしない
  const dirLog = fileWorld("2026-10-09T03:05:00+09:00", p2, {});
  fs.writeFileSync(path.join(dirLog, "daytrade", "log.csv"), require("../log").appendedText("", []));
  await main([`--data-dir=${dirLog}`, "--now=2026-10-09T03:05:00+09:00"], env, out().io, { fetchImpl: gh.fetchImpl });
  assert.deepEqual(gh.posts.slice(4).map((x) => x[0]), ["comment", "patch"]);
  assert.equal(gh.issues[0].state, "closed");
  await main([`--data-dir=${dirLog}`, "--now=2026-10-09T03:20:00+09:00"], env, out().io, { fetchImpl: gh.fetchImpl });
  assert.equal(gh.posts.length, 6);
  fs.rmSync(dirLog, { recursive: true, force: true });
});

test("結合: 偽の GitHub が、書いた直後に応答だけ失敗しても（コメントは作られている）、次の実行は二重に書かない", async () => {
  const gh = fakeGithub();
  const env = { GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO };
  const d1 = { slot: 1, generated_at: "2026-10-08T06:10:00+09:00", inputs_ok: true }, d2 = { slot: 2, generated_at: "2026-10-08T15:30:00+09:00", inputs_ok: true };
  const p1 = plan((q) => { q.designs = [d1]; q.candidates = []; });
  const p2 = plan((q) => { q.designs = [d1, d2]; });
  const d0 = fileWorld("2026-10-08T06:15:00+09:00", p1, {});
  await main([`--data-dir=${d0}`, "--now=2026-10-08T06:15:00+09:00"], env, out().io, { fetchImpl: gh.fetchImpl });
  // コメントの POST は成功するが応答が 502（作られている）
  const lossy = async (url, init) => { const r = await gh.fetchImpl(url, init); return init.method === "POST" && /comments/.test(url) ? res(502, "bad gateway") : r; };
  const d1_ = fileWorld("2026-10-08T15:35:00+09:00", p2, {});
  const r1 = await main([`--data-dir=${d1_}`, "--now=2026-10-08T15:35:00+09:00"], env, out().io, { fetchImpl: lossy });
  assert.equal(r1.errors.length, 1);
  const comments1 = gh.issues[0].comments.length;
  assert.ok(comments1 >= 1);
  assert.equal(gh.posts.filter((x) => x[0] === "comment").length, comments1); // 再送していない（1回の失敗で1件だけ作られた）
  // 次の実行: 作られていたコメントのマーカーを読むので、同じ案を重ねない
  const r2 = await main([`--data-dir=${d1_}`, "--now=2026-10-08T15:50:00+09:00"], env, out().io, { fetchImpl: gh.fetchImpl });
  assert.deepEqual(r2.errors, []);
  assert.equal(gh.issues[0].comments.length, comments1);
  for (const d of [d0, d1_]) fs.rmSync(d, { recursive: true, force: true });
});

test("CLI: 不正な --now は例外。トークンが無ければ警告の行を出して終了コード1。--dry-run は終了コード0で、GITHUB_REPOSITORY があれば plan.txt へのリンクを本文に付ける", () => {
  const dir = fileWorld("2026-10-08T16:35:00+09:00", plan(), { EURUSD: 1.1041 });
  try {
    const script = path.join(__dirname, "..", "..", "daytrade-notify.js");
    const run = (args, env) => spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
    const noToken = run([`--data-dir=${dir}`, "--now=2026-10-08T16:35:00+09:00"], { GITHUB_REPOSITORY: REPO });
    assert.equal(noToken.status, 1);
    assert.match(noToken.stderr, /::warning::daytrade-notify: GITHUB_TOKEN がありません/);
    const badNow = run(["--dry-run", `--data-dir=${dir}`, "--now=garbage"], {});
    assert.equal(badNow.status, 1);
    assert.match(badNow.stderr, /--now が読めません/);
    const dry = run(["--dry-run", `--data-dir=${dir}`, "--now=2026-10-08T16:35:00+09:00"], { GITHUB_REPOSITORY: "o/r", GITHUB_SERVER_URL: "https://github.com" });
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /https:\/\/github\.com\/o\/r\/blob\/main\/data\/daytrade-plan\.txt/);
    assert.match(dry.stdout, /Issue は作っていません/);
    // 空の --now（Resolve が失敗して NOW が空のとき）は現在時刻として扱う
    const empty = run(["--dry-run", `--data-dir=${dir}`, "--now="], {});
    assert.equal(empty.status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
