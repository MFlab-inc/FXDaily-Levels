"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient, fetchRange, fetchRecent } = require("../lib/twelvedata");
const { fakeTwelveData, fakeClock } = require("./helpers");
const { isoDatetime, HR } = require("../lib/ny-time");

const KEY = "SECRETKEY123";
const mkBars = (n, start = Date.UTC(2026, 0, 1)) => Array.from({ length: n }, (_, i) => ({ datetime: isoDatetime(start + i * HR), open: 1, high: 2, low: 0.5, close: 1.5 }));
const mk = (fetchImpl, clock, extra = {}) => createClient({ apiKey: KEY, fetchImpl, sleep: clock.sleep, now: clock.now, spacingMs: 1000, ...extra });

test("取得: 5000本の上限を超える範囲は、end_date を最古の足の1秒前にして遡り、全部つなげる（ページ数・重複なし）", async () => {
  const bars = mkBars(230);
  const f = fakeTwelveData({ "EUR/USD": bars }, { pageCap: 100 });
  const clock = fakeClock();
  const got = await fetchRange(mk(f, clock), "EUR/USD", bars[0].datetime, { pageSize: 100 });
  assert.equal(got.length, 230);
  assert.equal(new Set(got.map((b) => b.datetime)).size, 230);
  assert.equal(f.calls.length, 3); // 100 + 100 + 30
  assert.equal(f.calls[0].end_date, undefined);
  assert.equal(f.calls[1].end_date, isoDatetime(Date.parse(bars[130].datetime.replace(" ", "T") + "Z") - 1000)); // 2ページ目は最古(index130)の1秒前
  assert.ok(f.calls.every((c) => c.timezone === "UTC" && c.interval === "1h" && c.start_date === bars[0].datetime));
});

test("取得: ちょうどページ数の倍の本数でも止まる（開始日ちょうどで終わるなら2回、手前に余白があれば最後の空ページ『データなし』を空として扱い3回）", async () => {
  const bars = mkBars(200);
  const f = fakeTwelveData({ X: bars }, { pageCap: 100 });
  const got = await fetchRange(mk(f, fakeClock()), "X", bars[0].datetime, { pageSize: 100 });
  assert.equal(got.length, 200);
  assert.equal(f.calls.length, 2); // 2ページ目の最古が開始日ちょうど → 次の end_date は開始日より前なので打ち切り
  const f2 = fakeTwelveData({ X: bars }, { pageCap: 100 });
  const got2 = await fetchRange(mk(f2, fakeClock()), "X", "2025-12-01 00:00:00", { pageSize: 100 });
  assert.equal(got2.length, 200);
  assert.equal(f2.calls.length, 3); // 100 + 100 + 0（「No data is available」を空として扱う）
});

test("取得: ページが上限(maxPages)に達しても範囲の先頭に届かないときは黙って切らずに例外", async () => {
  const bars = mkBars(500);
  const f = fakeTwelveData({ X: bars }, { pageCap: 100 });
  await assert.rejects(fetchRange(mk(f, fakeClock()), "X", bars[0].datetime, { pageSize: 100, maxPages: 3 }), /先頭に届きません/);
});

test("取得: 直近N本（毎日の更新）は1リクエスト", async () => {
  const f = fakeTwelveData({ X: mkBars(50) });
  const c = mk(f, fakeClock());
  const got = await fetchRecent(c, "X", 30);
  assert.equal(got.length, 30);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].outputsize, "30");
  assert.equal(c.stats.requests, 1);
  assert.ok(got.every((b) => typeof b.open === "number"));
});

test("レート: 呼び出しの間隔を空け、直近60秒の呼び出し数が上限（maxPerMinute）を超えない", async () => {
  const f = fakeTwelveData({ X: mkBars(5) });
  const clock = fakeClock();
  const times = [];
  const wrapped = async (...a) => { times.push(clock.t); return f(...a); };
  const c = createClient({ apiKey: KEY, fetchImpl: wrapped, sleep: clock.sleep, now: clock.now, spacingMs: 500, maxPerMinute: 10 });
  for (let i = 0; i < 35; i++) await fetchRecent(c, "X", 5);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 500, "間隔");
  for (let i = 0; i < times.length; i++) {
    const inWindow = times.filter((t) => t > times[i] - 60000 && t <= times[i]).length;
    assert.ok(inWindow <= 10, `60秒の窓に${inWindow}回`);
  }
});

