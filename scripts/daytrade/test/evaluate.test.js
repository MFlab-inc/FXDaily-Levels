"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate, SL_MIN_PIPS } = require("../evaluate");
const { pairOf } = require("../pairs");
const { evalCtx, DAILY, OK_DIR, NO_GROUPS } = require("./helpers");

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
// 売り・基準水準 Pivot=1.1040 のとき、TP1 までの利益幅が P pips になるよう S1 を置いた日次レベル（S1 より下の水準は遠くに退ける）
const withProfit = (P) => ({ ...DAILY, s1: Number((1.1040 - (P + 0.5) * 0.0001).toFixed(5)), s2: 1.0000, prev_low: 1.0000 });

test("型A 売り: 基準水準・Entry帯・SL・TP1・RR・ロット上限（基本の通る場面）", () => {
  const r = evaluate(evalCtx(), "A");
  assert.equal(r.outcome, "candidate");
  assert.equal(r.side, "sell");
  assert.deepEqual(r.ref, { label: "Pivot", price: 1.104 });
  // Entry帯 = 基準水準から ATR×0.1（2pips）。売りは水準から上へ。最悪Entry = 帯の下端
  assert.deepEqual(r.band, { low: 1.104, high: 1.1042 });
  assert.equal(r.worst_entry, 1.104);
  near(r.distance_pips, 40);
  const A = r.schemes.A, B = r.schemes.B;
  assert.equal(A.pass, true);
  assert.equal(B.pass, true);
  assert.equal(A.sl, 1.105); near(A.sl_pips, 10);
  assert.equal(B.sl, 1.106); near(B.sl_pips, 20);
  // TP1 = 最初の障害（S1 1.0900）の手前 0.5pip（ドル建て）
  assert.deepEqual(r.obstacle, { label: "S1", price: 1.09 });
  assert.equal(A.tp, 1.09005);
  near(A.profit_pips, 139.5);
  near(A.rr, 13.95);
  near(B.rr, 6.975);
  near(A.cost_cap_pips, (139.5 - 15) / 2.5);
  assert.equal(A.cost_threshold_pips, 1.2);
  // ロット: 610273 × 0.5% ÷ (10pips × 1500円) = 0.2034 → 0.20。B案(SL20) = 0.1017 → 0.10
  near(r.pip_value_jpy, 1500);
  assert.equal(A.lots[701620], 0.2);
  assert.equal(B.lots[701620], 0.1);
  assert.equal(A.lots[702449], 1.56); // 4682566×0.005÷15000 = 1.5608
  assert.equal(B.lots[702449], 0.78);
});

test("型A 買い: 基準水準は現在値より下で最も近い水準、帯は水準から下へ、SL は下、TP1 は障害の下側に0.5pip手前", () => {
  const ctx = evalCtx({ price: 1.1100, direction: OK_DIR("buy"), daily: { pivot: 1.1060, r1: 1.1300, r2: 1.1400, s1: 1.1060, s2: 1.0800, prev_high: 1.1500, prev_low: 1.0850 } });
  // 現在値より下で最も近い {Pivot, S1, S2, 前日安値} = 1.1060（Pivot と S1 が同値）
  const r = evaluate(ctx, "A");
  assert.equal(r.outcome, "candidate");
  assert.equal(r.side, "buy");
  assert.equal(r.ref.price, 1.106);
  assert.deepEqual(r.band, { low: 1.1058, high: 1.106 });
  assert.equal(r.worst_entry, 1.106); // 買いの最悪Entry = 帯の上端
  assert.equal(r.schemes.A.sl, 1.105);
  assert.equal(r.schemes.B.sl, 1.104);
  // 障害 = Entry より上で最初の水準 = R1 1.1300 → TP1 = 1.1300 − 0.5pip = 1.12995
  assert.deepEqual(r.obstacle, { label: "R1", price: 1.13 });
  assert.equal(r.schemes.A.tp, 1.12995);
});

test("基準水準が現在値と同値なら『上／下』ではないので採らない", () => {
  const r = evaluate(evalCtx({ price: 1.1040 }), "A");
  assert.equal(r.ref.price, 1.115); // R1。Pivot 1.1040 は現在値と同値
});

test("基準水準なし（現在値より上に水準が無い）は『基準水準なし』で不採用（6分類に数えない）", () => {
  const r = evaluate(evalCtx({ price: 1.3000 }), "A");
  assert.equal(r.outcome, "rejected");
  assert.equal(r.symbolReason, "no_reference");
  assert.equal(r.schemes.A.reason, "no_reference");
});

test("障害なし: Entry より下に水準が無ければ『障害なし』", () => {
  const daily = { ...DAILY, s1: 1.2, s2: 1.2, prev_low: 1.2 };
  const r = evaluate(evalCtx({ daily }), "A");
  assert.equal(r.outcome, "rejected");
  assert.equal(r.schemes.A.reason, "no_obstacle");
});

