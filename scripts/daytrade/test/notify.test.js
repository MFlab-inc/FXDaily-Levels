"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../notify/detect");
const F = require("../notify/format");
const { candRow } = require("../plan");
const L = require("../log");
const J = require("../jst");

/**
 * ■2 Issue 通知の判定と文面（純関数）。同じ出来事を二重に通知しない／取消のあとに同じ案が戻ったら出し直す／日付が変わる・週末の扱い。
 * 模擬データ: 2026-10-08（木）の設計②（15:30）= AUDUSD 買い・EURUSD 売り・XAUUSD 買い・GBPUSD 売り（型A）の4件。EURUSD に 15:25〜16:10 のイベント停止。
 */
const { iso, BASE, basePlan, plan, by, vOf, intraday } = require("./notify-fixture");
const NOW = iso("2026-10-08T16:30:00+09:00");

test("マーカー: 鍵は本文の隠しコメントに残り、書いた順に読める。'--' は壊れないよう置き換える", () => {
  const body = `x\n${D.markerOf("new:a|b")}\ntext\n${D.markerOf("near:c")}\n${D.markerOf("fail:2026-10-08 10")}`;
  assert.deepEqual(D.parseMarkers(body), ["new:a|b", "near:c", "fail:2026-10-08 10"]);
  assert.deepEqual(D.parseMarkers(null), []);
  assert.equal(D.markerOf("a--b"), "<!-- daytrade-notify key=a-_b -->");
  assert.equal(D.K.new("a--b"), "new:a-_b"); // 鍵とマーカーは同じ置き換えを通る
  assert.deepEqual(D.parseMarkers(D.markerOf(D.K.stale("intraday.json", "2026-10-08T10:00:00+09:00"))), [D.K.stale("intraday.json", "2026-10-08T10:00:00+09:00")]);
});

test("版の鍵: log.csv と同じ（plan_date|型|銘柄|向き|Entry帯|SL）。設計をやり直して generated_at が変わっても、値が同じなら同じ版", () => {
  const c = by(BASE, "EURUSD");
  assert.equal(D.versionKey(c), "2026-10-08|A|EURUSD|sell|1.104|1.1042|1.105|1.106");
  assert.equal(D.versionKey(c), L.keyOf(candRow(c, "design", "x")));
  assert.equal(D.versionKey({ ...c, generated_at: "2026-10-08T21:00:00+09:00", rank: 9 }), D.versionKey(c));
  assert.equal(D.parseVersionKey(D.versionKey(c)).symbol, "EURUSD");
});

test("新しい案: 初回は全部。通知済みなら出さない（同じ出来事は1回だけ）", () => {
  const p = plan();
  const e1 = D.candidateEvents({ nowMs: NOW, plan: p, intraday: null, markers: [] });
  assert.equal(e1.active, true);
  assert.deepEqual(e1.newCands.map((c) => c.symbol), ["AUDUSD", "EURUSD", "XAUUSD", "GBPUSD"]); // 順位順
  assert.deepEqual(e1.cancelled, []);
  const markers = e1.newCands.map((c) => D.K.new(D.versionKey(c)));
  const e2 = D.candidateEvents({ nowMs: NOW, plan: p, intraday: null, markers });
  assert.deepEqual([e2.newCands, e2.cancelled, e2.near], [[], [], []]);
  // 一部だけ通知済み（Issue の本文にあった案）なら、残りだけ
  const e3 = D.candidateEvents({ nowMs: NOW, plan: p, intraday: null, markers: markers.slice(0, 2) });
  assert.deepEqual(e3.newCands.map((c) => c.symbol), ["XAUUSD", "GBPUSD"]);
});

