"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runNotify } = require("../notify/run");
const { createMemoryClient } = require("../notify/github");
const D = require("../notify/detect");
const F = require("../notify/format");
const L = require("../log");
const { candRow } = require("../plan");
const J = require("../jst");
const { iso, plan, by, vOf, intraday, clone } = require("./notify-fixture");

/**
 * ■2 通知の1回分（run.js）を、メモリ上の Issue に対して順に動かす。実データと同じファイル（計画・intraday・ログ）を一時フォルダに置く。
 * 木曜 2026-10-08 の1日: 設計① → 同じ状態の再実行 → 設計② → 価格が帯に入る → 設計③（再設計・取消）→ 取消した案が戻る →
 * 翌 03:00 のまとめ・クローズ → 翌朝の採点。週末をまたぐ金曜 → 月曜。
 */
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-run-"));
  fs.mkdirSync(path.join(dir, "daytrade"), { recursive: true });
  const w = {
    dir, client: createMemoryClient(), logRows: [],
    put(rel, obj) { fs.writeFileSync(path.join(dir, rel), typeof obj === "string" ? obj : JSON.stringify(obj)); },
    feeds(nowMs, ageMin = 2) { for (const n of D.FEEDS) this.put(n, { as_of: J.jstIso(nowMs - ageMin * 60000), pairs: {} }); },
    setLog(rows) { this.logRows = rows; this.put("daytrade/log.csv", L.appendedText("", rows)); },
    async run(nowIso, { plan: p, prices = {}, failure = null, client = this.client, feedAge = 2 } = {}) {
      const nowMs = iso(nowIso);
      if (p !== undefined) this.put("daytrade-plan.json", p);
      this.put("intraday.json", intraday(nowMs, prices));
      for (const n of D.FEEDS.filter((x) => x !== "intraday.json")) this.put(n, { as_of: J.jstIso(nowMs - feedAge * 60000), pairs: {} });
      const before = this.client.ops.length;
      const r = await runNotify({ dataDir: dir, nowMs, client, failure, repoUrl: "https://github.com/o/r", log: () => {} });
      return { ...r, ops: this.client.ops.slice(before) };
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return w;
}
const kinds = (ops) => ops.map((o) => o.op);
const withDesign = (slot, genIso, cands, over = {}) => plan((q) => {
  q.designs = [...(over.prev || []), { slot, generated_at: genIso, inputs_ok: true }];
  q.generated_at = genIso; q.design_slot = slot;
  q.candidates = cands.map((c, i) => ({ ...clone(c), rank: i + 1, generated_at: genIso }));
  Object.assign(q, over.plan || {});
});
const sel = (p, ...syms) => syms.map((s) => by(p, s));
const ALL = plan();
const D1 = { slot: 1, generated_at: "2026-10-08T06:10:00+09:00", inputs_ok: true };

test("1日の流れ: 設計①でIssue作成（候補の要点つき）→ 同じ状態の再実行は何もしない → 設計②で新しい案だけコメント", async () => {
  const w = world();
  try {
    const p1 = withDesign(1, "2026-10-08T06:10:00+09:00", sel(ALL, "AUDUSD", "EURUSD"));
    let r = await w.run("2026-10-08T06:15:00+09:00", { plan: p1 });
    assert.deepEqual(kinds(r.ops), ["create_issue"]);
    assert.equal(r.ops[0].title, "デイトレ 2026-10-08（木）");
    assert.deepEqual(r.ops[0].labels, ["daytrade"]);
    assert.match(r.ops[0].body, /^@MFlab-inc /);
    assert.match(r.ops[0].body, /設計①（06:10）時点の候補: \*\*2件\*\*/);
    assert.match(r.ops[0].body, /AUDUSD 買い 型A[\s\S]*EURUSD 売り 型A/);
    assert.deepEqual(r.errors, []);
    // 同じ状態の再実行・状態更新の実行（15分ごと）は、何も出さない
    for (const t of ["2026-10-08T06:30:00+09:00", "2026-10-08T07:05:00+09:00"]) assert.deepEqual((await w.run(t, { plan: p1 })).ops, []);
    // 設計②: 新しい案（XAUUSD・GBPUSD）だけ。コメントに要点
    const p2 = withDesign(2, "2026-10-08T15:30:00+09:00", sel(ALL, "AUDUSD", "EURUSD", "XAUUSD", "GBPUSD"), { prev: [D1] });
    r = await w.run("2026-10-08T15:35:00+09:00", { plan: p2 });
    assert.deepEqual(kinds(r.ops), ["comment"]);
    assert.match(r.ops[0].body, /^@MFlab-inc 新しい案 2件/);
    assert.match(r.ops[0].body, /XAUUSD 買い 型A[\s\S]*GBPUSD 売り 型A/);
    assert.ok(!/AUDUSD|EURUSD/.test(r.ops[0].body));
    assert.deepEqual((await w.run("2026-10-08T15:50:00+09:00", { plan: p2 })).ops, []);
    assert.equal(w.client.state().issues.length, 1);
  } finally { w.cleanup(); }
});

test("帯への到達: 価格が帯に入った実行でコメント1回（コミットなし＝計画ファイルは変わらない）。近づいた→帯に入った、は版ごとに1回だけ", async () => {
  const w = world();
  try {
    const p = withDesign(2, "2026-10-08T15:30:00+09:00", sel(ALL, "EURUSD", "AUDUSD"), { prev: [D1] });
    await w.run("2026-10-08T15:35:00+09:00", { plan: p, prices: { EURUSD: 1.1000 } });
    const planFile = fs.readFileSync(path.join(w.dir, "daytrade-plan.json"), "utf8");
    let r = await w.run("2026-10-08T16:35:00+09:00", { prices: { EURUSD: 1.1041, AUDUSD: 0.6600 } });
    assert.deepEqual(kinds(r.ops), ["comment"]);
    assert.match(r.ops[0].body, /^@MFlab-inc EURUSD 売り：帯に到達（現在値 1\.10410）。M15の確認条件を見る/);
    assert.ok(!/AUDUSD/.test(r.ops[0].body));
    assert.equal(fs.readFileSync(path.join(w.dir, "daytrade-plan.json"), "utf8"), planFile);
    // 同じ価格・離れて戻ってもう一度帯に入っても出さない（版ごとに1回）
    assert.deepEqual((await w.run("2026-10-08T16:50:00+09:00", { prices: { EURUSD: 1.1041 } })).ops, []);
    assert.deepEqual((await w.run("2026-10-08T17:05:00+09:00", { prices: { EURUSD: 1.1000 } })).ops, []);
    assert.deepEqual((await w.run("2026-10-08T17:20:00+09:00", { prices: { EURUSD: 1.1040 } })).ops, []);
    // 別の案（AUDUSD）が近づいたら、その案を1回
    r = await w.run("2026-10-08T17:35:00+09:00", { prices: { EURUSD: 1.1041, AUDUSD: 0.6562 } });
    assert.match(r.ops[0].body, /^@MFlab-inc AUDUSD 買い：帯の近く（現在値 0\.65620、帯まで 2pips）/);
    // 価格が古い実行（20分超）は出さない
    const w2 = world();
    try {
      await w2.run("2026-10-08T15:35:00+09:00", { plan: p });
      const nowMs = iso("2026-10-08T16:40:00+09:00");
      w2.put("intraday.json", intraday(nowMs, { EURUSD: 1.1041 }, 25));
      for (const n of ["h1-bars.json", "daytrade-context.json"]) w2.put(n, { as_of: J.jstIso(nowMs - 2 * 60000) });
      const rr = await runNotify({ dataDir: w2.dir, nowMs, client: w2.client, log: () => {} });
      assert.deepEqual(w2.client.ops.filter((o) => o.op === "comment"), []);
      assert.deepEqual(rr.errors, []);
    } finally { w2.cleanup(); }
  } finally { w.cleanup(); }
});

test("設計③の再設計: 古い版の取消（再設計あり／該当なし）と新しい案。取消した案が戻ったら新しい案として出し直す。もう一度は出さない", async () => {
  const w = world();
  try {
    const p2 = withDesign(2, "2026-10-08T15:30:00+09:00", sel(ALL, "AUDUSD", "EURUSD", "GBPUSD"), { prev: [D1] });
    await w.run("2026-10-08T15:35:00+09:00", { plan: p2 });
    // 設計③: EURUSD の帯が変わる（再設計）、AUDUSD は消える（該当なし）、GBPUSD は同じ
    const moved = clone(by(ALL, "EURUSD"));
    moved.band = { low: 1.1050, high: 1.1052 }; moved.worst_entry = 1.1050; moved.schemes.A.sl = 1.1060; moved.schemes.B.sl = 1.1070;
    const d2 = { slot: 2, generated_at: "2026-10-08T15:30:00+09:00", inputs_ok: true };
    const p3 = withDesign(3, "2026-10-08T21:30:00+09:00", [moved, by(ALL, "GBPUSD")], { prev: [D1, d2] });
    let r = await w.run("2026-10-08T21:35:00+09:00", { plan: p3 });
    assert.deepEqual(kinds(r.ops), ["comment", "comment"]);
    assert.match(r.ops[0].body, /^@MFlab-inc 案を取消しました/);
    assert.match(r.ops[0].body, /EURUSD 売り 型A（Entry 1\.10400〜1\.10420） → 再設計: 新しい案は 1\.10500〜1\.10520/);
    assert.match(r.ops[0].body, /AUDUSD 買い 型A（Entry 0\.65580〜0\.65600） → 該当する案なし/);
    assert.match(r.ops[1].body, /^@MFlab-inc 新しい案 1件/);
    assert.match(r.ops[1].body, /EURUSD 売り 型A/);
    assert.ok(!/GBPUSD/.test(r.ops[1].body));
    assert.deepEqual((await w.run("2026-10-08T21:50:00+09:00", { plan: p3 })).ops, []);
    // AUDUSD の同じ案が戻る（後の設計・型Bの追加など）→ 新しい案として出し直す
    const p4 = withDesign(3, "2026-10-08T21:30:00+09:00", [moved, by(ALL, "GBPUSD"), by(ALL, "AUDUSD")], { prev: [D1, d2] });
    r = await w.run("2026-10-08T22:05:00+09:00", { plan: p4 });
    assert.deepEqual(kinds(r.ops), ["comment"]);
    assert.match(r.ops[0].body, /^@MFlab-inc 新しい案 1件[\s\S]*AUDUSD 買い 型A/);
    assert.deepEqual((await w.run("2026-10-08T22:20:00+09:00", { plan: p4 })).ops, []);
  } finally { w.cleanup(); }
});

test("計画日の終了: 翌 03:00 以後の最初の実行でまとめを書いて閉じる（1回だけ）。閉じたあとの採点はその Issue にコメントされる（再オープンしない）。日付が変わった朝は新しい Issue", async () => {
  const w = world();
  try {
    const c = (s) => by(ALL, s);
    const d2 = { slot: 2, generated_at: "2026-10-08T15:30:00+09:00", inputs_ok: true };
    const d3 = { slot: 3, generated_at: "2026-10-08T21:30:00+09:00", inputs_ok: true };
    const p2 = withDesign(2, "2026-10-08T15:30:00+09:00", sel(ALL, "AUDUSD", "EURUSD", "GBPUSD"), { prev: [D1] });
    await w.run("2026-10-08T15:35:00+09:00", { plan: p2 });
    // 夜の設計③まで済んだ計画（設計の窓が全部終わっても、設計なしの異常は出ない）
    const p3 = withDesign(3, "2026-10-08T21:30:00+09:00", sel(ALL, "AUDUSD", "EURUSD", "GBPUSD"), { prev: [D1, d2] });
    await w.run("2026-10-08T21:35:00+09:00", { plan: p3 });
    // ログ: 3案を設計で記録、GBPUSD は取消
    const d = (x) => candRow(x, "design", "2026-10-08T15:30:00+09:00");
    w.setLog([d(c("AUDUSD")), d(c("EURUSD")), d(c("GBPUSD")), { ...d(c("GBPUSD")), run: "status", generated_at: "2026-10-08T21:30:00+09:00", reached: "取消(再設計)" }]);
    assert.deepEqual((await w.run("2026-10-09T02:55:00+09:00", { plan: p3 })).ops, []); // 02:55 はまだ
    let r = await w.run("2026-10-09T03:05:00+09:00");
    assert.deepEqual(kinds(r.ops), ["comment", "close"]);
    assert.match(r.ops[0].body, /^@MFlab-inc 計画日 2026-10-08 が終了しました/);
    assert.match(r.ops[0].body, /設計で出た案: 3件（取消 1件、期限まで有効だった案 2件）/);
    assert.equal(w.client.state().issues[0].state, "closed");
    assert.deepEqual((await w.run("2026-10-09T03:20:00+09:00")).ops, []);
    assert.deepEqual((await w.run("2026-10-09T05:50:00+09:00")).ops, []);
    // 翌朝 06:20: 採点の結果（閉じた Issue にコメント）。設計① → 新しい Issue も1つ
    const sc = (x, o) => ({ ...d(x), run: "status", generated_at: "2026-10-09T06:20:00+09:00", ...o });
    w.setLog([...w.logRows, sc(c("AUDUSD"), { reached: "未到達" }), sc(c("EURUSD"), { reached: "到達", reached_at: "2026-10-08T22:00:00+09:00", first_hit_a: "TP1", first_hit_b: "SL" })]);
    const fri = plan((q) => { q.plan_date = "2026-10-09"; q.designs = [{ slot: 1, generated_at: "2026-10-09T06:10:00+09:00", inputs_ok: true }]; q.candidates = []; q.expires_at = "2026-10-10T03:00:00+09:00"; });
    r = await w.run("2026-10-09T06:25:00+09:00", { plan: fri });
    assert.deepEqual(kinds(r.ops), ["comment", "create_issue"]);
    assert.equal(r.ops[0].title, "デイトレ 2026-10-08（木）");
    assert.match(r.ops[0].body, /^@MFlab-inc 採点の結果（計画日 2026-10-08）/);
    assert.match(r.ops[0].body, /EURUSD 売り 型A（Entry 1\.10400〜1\.10420）: 到達（10-08 22:00の足） ／ A案 TP1先、B案 SL先/);
    assert.match(r.ops[0].body, /AUDUSD 買い 型A（Entry 0\.65580〜0\.65600）: 未到達/);
    assert.match(r.ops[0].body, /GBPUSD 売り 型A（Entry 1\.30400〜1\.30420）: 取消\(再設計\)/);
    assert.equal(r.ops[1].title, "デイトレ 2026-10-09（金）");
    assert.match(r.ops[1].body, /候補: \*\*0件\*\*/); // 0件でも作る
    assert.equal(w.client.state().issues[0].state, "closed");
    assert.deepEqual((await w.run("2026-10-09T06:40:00+09:00", { plan: fri })).ops, []);
    assert.deepEqual((await w.run("2026-10-09T07:05:00+09:00", { plan: fri })).ops, []);
  } finally { w.cleanup(); }
});

test("未到達の採点には、Entry 帯まであと何pips足りなかったかを添える（設計時刻〜有効期限の H1 足の高値から）", async () => {
  const w = world();
  try {
    const au = by(ALL, "AUDUSD"); // 買い 帯 0.65580〜0.65600
    const p = withDesign(2, "2026-10-08T15:30:00+09:00", [au], { prev: [D1] });
    await w.run("2026-10-08T15:35:00+09:00", { plan: p });
    const d = candRow(au, "design", "2026-10-08T15:30:00+09:00");
    w.setLog([d, { ...d, run: "status", generated_at: "2026-10-09T06:20:00+09:00", reached: "未到達" }]);
    // H1 足: 設計後の安値の最小 0.65690（帯の上端 0.65600 まで 9.0pips）。設計前の足（安値 0.6500）は数えない
    const bar = (t, l, h) => ({ time_jst: t, o: h, h, l, c: h });
    w.put("h1-bars.json", { as_of: "2026-10-09T06:00:00+09:00", pairs: { AUDUSD: [bar("2026-10-08 14:00", 0.6500, 0.6600), bar("2026-10-08 16:00", 0.6700, 0.6720), bar("2026-10-08 22:00", 0.65690, 0.6571), bar("2026-10-09 02:00", 0.6695, 0.6705), bar("2026-10-09 03:00", 0.6600, 0.6610)] } });
    const nowMs = iso("2026-10-09T06:25:00+09:00");
    w.put("intraday.json", intraday(nowMs, {}));
    for (const n of ["daytrade-context.json"]) w.put(n, { as_of: J.jstIso(nowMs - 2 * 60000) });
    await runNotify({ dataDir: w.dir, nowMs, client: w.client, log: () => {} });
    const c = w.client.ops.filter((o) => o.op === "comment" && /採点の結果/.test(o.body)).pop();
    assert.match(c.body, /AUDUSD 買い 型A（Entry 0\.65580〜0\.65600）: 未到達（Entry帯まで 9pips 足りず）/);
  } finally { w.cleanup(); }
});

test("週末: 金曜の計画日は土曜 03:00 にまとめて閉じる。土日は Issue を作らない。月曜の設計①で新しい Issue", async () => {
  const w = world();
  try {
    const fri = plan((q) => { q.plan_date = "2026-10-09"; q.designs = [{ slot: 1, generated_at: "2026-10-09T06:10:00+09:00", inputs_ok: true }]; q.candidates = []; });
    await w.run("2026-10-09T06:15:00+09:00", { plan: fri });
    assert.equal(w.client.state().issues.length, 1);
    w.setLog([]);
    let r = await w.run("2026-10-10T03:05:00+09:00", { plan: fri });
    assert.deepEqual(kinds(r.ops), ["comment", "close"]);
    for (const t of ["2026-10-10T04:00:00+09:00", "2026-10-10T08:50:00+09:00"]) { const x = await w.run(t, { plan: fri }); assert.deepEqual(x.ops, [], t); }
    assert.equal(w.client.state().issues.length, 1);
    const mon = plan((q) => { q.plan_date = "2026-10-12"; q.designs = [{ slot: 1, generated_at: "2026-10-12T06:10:00+09:00", inputs_ok: true }]; q.candidates = [by(ALL, "EURUSD")]; });
    r = await w.run("2026-10-12T06:15:00+09:00", { plan: mon });
    assert.deepEqual(kinds(r.ops), ["create_issue"]);
    assert.equal(r.ops[0].title, "デイトレ 2026-10-12（月）");
    assert.equal(w.client.state().issues.length, 2);
  } finally { w.cleanup(); }
});

test("異常: 失敗の通知は1時間に1回（Issue が無ければ作る）。週末・月曜早朝は出さない", async () => {
  const w = world();
  try {
    const p = withDesign(1, "2026-10-08T06:10:00+09:00", []);
    await w.run("2026-10-08T06:15:00+09:00", { plan: p });
    let r = await w.run("2026-10-08T10:10:00+09:00", { failure: { run_url: "https://github.com/o/r/actions/runs/9" } });
    assert.deepEqual(kinds(r.ops), ["comment"]);
    assert.match(r.ops[0].body, /Daytrade Plan が失敗しました[\s\S]*実行: https:\/\/github\.com\/o\/r\/actions\/runs\/9/);
    assert.deepEqual((await w.run("2026-10-08T10:40:00+09:00", { failure: { run_url: "u" } })).ops, []);
    assert.deepEqual(kinds((await w.run("2026-10-08T11:10:00+09:00", { failure: { run_url: "u" } })).ops), ["comment"]);
    for (const t of ["2026-10-10T10:00:00+09:00", "2026-10-12T04:00:00+09:00"]) assert.deepEqual((await w.run(t, { failure: { run_url: "u" } })).ops, [], t);
    // Issue が無い日の失敗 → Issue を作ってからコメント。公開前かもしれない手元の計画は信用せず、候補を載せない本文（pending の印つき）で作る
    const w2 = world();
    try {
      w2.put("daytrade-plan.json", plan());
      const r2 = await w2.run("2026-10-08T07:10:00+09:00", { failure: { run_url: "https://github.com/o/r/actions/runs/1", detail: "Score previous plans（採点）" } });
      assert.deepEqual(kinds(r2.ops), ["create_issue", "comment"]);
      assert.match(r2.ops[0].body, /設計: 発注できる状態の設計はまだありません/);
      assert.ok(!/EURUSD|AUDUSD/.test(r2.ops[0].body));
      assert.deepEqual(D.parseMarkers(r2.ops[0].body), ["pending:2026-10-08"]);
      assert.match(r2.ops[1].body, /失敗した手順: Score previous plans（採点）/);
    } finally { w2.cleanup(); }
  } finally { w.cleanup(); }
});

test("異常: 設計の窓が終わっても設計が無い／入力の更新が1時間止まっている → Issue（無ければ作る）にコメント。同じ出来事は1回。入力は1つのコメントにまとめる", async () => {
  const w = world();
  try {
    const noDesign = plan((q) => { q.designs = []; q.candidates = []; q.order_ok = false; q.design_missing = true; });
    let r = await w.run("2026-10-08T09:10:00+09:00", { plan: noDesign });
    assert.deepEqual(kinds(r.ops), ["create_issue", "comment"]);
    assert.match(r.ops[1].body, /設計①がありません/);
    assert.deepEqual((await w.run("2026-10-08T09:25:00+09:00", { plan: noDesign })).ops, []);
    // 入力が止まる: 3つのフィードが1つのコメント
    r = await w.run("2026-10-08T12:00:00+09:00", { plan: noDesign, feedAge: 75 });
    const cm = r.ops.filter((o) => o.op === "comment");
    assert.equal(cm.length, 1, "設計なしは出済み、入力停止は1つにまとめる");
    assert.match(cm[0].body, /入力の更新が止まっています/);
    for (const n of D.FEEDS.filter((x) => x !== "intraday.json")) assert.ok(cm[0].body.includes(`- ${n}:`), n);
    assert.deepEqual((await w.run("2026-10-08T12:15:00+09:00", { plan: noDesign, feedAge: 100 })).ops.filter((o) => o.op === "comment").length, 1, "as_of が変わる（新しい時刻が付かない）ので別の出来事として数える");
  } finally { w.cleanup(); }
});

test("通知が途中で失敗しても、マーカーが付かなかった通知は次の実行で出る（取りこぼさない・二重にもしない）。log.csv が壊れていても止まらない", async () => {
  const w = world();
  try {
    const p = withDesign(1, "2026-10-08T06:10:00+09:00", sel(ALL, "EURUSD"));
    await w.run("2026-10-08T06:15:00+09:00", { plan: p });
    const p2 = withDesign(2, "2026-10-08T15:30:00+09:00", sel(ALL, "EURUSD", "GBPUSD"), { prev: [D1] });
    const flaky = { ...w.client, addComment: async () => { throw new Error("HTTP 502"); } };
    const r1 = await w.run("2026-10-08T15:35:00+09:00", { plan: p2, client: flaky });
    assert.equal(r1.errors.length, 1);
    assert.match(r1.errors[0], /今日の計画: HTTP 502/);
    assert.deepEqual(w.client.ops.filter((o) => o.op === "comment"), []);
    const r2 = await w.run("2026-10-08T15:50:00+09:00", { plan: p2 });
    assert.deepEqual(kinds(r2.ops), ["comment"]);
    assert.deepEqual((await w.run("2026-10-08T16:05:00+09:00", { plan: p2 })).ops, []);
    // log.csv が壊れている: 期限後でもまとめ・クローズをしない（次の実行で再試行）。ほかの通知は動く
    fs.writeFileSync(path.join(w.dir, "daytrade", "log.csv"), "broken\n");
    const r3 = await w.run("2026-10-09T03:10:00+09:00");
    assert.deepEqual(r3.ops, []);
    assert.deepEqual(r3.errors, []);
    assert.equal(w.client.state().issues[0].state, "open");
  } finally { w.cleanup(); }
});

test("公開される Issue: 本文・コメントのどこにも、口座の資金・損失上限・手数料が出ない", async () => {
  const w = world();
  try {
    const p = withDesign(2, "2026-10-08T15:30:00+09:00", sel(ALL, "EURUSD", "AUDUSD"), { prev: [D1] });
    await w.run("2026-10-08T15:35:00+09:00", { plan: p, prices: { EURUSD: 1.1041 } });
    await w.run("2026-10-08T21:35:00+09:00", { plan: withDesign(3, "2026-10-08T21:30:00+09:00", [], { prev: [D1] }) });
    w.setLog([]);
    await w.run("2026-10-09T03:10:00+09:00");
    const text = w.client.ops.map((o) => o.body || "").join("\n");
    assert.ok(text.length > 500);
    assert.ok(!/500000|3000000|500,000|3,000,000|equity|損失上限|手数料|7,500|45,000/i.test(text));
    assert.match(text, /上限ロット A=0\.16 \/ B=1\.00/);
  } finally { w.cleanup(); }
});

// ================= レビューの指摘に対応する試験 =================
const BOTU = { login: "github-actions[bot]", type: "Bot" };
const ATTACKER = { login: "someone-else", type: "User" };
const D2 = { slot: 2, generated_at: "2026-10-08T15:30:00+09:00", inputs_ok: true };
const D3 = { slot: 3, generated_at: "2026-10-08T21:30:00+09:00", inputs_ok: true };
const ops = (client, kind) => client.ops.filter((o) => o.op === kind);
const forge = (client, number, text, user = ATTACKER) => { const i = client.state().issues.find((x) => x.number === number); i.comments.push({ id: 9000 + i.comments.length, body: text, created_at: null, user }); };

test("偽のマーカー: 他の人のコメントにマーカーがあっても読まない（通知を止められない・増やされない）。bot 以外が作った同じ題名の Issue も使わない", async () => {
  const w = world();
  try {
    const p1 = withDesign(1, "2026-10-08T06:10:00+09:00", sel(ALL, "AUDUSD", "EURUSD"));
    await w.run("2026-10-08T06:15:00+09:00", { plan: p1 });
    // 外の人が、これから出る通知の印を先に書き込む
    const gb = vOf(ALL, "GBPUSD"), eu = vOf(ALL, "EURUSD");
    forge(w.client, 1, [D.markerOf(D.K.new(gb)), D.markerOf(D.K.near(eu)), D.markerOf(D.K.summary("2026-10-08")), D.markerOf(D.K.nodesign("2026-10-08", 2)), D.markerOf(D.K.cancel(vOf(ALL, "AUDUSD")))].join("\n"));
    const p2 = withDesign(2, "2026-10-08T15:30:00+09:00", sel(ALL, "AUDUSD", "EURUSD", "GBPUSD"), { prev: [D1] });
    let r = await w.run("2026-10-08T15:35:00+09:00", { plan: p2 });
    assert.deepEqual(kinds(r.ops), ["comment"]);
    assert.match(r.ops[0].body, /新しい案 1件[\s\S]*GBPUSD 売り 型A/); // 偽の new: に止められない
    r = await w.run("2026-10-08T16:35:00+09:00", { prices: { EURUSD: 1.1041 } });
    assert.match(r.ops[0].body, /EURUSD 売り：帯に到達/); // 偽の near: に止められない
    // 偽の cancel: が付いても、案を出し直したりしない
    assert.deepEqual((await w.run("2026-10-08T16:50:00+09:00", { prices: { EURUSD: 1.1041 } })).ops, []);
    // 期限後のまとめ・クローズも、偽の summary: に止められない
    w.setLog([]);
    r = await w.run("2026-10-09T03:05:00+09:00");
    assert.deepEqual(kinds(r.ops), ["comment", "close"]);
    assert.match(r.ops[0].body, /計画日 2026-10-08 が終了しました/);
    // bot 以外が作った（ラベル付きの）同じ題名の Issue は対象にしない → bot が自分の Issue を作る
    const w2 = world();
    try {
      const fake = { issues: [{ number: 1, title: "デイトレ 2026-10-08（木）", state: "open", body: `${D.markerOf(D.K.design("2026-10-08"))}${D.markerOf(D.K.new(vOf(ALL, "EURUSD")))}`, labels: ["daytrade"], comments: [], user: ATTACKER }] };
      const c2 = createMemoryClient(fake);
      const rr = await runNotify({ dataDir: w2.dir, nowMs: iso("2026-10-08T06:15:00+09:00"), client: c2, log: () => {} }).catch((e) => e);
      assert.ok(!(rr instanceof Error));
      w2.put("daytrade-plan.json", withDesign(1, "2026-10-08T06:10:00+09:00", sel(ALL, "EURUSD")));
      w2.put("intraday.json", intraday(iso("2026-10-08T06:15:00+09:00"), {}));
      for (const n of ["h1-bars.json", "daytrade-context.json"]) w2.put(n, { as_of: J.jstIso(iso("2026-10-08T06:13:00+09:00")) });
      await runNotify({ dataDir: w2.dir, nowMs: iso("2026-10-08T06:15:00+09:00"), client: c2, log: () => {} });
      assert.equal(ops(c2, "create_issue").length, 1);
      assert.equal(c2.state().issues.find((i) => i.number !== 1).user.login, "github-actions[bot]");
    } finally { w2.cleanup(); }
  } finally { w.cleanup(); }
});

test("同じ題名の Issue が複数あれば、開いているもの・新しいものを使う（古い閉じた Issue に書かない）", async () => {
  const w = world();
  try {
    const mkIssue = (number, state) => ({ number, title: "デイトレ 2026-10-08（木）", state, body: D.markerOf(D.K.design("2026-10-08")), labels: ["daytrade"], comments: [] });
    const client = createMemoryClient({ issues: [mkIssue(1, "closed"), mkIssue(2, "open"), mkIssue(3, "open")] }); // 3 が最新
    w.client = client;
    const p = withDesign(2, "2026-10-08T15:30:00+09:00", sel(ALL, "EURUSD"), { prev: [D1] });
    await w.run("2026-10-08T15:35:00+09:00", { plan: p, client });
    const r = await w.run("2026-10-08T16:35:00+09:00", { prices: { EURUSD: 1.1041 }, client });
    assert.deepEqual(client.ops.map((o) => [o.op, o.number]), [["comment", 3], ["comment", 3]]); // 新しい案 → 帯。どちらも最新の開いている Issue
    assert.equal(r.errors.length, 0);
    const c2 = createMemoryClient({ issues: [mkIssue(1, "open"), mkIssue(2, "closed")] }); // 開いているものを優先（古くても）
    w.client = c2;
    await w.run("2026-10-08T16:40:00+09:00", { plan: p, prices: { EURUSD: 1.1041 }, client: c2 });
    assert.deepEqual(c2.ops.map((o) => o.number), [1, 1]);
  } finally { w.cleanup(); }
});

test("Issue を作るのに失敗したら、同じ実行で重ねて作らない（作られていれば、次の実行が見つける）", async () => {
  const w = world();
  try {
    let creates = 0;
    const flaky = { ...w.client, createIssue: async (x) => { creates++; throw new Error("HTTP 502 応答が返らない"); } };
    // 設計②だけの計画（設計①の異常もある）。今日の計画の Issue 作成が失敗 → 異常の通知では作り直さない
    const p = withDesign(2, "2026-10-08T15:30:00+09:00", sel(ALL, "EURUSD"), { prev: [] });
    const r = await w.run("2026-10-08T15:35:00+09:00", { plan: p, client: flaky });
    assert.equal(creates, 1);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /今日の計画/);
    assert.equal(w.client.state().issues.length, 0);
  } finally { w.cleanup(); }
});