test("入力欠落: 現在値・ATR・ADR のどれかが無ければ『入力欠落』", () => {
  for (const o of [{ price: NaN }, { atr: NaN }, { atr: 0 }, { adr: null }, { adr: { used_pct: NaN, remaining: 1 } }]) {
    const r = evaluate(evalCtx(o), "A");
    assert.equal(r.outcome, "rejected");
    assert.equal(r.symbolReason, "no_data");
  }
});

// ---- 各条件の境界（『ちょうど』の値） ----
test("SL幅: 10pips ちょうどは通り、9.5pips は『SL幅不足』", () => {
  let r = evaluate(evalCtx({ atr: 0.0020 }), "A"); // A案 10.0pips
  assert.equal(r.schemes.A.pass, true);
  r = evaluate(evalCtx({ atr: 0.0019 }), "A"); // A案 9.5pips、B案 19.0pips
  assert.equal(r.schemes.A.pass, false);
  assert.equal(r.schemes.A.reason, "sl_narrow");
  assert.equal(r.schemes.B.pass, true);
  assert.equal(r.outcome, "candidate"); // 片方の案が通れば候補
  assert.ok(SL_MIN_PIPS === 10);
});

test("SL は 0.5pip 単位に切り上げ（売り）／切り下げ（買い）で、広がる方向に丸める（XAUUSD も 0.05）", () => {
  // ATR 20.1pips: A案 10.05 → 10.5、B案 20.1 → 20.5
  let r = evaluate(evalCtx({ atr: 0.00201 }), "A");
  near(r.schemes.A.sl_pips, 10.5);
  near(r.schemes.B.sl_pips, 20.5);
  assert.equal(r.schemes.A.sl, 1.10505);
  // 買い
  r = evaluate(evalCtx({ atr: 0.00201, price: 1.1100, direction: OK_DIR("buy"), daily: { ...DAILY, pivot: 1.1060, s1: 1.1060 } }), "A");
  near(r.schemes.A.sl_pips, 10.5);
  assert.equal(r.schemes.A.sl, 1.10495);
  // XAUUSD: pip 0.1、丸め 0.05。ATR 2.01 → A案 SL = L + 1.005 → 1.05
  const xau = pairOf("XAUUSD");
  const x = evaluate(evalCtx({
    pair: xau, price: 4090, atr: 2.01, adr: { used_pct: 40, remaining: 60 },
    daily: { pivot: 4100, r1: 4200, r2: 4300, s1: 3900, s2: 3800, prev_high: 4250, prev_low: 3850 },
  }), "A");
  assert.equal(x.schemes.A.sl, 4101.05);
  assert.equal(x.schemes.B.sl, 4102.05);
  assert.equal(x.band.high, 4100.2);
  // TP1 = 障害(S1 3900)の手前 0.5pip = 3900.05
  assert.equal(x.schemes.A.tp, 3900.05);
});

test("RR: 利益幅 < SL幅 は『RR不足』、利益幅 = SL幅 はRRを通る（次のコスト条件で落ちる）", () => {
  let r = evaluate(evalCtx({ daily: withProfit(9.5) }), "A");
  near(r.schemes.A.profit_pips, 9.5);
  assert.equal(r.schemes.A.reason, "rr_low");
  r = evaluate(evalCtx({ daily: withProfit(10) }), "A");
  near(r.schemes.A.rr, 1.0);
  assert.equal(r.schemes.A.reason, "cost_low"); // 1.0 は RR の下限を満たす。コスト上限 (10−15)/2.5 < 1.2
});

test("コスト上限: (利益幅 − 1.5×SL幅) ÷ 2.5 が閾値(ドル建て1.2)以上で通る。ちょうどは通る", () => {
  let r = evaluate(evalCtx({ daily: withProfit(18) }), "A"); // cap = (18−15)/2.5 = 1.2
  near(r.schemes.A.cost_cap_pips, 1.2);
  assert.equal(r.schemes.A.pass, true);
  r = evaluate(evalCtx({ daily: withProfit(17.5) }), "A"); // cap = 1.0
  assert.equal(r.schemes.A.reason, "cost_low");
  assert.equal(r.schemes.B.reason, "rr_low"); // B案(SL20) は利益幅17.5 < 20
});

test("円ペア: 閾値は1.6pips、TP1 の手前幅は0.7pips（0.5pip単位にEntry側へ丸め）", () => {
  const jpy = pairOf("USDJPY");
  const base = (s1) => evalCtx({
    pair: jpy, price: 150.0, atr: 0.20, adr: { used_pct: 40, remaining: 0.6 },
    daily: { pivot: 150.4, r1: 151.0, r2: 152.0, s1, s2: 100, prev_high: 151.5, prev_low: 100 },
  });
  // S1 150.203 → +0.7pip(7ティック) = 150.210 → 5ティック単位は 150.210（ちょうど）→ 利益幅 19.0pips → cap 1.6 ちょうど
  let r = evaluate(base(150.203), "A");
  assert.equal(r.schemes.A.tp, 150.21);
  near(r.schemes.A.profit_pips, 19);
  assert.equal(r.schemes.A.cost_threshold_pips, 1.6);
  assert.equal(r.schemes.A.pass, true);
  // S1 150.208 → TP 150.215 → 利益幅 18.5 → cap 1.4 < 1.6
  r = evaluate(base(150.208), "A");
  assert.equal(r.schemes.A.tp, 150.215);
  assert.equal(r.schemes.A.reason, "cost_low");
  // 手前幅が 5ティック単位に乗らない例: S1 149.000 + 7ティック = 149.007 → Entry側へ 149.010
  r = evaluate(base(149.0), "A");
  assert.equal(r.schemes.A.tp, 149.01);
  // 円決済の1pip = 1000円。ロット = 610273×0.5%÷(10×1000) = 0.305 → 0.30
  assert.equal(r.pip_value_jpy, 1000);
  assert.equal(r.schemes.A.lots[701620], 0.3);
});