test("取消: 通知した案が計画から消えたら1回だけ取消を出す。取消のあとに同じ案が戻ったら、新しい案としてもう一度出す", () => {
  const p = plan();
  const all = p.candidates.map((c) => D.K.new(D.versionKey(c)));
  const gone = plan((q) => { q.candidates = q.candidates.filter((c) => c.symbol !== "GBPUSD"); });
  const e1 = D.candidateEvents({ nowMs: NOW, plan: gone, intraday: null, markers: all });
  assert.deepEqual(e1.cancelled.map((x) => x.info.symbol), ["GBPUSD"]);
  assert.equal(e1.cancelled[0].v, vOf(p, "GBPUSD"));
  assert.deepEqual(e1.newCands, []);
  // 取消を通知したあとは、案が無いままなら重ねて出さない
  const m2 = [...all, D.K.cancel(vOf(p, "GBPUSD"))];
  const e2 = D.candidateEvents({ nowMs: NOW, plan: gone, intraday: null, markers: m2 });
  assert.deepEqual([e2.newCands, e2.cancelled], [[], []]);
  // 戻ってきた（同じ版）→ 新しい案として出し直す。さらに通知したあとは出さない
  const e3 = D.candidateEvents({ nowMs: NOW, plan: p, intraday: null, markers: m2 });
  assert.deepEqual(e3.newCands.map((c) => c.symbol), ["GBPUSD"]);
  const e4 = D.candidateEvents({ nowMs: NOW, plan: p, intraday: null, markers: [...m2, D.K.new(vOf(p, "GBPUSD"))] });
  assert.deepEqual([e4.newCands, e4.cancelled], [[], []]);
  // 再設計（帯が変わった）: 古い版の取消と、新しい版の新しい案が同時に出る
  const redesigned = plan((q) => { const c = by(q, "EURUSD"); c.band = { low: 1.1050, high: 1.1052 }; c.worst_entry = 1.1050; c.schemes.A.sl = 1.1060; c.schemes.B.sl = 1.1070; });
  const e5 = D.candidateEvents({ nowMs: NOW, plan: redesigned, intraday: null, markers: all });
  assert.deepEqual(e5.cancelled.map((x) => x.info.symbol), ["EURUSD"]);
  assert.deepEqual(e5.newCands.map((c) => c.symbol), ["EURUSD"]);
});

test("門: 発注できる状態でない計画・別の計画日・有効期限後・設計なし・週末の計画日では、新しい案も取消も出さない（入力の不調で案が消えても取消を出さない）", () => {
  const markers = BASE.candidates.map((c) => D.K.new(D.versionKey(c)));
  const none = (p, nowMs = NOW, mk = markers) => { const e = D.candidateEvents({ nowMs, plan: p, intraday: null, markers: mk }); return !e.active && !e.newCands.length && !e.cancelled.length && !e.near.length; };
  assert.ok(none(plan((q) => { q.order_ok = false; q.candidates = []; })));
  assert.ok(none(plan((q) => { q.order_ok = false; }), NOW, []));
  assert.ok(none(plan((q) => { q.designs = []; q.candidates = []; })));
  assert.ok(none(null));
  assert.ok(none(plan(), iso("2026-10-09T06:30:00+09:00"), [])); // 翌日の計画日（日付が変わった）。昨日の計画では何も出さない
  assert.ok(none(plan(), iso("2026-10-09T03:00:00+09:00"), [])); // 有効期限（翌03:00）ちょうど
  const sat = plan((q) => { q.plan_date = "2026-10-10"; });
  assert.ok(none(sat, iso("2026-10-10T10:00:00+09:00"), []));
  // 日付が変わる前（02:59）は、まだその計画日
  assert.equal(D.candidateEvents({ nowMs: iso("2026-10-09T02:59:00+09:00"), plan: plan(), intraday: null, markers: [] }).active, true);
});

