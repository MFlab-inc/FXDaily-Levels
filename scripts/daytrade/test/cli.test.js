"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { main } = require("../../daytrade-plan");
const { main: scoreMain } = require("../../daytrade-score");
const L = require("../log");
const { makeScenario, snapshot } = require("./scenario");
const { rm, toH1Json } = require("./helpers");
const J = require("../jst");

const INPUTS = ["intraday.json", "daily-levels.json", "h1-bars.json", "daytrade-context.json", "mtf-feed.json", "economic-calendar.json"];
const quiet = () => { const out = []; return { out, io: { log: (m) => out.push(String(m)) } }; };
const run = (sc, extra, env = {}) => { const q = quiet(); return main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", `--now=${sc.nowIso}`, ...extra], env, q.io).then((r) => ({ r, out: q.out })); };
const cleanup = (sc) => rm(path.dirname(sc.dataDir));
const read = (sc, rel) => fs.readFileSync(path.join(sc.dataDir, rel), "utf8");

test("design: plan.json・plan.txt・log.csv を書く。既存の入力ファイルは一字も変えない", async () => {
  const sc = makeScenario();
  try {
    const before = snapshot(sc.dataDir, INPUTS);
    const { r } = await run(sc, ["--run=design", "--slot=2"]);
    assert.equal(r.plan.candidates.length, 4);
    assert.deepEqual(snapshot(sc.dataDir, INPUTS), before);
    const plan = JSON.parse(read(sc, "daytrade-plan.json"));
    assert.equal(plan.run, "design");
    assert.equal(plan.design_slot, 2);
    assert.match(read(sc, "daytrade-plan.txt"), /== 7\. 停止時間と新規不可の時間帯 ==/);
    assert.equal(L.parseLog(read(sc, "daytrade/log.csv")).length, 4);
    // 一時ファイルを data/ に残さない（data/ の隣の一時フォルダも消す）
    assert.deepEqual(fs.readdirSync(path.dirname(sc.dataDir)).filter((n) => n.startsWith(".mtf-tmp-")), []);
    assert.deepEqual(fs.readdirSync(sc.dataDir).filter((n) => /tmp/i.test(n)), []);
  } finally { cleanup(sc); }
});

test("design: 同じ枠が済んでいれば何もしない（--force で再実行。ログは同じ版を二重に追記しない）", async () => {
  const sc = makeScenario();
  try {
    await run(sc, ["--run=design", "--slot=2"]);
    const logBefore = read(sc, "daytrade/log.csv");
    const again = await run(sc, ["--run=design", "--slot=2"]);
    assert.equal(again.r.skipped, "done");
    assert.match(again.out.join("\n"), /済んでいます/);
    const forced = await run(sc, ["--run=design", "--slot=2", "--force"]);
    assert.ok(forced.r.plan);
    assert.equal(read(sc, "daytrade/log.csv"), logBefore);
  } finally { cleanup(sc); }
});

test("design: 遅れて動いた設計は見送る（次の枠の名目時刻を過ぎている／後の枠が済んでいる）", async () => {
  const sc = makeScenario({ nowIso: "2026-10-08T16:00:00+09:00" });
  try {
    const r1 = await run(sc, ["--run=design", "--slot=1"]);
    assert.match(r1.r.skipped, /次の枠/);
    assert.equal(fs.existsSync(path.join(sc.dataDir, "daytrade-plan.json")), false);
    // 設計②を実行 → その後の設計①は『後の枠が既にある』で見送り
    await run(sc, ["--run=design", "--slot=2"]);
    const sc2 = { ...sc, nowIso: "2026-10-08T15:40:00+09:00" };
    const r2 = await run(sc2, ["--run=design", "--slot=1"]);
    assert.match(r2.r.skipped, /後の枠|次の枠/);
    // --force なら見送らない
    const r3 = await run(sc, ["--run=design", "--slot=1", "--force"]);
    assert.ok(r3.r.plan);
  } finally { cleanup(sc); }
});

test("status: 同じ時間内の二重実行は何もしない。Entry・SL・TP は設計のまま", async () => {
  const sc = makeScenario();
  try {
    await run(sc, ["--run=design", "--slot=2"]);
    const design = JSON.parse(read(sc, "daytrade-plan.json"));
    const logBefore = read(sc, "daytrade/log.csv");
    const q = quiet();
    // 設計と同じ時間内（15:55）の状態更新は、設計が兼ねているので何もしない
    const same = await main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", "--now=2026-10-08T15:55:00+09:00", "--run=status"], {}, q.io);
    assert.equal(same.skipped, "done");
    // 次の時間（入力は 15:30 のままなので鮮度超過＝発注不可で出る）
    const r = await main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", "--now=2026-10-08T16:05:00+09:00", "--run=status"], {}, q.io);
    assert.equal(r.plan.run, "status");
    assert.equal(r.plan.design_slot, 2);
    assert.equal(r.plan.order_ok, false);
    assert.deepEqual(r.plan.candidates.map((c) => c.band), design.candidates.map((c) => c.band));
    assert.deepEqual(r.plan.candidates.map((c) => c.schemes.A.sl), design.candidates.map((c) => c.schemes.A.sl));
    assert.equal(read(sc, "daytrade/log.csv"), logBefore); // 毎時の状態更新はログに書かない
    const again = await main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", "--now=2026-10-08T16:20:00+09:00", "--run=status"], {}, q.io);
    assert.equal(again.skipped, "done");
  } finally { cleanup(sc); }
});

test("--resolve: cron の文字列から実行の種類を決めて出力する（夏冬）", async () => {
  const q = quiet();
  const sum = await main(["--resolve", "--now=2026-07-15T06:30:00+09:00", "--cron=30 21 * * 0-4"], {}, q.io);
  assert.deepEqual(sum, { action: "design", slot: 1 });
  assert.deepEqual(q.out.slice(0, 2), ["action=design", "slot=1"]);
  const q2 = quiet();
  const win = await main(["--resolve", "--now=2026-12-15T06:30:00+09:00", "--cron=30 21 * * 0-4"], {}, q2.io);
  assert.equal(win.action, "skip");
  assert.match(q2.out.join("\n"), /reason=.*冬/);
  const q3 = quiet();
  assert.deepEqual(await main(["--resolve", "--now=2026-07-15T21:00:00+09:00"], { DAYTRADE_CRON: "0 12 * * 1-5" }, q3.io), { action: "design", slot: 3 });
  const q4 = quiet();
  assert.deepEqual(await main(["--resolve", "--now=2026-12-15T21:00:00+09:00"], { DAYTRADE_CRON: "0 12 * * 1-5" }, q4.io), { action: "status", slot: null });
  // 夏冬が合わない cron は何もしない（実行は skip）
  const q5 = quiet();
  const sk = await main(["--now=2026-12-15T06:30:00+09:00"], { DAYTRADE_CRON: "30 21 * * 0-4" }, q5.io);
  assert.ok(sk.skipped);
});

test("引数の誤りは例外（黙って別の動きをしない）", async () => {
  await assert.rejects(() => main(["--now=2026-10-08T15:30:00+09:00"], {}, quiet().io), /--run=design\|status/);
  await assert.rejects(() => main(["--run=design", "--slot=9", "--now=2026-10-08T15:30:00+09:00"], {}, quiet().io), /--slot/);
  await assert.rejects(() => main(["--run=design", "--now=garbage"], {}, quiet().io), /--now/);
  await assert.rejects(() => main(["--run=design", "--now=2026-10-08T15:30:00+09:00"], {}, quiet().io), /設計の枠/);
  // 起動の解決の段階で（採点より前に）失敗させる
  await assert.rejects(() => main(["--resolve", "--run=design", "--now=2026-10-08T15:30:00+09:00"], {}, quiet().io), /設計の枠/);
});

test("--dry-run は何も書かない", async () => {
  const sc = makeScenario();
  try {
    const { r, out } = await run(sc, ["--run=design", "--slot=2", "--dry-run"]);
    assert.equal(r.dry, true);
    assert.match(out.join("\n"), /デイトレプラン（自動生成）/);
    assert.equal(fs.existsSync(path.join(sc.dataDir, "daytrade-plan.json")), false);
    assert.equal(fs.existsSync(path.join(sc.dataDir, "daytrade", "log.csv")), false);
  } finally { cleanup(sc); }
});

// ---- 採点の CLI ----
test("score: 有効期限を過ぎた案を h1-bars.json で採点し log.csv に追記。二度目は何もしない。足が届かなければ保留", async () => {
  const sc = makeScenario();
  try {
    await run(sc, ["--run=design", "--slot=2"]);
    const rows0 = L.parseLog(read(sc, "daytrade/log.csv"));
    assert.equal(rows0.length, 4);
    const q = quiet();
    // 足が有効期限まで届いていない → 保留
    let res = scoreMain([`--data-dir=${sc.dataDir}`, "--now=2026-10-09T06:30:00+09:00"], q.io);
    assert.equal(res.newRows.length, 0);
    assert.equal(res.held.length, 4);
    // 有効期限まで足を延ばす（EURUSD は 17:00 に帯へ到達、20:00 に TP1）
    const endMs = J.parseIso("2026-10-09T03:00:00+09:00");
    const bars = JSON.parse(read(sc, "h1-bars.json"));
    const ext = {};
    for (const [code, arr] of Object.entries(bars.pairs)) {
      const last = arr[arr.length - 1];
      const mid = (last.h + last.l) / 2;
      const half = (last.h - last.l) / 4;
      ext[code] = [];
      for (let t = J.jstAt("2026-10-08", "15:00"); t < endMs; t += J.HR) ext[code].push({ t, o: mid, h: mid + half, l: mid - half, c: mid });
    }
    const at = (hm) => J.jstAt("2026-10-08", hm);
    const setBar = (code, hm, v) => { const i = ext[code].findIndex((b) => b.t === at(hm)); ext[code][i] = { t: at(hm), ...v }; };
    setBar("EURUSD", "17:00", { o: 1.1036, h: 1.1045, l: 1.1035, c: 1.1038 });
    setBar("EURUSD", "20:00", { o: 1.1030, h: 1.1035, l: 1.0900, c: 1.0950 });
    // 元の足（階段）を、そのまま 14:00 までの分として使う
    const parsed = {};
    for (const [code, arr] of Object.entries(bars.pairs)) parsed[code] = arr.map((b) => ({ t: J.parseJstLabel(b.time_jst), o: b.o, h: b.h, l: b.l, c: b.c }));
    const merged = Object.fromEntries(Object.keys(parsed).map((c) => [c, [...parsed[c], ...ext[c]]]));
    fs.writeFileSync(path.join(sc.dataDir, "h1-bars.json"), JSON.stringify({ as_of: "2026-10-09T06:25:00+09:00", pairs: toH1Json(merged) }));
    res = scoreMain([`--data-dir=${sc.dataDir}`, "--now=2026-10-09T06:30:00+09:00"], q.io);
    assert.equal(res.held.length, 0);
    assert.equal(res.newRows.length, 4);
    const rows = L.parseLog(read(sc, "daytrade/log.csv"));
    assert.equal(rows.length, 8); // 旧行は変えず、結果の行を追記
    assert.deepEqual(rows.slice(0, 4), rows0);
    const eu = rows.slice(4).find((r) => r.symbol === "EURUSD");
    assert.equal(eu.run, "status");
    assert.equal(eu.reached, "到達");
    assert.equal(eu.reached_at, "2026-10-08T17:00:00+09:00");
    assert.equal(eu.first_hit_a, "TP1");
    assert.equal(eu.first_hit_b, "TP1");
    assert.ok(rows.slice(4).filter((r) => r.symbol !== "EURUSD").every((r) => r.reached === "未到達" && r.first_hit_a === ""));
    // 二度目は何もしない
    res = scoreMain([`--data-dir=${sc.dataDir}`, "--now=2026-10-09T06:35:00+09:00"], q.io);
    assert.equal(res.newRows.length, 0);
    assert.equal(L.parseLog(read(sc, "daytrade/log.csv")).length, 8);
    // 次の設計の出力に前日の結果が出る
    const next = makeScenario({ nowIso: "2026-10-09T15:30:00+09:00" });
    fs.writeFileSync(path.join(next.dataDir, "daytrade", "log.csv"), read(sc, "daytrade/log.csv"));
    const q2 = quiet();
    const out = await main([`--data-dir=${next.dataDir}`, "--no-risk-feed", `--now=${next.nowIso}`, "--run=design", "--slot=2"], {}, q2.io);
    assert.equal(out.plan.previous_day.plan_date, "2026-10-08");
    assert.equal(out.plan.previous_day.reached, 1);
    assert.equal(out.plan.previous_day.a.tp1, 1);
    cleanup(next);
  } finally { cleanup(sc); }
});

test("score: log.csv や h1-bars.json が無ければ何もしない（失敗にしない）", () => {
  const sc = makeScenario();
  try {
    const q = quiet();
    assert.deepEqual(scoreMain([`--data-dir=${sc.dataDir}`, "--now=2026-10-09T06:30:00+09:00"], q.io).newRows, []);
    fs.mkdirSync(path.join(sc.dataDir, "daytrade"), { recursive: true });
    fs.writeFileSync(path.join(sc.dataDir, "daytrade", "log.csv"), `${L.COLUMNS.join(",")}\n`);
    fs.rmSync(path.join(sc.dataDir, "h1-bars.json"));
    const r = scoreMain([`--data-dir=${sc.dataDir}`, "--now=2026-10-09T06:30:00+09:00"], q.io);
    assert.equal(r.newRows.length, 0);
    assert.match(q.out.join("\n"), /保留/);
  } finally { cleanup(sc); }
});