test("ドル建て以外（EURGBP）の閾値は1.6pips、手前幅は0.5pip", () => {
  const eg = pairOf("EURGBP");
  const r = evaluate(evalCtx({
    pair: eg, price: 0.8600, atr: 0.0020, adr: { used_pct: 40, remaining: 0.0060 },
    daily: { pivot: 0.8640, r1: 0.88, r2: 0.89, s1: 0.8400, s2: 0.8300, prev_high: 0.8850, prev_low: 0.8350 },
    rates: { USDJPY: 150, GBPUSD: 1.25, USDCAD: 1.35, USDCHF: 0.9 },
  }), "A");
  assert.equal(r.schemes.A.cost_threshold_pips, 1.6);
  assert.equal(r.schemes.A.tp, 0.84005);
  near(r.pip_value_jpy, 10 * 1.25 * 150);
});

test("追加の理由の並び: 届かない → SL幅不足 → RR不足 → コスト不足 → ADR消化超過（最初に当たった1つ）", () => {
  // 届かない + SL幅不足 + ADR超過 → 届かない
  let r = evaluate(evalCtx({ atr: 0.0019, adr: { used_pct: 90, remaining: 0.0030 } }), "A");
  assert.equal(r.schemes.A.reason, "unreachable");
  // SL幅不足 + ADR超過 → SL幅不足
  r = evaluate(evalCtx({ atr: 0.0019, adr: { used_pct: 90, remaining: 0.0060 } }), "A");
  assert.equal(r.schemes.A.reason, "sl_narrow");
  // RR不足 + ADR超過 → RR不足
  r = evaluate(evalCtx({ daily: withProfit(9.5), adr: { used_pct: 90, remaining: 0.0060 } }), "A");
  assert.equal(r.schemes.A.reason, "rr_low");
  // コスト不足 + ADR超過 → コスト不足
  r = evaluate(evalCtx({ daily: withProfit(17), adr: { used_pct: 90, remaining: 0.0060 } }), "A");
  assert.equal(r.schemes.A.reason, "cost_low");
  // ADR超過だけ
  r = evaluate(evalCtx({ adr: { used_pct: 90, remaining: 0.0060 } }), "A");
  assert.equal(r.schemes.A.reason, "adr_over");
  assert.equal(r.schemes.B.reason, "adr_over");
  assert.equal(r.outcome, "rejected");
});

test("ADR消化率は 80% ちょうどは通り、80.1% は『ADR消化超過』", () => {
  assert.equal(evaluate(evalCtx({ adr: { used_pct: 80, remaining: 0.0060 } }), "A").schemes.A.pass, true);
  assert.equal(evaluate(evalCtx({ adr: { used_pct: 80.1, remaining: 0.0060 } }), "A").schemes.A.reason, "adr_over");
});

test("届かない: 基準水準までの距離 = ADR残り は通り、1ティック超えると『届かない』", () => {
  assert.equal(evaluate(evalCtx({ adr: { used_pct: 50, remaining: 0.0040 } }), "A").schemes.A.pass, true); // 距離 40pips = 残り
  const r = evaluate(evalCtx({ adr: { used_pct: 50, remaining: 0.00399 } }), "A");
  assert.equal(r.schemes.A.reason, "unreachable");
  assert.equal(r.schemes.B.reason, "unreachable");
});

test("A案が落ちてもB案が通れば候補（片方だけ）", () => {
  // RR: A案 SL10 利益幅 ≥ 18 で通る。B案 SL20 は利益幅 ≥ 33 が必要 → 利益幅 20 だとB案は rr 不足にならず cost_low
  const r = evaluate(evalCtx({ daily: withProfit(20) }), "A");
  assert.equal(r.outcome, "candidate");
  assert.equal(r.schemes.A.pass, true);
  assert.equal(r.schemes.B.pass, false);
  assert.equal(r.schemes.B.reason, "cost_low"); // B: cap = (20−30)/2.5 < 1.2。RR = 1.0 は下限を満たす
});