test("帯への到達・接近: 帯の中=到達、帯から 0.1×H1 ATR（20pips→2pips）以内=近く、それより外は出さない。版ごとに1回", () => {
  const p = plan();
  const near = (prices, over = {}) => D.candidateEvents({ nowMs: over.nowMs ?? NOW, plan: p, intraday: "intraday" in over ? over.intraday : intraday(over.nowMs ?? NOW, prices, over.age ?? 1), markers: over.markers ?? [] }).near;
  // EURUSD 売り: 帯 1.10400〜1.10420
  let n = near({ EURUSD: 1.1041 });
  assert.deepEqual(n.map((x) => [x.c.symbol, x.kind, x.distance_pips]), [["EURUSD", "in_band", 0]]);
  assert.equal(near({ EURUSD: 1.1040 })[0].kind, "in_band"); // 帯の端はちょうど帯の中
  assert.equal(near({ EURUSD: 1.1042 })[0].kind, "in_band");
  n = near({ EURUSD: 1.1038 }); // 帯の下 2.0pips = ちょうど 0.1×ATR → 近く
  assert.deepEqual(n.map((x) => [x.kind, x.distance_pips]), [["near", 2]]);
  n = near({ EURUSD: 1.1044 }); // 帯の上 2.0pips
  assert.deepEqual(n.map((x) => [x.kind, x.distance_pips]), [["near", 2]]);
  assert.deepEqual(near({ EURUSD: 1.10379 }), []); // 2.1pips は外
  assert.deepEqual(near({ EURUSD: 1.1000 }), []);
  // 買い（AUDUSD 帯 0.65580〜0.65600）
  assert.equal(near({ AUDUSD: 0.6559 })[0].kind, "in_band");
  assert.equal(near({ AUDUSD: 0.6562 })[0].kind, "near");
  // 通知済み（版ごとに1回）。別の銘柄は別
  assert.deepEqual(near({ EURUSD: 1.1041, AUDUSD: 0.6559 }, { markers: [D.K.near(vOf(p, "EURUSD"))] }).map((x) => x.c.symbol), ["AUDUSD"]);
  // 価格が古い（20分より前）・価格が無い・intraday が無い → 出さない。20分ちょうどは可
  assert.deepEqual(near({ EURUSD: 1.1041 }, { age: 21 }), []);
  assert.equal(near({ EURUSD: 1.1041 }, { age: 20 }).length, 1);
  assert.deepEqual(near({}), []);
  assert.deepEqual(near({ EURUSD: 1.1041 }, { intraday: null }), []);
  assert.deepEqual(near({ EURUSD: NaN }), []);
});

test("帯への到達: 新規不可の時間帯・イベント停止中は、その理由を添える（出さないのではなく知らせる）", () => {
  const p = plan();
  const at = (s) => { const nowMs = iso(s); return D.candidateEvents({ nowMs, plan: p, intraday: intraday(nowMs, { EURUSD: 1.1041 }), markers: [] }).near[0]; };
  assert.deepEqual(at("2026-10-08T16:00:00+09:00").entry_reasons, ["停止中: 15:40 [EUR] ECB Speaks"]); // 停止 15:25〜16:10
  assert.deepEqual(at("2026-10-08T16:30:00+09:00").entry_reasons, []);
  assert.deepEqual(at("2026-10-08T09:30:00+09:00").entry_reasons, ["9時台"]);
  assert.deepEqual(at("2026-10-09T01:10:00+09:00").entry_reasons, ["翌1:00以降"]);
});

test("採点: 採点の行（run=status・到達/未到達/失効後到達）を1回だけ出す。取消は通知の対象にならないが一覧には入る。72時間より前の採点は出さない", () => {
  const c = by(BASE, "EURUSD"), a = by(BASE, "AUDUSD"), g = by(BASE, "GBPUSD");
  const design = (x) => candRow(x, "design", x.generated_at);
  const scored = (x, o) => ({ ...candRow(x, "design", x.generated_at), run: "status", generated_at: "2026-10-09T06:20:00+09:00", ...o });
  const rows = [
    design(c), design(a), design(g), design(by(BASE, "XAUUSD")),
    scored(c, { reached: "到達", reached_at: "2026-10-08T22:00:00+09:00", first_hit_a: "TP1", first_hit_b: "SL" }),
    scored(a, { reached: "未到達" }),
    scored(g, { reached: "取消(再設計)", generated_at: "2026-10-08T21:30:00+09:00" }),
  ];
  const now = iso("2026-10-09T06:30:00+09:00");
  const r = D.scoreEvents({ logRows: rows, planDate: "2026-10-08", markers: [], nowMs: now });
  assert.deepEqual(r.due.map((x) => x.row.symbol).sort(), ["AUDUSD", "EURUSD"]);
  assert.equal(r.all.length, 4);
  assert.deepEqual(r.all.map((x) => x.state).sort(), ["cancelled", "open", "scored", "scored"]);
  const m = r.due.map((x) => D.K.score(x.v));
  assert.deepEqual(D.scoreEvents({ logRows: rows, planDate: "2026-10-08", markers: m, nowMs: now }).due, []);
  assert.deepEqual(D.scoreEvents({ logRows: rows, planDate: "2026-10-08", markers: m.slice(0, 1), nowMs: now }).due.length, 1);
  assert.deepEqual(D.scoreEvents({ logRows: rows, planDate: "2026-10-08", markers: [], nowMs: iso("2026-10-12T06:21:00+09:00") }).due, []); // 採点から3日と1分
  assert.equal(D.scoreEvents({ logRows: rows, planDate: "2026-10-08", markers: [], nowMs: iso("2026-10-12T06:20:00+09:00") }).due.length, 2);
  assert.deepEqual(D.scoreEvents({ logRows: rows, planDate: "2026-10-07", markers: [], nowMs: now }).all, []);
});