test("異常が先に出て作られた Issue: 設計①の結果（候補0件でも）を、最初の設計ができた実行でコメントする。候補は重ねて通知しない", async () => {
  const w = world();
  try {
    let r = await w.run("2026-10-08T06:20:00+09:00", { failure: { run_url: "https://github.com/o/r/actions/runs/1" } });
    assert.deepEqual(kinds(r.ops), ["create_issue", "comment"]);
    // 設計①: 候補0件 → 『設計の結果』のコメント（本文は書き換えない）
    const p0 = withDesign(1, "2026-10-08T06:30:00+09:00", []);
    r = await w.run("2026-10-08T06:35:00+09:00", { plan: p0 });
    assert.deepEqual(kinds(r.ops), ["comment"]);
    assert.match(r.ops[0].body, /^@MFlab-inc 設計の結果/);
    assert.match(r.ops[0].body, /設計①（06:30）時点の候補: \*\*0件\*\*[\s\S]*候補はありません/);
    assert.deepEqual((await w.run("2026-10-08T06:50:00+09:00", { plan: p0 })).ops, []);
    // 候補があるとき: 1つのコメントに要点。『新しい案』を別に重ねない。設計②の追加分だけが新しい案
    const w2 = world();
    try {
      await w2.run("2026-10-08T06:20:00+09:00", { failure: { run_url: "https://github.com/o/r/actions/runs/2" } });
      const p1 = withDesign(1, "2026-10-08T06:30:00+09:00", sel(ALL, "AUDUSD", "EURUSD"));
      const a = await w2.run("2026-10-08T06:35:00+09:00", { plan: p1 });
      assert.deepEqual(kinds(a.ops), ["comment"]);
      assert.match(a.ops[0].body, /^@MFlab-inc 設計の結果[\s\S]*候補: \*\*2件\*\*[\s\S]*AUDUSD 買い 型A[\s\S]*EURUSD 売り 型A/);
      assert.deepEqual((await w2.run("2026-10-08T06:50:00+09:00", { plan: p1 })).ops, []);
      const p2 = withDesign(2, "2026-10-08T15:30:00+09:00", sel(ALL, "AUDUSD", "EURUSD", "GBPUSD"), { prev: [D1] });
      const b = await w2.run("2026-10-08T15:35:00+09:00", { plan: p2 });
      assert.deepEqual(kinds(b.ops), ["comment"]);
      assert.match(b.ops[0].body, /新しい案 1件[\s\S]*GBPUSD/);
      assert.ok(!/AUDUSD|EURUSD/.test(b.ops[0].body));
    } finally { w2.cleanup(); }
  } finally { w.cleanup(); }
});