// ---- 方向 ----
test("方向根拠なし: 監視のみ(watch) と 根拠なし(no_basis) を区別し、型Bは『不成立』（数えない）", () => {
  const watch = { ok: false, kind: "watch", reason: "監視のみ（1/3 Up）", alignment: "1/3 Up", dirs: ["↑", "→", "↓"] };
  const nobasis = { ok: false, kind: "no_basis", reason: "MTF未収録", alignment: null };
  let r = evaluate(evalCtx({ direction: watch }), "A");
  assert.equal(r.outcome, "watch");
  assert.equal(r.symbolReason, "no_direction");
  assert.equal(r.schemes.A.reason, "no_direction");
  r = evaluate(evalCtx({ direction: nobasis }), "A");
  assert.equal(r.outcome, "rejected");
  assert.equal(r.symbolReason, "no_direction");
  r = evaluate(evalCtx({ direction: watch }), "B");
  assert.equal(r.outcome, "not_formed");
});

// ---- 型B ----
const B_DAILY = { pivot: 1.1300, r1: 1.1400, r2: 1.1500, s1: 1.0900, s2: 1.0800, prev_high: 1.1450, prev_low: 1.0850 };
const tokyo = (o = {}) => ({ complete: true, high: 1.1100, low: 1.1050, breakUp: false, breakDown: true, bars: 6, ...o });

test("型B 売り: 東京レンジ安値を基準にし、帯は安値から上へ。ブレイク後の戻り（帯の上端より上）は不成立、上端ちょうどは成立", () => {
  const base = (o) => evalCtx({ price: 1.1048, daily: B_DAILY, tokyo: tokyo(), ...o });
  let r = evaluate(base({}), "B");
  assert.equal(r.outcome, "candidate");
  assert.equal(r.setup, "B");
  assert.deepEqual(r.ref, { label: "東京レンジ安値", price: 1.105 });
  assert.deepEqual(r.band, { low: 1.105, high: 1.1052 });
  near(r.distance_pips, 2);
  assert.equal(r.schemes.A.sl, 1.106);
  assert.deepEqual(r.obstacle, { label: "S1", price: 1.09 });
  // 帯の上端ちょうど = まだ戻りではない
  assert.equal(evaluate(base({ price: 1.1052 }), "B").outcome, "candidate");
  // 帯の上端より上 = レンジ内に戻り済み
  r = evaluate(base({ price: 1.1053 }), "B");
  assert.equal(r.outcome, "not_formed");
  assert.match(r.detail, /戻り済み/);
});

test("型B 買い: 東京レンジ高値を基準にし、帯は高値から下へ。帯の下端より下は戻り済みで不成立", () => {
  const base = (o) => evalCtx({ price: 1.1102, daily: B_DAILY, direction: OK_DIR("buy"), tokyo: tokyo({ breakUp: true, breakDown: false }), ...o });
  const r = evaluate(base({}), "B");
  assert.equal(r.outcome, "candidate");
  assert.deepEqual(r.ref, { label: "東京レンジ高値", price: 1.11 });
  assert.deepEqual(r.band, { low: 1.1098, high: 1.11 });
  assert.equal(r.worst_entry, 1.11);
  assert.equal(r.schemes.A.sl, 1.109);
  assert.equal(evaluate(base({ price: 1.1098 }), "B").outcome, "candidate");
  assert.equal(evaluate(base({ price: 1.1097 }), "B").outcome, "not_formed");
});

test("型B 不成立: 東京レンジ未確定／ブレイクなし／両方向ブレイク／ブレイク方向がMTFと逆", () => {
  const f = (t, dir) => evaluate(evalCtx({ price: 1.1048, daily: B_DAILY, tokyo: t, ...(dir ? { direction: dir } : {}) }), "B");
  assert.equal(f({ complete: false }).outcome, "not_formed");
  assert.match(f({ complete: false }).detail, /確定していません/);
  assert.equal(f(tokyo({ breakDown: false })).outcome, "not_formed");
  assert.match(f(tokyo({ breakDown: false })).detail, /ブレイク未成立/);
  assert.match(f(tokyo({ breakUp: true })).detail, /両方向/);
  assert.match(f(tokyo({ breakUp: true, breakDown: false }), OK_DIR("sell")).detail, /不一致/);
  assert.equal(f(null).outcome, "not_formed");
});

test("型Bは基準水準の探索をしない: 型Aなら現在値の上のPivotが基準だが、型Bは東京レンジを基準にする", () => {
  const a = evaluate(evalCtx({ price: 1.1048, daily: B_DAILY, tokyo: tokyo() }), "A");
  const b = evaluate(evalCtx({ price: 1.1048, daily: B_DAILY, tokyo: tokyo() }), "B");
  assert.equal(a.ref.label, "Pivot");
  assert.equal(b.ref.label, "東京レンジ安値");
});

// ---- ロット ----
test("ロット上限: 0.01単位に切り捨て。資金に対してSL幅が大きければ 0.00", () => {
  const r = evaluate(evalCtx({ accounts: { 701620: { equity_jpy: 1000 } } }), "A");
  assert.equal(r.schemes.A.lots[701620], 0);
  assert.equal(r.schemes.A.pass, true); // 0.00 でも案は残す（Q37）
});