test("計画日の終了: 有効期限（翌03:00）以後に1回。金曜の計画日は土曜03:00。まとめは版ごとの最終状態の件数", () => {
  const md = { nowMs: iso("2026-10-09T02:59:00+09:00"), issueDate: "2026-10-08", markers: [] };
  assert.equal(D.closeDue(md), false);
  assert.equal(D.closeDue({ ...md, nowMs: iso("2026-10-09T03:00:00+09:00") }), true);
  assert.equal(D.closeDue({ ...md, nowMs: iso("2026-10-09T03:00:00+09:00"), markers: [D.K.summary("2026-10-08")] }), false);
  assert.equal(D.closeDue({ nowMs: iso("2026-10-10T02:59:00+09:00"), issueDate: "2026-10-09", markers: [] }), false);
  assert.equal(D.closeDue({ nowMs: iso("2026-10-10T03:00:00+09:00"), issueDate: "2026-10-09", markers: [] }), true); // 金曜 → 土曜 03:00
  const c = by(BASE, "EURUSD"), a = by(BASE, "AUDUSD");
  const rows = [candRow(c, "design", c.generated_at), candRow(a, "design", a.generated_at), { ...candRow(a, "design", a.generated_at), run: "status", reached: "取消(再設計)" }];
  const s = D.daySummary({ logRows: rows, planDate: "2026-10-08", markers: [D.K.new("x"), D.K.new("y"), D.K.near("z")] });
  assert.deepEqual(s, { versions: 2, cancelled: 1, scored: 0, valid_at_expiry: 1, near_notified: 1, new_notified: 2 });
});

test("市場が動いている時間: 平日の計画日の JST 06:00〜翌02:59。月曜の早朝・土日は異常を出さない", () => {
  const op = (s) => D.isOperating(iso(s));
  assert.equal(op("2026-10-08T05:59:00+09:00"), false);
  assert.equal(op("2026-10-08T06:00:00+09:00"), true);
  assert.equal(op("2026-10-09T02:59:00+09:00"), true);
  assert.equal(op("2026-10-09T03:00:00+09:00"), false);
  assert.equal(op("2026-10-10T02:59:00+09:00"), true); // 金曜の計画日の続き
  assert.equal(op("2026-10-10T03:00:00+09:00"), false);
  assert.equal(op("2026-10-10T10:00:00+09:00"), false);
  assert.equal(op("2026-10-11T22:00:00+09:00"), false);
  assert.equal(op("2026-10-12T05:59:00+09:00"), false);
  assert.equal(op("2026-10-12T06:00:00+09:00"), true);
});