test("同じ実行で Issue を作ってから異常が見つかっても、Issue は1つだけ（設計②からの運用開始日など）", async () => {
  const w = world();
  try {
    const p = withDesign(2, "2026-10-08T15:30:00+09:00", sel(ALL, "EURUSD"), { prev: [] });
    const r = await w.run("2026-10-08T15:35:00+09:00", { plan: p });
    assert.deepEqual(kinds(r.ops), ["create_issue", "comment"]);
    assert.match(r.ops[0].body, /設計②（15:30）時点の候補: \*\*1件\*\*/); // 設計②で作った Issue の見出しは設計②
    assert.match(r.ops[1].body, /設計①がありません/);
    assert.equal(w.client.state().issues.length, 1);
    assert.equal(r.ops[1].number, r.ops[0].number);
  } finally { w.cleanup(); }
});

test("まとめを書いたあとで閉じるのに失敗したら、次の実行は閉じるだけ（まとめを重ねない）。まとめの印が付いている", async () => {
  const w = world();
  try {
    const p = withDesign(3, "2026-10-08T21:30:00+09:00", sel(ALL, "EURUSD"), { prev: [D1, D2] });
    await w.run("2026-10-08T21:35:00+09:00", { plan: p });
    w.setLog([]);
    let closes = 0;
    const flaky = { ...w.client, closeIssue: async (n) => { closes++; if (closes === 1) throw new Error("HTTP 502"); return w.client.closeIssue(n); } };
    const r1 = await w.run("2026-10-09T03:05:00+09:00", { client: flaky });
    assert.deepEqual(kinds(r1.ops), ["comment"]);
    assert.equal(r1.errors.length, 1);
    assert.deepEqual(D.parseMarkers(r1.ops[0].body), ["summary:2026-10-08"]);
    assert.equal(w.client.state().issues[0].state, "open");
    const r2 = await w.run("2026-10-09T03:20:00+09:00");
    assert.deepEqual(kinds(r2.ops), ["close"]);
    assert.deepEqual((await w.run("2026-10-09T03:35:00+09:00")).ops, []);
  } finally { w.cleanup(); }
});