test("B案のロットは『式の値』と『A案の式の値の半分』の小さい方（四捨五入の差でB案が大きくならない）", () => {
  // ATR 20.1pips → A案SL 10.5、B案SL 20.5（比が2倍未満）。equity 620000: B式 = 3100/30750 = 0.1008 → 0.10、A式の半分 = 0.0984 → 0.09
  const r = evaluate(evalCtx({ atr: 0.00201, accounts: { 701620: { equity_jpy: 620000 } } }), "A");
  near(r.schemes.A.sl_pips, 10.5);
  near(r.schemes.B.sl_pips, 20.5);
  assert.equal(r.schemes.A.lots[701620], 0.19);
  assert.equal(r.schemes.B.lots[701620], 0.09);
});

test("円換算レートが無ければロットは null（0.00 と区別する）", () => {
  const cad = pairOf("USDCAD");
  const r = evaluate(evalCtx({
    pair: cad, price: 1.3500, atr: 0.0020, adr: { used_pct: 40, remaining: 0.0060 }, rates: { USDJPY: 150 },
    daily: { pivot: 1.3540, r1: 1.37, r2: 1.38, s1: 1.3300, s2: 1.3200, prev_high: 1.375, prev_low: 1.3250 },
  }), "A");
  assert.equal(r.schemes.A.lots[701620], null);
  assert.equal(r.pip_value_jpy, null);
  // レートがあれば 10×USDJPY÷USDCAD
  const r2 = evaluate(evalCtx({
    pair: cad, price: 1.3500, atr: 0.0020, adr: { used_pct: 40, remaining: 0.0060 }, rates: { USDJPY: 150, USDCAD: 1.35 },
    daily: { pivot: 1.3540, r1: 1.37, r2: 1.38, s1: 1.3300, s2: 1.3200, prev_high: 1.375, prev_low: 1.3250 },
  }), "A");
  near(r2.pip_value_jpy, (10 * 150) / 1.35);
});

test("H1の群が基準水準・障害になる（Pivot より近い群の上端が基準）", () => {
  const groups = { highs: [{ min: 1.1010, max: 1.1015, count: 3 }], lows: [{ min: 1.0980, max: 1.0990, count: 2 }], window: 24 };
  const r = evaluate(evalCtx({ groups, adr: { used_pct: 50, remaining: 0.0060 } }), "A");
  assert.deepEqual(r.ref, { label: "H1高値群の上端", price: 1.1015 });
  // 障害 = Entry(1.1015) から下で最初の水準: H1安値群(Entry に近い端 = 最大値 1.0990)
  assert.deepEqual(r.obstacle, { label: "H1安値群", price: 1.099 });
});

// ---- SL下限方式（opts.slFloor）: 'reject'（既定・ライブ）／'widen'（バックテストの比較用）----
const WIDEN = { slFloor: "widen" };
const BUY_CTX = (o = {}) => evalCtx({ price: 1.1100, direction: OK_DIR("buy"), daily: { ...DAILY, pivot: 1.1060, s1: 1.1060 }, ...o });

test("SL下限方式: 既定（opts なし／空／'reject'）は従来どおり。sl_floored は付かず、10pips未満は『SL幅不足』", () => {
  const base = evaluate(evalCtx({ atr: 0.0019 }), "A");
  for (const opts of [undefined, {}, null, { slFloor: "reject" }, { t: 1, slot: 2 }]) {
    const r = evaluate(evalCtx({ atr: 0.0019 }), "A", opts);
    assert.deepEqual(r, base);
    assert.equal(r.schemes.A.reason, "sl_narrow");
    assert.equal("sl_floored" in r.schemes.A, false);
    assert.equal("sl_floored" in r.schemes.B, false);
  }
  assert.throws(() => evaluate(evalCtx(), "A", { slFloor: "wide" }), /slFloor/);
});

test("SL下限方式 widen・売り: 係数×ATR が 10pips 未満なら SL 幅 10pips に広げて採用（9.5pips → 10.0pips）。B案(19pips)はそのまま", () => {
  const r = evaluate(evalCtx({ atr: 0.0019 }), "A", WIDEN); // A案 9.5pips、B案 19.0pips
  const A = r.schemes.A, B = r.schemes.B;
  assert.equal(A.pass, true);
  assert.equal(A.reason, null);
  near(A.sl_pips, 10);
  assert.equal(A.sl, 1.105);
  assert.equal(A.sl_floored, true);
  assert.equal(B.pass, true);
  near(B.sl_pips, 19);
  assert.equal(B.sl, 1.1059);
  assert.equal(B.sl_floored, false);
  // 他の門は同じ式で、広げた後のSL幅を使う: RR = 利益幅 139.5 ÷ 10、コスト上限 = (139.5 − 1.5×10) ÷ 2.5、ロットは SL 10pips で計算（9.5pips ではない）
  near(A.rr, 13.95);
  near(A.cost_cap_pips, (139.5 - 15) / 2.5);
  assert.equal(A.lots[701620], 0.2); // 610273×0.5%÷(10×1500) = 0.2034
  assert.equal(evaluate(evalCtx({ atr: 0.0019 }), "A").schemes.A.lots[701620], 0.21); // 現行（不採用）の SL 9.5pips なら 0.2141 → 0.21（広げると小さくなる）
  assert.equal(B.lots[701620], 0.1); // B案: min(610273×0.5%÷(19×1500)=0.107→0.10, A案の式0.2034×0.5=0.1017→0.10)
});