test("異常: 失敗は1時間に1回。設計の窓が終わっても設計が無ければ枠ごとに1回。入力が60分以上止まっていれば as_of ごとに1回。止まった時間帯・週末は出さない", () => {
  const feeds = (ageMin, nowMs) => D.FEEDS.map((name) => ({ name, as_of: J.jstIso(nowMs - ageMin * 60000) }));
  const withDesigns = (slots, okFlags = {}) => plan((q) => { q.designs = slots.map((s) => ({ slot: s, generated_at: "2026-10-08T06:10:00+09:00", inputs_ok: okFlags[s] !== false })); });
  // 失敗（設計①は済み・②の窓はまだ先、の状態で）
  const t = iso("2026-10-08T10:20:00+09:00");
  const ev = (nowMs, o = {}) => D.anomalyEvents({ nowMs, plan: o.plan === undefined ? withDesigns([1]) : o.plan, logRows: o.logRows ?? [], feeds: o.feeds ?? [], failure: o.failure ?? null, markers: o.markers ?? [] });
  const f = ev(t, { failure: { run_url: "u" } });
  assert.deepEqual(f.map((e) => e.key), ["fail:2026-10-08 10"]);
  assert.deepEqual(ev(iso("2026-10-08T10:50:00+09:00"), { failure: { run_url: "u" }, markers: ["fail:2026-10-08 10"] }), []);
  assert.deepEqual(ev(iso("2026-10-08T11:05:00+09:00"), { failure: { run_url: "u" }, markers: ["fail:2026-10-08 10"] }).map((e) => e.key), ["fail:2026-10-08 11"]);
  assert.deepEqual(ev(iso("2026-10-10T10:00:00+09:00"), { failure: { run_url: "u" } }), []); // 土曜
  assert.deepEqual(ev(iso("2026-10-12T04:00:00+09:00"), { failure: { run_url: "u" } }), []); // 月曜の早朝
  // 設計なし: ①の窓（夏時間 06:00〜09:00）が終わった 09:05
  const t1 = iso("2026-10-08T09:05:00+09:00");
  assert.deepEqual(ev(t1, { plan: withDesigns([]) }).map((e) => [e.kind, e.slot]), [["nodesign", 1]]);
  assert.deepEqual(ev(t1, { plan: withDesigns([1]) }), []);
  assert.deepEqual(ev(t1, { plan: withDesigns([1], { 1: false }) }).map((e) => e.slot), [1]); // 入力が整わず『済み』にならなかった設計は数えない
  assert.deepEqual(ev(t1, { plan: withDesigns([]), markers: ["nodesign:2026-10-08:1"] }), []);
  assert.deepEqual(ev(iso("2026-10-08T08:59:00+09:00"), { plan: withDesigns([]) }), []); // 窓の中
  assert.deepEqual(ev(iso("2026-10-08T17:00:00+09:00"), { plan: withDesigns([1]) }).map((e) => e.slot), [2]);
  assert.deepEqual(ev(iso("2026-10-08T23:00:00+09:00"), { plan: withDesigns([1, 2]) }).map((e) => e.slot), [3]);
  assert.deepEqual(ev(iso("2026-10-08T23:00:00+09:00"), { plan: withDesigns([1, 2, 3]) }), []);
  // 別の計画日の計画（日付が変わった直後）は、その日の設計として数えない
  assert.deepEqual(ev(iso("2026-10-09T09:05:00+09:00"), { plan: withDesigns([1, 2, 3]) }).map((e) => e.slot), [1]);
  // ログから（plan.json が別の日のとき）: 窓の中に生成した design 行があれば済み
  const row = { ...candRow(by(BASE, "EURUSD"), "design", "2026-10-09T06:10:00+09:00"), plan_date: "2026-10-09" };
  assert.deepEqual(ev(iso("2026-10-09T09:05:00+09:00"), { plan: withDesigns([]), logRows: [row] }), []);
  // 入力の停止
  const t2 = iso("2026-10-08T12:00:00+09:00");
  assert.deepEqual(ev(t2, { plan: withDesigns([1]), feeds: feeds(59, t2) }), []);
  const st = ev(t2, { plan: withDesigns([1]), feeds: feeds(60, t2) });
  assert.deepEqual(st.map((e) => [e.kind, e.name, e.age_min]), D.FEEDS.map((n) => ["stale", n, 60]));
  assert.deepEqual(ev(t2, { plan: withDesigns([1]), feeds: feeds(60, t2), markers: st.map((e) => e.key) }), []); // 同じ as_of は1回
  const t3 = iso("2026-10-08T12:15:00+09:00");
  assert.equal(ev(t3, { plan: withDesigns([1]), feeds: [{ name: "intraday.json", as_of: J.jstIso(t2 - 61 * 60000) }], markers: st.map((e) => e.key) }).length, 1); // as_of が違う（再び止まった）→ 出す
  const un = ev(t2, { plan: withDesigns([1]), feeds: [{ name: "h1-bars.json", as_of: null }] });
  assert.deepEqual(un.map((e) => [e.kind, e.age_min]), [["stale", null]]);
  assert.deepEqual(ev(iso("2026-10-10T12:00:00+09:00"), { feeds: feeds(600, iso("2026-10-10T12:00:00+09:00")) }), []); // 週末は止まっているのが普通
});

