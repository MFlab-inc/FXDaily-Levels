"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { httpGet } = require("../lib/http");

const ok = (body, headers = {}) => new Response(body, { status: 200, headers });
const noSleep = async () => {};

test("200：本文とLast-Modifiedを返す。User-Agent を付ける", async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = opts; return ok("abc", { "last-modified": "Tue, 06 Oct 2026 23:30:14 GMT" }); };
  const r = await httpGet("https://example.test/a", { fetchImpl, sleep: noSleep });
  assert.equal(r.bytes.toString(), "abc");
  assert.equal(r.lastModified, "Tue, 06 Oct 2026 23:30:14 GMT");
  assert.match(seen.headers["User-Agent"], /FXDaily-Levels-rates/);
});

test("503→200：再試行して成功する。404：再試行せず失敗する（本文の種類を問わず4xxは変わらない）", async () => {
  let n = 0;
  const flaky = async () => (++n < 3 ? new Response("x", { status: 503 }) : ok("fine"));
  assert.equal((await httpGet("https://example.test/a", { fetchImpl: flaky, sleep: noSleep })).bytes.toString(), "fine");
  assert.equal(n, 3);
  let m = 0;
  const gone = async () => { m++; return new Response("x", { status: 404 }); };
  await assert.rejects(httpGet("https://example.test/b", { label: "b", fetchImpl: gone, sleep: noSleep }), /HTTP 404 \(b\)/);
  assert.equal(m, 1);
});

test("再試行の回数の上限（既定2回＝計3回）で失敗にする", async () => {
  let n = 0;
  const down = async () => { n++; return new Response("x", { status: 500 }); };
  await assert.rejects(httpGet("https://example.test/c", { fetchImpl: down, sleep: noSleep }), /HTTP 500/);
  assert.equal(n, 3);
});

test("タイムアウト（messageを書き換えられない例外）・接続の失敗も、包み直して再試行する", async () => {
  let n = 0;
  const timeout = async () => {
    n++;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); // messageは読み取り専用
  };
  await assert.rejects(httpGet("https://example.test/d", { label: "d", timeoutMs: 20000, fetchImpl: timeout, sleep: noSleep }), /タイムアウト（20秒） \(d\)/);
  assert.equal(n, 3);
  let k = 0;
  const reset = async () => { if (++k < 2) throw new TypeError("fetch failed"); return ok("again"); };
  assert.equal((await httpGet("https://example.test/e", { fetchImpl: reset, sleep: noSleep })).bytes.toString(), "again");
});
