"use strict";

/**
 * GitHub の Issue API（REST）の最小のクライアント。fetch を差し込める（試験・dry-run では本物に接続しない）。
 * トークンは Authorization ヘッダにだけ使い、エラー文・ログには出さない。使う権限は issues: write だけ（ワークフローの GITHUB_TOKEN）。
 *   findIssues({label})      … ラベル付きの Issue を新しい順（開いているもの・閉じたもの両方。最大 pages×100 件）
 *   createIssue({title, body, labels})
 *   listComments(number)     … 古い順
 *   addComment(number, body)
 *   closeIssue(number)
 *   ensureLabel(name, color, description)
 * MemoryClient は同じ形のメモリ上の実装（dry-run と単体試験用）。ops に呼び出しの記録が残る。
 */
const API = "https://api.github.com";

class GithubError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function createClient({ token, repo, fetchImpl = globalThis.fetch, apiBase = API, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 2, log = () => {} }) {
  if (!token) throw new GithubError("GITHUB_TOKEN がありません", 0);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new GithubError(`GITHUB_REPOSITORY が読めません: ${repo}`, 0);
  const headers = {
    Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fxdaily-daytrade-notify", "Content-Type": "application/json",
  };
  async function call(method, path, body) {
    const url = `${apiBase}/repos/${repo}${path}`;
    let last;
    for (let i = 0; i <= retries; i++) {
      let res;
      try { res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
      catch (e) { last = new GithubError(`${method} ${path}: 接続できません（${String(e.message || e).slice(0, 120)}）`, 0); }
      if (res) {
        if (res.ok) return res.status === 204 ? null : res.json();
        const text = await res.text().catch(() => "");
        last = new GithubError(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200).replace(token, "***")}`, res.status);
        if (res.status < 500 && res.status !== 429) throw last; // 認証・権限・不正な入力は、やり直しても同じ
      }
      if (i < retries) { log(`[notify] ${last.message}。${i + 1}回目のやり直しを待ちます`); await sleep(2000 * 2 ** i); }
    }
    throw last;
  }
  const pages = async (path, max = 3) => {
    const out = [];
    for (let p = 1; p <= max; p++) {
      const r = await call("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${p}`);
      out.push(...r);
      if (r.length < 100) break;
    }
    return out;
  };
  const slim = (i) => ({ number: i.number, title: i.title, state: i.state, body: i.body ?? "", comments: i.comments ?? 0, html_url: i.html_url, created_at: i.created_at });
  return {
    async findIssues({ label }) {
      const r = await pages(`/issues?labels=${encodeURIComponent(label)}&state=all&sort=created&direction=desc`);
      return r.filter((i) => !i.pull_request).map(slim);
    },
    async createIssue({ title, body, labels }) { return slim(await call("POST", "/issues", { title, body, labels })); },
    async listComments(number) { return (await pages(`/issues/${number}/comments`, 10)).map((c) => ({ id: c.id, body: c.body ?? "", created_at: c.created_at })); },
    async addComment(number, body) { const c = await call("POST", `/issues/${number}/comments`, { body }); return { id: c.id, body: c.body ?? body, created_at: c.created_at }; },
    async closeIssue(number) { await call("PATCH", `/issues/${number}`, { state: "closed", state_reason: "completed" }); },
    async ensureLabel(name, color, description) {
      try { await call("GET", `/labels/${encodeURIComponent(name)}`); return; }
      catch (e) { if (e.status !== 404) throw e; }
      await call("POST", "/labels", { name, color, description });
    },
  };
}

// メモリ上の Issue（dry-run・試験）。state は { issues: [{number,title,state,body,labels,comments:[{id,body,created_at}]}] } の形で受け渡せる
function createMemoryClient(seed = null) {
  const issues = seed?.issues ? JSON.parse(JSON.stringify(seed.issues)) : [];
  const ops = [];
  let next = issues.reduce((m, i) => Math.max(m, i.number), 0) + 1;
  let cid = 1;
  const find = (n) => { const i = issues.find((x) => x.number === n); if (!i) throw new GithubError(`Issue #${n} がありません`, 404); return i; };
  const slim = (i) => ({ number: i.number, title: i.title, state: i.state, body: i.body, comments: i.comments.length, html_url: `memory://issues/${i.number}`, created_at: i.created_at || null });
  return {
    ops, state: () => ({ issues }),
    async findIssues({ label }) { return issues.filter((i) => (i.labels || []).includes(label)).map(slim).reverse(); },
    async createIssue({ title, body, labels }) {
      const i = { number: next++, title, state: "open", body, labels: labels || [], comments: [] };
      issues.push(i); ops.push({ op: "create_issue", number: i.number, title, labels, body });
      return slim(i);
    },
    async listComments(number) { return find(number).comments.map((c) => ({ ...c })); },
    async addComment(number, body) {
      const c = { id: cid++, body, created_at: null };
      find(number).comments.push(c); ops.push({ op: "comment", number, title: find(number).title, body });
      return { ...c };
    },
    async closeIssue(number) { find(number).state = "closed"; ops.push({ op: "close", number, title: find(number).title }); },
    async ensureLabel() {},
  };
}

module.exports = { GithubError, createClient, createMemoryClient };