// ---- 文面 ----
test("題名: 『デイトレ 2026-10-13（火）』。日付を読み戻せる", () => {
  assert.equal(F.issueTitle("2026-10-13"), "デイトレ 2026-10-13（火）");
  assert.equal(F.issueTitle("2026-10-09"), "デイトレ 2026-10-09（金）");
  assert.equal(F.parseIssueDate("デイトレ 2026-10-13（火）"), "2026-10-13");
  assert.equal(F.parseIssueDate("デイトレ 2026-10-13"), null);
  assert.equal(F.parseIssueDate("デイトレ週次 2026-10-05週"), null);
});

test("Issue の本文: @MFlab-inc・候補の件数・各案の要点・通知済みの印。候補0件でも作る。設計が無い／発注できる状態でないときは候補を載せない", () => {
  const { body, keys } = F.issueBody({ planDate: "2026-10-08", plan: plan(), repoUrl: "https://github.com/o/r" });
  assert.match(body, /^@MFlab-inc /);
  assert.match(body, /設計②（15:30）時点の候補: \*\*4件\*\*/);
  assert.match(body, /不採用の内訳（件数）: 方向根拠なし 12/);
  assert.equal(keys.length, 4);
  for (const k of keys) assert.ok(body.includes(`<!-- daytrade-notify key=${k} -->`));
  assert.match(body, /\[2\] EURUSD 売り 型A/);
  assert.match(body, /Entry帯: 1\.10400〜1\.10420（最悪Entry 1\.10400）/);
  assert.match(body, /A案\(0\.5×ATR\): SL 1\.10500（10pips）／ TP1 1\.09005（139\.5pips）／ RR 13\.95 ／ 上限ロット A=0\.16 \/ B=1\.00/);
  assert.match(body, /B案\(1\.0×ATR\): SL 1\.10600（20pips）／ TP1 1\.09005（139\.5pips）／ RR 6\.98/);
  assert.match(body, /有効期限: 10-09 03:00/);
  assert.match(body, /確認条件: 帯に到達したあと、M15が基準価格（1\.10400）より下で陰線確定/);
  assert.match(body, /停止時間: 15:25〜16:10 \[EUR\] ECB Speaks/);
  assert.match(body, /https:\/\/github\.com\/o\/r\/blob\/main\/data\/daytrade-plan\.txt/);
  const zero = F.issueBody({ planDate: "2026-10-08", plan: plan((q) => { q.candidates = []; }) });
  assert.match(zero.body, /候補: \*\*0件\*\*/);
  assert.match(zero.body, /候補はありません/);
  assert.deepEqual(zero.keys, []);
  for (const p of [null, plan((q) => { q.designs = []; }), plan((q) => { q.order_ok = false; }), plan((q) => { q.plan_date = "2026-10-07"; })]) {
    const r = F.issueBody({ planDate: "2026-10-08", plan: p });
    assert.match(r.body, /設計: 発注できる状態の設計はまだありません/);
    assert.ok(!/EURUSD/.test(r.body));
    assert.deepEqual(r.keys, []);
  }
});