test("SL下限方式 widen・買い: 9.5pips → 10.0pips（下へ）。ちょうど 10.0／10.5pips は広げない", () => {
  let r = evaluate(BUY_CTX({ atr: 0.0019 }), "A", WIDEN);
  assert.equal(r.schemes.A.pass, true);
  near(r.schemes.A.sl_pips, 10);
  assert.equal(r.schemes.A.sl, 1.105); // 基準 1.1060 − 10pips
  assert.equal(r.schemes.A.sl_floored, true);
  assert.equal(evaluate(BUY_CTX({ atr: 0.0019 }), "A").schemes.A.reason, "sl_narrow"); // 既定は不採用
  // 10.0pips ちょうど（ATR 20pips の A案）
  r = evaluate(BUY_CTX({ atr: 0.0020 }), "A", WIDEN);
  assert.equal(r.schemes.A.sl, 1.105);
  assert.equal(r.schemes.A.sl_floored, false);
  const { sl_floored: _f, ...same } = r.schemes.A;
  assert.deepEqual(same, evaluate(BUY_CTX({ atr: 0.0020 }), "A").schemes.A);
  // 10.5pips ちょうど（ATR 21pips）
  r = evaluate(BUY_CTX({ atr: 0.0021 }), "A", WIDEN);
  near(r.schemes.A.sl_pips, 10.5);
  assert.equal(r.schemes.A.sl, 1.10495);
  assert.equal(r.schemes.A.sl_floored, false);
});

test("SL下限方式 widen: 10.5pips(ATR 21) と 20.1pips(A案がATR 40.2) は従来と同じ SL（20.1 → 外側へ 20.5）。下限は効かない", () => {
  let r = evaluate(evalCtx({ atr: 0.0021 }), "A", WIDEN);
  near(r.schemes.A.sl_pips, 10.5);
  assert.equal(r.schemes.A.sl, 1.10505);
  assert.equal(r.schemes.A.sl_floored, false);
  near(r.schemes.B.sl_pips, 21);
  r = evaluate(evalCtx({ atr: 0.00402 }), "A", WIDEN); // A案 0.5×40.2 = 20.1pips → 20.5
  near(r.schemes.A.sl_pips, 20.5);
  assert.equal(r.schemes.A.sl, 1.10605);
  assert.equal(r.schemes.A.sl_floored, false);
  near(r.schemes.B.sl_pips, 40.5); // 40.2 → 40.5
  assert.equal(r.schemes.B.sl_floored, false);
  const d = evaluate(evalCtx({ atr: 0.00402 }), "A");
  assert.equal(d.schemes.A.sl, r.schemes.A.sl);
  assert.equal(d.schemes.B.sl, r.schemes.B.sl);
});

test("SL下限方式 widen: B案（1.0×ATR）も 10pips 未満なら広げる（ATR 8pips → A案 4pips・B案 8pips とも SL 10pips）。ロットは広げた後のSL幅で、B案は A案の式の半分が上限", () => {
  const r = evaluate(evalCtx({ atr: 0.0008 }), "A", WIDEN);
  for (const n of ["A", "B"]) {
    assert.equal(r.schemes[n].sl, 1.105, n);
    near(r.schemes[n].sl_pips, 10);
    assert.equal(r.schemes[n].sl_floored, true, n);
    assert.equal(r.schemes[n].pass, true, n);
  }
  assert.equal(r.schemes.A.lots[701620], 0.2); // 610273×0.5%÷(10×1500) = 0.2034
  assert.equal(r.schemes.B.lots[701620], 0.1); // B案 = min(式 0.2034→0.20, A案の式×0.5 = 0.1017→0.10)
  const d = evaluate(evalCtx({ atr: 0.0008 }), "A");
  assert.equal(d.schemes.B.reason, "sl_narrow"); // 既定は B案(8pips)も不採用
  assert.equal(d.outcome, "rejected");
  assert.equal(r.outcome, "candidate");
});

