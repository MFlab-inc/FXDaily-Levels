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
    assert.match(read(sc, "daytrade-plan.txt"), /== 7\. 出典 ==/);
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

test("design（手動）: 時刻にかかわらず枠を指定して作れる。同じ枠が済んでいれば何もしない（枠の窓は自動のときだけ見る）", async () => {
  const sc = makeScenario({ nowIso: "2026-10-08T16:00:00+09:00" });
  try {
    const r1 = await run(sc, ["--run=design", "--slot=1"]); // 設計①の窓(06:00〜08:59)の外でも、手動なら作る
    assert.equal(r1.r.plan.design_slot, 1);
    const r2 = await run(sc, ["--run=design", "--slot=1"]);
    assert.equal(r2.r.skipped, "done");
    const r3 = await run(sc, ["--run=design", "--slot=2"]); // 別の枠は作れる
    assert.equal(r3.r.plan.design_slot, 2);
    assert.deepEqual(r3.r.plan.designs.map((d) => d.slot), [1, 2]); // 設計の履歴
    const r4 = await run(sc, ["--run=design", "--slot=1", "--force"]);
    assert.ok(r4.r.plan);
  } finally { cleanup(sc); }
});

test("自動（run 指定なし）: 実行時刻の窓と済みの設計で種類を決める。設計②→同じ時間内は何もしない→次の時間は状態更新→窓の外・土日は何もしない", async () => {
  const sc = makeScenario(); // 15:30（設計②の窓）
  try {
    const auto = (iso, extra = []) => main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", `--now=${iso}`, ...extra], {}, quiet().io);
    const d = await auto("2026-10-08T15:30:00+09:00");
    assert.equal(d.plan.run, "design");
    assert.equal(d.plan.design_slot, 2);
    assert.equal((await auto("2026-10-08T15:50:00+09:00")).skipped, "done"); // 設計②が済み → 状態更新だが、同じ時間内
    const st = await auto("2026-10-08T16:05:00+09:00");
    assert.equal(st.plan.run, "status");
    assert.deepEqual(st.plan.designs.map((x) => x.slot), [2]); // 状態更新は設計の履歴を引き継ぐ
    assert.match((await auto("2026-10-09T04:00:00+09:00")).skipped, /時間帯/);
    assert.match((await auto("2026-10-10T10:00:00+09:00")).skipped, /土日/);
    // 発注できる状態の入力で作った設計は、候補が0件でも『済み』（log.csv に行が残らなくても plan.json の履歴で分かる）
    const none = Object.fromEntries(["USDJPY", "EURUSD", "GBPUSD", "AUDUSD", "XAUUSD", "EURJPY", "USDCAD", "EURGBP"].map((c) => [c, { score: "Mixed", dirs: ["↑", "↓", "→"] }]));
    const empty = makeScenario({ nowIso: "2026-10-08T15:20:00+09:00", spec: none });
    try {
      const a2 = (iso) => main([`--data-dir=${empty.dataDir}`, "--no-risk-feed", `--now=${iso}`], {}, quiet().io);
      const e1 = await a2("2026-10-08T15:20:00+09:00");
      assert.equal(e1.plan.candidates.length, 0);
      assert.equal(e1.plan.designs[0].inputs_ok, true);
      assert.equal(fs.existsSync(path.join(empty.dataDir, "daytrade", "log.csv")), false); // 行が残らない
      assert.equal((await a2("2026-10-08T16:10:00+09:00")).plan.run, "status"); // 設計②を繰り返さない
    } finally { cleanup(empty); }
    // 発注できる状態でない入力（MTFが使えない）で作った設計は『済み』にしない: 窓の中の次の実行で設計をやり直し、入力が整えば済みになる
    const bad = makeScenario({ mtfStatus: "partial", nowIso: "2026-10-08T15:20:00+09:00" });
    try {
      const a3 = (iso) => main([`--data-dir=${bad.dataDir}`, "--no-risk-feed", `--now=${iso}`], {}, quiet().io);
      const b1 = await a3("2026-10-08T15:20:00+09:00");
      assert.equal(b1.plan.designs[0].inputs_ok, false);
      assert.equal(b1.plan.inputs_ok, false);
      const b2 = await a3("2026-10-08T15:40:00+09:00");
      assert.equal(b2.plan.run, "design"); // 窓（15:00〜16:59）の中なので、もう一度設計する
      // MTF が使えるようになった → 設計し直して『済み』になり、次は状態更新
      const mtf = JSON.parse(read(bad, "mtf-feed.json")); mtf.status = "ok";
      fs.writeFileSync(path.join(bad.dataDir, "mtf-feed.json"), JSON.stringify(mtf));
      for (const f of ["intraday.json", "h1-bars.json", "daytrade-context.json"]) { const j = JSON.parse(read(bad, f)); j.as_of = "2026-10-08T15:45:00+09:00"; fs.writeFileSync(path.join(bad.dataDir, f), JSON.stringify(j)); }
      const b3 = await a3("2026-10-08T15:50:00+09:00");
      assert.equal(b3.plan.run, "design");
      assert.equal(b3.plan.designs.at(-1).inputs_ok, true);
      assert.equal(b3.plan.designs.length, 1); // 同じ枠の履歴は置き換わる
      assert.equal((await a3("2026-10-08T16:20:00+09:00")).plan.run, "status");
    } finally { cleanup(bad); }
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
    // 前の状態更新が古い入力（発注不可）だったので、同じ時間内でも新しい入力でやり直す
    assert.equal(r.plan.inputs_ok, false);
    const again = await main([`--data-dir=${sc.dataDir}`, "--no-risk-feed", "--now=2026-10-08T16:20:00+09:00", "--run=status"], {}, q.io);
    assert.equal(again.plan.run, "status");
  } finally { cleanup(sc); }
  // 入力が新しい状態更新は、同じ時間内の2回目を何もしない
  const fresh = makeScenario({ nowIso: "2026-10-08T16:05:00+09:00" });
  try {
    const f = (iso) => main([`--data-dir=${fresh.dataDir}`, "--no-risk-feed", `--now=${iso}`, "--run=status"], {}, quiet().io);
    const s1 = await f("2026-10-08T16:05:00+09:00");
    assert.equal(s1.plan.inputs_ok, true);
    assert.equal((await f("2026-10-08T16:12:00+09:00")).skipped, "done");
    assert.equal((await f("2026-10-08T17:02:00+09:00")).plan.run, "status"); // 次の時間は動く
  } finally { cleanup(fresh); }
});