test("新しい案のコメント: 銘柄・向き・型・Entry帯・A/B案のSL・TP1・RR・口座ごとの上限ロット・有効期限・確認条件・停止時間。1回の実行分を1つに、鍵は案の数だけ", () => {
  const p = plan();
  const { body, keys } = F.newCandidatesComment({ cands: [by(p, "EURUSD"), by(p, "GBPUSD")], plan: p });
  assert.match(body, /^@MFlab-inc 新しい案 2件（15:30）/);
  assert.deepEqual(keys, [D.K.new(vOf(p, "EURUSD")), D.K.new(vOf(p, "GBPUSD"))]);
  assert.deepEqual(D.parseMarkers(body), keys);
  assert.match(body, /\[2\] EURUSD 売り 型A[\s\S]*\[4\] GBPUSD 売り 型A/);
  assert.match(body, /上限ロット A=0\.16 \/ B=1\.00/);
  // 不採用のA案は理由だけ、型Bの追加は印を付ける
  const q = plan((x) => { const c = by(x, "EURUSD"); c.schemes.A = { pass: false, reason: "rr_low", reason_text: "RR不足" }; c.run = "design-b"; });
  assert.match(F.newCandidatesComment({ cands: [by(q, "EURUSD")], plan: q }).body, /A案\(0\.5×ATR\): 不採用（RR不足）/);
  assert.match(F.newCandidatesComment({ cands: [by(q, "EURUSD")], plan: q }).body, /型A（型Bの追加 15:30）|型A（型Bの追加/);
  // 資金が未設定の口座は『未設定』
  const un = plan((x) => { x.accounts.A.equity_status = "unset"; });
  assert.match(F.newCandidatesComment({ cands: [by(un, "EURUSD")], plan: un }).body, /上限ロット A=未設定 \/ B=1\.00/);
});

test("取消のコメント: 再設計（同じ型・銘柄・向きの新しい案がある）か、該当なしか", () => {
  const p = plan();
  const old = { v: "2026-10-08|A|EURUSD|sell|1.1050|1.1052|1.106|1.107", info: D.parseVersionKey("2026-10-08|A|EURUSD|sell|1.1050|1.1052|1.106|1.107") };
  const other = { v: "2026-10-08|A|USDJPY|buy|150.1|150.2|149|148", info: D.parseVersionKey("2026-10-08|A|USDJPY|buy|150.1|150.2|149|148") };
  const r = F.cancelComment({ cancelled: [old, other], newCands: [by(p, "EURUSD")], nowMs: iso("2026-10-08T21:35:00+09:00") });
  assert.match(r.body, /^@MFlab-inc 案を取消しました（21:35）/);
  assert.match(r.body, /EURUSD 売り 型A（Entry 1\.10500〜1\.10520） → 再設計: 新しい案は 1\.10400〜1\.10420/);
  assert.match(r.body, /USDJPY 買い 型A（Entry 150\.100〜150\.200） → 該当する案なし/);
  assert.deepEqual(r.keys, [D.K.cancel(old.v), D.K.cancel(other.v)]);
});

test("帯のコメント: 『EURUSD 売り：帯に到達（現在値 ◯）。M15の確認条件を見る』。近いときは帯までのpips。新規不可の理由があれば添える", () => {
  const p = plan();
  const now = iso("2026-10-08T16:00:00+09:00");
  const ev = D.candidateEvents({ nowMs: now, plan: p, intraday: intraday(now, { EURUSD: 1.1041, AUDUSD: 0.6562 }), markers: [] }).near;
  const r = F.nearComment({ events: ev, nowMs: now });
  assert.match(r.body, /^@MFlab-inc AUDUSD 買い：帯の近く（現在値 0\.65620、帯まで 2pips）。M15の確認条件を見る/);
  assert.match(r.body, /\nEURUSD 売り：帯に到達（現在値 1\.10410）。M15の確認条件を見る/);
  assert.match(r.body, /確認条件: 帯に到達したあと、M15が基準価格（1\.10400）より下で陰線確定/);
  assert.match(r.body, /新規不可: 停止中: 15:40 \[EUR\] ECB Speaks/);
  assert.deepEqual(r.keys, ev.map((e) => D.K.near(e.v)));
});