test("再試行: 429（HTTP 200 + code 429）は次の分まで待って再試行し、成功すれば値を返す", async () => {
  const f = fakeTwelveData({ X: mkBars(5) }, { failures: { X: { kind: "429-body", times: 2 } } });
  const clock = fakeClock(Date.UTC(2026, 9, 6, 21, 10, 40));
  const c = mk(f, clock);
  const got = await fetchRecent(c, "X", 5);
  assert.equal(got.length, 5);
  assert.equal(c.stats.rateLimited, 2);
  assert.equal(c.stats.retries, 2);
  assert.ok(clock.slept.some((ms) => ms >= 20000 && ms <= 61000), "分の頭まで待つ");
});

test("再試行: 429 が続けば上限回数で諦めて例外（無限に待たない）", async () => {
  const f = fakeTwelveData({ X: mkBars(5) }, { failures: { X: { kind: "429-body", times: 99 } } });
  await assert.rejects(fetchRecent(mk(f, fakeClock(), { maxAttempts: 3 }), "X", 5), /429/);
  assert.equal(f.calls.length, 3);
});

test("再試行: 5xx・通信失敗は再試行。認証エラー（401相当）は再試行しない", async () => {
  const f5 = fakeTwelveData({ X: mkBars(5) }, { failures: { X: { kind: "500", times: 1 } } });
  assert.equal((await fetchRecent(mk(f5, fakeClock()), "X", 5)).length, 5);
  const ft = fakeTwelveData({ X: mkBars(5) }, { failures: { X: { kind: "throw", times: 1 } } });
  assert.equal((await fetchRecent(mk(ft, fakeClock()), "X", 5)).length, 5);
  const f4 = fakeTwelveData({ X: mkBars(5) }, { failures: { X: { kind: "401", times: 9 } } });
  await assert.rejects(fetchRecent(mk(f4, fakeClock()), "X", 5), /APIエラー code=401/);
  assert.equal(f4.calls.length, 1);
});

test("APIキーは、エラー文（URL入りの例外・APIが返すメッセージ）のどちらにも出ない", async () => {
  const check = async (kind) => {
    const logs = [];
    const f = fakeTwelveData({ X: mkBars(5) }, { failures: { X: { kind, times: 99 } } });
    // fakeTwelveData は apikey を含むURLを受け取る。キーを含む例外・メッセージを上位に出さないこと
    const c = mk((url, o) => f(url, o), fakeClock(), { maxAttempts: 2, log: (m) => logs.push(m) });
    let msg = "";
    try { await fetchRecent(c, "X", 5); } catch (e) { msg = e.message + "\n" + (e.stack || ""); }
    return msg + logs.join("\n");
  };
  for (const kind of ["throw", "401", "500", "429-body"]) {
    const text = await check(kind);
    assert.ok(!text.includes(KEY), `${kind}: キーが漏れている: ${text.slice(0, 200)}`);
  }
  // 失敗の中身はちゃんと出る（***に置き換わるだけ）
  assert.match(await check("401"), /\*\*\*/);
});

test("取得: 応答が壊れていれば例外（values が無い・数値でない・日時の形式が違う）", async () => {
  const mkFetch = (body) => async () => new Response(JSON.stringify(body), { status: 200 });
  await assert.rejects(fetchRecent(mk(mkFetch({ status: "ok" }), fakeClock(), { maxAttempts: 1 }), "X", 5), /values/);
  await assert.rejects(fetchRecent(mk(mkFetch({ values: [{ datetime: "2026-01-01 00:00:00", open: "x", high: "1", low: "1", close: "1" }] }), fakeClock()), "X", 5), /数値/);
  await assert.rejects(fetchRecent(mk(mkFetch({ values: [{ datetime: "2026-01-01", open: "1", high: "1", low: "1", close: "1" }] }), fakeClock()), "X", 5), /日時/);
});

test("キーが無ければクライアントを作れない", () => {
  assert.throws(() => createClient({ apiKey: "" }), /TWELVE_DATA_API_KEY/);
});

test("beforeRequest（他ワークフローとの重なり確認）は毎回の呼び出しの直前に走り、例外なら Twelve Data を呼ばない", async () => {
  const f = fakeTwelveData({ X: mkBars(5) });
  let n = 0;
  const c = mk(f, fakeClock(), { beforeRequest: async () => { n += 1; } });
  await fetchRecent(c, "X", 5);
  await fetchRecent(c, "X", 5);
  assert.equal(n, 2);
  const c2 = mk(f, fakeClock(), { beforeRequest: async () => { throw new Error("busy"); }, maxAttempts: 1 });
  const before = f.calls.length;
  await assert.rejects(fetchRecent(c2, "X", 5), /busy/);
  assert.equal(f.calls.length, before);
});