test("SL下限方式 widen・円ペア: 9.5pips（ATR 19pips）→ SL 10pips = 0.10。ロットは 10pips×1000円で計算", () => {
  const jpy = pairOf("USDJPY");
  const ctx = evalCtx({
    pair: jpy, price: 150.0, atr: 0.19, adr: { used_pct: 40, remaining: 0.6 },
    daily: { pivot: 150.4, r1: 151.0, r2: 152.0, s1: 149.0, s2: 100, prev_high: 151.5, prev_low: 100 },
  });
  const d = evaluate(ctx, "A");
  assert.equal(d.schemes.A.reason, "sl_narrow");
  const r = evaluate(ctx, "A", WIDEN);
  assert.equal(r.schemes.A.sl, 150.5); // 150.400 + 0.10
  near(r.schemes.A.sl_pips, 10);
  assert.equal(r.schemes.A.sl_floored, true);
  assert.equal(r.schemes.A.pass, true);
  assert.equal(r.schemes.A.lots[701620], 0.3); // 610273×0.5%÷(10×1000) = 0.3051
  assert.equal(r.schemes.A.cost_threshold_pips, 1.6);
  // 10.0pips ちょうど（ATR 0.20）／10.5pips（ATR 0.21）／20.1pips（A案が ATR 0.402）は広げない（20.1 → 外側へ 20.5）
  const at = (atr) => evaluate({ ...ctx, atr }, "A", WIDEN).schemes.A;
  assert.deepEqual([at(0.20).sl, at(0.20).sl_floored], [150.5, false]);
  assert.deepEqual([at(0.21).sl, at(0.21).sl_floored], [150.505, false]);
  assert.deepEqual([at(0.402).sl, at(0.402).sl_floored], [150.605, false]);
  near(at(0.402).sl_pips, 20.5);
  // 買い（円ペア）
  const rb = evaluate(evalCtx({
    pair: jpy, price: 151.0, atr: 0.19, adr: { used_pct: 40, remaining: 0.6 }, direction: OK_DIR("buy"),
    daily: { pivot: 150.4, r1: 152.0, r2: 153.0, s1: 150.4, s2: 100, prev_high: 154, prev_low: 100 },
  }), "A", WIDEN);
  assert.equal(rb.schemes.A.sl, 150.3);
  near(rb.schemes.A.sl_pips, 10);
  assert.equal(rb.schemes.A.sl_floored, true);
});

test("SL下限方式 widen・XAUUSD: pip=0.1 なので 10pips = 1.0 ドル。ATR 1.9（19pips）→ A案 SL 幅 10pips", () => {
  const xau = pairOf("XAUUSD");
  const ctx = (atr, extra = {}) => evalCtx({
    pair: xau, price: 4090, atr, adr: { used_pct: 40, remaining: 60 },
    daily: { pivot: 4100, r1: 4200, r2: 4300, s1: 3900, s2: 3800, prev_high: 4250, prev_low: 3850 }, ...extra,
  });
  assert.equal(evaluate(ctx(1.9), "A").schemes.A.reason, "sl_narrow");
  let r = evaluate(ctx(1.9), "A", WIDEN);
  assert.equal(r.schemes.A.sl, 4101);
  near(r.schemes.A.sl_pips, 10);
  assert.equal(r.schemes.A.sl_floored, true);
  assert.equal(r.schemes.B.sl, 4101.9);
  near(r.schemes.B.sl_pips, 19);
  // 10.0 ちょうど（ATR 2.0）、10.5（ATR 2.1）、20.1pips（ATR 4.02 の A案 → 2.01 → 外側へ 2.05）
  r = evaluate(ctx(2.0), "A", WIDEN);
  assert.equal(r.schemes.A.sl, 4101);
  assert.equal(r.schemes.A.sl_floored, false);
  r = evaluate(ctx(2.1), "A", WIDEN);
  assert.equal(r.schemes.A.sl, 4101.05);
  assert.equal(r.schemes.A.sl_floored, false);
  r = evaluate(ctx(4.02), "A", WIDEN);
  assert.equal(r.schemes.A.sl, 4102.05);
  near(r.schemes.A.sl_pips, 20.5);
  assert.equal(r.schemes.A.sl_floored, false);
  // 買い
  r = evaluate(ctx(1.9, { price: 4110, direction: OK_DIR("buy"), daily: { pivot: 4100, r1: 4300, r2: 4400, s1: 4100, s2: 3800, prev_high: 4350, prev_low: 3850 } }), "A", WIDEN);
  assert.equal(r.schemes.A.sl, 4099);
  near(r.schemes.A.sl_pips, 10);
  assert.equal(r.schemes.A.sl_floored, true);
});

test("SL下限方式 widen: 基準水準が 0.5pip の格子に乗らないとき、丸め後に 10pips 以上になるなら広げた扱いにしない（丸め後で見る）", () => {
  // Pivot 1.10402（格子外）、ATR 19.2pips → A案 9.6pips: 現行は 1.10402+0.00096=1.10498 → 切り上げ 1.1050 → 9.8pips で不採用
  const daily = { ...DAILY, pivot: 1.10402, s1: 1.0900 };
  const narrow = evalCtx({ atr: 0.00192, daily });
  assert.equal(evaluate(narrow, "A").schemes.A.reason, "sl_narrow");
  let r = evaluate(narrow, "A", WIDEN);
  assert.equal(r.schemes.A.sl, 1.10505); // 1.10402 + 10pips = 1.10502 → 1.10505（10.3pips）
  near(r.schemes.A.sl_pips, 10.3);
  assert.equal(r.schemes.A.sl_floored, true);
  // ATR 19.7pips → A案 9.85pips: 現行でも 1.10402+0.000985 = 1.100... → 切り上げ 1.10505（10.3pips）で通る。広げても同じSL → 広げた扱いにしない
  const ok = evalCtx({ atr: 0.00197, daily });
  assert.equal(evaluate(ok, "A").schemes.A.pass, true);
  r = evaluate(ok, "A", WIDEN);
  assert.equal(r.schemes.A.sl, 1.10505);
  assert.equal(r.schemes.A.sl_floored, false);
});