test("--resolve: 自動なら実行時刻と済みの設計から、手動（run 指定）ならその指定を、key=value で出力する", async () => {
  const sc = makeScenario();
  try {
    const res = async (iso, argv = [], env = {}) => { const q = quiet(); const r = await main(["--resolve", `--data-dir=${sc.dataDir}`, `--now=${iso}`, ...argv], env, q.io); return { r, out: q.out }; };
    let x = await res("2026-07-15T06:30:00+09:00");
    assert.deepEqual(x.r, { action: "design", slot: 1 });
    assert.deepEqual(x.out.slice(0, 2), ["action=design", "slot=1"]);
    x = await res("2026-12-15T06:30:00+09:00"); // 冬の06時台は何もしない
    assert.equal(x.r.action, "skip");
    assert.match(x.out.join("\n"), /reason=/);
    x = await res("2026-07-15T12:00:00+09:00", [], { DAYTRADE_RUN: "status" }); // 手動（環境変数）
    assert.deepEqual(x.r, { action: "status", slot: null });
    x = await res("2026-07-15T12:00:00+09:00", [], { DAYTRADE_RUN: "design", DAYTRADE_SLOT: "3" });
    assert.deepEqual(x.r, { action: "design", slot: 3 });
    x = await res("2026-07-15T12:00:00+09:00", ["--run=status"]);
    assert.equal(x.r.action, "status");
  } finally { cleanup(sc); }
});

test("引数の誤りは例外（黙って別の動きをしない）", async () => {
  await assert.rejects(() => main(["--run=foo", "--now=2026-10-08T15:30:00+09:00", "--dry-run", "--data-dir=/nonexistent-daytrade-test"], {}, quiet().io), /--run は design か status/);
  await assert.rejects(() => main(["--run=design", "--slot=9", "--now=2026-10-08T15:30:00+09:00", "--dry-run", "--data-dir=/nonexistent-daytrade-test"], {}, quiet().io), /--slot/);
  await assert.rejects(() => main(["--run=design", "--now=garbage", "--dry-run", "--data-dir=/nonexistent-daytrade-test"], {}, quiet().io), /--now/);
  await assert.rejects(() => main(["--run=design", "--now=2026-10-08T15:30:00+09:00", "--dry-run", "--data-dir=/nonexistent-daytrade-test"], {}, quiet().io), /設計の枠/);
  // 起動の解決の段階で（採点より前に）失敗させる
  await assert.rejects(() => main(["--resolve", "--run=design", "--now=2026-10-08T15:30:00+09:00", "--dry-run", "--data-dir=/nonexistent-daytrade-test"], {}, quiet().io), /設計の枠/);
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

test("自動: 17:05 の状態更新で型Bが追加され、log.csv に run=design-b の行が追記される。同じ時間内にもう一度動いても追加しない", async () => {
  const d = makeScenario({ spec: { EURUSD: { bars: { dir: "down" } } } });
  const s17 = makeScenario({ nowIso: "2026-10-08T17:05:00+09:00", spec: { EURUSD: { bars: { dir: "down" } } } });
  try {
    const q = quiet();
    await main([`--data-dir=${d.dataDir}`, "--no-risk-feed", `--now=${d.nowIso}`], {}, q.io); // 自動 → 設計②
    fs.copyFileSync(path.join(d.dataDir, "daytrade-plan.json"), path.join(s17.dataDir, "daytrade-plan.json"));
    fs.mkdirSync(path.join(s17.dataDir, "daytrade"), { recursive: true });
    fs.copyFileSync(path.join(d.dataDir, "daytrade", "log.csv"), path.join(s17.dataDir, "daytrade", "log.csv"));
    const before = L.parseLog(read(s17, "daytrade/log.csv"));
    assert.equal(before.length, 4);
    const r = await main([`--data-dir=${s17.dataDir}`, "--no-risk-feed", `--now=${s17.nowIso}`], {}, q.io);
    assert.equal(r.plan.run, "status");
    assert.equal(r.logAppend.length, 3);
    const rows = L.parseLog(read(s17, "daytrade/log.csv"));
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.slice(0, 4), before); // 旧行は変えない
    assert.deepEqual(rows.slice(4).map((x) => [x.run, x.setup]).sort(), [["design-b", "B"], ["design-b", "B"], ["design-b", "B"]]);
    assert.match(read(s17, "daytrade-plan.txt"), /型Bの追加（状態更新 17:05）/);
    assert.equal((await main([`--data-dir=${s17.dataDir}`, "--no-risk-feed", "--now=2026-10-08T17:40:00+09:00"], {}, q.io)).skipped, "done");
    // 強制で動かしても二重に追加しない
    const again = await main([`--data-dir=${s17.dataDir}`, "--no-risk-feed", "--now=2026-10-08T17:40:00+09:00", "--force"], {}, q.io);
    assert.equal(again.logAppend.length, 0);
    assert.equal(L.parseLog(read(s17, "daytrade/log.csv")).length, 7);
  } finally { cleanup(d); cleanup(s17); }
});