test("運用開始の日: 採点の行があっても、Issue の無い計画日には Issue を作らない（さかのぼって作らない）", async () => {
  const w = world();
  try {
    const eu = by(ALL, "EURUSD");
    const d = candRow({ ...eu, plan_date: "2026-10-07" }, "design", "2026-10-07T15:30:00+09:00");
    w.setLog([{ ...d, plan_date: "2026-10-07" }, { ...d, plan_date: "2026-10-07", run: "status", generated_at: "2026-10-08T06:20:00+09:00", reached: "未到達" }]);
    const p = withDesign(1, "2026-10-08T06:10:00+09:00", []);
    const r = await w.run("2026-10-08T06:25:00+09:00", { plan: p });
    assert.deepEqual(kinds(r.ops), ["create_issue"]);
    assert.equal(r.ops[0].title, "デイトレ 2026-10-08（木）");
    assert.equal(w.client.state().issues.length, 1);
  } finally { w.cleanup(); }
});

test("日付が変わる・週末をまたぐ: 昨日の計画のままの朝は新しい計画日の Issue。月曜の最初の実行で、金曜の Issue をまとめて閉じ、採点を書き、月曜の Issue を作る", async () => {
  const w = world();
  try {
    // 火曜 06:30、plan.json はまだ月曜のもの。失敗の通知 → 火曜の題名で作る
    const mon = plan((q) => { q.plan_date = "2026-10-12"; q.designs = [{ slot: 1, generated_at: "2026-10-12T06:10:00+09:00", inputs_ok: true }]; q.candidates = [by(ALL, "EURUSD")]; });
    const r = await w.run("2026-10-13T06:30:00+09:00", { plan: mon, failure: { run_url: "https://github.com/o/r/actions/runs/3" } });
    assert.equal(r.ops[0].title, "デイトレ 2026-10-13（火）");
    assert.ok(!/EURUSD/.test(r.ops[0].body));
    // 金曜の Issue（開いたまま）→ 週末に実行なし → 月曜
    const w2 = world();
    try {
      const fri = plan((q) => { q.plan_date = "2026-10-09"; q.designs = [{ slot: 1, generated_at: "2026-10-09T06:10:00+09:00", inputs_ok: true }]; q.candidates = [by(ALL, "EURUSD")]; });
      await w2.run("2026-10-09T06:15:00+09:00", { plan: fri });
      const eu = by(ALL, "EURUSD");
      const d = { ...candRow({ ...eu, plan_date: "2026-10-09" }, "design", "2026-10-09T06:10:00+09:00"), plan_date: "2026-10-09", expires_at: "2026-10-10T03:00:00+09:00" };
      w2.setLog([d, { ...d, run: "status", generated_at: "2026-10-12T06:20:00+09:00", reached: "到達", reached_at: "2026-10-09T20:00:00+09:00", first_hit_a: "TP1", first_hit_b: "TP1" }]);
      const monPlan = plan((q) => { q.plan_date = "2026-10-12"; q.designs = [{ slot: 1, generated_at: "2026-10-12T06:10:00+09:00", inputs_ok: true }]; q.candidates = []; });
      const m = await w2.run("2026-10-12T06:25:00+09:00", { plan: monPlan });
      assert.deepEqual(m.ops.map((o) => [o.op, o.title]), [["comment", "デイトレ 2026-10-09（金）"], ["close", "デイトレ 2026-10-09（金）"], ["comment", "デイトレ 2026-10-09（金）"], ["create_issue", "デイトレ 2026-10-12（月）"]]);
      assert.match(m.ops[0].body, /計画日 2026-10-09 が終了しました/);
      assert.match(m.ops[2].body, /採点の結果（計画日 2026-10-09）[\s\S]*到達（10-09 20:00の足） ／ A案 TP1先、B案 TP1先/);
      assert.deepEqual((await w2.run("2026-10-12T06:40:00+09:00", { plan: monPlan })).ops, []);
    } finally { w2.cleanup(); }
  } finally { w.cleanup(); }
});