test("採点・まとめ・異常の文面: 数字と状態だけ（判定文なし）。どれも @MFlab-inc で始まり、鍵のマーカーで終わる", () => {
  const c = by(BASE, "EURUSD"), a = by(BASE, "AUDUSD"), g = by(BASE, "GBPUSD");
  const d = (x) => candRow(x, "design", x.generated_at);
  const rows = [d(c), d(a), d(g), { ...d(c), run: "status", reached: "到達", reached_at: "2026-10-08T22:00:00+09:00", first_hit_a: "TP1", first_hit_b: "SL" }, { ...d(a), run: "status", reached: "未到達" }, { ...d(g), run: "status", reached: "取消(再設計)" }];
  const sc = D.scoreEvents({ logRows: rows, planDate: "2026-10-08", markers: [], nowMs: iso("2026-10-09T06:30:00+09:00") });
  const gaps = new Map([[D.versionKey(a), 1.9]]);
  rows.forEach((r) => { if (r.run === "status") r.generated_at = "2026-10-09T06:20:00+09:00"; });
  const s = F.scoreComment({ planDate: "2026-10-08", due: D.scoreEvents({ logRows: rows, planDate: "2026-10-08", markers: [], nowMs: iso("2026-10-09T06:30:00+09:00") }).due, all: sc.all, gaps });
  assert.match(s.body, /^@MFlab-inc 採点の結果（計画日 2026-10-08）/);
  assert.match(s.body, /- EURUSD 売り 型A（Entry 1\.10400〜1\.10420）: 到達（10-08 22:00の足） ／ A案 TP1先、B案 SL先/);
  assert.match(s.body, /- AUDUSD 買い 型A（Entry 0\.65580〜0\.65600）: 未到達（Entry帯まで 1\.9pips 足りず）/);
  assert.match(s.body, /- GBPUSD 売り 型A（Entry 1\.30400〜1\.30420）: 取消\(再設計\)/);
  assert.equal(s.keys.length, 2);
  const sm = F.summaryComment({ planDate: "2026-10-08", summary: { versions: 4, cancelled: 1, scored: 0, valid_at_expiry: 3, near_notified: 2, new_notified: 4 } });
  assert.match(sm.body, /計画日 2026-10-08 が終了しました（有効期限 10-09 03:00）/);
  assert.match(sm.body, /設計で出た案: 4件（取消 1件、期限まで有効だった案 3件）/);
  assert.match(sm.body, /採点は次の営業日の設計①の前に行い/);
  const f = F.anomalyComment({ evs: [{ kind: "failure", key: "fail:2026-10-08 10", failure: { run_url: "https://x/runs/1" } }], planDate: "2026-10-08" });
  assert.match(f.body, /\*\*Daytrade Plan が失敗しました\*\*/);
  assert.match(f.body, /実行: https:\/\/x\/runs\/1/);
  const nd = F.anomalyComment({ evs: [{ kind: "nodesign", key: "nodesign:2026-10-08:1", slot: 1, window: { start: iso("2026-10-08T06:00:00+09:00"), end: iso("2026-10-08T09:00:00+09:00") } }], planDate: "2026-10-08" });
  assert.match(nd.body, /設計①がありません\*\*（窓 06:00〜09:00 が終わりました。計画日 2026-10-08）/);
  const st = F.anomalyComment({ evs: [{ kind: "stale", key: "k1", name: "intraday.json", as_of: "2026-10-08T10:00:00+09:00", age_min: 75 }, { kind: "stale", key: "k2", name: "h1-bars.json", as_of: null, age_min: null }], planDate: "2026-10-08" });
  assert.match(st.body, /- intraday\.json: as_of 2026-10-08T10:00:00\+09:00（75分前）\n- h1-bars\.json: 読めません/);
  assert.deepEqual(st.keys, ["k1", "k2"]);
  for (const b of [s.body, sm.body, f.body, nd.body, st.body]) {
    assert.ok(b.startsWith("@MFlab-inc "));
    assert.ok(!/良い|悪い|緩い|厳しい|おすすめ|推奨/.test(b), "判定文を書かない");
  }
});

test("公開される Issue に、口座の資金・損失上限・手数料を書かない（上限ロットは plan.txt と同じく出す）", () => {
  const p = basePlan({ DAYTRADE_EQUITY_A: "123456", DAYTRADE_EQUITY_B: "7654321" });
  const all = [F.issueBody({ planDate: "2026-10-08", plan: p }).body, F.newCandidatesComment({ cands: p.candidates, plan: p }).body].join("\n");
  assert.ok(!/123456|7654321|equity|損失上限|手数料|commission/i.test(all));
  assert.ok(!/123,456|7,654,321/.test(all));
  assert.match(all, /上限ロット A=/);
});
