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
    // Issue が無い日の失敗 → Issue を作ってからコメント
    const w2 = world();
    try {
      w2.put("daytrade-plan.json", plan());
      const r2 = await w2.run("2026-10-08T07:10:00+09:00", { failure: { run_url: "u" } });
      assert.deepEqual(kinds(r2.ops), ["create_issue", "comment"]);
      assert.match(r2.ops[0].body, /設計②（15:30）時点の候補: \*\*4件\*\*/); // 設計があれば、その要点をのせる
      const w3 = world();
      try {
        w3.put("daytrade-plan.json", plan((q) => { q.order_ok = false; }));
        const r3 = await w3.run("2026-10-08T07:10:00+09:00", { failure: { run_url: "u" } });
        assert.match(r3.ops[0].body, /設計: 発注できる状態の設計はまだありません/); // 発注できる状態の設計が無ければ、候補は載せない
      } finally { w3.cleanup(); }
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