test("SL下限方式 widen: 理由の並びから『SL幅不足』が消える（届かない → RR不足 → コスト不足 → ADR消化超過）", () => {
  const T = { atr: 0.0019 }; // A案 9.5pips（既定なら SL幅不足）
  // 届かない + ADR超過 → 届かない（既定と同じ）
  let r = evaluate(evalCtx({ ...T, adr: { used_pct: 90, remaining: 0.0030 } }), "A", WIDEN);
  assert.equal(r.schemes.A.reason, "unreachable");
  // ADR超過だけ（既定は SL幅不足が先に当たる）
  r = evaluate(evalCtx({ ...T, adr: { used_pct: 90, remaining: 0.0060 } }), "A", WIDEN);
  assert.equal(r.schemes.A.reason, "adr_over");
  assert.equal(evaluate(evalCtx({ ...T, adr: { used_pct: 90, remaining: 0.0060 } }), "A").schemes.A.reason, "sl_narrow");
  // 広げた後の SL 10pips で RR 判定: 利益幅 9.5 < 10 → RR不足（広げる前の SL 9.5 なら RR 1.0 で通る）
  r = evaluate(evalCtx({ ...T, daily: withProfit(9.5) }), "A", WIDEN);
  assert.equal(r.schemes.A.reason, "rr_low");
  near(r.schemes.A.rr, 0.95);
  // 利益幅 17: 広げた SL 10 → コスト上限 (17−15)/2.5 = 0.8 < 1.2 → コスト不足
  r = evaluate(evalCtx({ ...T, daily: withProfit(17) }), "A", WIDEN);
  assert.equal(r.schemes.A.reason, "cost_low");
  // 利益幅 18: ちょうど通る（(18−15)/2.5 = 1.2）
  r = evaluate(evalCtx({ ...T, daily: withProfit(18) }), "A", WIDEN);
  assert.equal(r.schemes.A.pass, true);
  // 障害なし
  r = evaluate(evalCtx({ ...T, daily: { ...DAILY, s1: 1.2, s2: 1.2, prev_low: 1.2 } }), "A", WIDEN);
  assert.equal(r.schemes.A.reason, "no_obstacle");
  assert.equal(r.schemes.A.sl_floored, true);
  // 方向根拠なし・基準水準なしは SL 下限方式に関係なく同じ
  const watch = { ok: false, kind: "watch", reason: "監視のみ（1/3 Up）", alignment: "1/3 Up", dirs: ["↑", "→", "↓"] };
  assert.deepEqual(evaluate(evalCtx({ ...T, direction: watch }), "A", WIDEN), evaluate(evalCtx({ ...T, direction: watch }), "A"));
  assert.deepEqual(evaluate(evalCtx({ ...T, price: 1.3 }), "A", WIDEN), evaluate(evalCtx({ ...T, price: 1.3 }), "A"));
});

test("SL下限方式 widen: 下限が効かない案は既定と同じ結果。効く案は SL 幅 ≥ 10pips で、既定なら『SL幅不足』になる案と一致（ATR・売買を掃引）", () => {
  for (const mk of [(atr) => evalCtx({ atr }), (atr) => BUY_CTX({ atr })]) {
    for (let a = 30; a <= 450; a++) { // ATR 3.0〜45.0pips（0.1pips刻み。B案が広がる ATR 10pips 未満も含む）
      const ctx = mk(Number((a / 10 / 10000).toFixed(6)));
      const d = evaluate(ctx, "A"), w = evaluate(ctx, "A", WIDEN);
      for (const name of ["A", "B"]) {
        const ds = d.schemes[name], ws = w.schemes[name];
        assert.ok(ws.sl_pips >= 10 - 1e-9, `atr=${ctx.atr} ${name} sl_pips=${ws.sl_pips}`);
        assert.notEqual(ws.reason, "sl_narrow");
        if (ds.reason === "sl_narrow") assert.equal(ws.sl_floored, true, `atr=${ctx.atr} ${name}`);
        else {
          assert.equal(ws.sl_floored, false, `atr=${ctx.atr} ${name}`);
          const { sl_floored: _f, lots: wl, ...rest } = ws;
          const { lots: dl, ...dRest } = ds;
          assert.deepEqual(rest, dRest, `atr=${ctx.atr} ${name}`);
          // ロットは B案が『A案の式の半分』を使うので、A案のSLが広げられていれば B案も変わりうる（A案が広がっていなければ同じ）
          if (!w.schemes.A.sl_floored) assert.deepEqual(wl, dl, `atr=${ctx.atr} ${name}`);
        }
      }
    }
  }
});
