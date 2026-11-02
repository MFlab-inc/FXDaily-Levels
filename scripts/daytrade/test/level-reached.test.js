"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const L = require("../log");
const V = require("../versions");
const J = require("../jst");
const N = require("../num");
const { pairOf } = require("../pairs");
const { buildDesign, candRow } = require("../plan");
const { render } = require("../render");
const { loadInputs } = require("../inputs");
const { makeScenario } = require("./scenario");
const { rm, jstAt, HR } = require("./helpers");

/**
 * ■3 同じ計画日・同じ水準の版が到達済みなら、出し直さない。
 * 対象: 同じ plan_date・型・銘柄・向きで、基準水準（売りは Entry 帯の下端、買いは上端）が同じ版が、すでに到達している（H1 で到達／取消(到達後)）とき。
 * その案は候補に出さず、不採用の理由『同じ水準は到達済み』に件数を出す（価格は書かない）。log.csv にも書かない。
 */
const noFeed = { status: "未取得", reason: "x", pairs: {} };
const cleanup = (...scs) => { for (const sc of scs) rm(path.dirname(sc.dataDir)); };
const inputsOf = (sc) => loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs, env: sc.env });
const design = (sc, o = {}) => buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: sc.nowMs, slot: o.slot ?? 2, prevPlan: o.prevPlan ?? null, logRows: o.logRows ?? [], shadowLogRows: o.shadowLogRows ?? [] });
const REASON = "同じ水準は到達済み";

// EURUSD（売り）の帯 1.10400〜1.10420（Pivot が基準水準）。bars: touchAt の足を帯に触れさせる／atrScale でH1の幅（=ATR）を変えて、SL の違う版を作る
const eurusdBars = ({ touchAt = null, atrScale = 1 } = {}) => (bars) => bars.map((b) => {
  let x = b;
  if (atrScale !== 1) { const mid = b.o; x = { ...b, h: Number((mid + (0.0020 * atrScale) / 2).toFixed(5)), l: Number((mid - (0.0020 * atrScale) / 2).toFixed(5)) }; }
  if (touchAt && b.t === jstAt("2026-10-08", touchAt)) x = { ...x, h: 1.1045, l: 1.1035 };
  return x;
});
const at = (nowIso, o = {}) => makeScenario({ nowIso, ...o });
const eu = (plan) => plan.candidates.find((c) => c.symbol === "EURUSD");

test("■3 実データの例: 2026-10-27 EURJPY 売り — 06:22 の版（基準水準 176.075）が 08:00 に到達済みなら、21:05 の設計③の版（同じ 176.075）は出さない", () => {
  // ログの行と H1 足は実データ（fixtures/cancelled-versions-2026-10.json）。21:05 の版の候補は、実データの plan.json の通りに作る代わりに、同じ水準の版として判定する
  const fx = require("./fixtures/cancelled-versions-2026-10.json").versions.find((v) => v.design.plan_date === "2026-10-27" && v.design.symbol === "EURJPY");
  const bars = fx.bars.map(([t, o, h, l, c]) => ({ t: J.parseJstLabel(t), o, h, l, c }));
  const rows = [fx.design, fx.cancel]; // 06:22 の版（15:05 に 取消(再設計) の行）
  const hist = V.reachedIdeas({ rows, planDate: "2026-10-27", barsByCode: { EURJPY: bars }, nowMs: J.parseIso("2026-10-27T21:05:52+09:00") });
  const v2 = { plan_date: "2026-10-27", setup: "A", symbol: "EURJPY", side: "sell", band: { low: 176.075, high: 176.094 } }; // 21:05 の版（SL が違うので鍵が違う）
  assert.equal(hist.suppresses(v2, "2026-10-27|A|EURJPY|sell|176.075|176.094|176.175|175.795"), true);
  // 取消の時刻（15:05）までに到達していない版なら、抑えない（取消の時刻より後の足は使わない）
  const early = V.reachedIdeas({ rows: [fx.design, { ...fx.cancel, generated_at: "2026-10-27T07:30:00+09:00" }], planDate: "2026-10-27", barsByCode: { EURJPY: bars }, nowMs: J.parseIso("2026-10-27T21:05:52+09:00") });
  assert.equal(early.suppresses(v2, "x"), false);
});