test("設計の窓が3つとも終わって設計が無いとき、枠ごとに別のコメント（それぞれの枠を名指し）", async () => {
  const w = world();
  try {
    const none = plan((q) => { q.designs = []; q.candidates = []; q.order_ok = false; q.design_missing = true; });
    const r = await w.run("2026-10-08T23:10:00+09:00", { plan: none });
    assert.deepEqual(kinds(r.ops), ["create_issue", "comment", "comment", "comment"]);
    assert.deepEqual(r.ops.slice(1).map((o) => /設計(①|②|③)がありません/.exec(o.body)[1]), ["①", "②", "③"]);
    assert.deepEqual(r.ops.slice(1).map((o) => D.parseMarkers(o.body)), [["nodesign:2026-10-08:1"], ["nodesign:2026-10-08:2"], ["nodesign:2026-10-08:3"]]);
    assert.deepEqual((await w.run("2026-10-08T23:25:00+09:00", { plan: none })).ops, []);
  } finally { w.cleanup(); }
});

test("コメントを読み切れない・ラベルの用意に失敗する: 読み切れなければ何も書かない（二重に通知しない）。ラベルの失敗は Issue の作成を止めない（1回の実行で1回だけ用意する）", async () => {
  const w = world();
  try {
    const p = withDesign(1, "2026-10-08T06:10:00+09:00", sel(ALL, "EURUSD"));
    await w.run("2026-10-08T06:15:00+09:00", { plan: p });
    forge(w.client, 1, "x", BOTU); // コメントがある Issue（読む必要がある）
    let adds = 0;
    const cut = { ...w.client, listComments: async () => { throw new Error("GET /issues/1/comments: 3000件を超えていて読み切れません"); }, addComment: async () => { adds++; } };
    const p2 = withDesign(2, "2026-10-08T15:30:00+09:00", sel(ALL, "EURUSD", "GBPUSD"), { prev: [D1] });
    const r = await w.run("2026-10-08T15:35:00+09:00", { plan: p2, client: cut });
    assert.equal(adds, 0);
    assert.ok(r.errors.length >= 1 && r.errors.every((e) => /読み切れません/.test(e)));
    const w2 = world();
    try {
      let labels = 0;
      const nolabel = { ...w2.client, ensureLabel: async () => { labels++; throw new Error("HTTP 403"); } };
      const rr = await w2.run("2026-10-08T06:15:00+09:00", { plan: p, client: nolabel });
      assert.deepEqual(kinds(rr.ops), ["create_issue"]);
      assert.equal(labels, 1);
      assert.deepEqual(rr.errors, []);
    } finally { w2.cleanup(); }
  } finally { w.cleanup(); }
});
