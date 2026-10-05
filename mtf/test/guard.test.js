"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGuard, inTriggerMinute, TRIGGER_MINUTES } = require("../lib/guard");
const { fakeClock } = require("./helpers");

const utc = (h, m, s = 0) => Date.UTC(2026, 9, 6, h, m, s);
const runsResponse = (byStatus) => async (url) => {
  const status = new URL(url).searchParams.get("status");
  return new Response(JSON.stringify({ workflow_runs: byStatus[status] || [] }), { status: 200 });
};

test("起動分(:00 :02 :15 :17 :20 :30 :32 :45 :47 :50)には呼ばない。それ以外は呼べる", () => {
  for (const m of [0, 2, 15, 17, 20, 30, 32, 45, 47, 50]) assert.equal(inTriggerMinute(utc(21, m)), true, `:${m}`);
  for (const m of [5, 10, 11, 12, 25, 40, 55]) assert.equal(inTriggerMinute(utc(21, m)), false, `:${m}`);
  assert.equal(TRIGGER_MINUTES.size, 10);
});

test("他の Daily / Intraday が実行中・待機中なら待ち、いなくなったら進む。自分の実行は無視する", async () => {
  const clock = fakeClock(utc(21, 11));
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const status = new URL(url).searchParams.get("status");
    // 最初の2巡は intraday が実行中、その後は居ない。自分(run 99)はずっと実行中として返る
    const busy = calls <= 4 && status === "in_progress" ? [{ id: 5, name: "Intraday Snapshot" }] : [];
    return new Response(JSON.stringify({ workflow_runs: [...busy, { id: 99, name: "MTF Backfill" }, { id: 99, name: "Daily FX Data" }] }), { status: 200 });
  };
  const logs = [];
  const g = createGuard({ repo: "o/r", token: "t", selfRunId: "99", fetchImpl, sleep: clock.sleep, now: clock.now, log: (m) => logs.push(m) });
  await g.waitQuiet();
  assert.ok(logs.length >= 1 && /Intraday Snapshot#5/.test(logs[0]));
  assert.ok(!logs.some((l) => /#99/.test(l)), "自分の実行では待たない");
});

test("起動分に入りそうなときは待つ（:14:58 は直後に :15 に入るので待つ）", async () => {
  const clock = fakeClock(utc(21, 14, 58));
  const g = createGuard({ repo: "o/r", token: "t", fetchImpl: runsResponse({}), sleep: clock.sleep, now: clock.now });
  await g.waitQuiet();
  assert.equal(inTriggerMinute(clock.t), false);
  assert.ok(clock.t >= utc(21, 16, 0)); // :15 :16? → :16 は起動分ではない（:17 が intraday）
});

test("稼働状況を確認できない（GitHub API エラー）ときは中止する（Twelve Data は呼ばない）", async () => {
  const clock = fakeClock(utc(21, 11));
  const g = createGuard({ repo: "o/r", token: "t", fetchImpl: async () => new Response("no", { status: 500 }), sleep: clock.sleep, now: clock.now });
  await assert.rejects(g.waitQuiet(), /確認できない/);
});

test("待ちが長引いたら（上限を超えたら）中止する", async () => {
  const clock = fakeClock(utc(21, 11));
  const fetchImpl = runsResponse({ in_progress: [{ id: 5, name: "Daily FX Data" }] });
  const g = createGuard({ repo: "o/r", token: "t", fetchImpl, sleep: clock.sleep, now: clock.now, maxWaitMs: 60000 });
  await assert.rejects(g.waitQuiet(), /長引いた/);
});

test("開始の枠: 毎時 :10 :25 :40 :55 の10〜11分台まで待つ", async () => {
  const clock = fakeClock(utc(21, 3, 20));
  const g = createGuard({ repo: "o/r", token: "t", fetchImpl: runsResponse({}), sleep: clock.sleep, now: clock.now });
  await g.waitStartWindow();
  const d = new Date(clock.t);
  assert.equal(d.getUTCMinutes() % 15, 10);
  assert.ok(d.getUTCSeconds() < 30 || d.getUTCSeconds() === 0);
});