test("■3 設計で: 同じ水準の版が H1 で到達済みなら、SL の違う新しい版は候補に出さない。不採用の理由に件数が出る（価格なし）。log.csv にも書かない。取消の行は 取消(到達後)", () => {
  const sc1 = at("2026-10-08T06:30:00+09:00");
  const sc2 = at("2026-10-08T15:30:00+09:00", { barsEdit: { EURUSD: eurusdBars({ touchAt: "08:00", atrScale: 1.05 }) } });
  const ctrl = at("2026-10-08T15:30:00+09:00", { barsEdit: { EURUSD: eurusdBars({ atrScale: 1.05 }) } }); // 対照: 到達していない
  try {
    const first = design(sc1, { slot: 1 });
    const v1 = eu(first.plan);
    assert.deepEqual([v1.band.low, v1.band.high, v1.schemes.A.sl], [1.104, 1.1042, 1.105]);
    // 対照: 08:00 の足が帯に触れていなければ、ATR が変わって SL が違う版は、新しい版として出る（今までどおり）
    const c = design(ctrl, { slot: 2, prevPlan: first.plan, logRows: first.logAppend });
    assert.ok(eu(c.plan), "到達していなければ出し直す");
    assert.notEqual(eu(c.plan).schemes.A.sl, v1.schemes.A.sl);
    assert.equal(c.plan.summary.extra[REASON], 0);
    // 本番: V1 は 08:00 に到達済み
    const d = design(sc2, { slot: 2, prevPlan: first.plan, logRows: first.logAppend });
    assert.equal(eu(d.plan), undefined, "同じ水準は候補に出さない");
    assert.deepEqual(d.plan.candidates.map((x) => x.symbol).sort(), ["AUDUSD", "GBPUSD", "XAUUSD"]);
    assert.equal(d.plan.summary.extra[REASON], 2, "A案・B案の2件");
    assert.equal(d.plan.summary.rejections.sl_narrow, c.plan.summary.rejections.sl_narrow, "6分類の件数は増えない");
    const cases = d.plan.summary.rejected_cases.filter((r) => r.reason === "level_reached");
    assert.deepEqual(cases.map((r) => [r.symbol, r.setup, r.scheme, r.reason_text, r.counted, r.detail]), [["EURUSD", "A", "A", REASON, false, null], ["EURUSD", "A", "B", REASON, false, null]]);
    // ログ: 新しい版の design の行は書かない。V1 は 取消(到達後)（H1 の 08:00）
    assert.ok(!d.logAppend.some((r) => r.run === "design" && r.symbol === "EURUSD"));
    const cancel = d.logAppend.find((r) => r.symbol === "EURUSD");
    assert.deepEqual([cancel.run, cancel.reached, cancel.reached_at], ["status", "取消(到達後)", "2026-10-08T08:00:00+09:00"]);
    assert.equal(L.keyOf(cancel), L.keyOf(first.logAppend.find((r) => r.symbol === "EURUSD")));
    // txt: 6分類に数えない理由に件数が出る。EURUSD の行に価格は出ない
    const txt = render(d.plan, d.plan.accounts);
    assert.match(txt, /6分類に数えない理由: 基準水準なし \d+ ／ 障害なし \d+ ／ 入力欠落 \d+ ／ 同じ水準は到達済み 2/);
    const line = txt.split("\n").find((l) => /EURUSD 型A A案: 同じ水準は到達済み/.test(l));
    assert.equal(line.trim(), "EURUSD 型A A案: 同じ水準は到達済み（6分類外）");
    assert.ok(!/1\.1040|1\.1042|1\.105/.test(txt.split("== 4.")[0].split("== 3.")[1].split("── 参考情報")[0]), "不採用の一覧に価格を書かない");
  } finally { cleanup(sc1, sc2, ctrl); }
});

test("■3 同じ版が続くだけなら出し直しではない: 到達済みでも、鍵（Entry帯・SL）が同じ版は、そのまま続く（取消も追記もしない）", () => {
  // 同じ入力（同じ ATR・同じ水準）で 06:30 に設計した版 V1 を、23:05 の設計で再び評価する。V1 は 08:00 の足で到達済み
  const sc = at("2026-10-08T23:05:00+09:00", { barsEdit: { EURUSD: eurusdBars({ touchAt: "08:00" }) } });
  try {
    const first = buildDesign({ inputs: inputsOf(sc), riskFeed: noFeed, nowMs: J.parseIso("2026-10-08T06:30:00+09:00"), slot: 1, prevPlan: null, logRows: [] });
    const v1 = first.logAppend.find((r) => r.symbol === "EURUSD");
    assert.ok(v1 && v1.entry_low === "1.10400");
    const d = design(sc, { slot: 2, prevPlan: first.plan, logRows: first.logAppend });
    assert.ok(eu(d.plan), "同じ版は続く");
    assert.equal(L.keyOf(candRow(eu(d.plan), "design", "x")), L.keyOf(v1));
    assert.equal(d.plan.summary.extra[REASON], 0);
    assert.deepEqual(d.logAppend, []);
    assert.equal(V.reachedIdeas({ rows: first.logAppend, planDate: "2026-10-08", barsByCode: inputsOf(sc).h1, nowMs: sc.nowMs }).ideas.size >= 1, true, "V1 は到達済みの水準として数えられている");
  } finally { cleanup(sc); }
});

test("■3 抑えるのは同じ型・銘柄・向き・計画日・水準だけ。別の水準・別の型・向き・計画日、失効後到達、取消の時刻より後の到達は抑えない", () => {
  const D = "2026-10-08";
  const bar = (hm, h, l, date = D) => ({ t: jstAt(date, hm), o: (h + l) / 2, h, l, c: (h + l) / 2 });
  const row = (o = {}) => ({ ...Object.fromEntries(L.COLUMNS.map((c) => [c, ""])), plan_date: D, generated_at: "2026-10-08T06:30:00+09:00", run: "design", setup: "A", symbol: "EURUSD", side: "sell", entry_low: "1.10400", entry_high: "1.10420", sl_a: "1.10500", tp_a: "1.09900", expires_at: "2026-10-09T03:00:00+09:00", ...o });
  const cand = (o = {}) => ({ plan_date: D, setup: "A", symbol: "EURUSD", side: "sell", band: { low: 1.104, high: 1.1042 }, ...o });
  const reach = [bar("08:00", 1.1045, 1.1035)]; // 帯に届く足
  const ctx = (rows, bars = reach, now = J.parseIso("2026-10-08T15:30:00+09:00")) => V.reachedIdeas({ rows, planDate: D, barsByCode: { EURUSD: bars }, nowMs: now });
  // 有効な版（最後の行が design）が H1 で到達 → 別の鍵の同じ水準は抑える／同じ鍵は続く
  const open = ctx([row()]);
  assert.equal(open.suppresses(cand(), "別の鍵"), true);
  assert.equal(open.suppresses(cand(), L.keyOf(row())), false);
  // 別の型・向き・銘柄・計画日・水準
  for (const [name, c] of Object.entries({ 型B: cand({ setup: "B" }), 買い: cand({ side: "buy", band: { low: 1.1038, high: 1.104 } }), 銘柄: cand({ symbol: "GBPUSD" }), 計画日: cand({ plan_date: "2026-10-09" }), 水準: cand({ band: { low: 1.1050, high: 1.1052 } }) })) {
    assert.equal(open.suppresses(c, "別の鍵"), false, name);
  }
  // 水準の一致は価格の丸めの単位（5ティック＝0.5pip）で比べる。EURUSD: 1.10402 は同じ水準、1.10405 は別の水準、買いは帯の上端で比べる
  assert.equal(open.suppresses(cand({ band: { low: 1.10402, high: 1.10422 } }), "k"), true);
  assert.equal(open.suppresses(cand({ band: { low: 1.10405, high: 1.10425 } }), "k"), false);
  assert.equal(V.levelKey({ plan_date: D, setup: "A", symbol: "USDJPY", side: "sell", level: 150.002 }), V.levelKey({ plan_date: D, setup: "A", symbol: "USDJPY", side: "sell", level: 150.0 })); // 円: 0.005
  assert.notEqual(V.levelKey({ plan_date: D, setup: "A", symbol: "USDJPY", side: "sell", level: 150.003 }), V.levelKey({ plan_date: D, setup: "A", symbol: "USDJPY", side: "sell", level: 150.0 }));
  const buyRow = row({ side: "buy", entry_low: "1.09980", entry_high: "1.10000", sl_a: "1.09900" });
  assert.equal(ctx([buyRow], [bar("08:00", 1.1005, 1.0995)]).suppresses(cand({ side: "buy", band: { low: 1.0997, high: 1.10 } }), "k"), true, "買いは帯の上端（1.10000）で比べる");
  assert.equal(N.ROUND_UNIT_TICKS, 5);
  // 到達していない（H1 の足が帯に届かない）／9時台の足だけ（失効後到達）／取消の時刻より後に届いた → 抑えない
  assert.equal(ctx([row()], [bar("08:00", 1.1030, 1.1020)]).suppresses(cand(), "k"), false);
  assert.equal(ctx([row()], [bar("09:00", 1.1045, 1.1035)]).suppresses(cand(), "k"), false);
  const cancelled = (reached, at2 = "2026-10-08T07:30:00+09:00") => [row(), { ...row(), run: "status", generated_at: at2, reached }];
  assert.equal(ctx(cancelled("取消(再設計)")).suppresses(cand(), "k"), false, "取消の時刻（07:30）より後の 08:00 の足は使わない");
  assert.equal(ctx(cancelled("取消(再設計)", "2026-10-08T09:30:00+09:00")).suppresses(cand(), "k"), true, "取消の時刻までに届いていれば、取消(再設計) の行でも到達済み（足が届いていなかった分）");
  assert.equal(ctx(cancelled("取消(到達後)")).suppresses(cand(), "k"), true, "取消(到達後) は到達済み（足を見なくてもよい）");
  assert.equal(ctx(cancelled("未到達")).suppresses(cand(), "k"), false);
  assert.equal(ctx(cancelled("到達")).suppresses(cand(), "k"), true);
  assert.equal(ctx(cancelled("失効後到達")).suppresses(cand(), "k"), false);
  // 取消されて同じ版が戻った（新しい design の行）後は、その版が有効。到達済みの別の一生があれば、戻った版も（鍵が同じでも）有効な版として続く扱い
  const back = ctx([row(), { ...row(), run: "status", generated_at: "2026-10-08T09:30:00+09:00", reached: "取消(到達後)" }, row({ generated_at: "2026-10-08T15:30:00+09:00" })]);
  assert.equal(back.suppresses(cand(), L.keyOf(row())), false);
  assert.equal(pairOf("EURUSD").digits, 5);
  void HR;
});
