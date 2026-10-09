"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../num");
const { chainClusters, h1Groups, referenceLevel, firstObstacle } = require("../levels");
const { pipValueJpy, costThresholdPips, tpMarginPips, lotRaw, lotCap } = require("../sizing");
const { planDateOf, expiresAtMs, newEntryCutoffMs, noNewEntryReason } = require("../windows");
const { calendarStatus, stopWindows, activeStops } = require("../events");
const { globalMtfStatus, symbolDirection } = require("../direction");
const { tokyoRange } = require("../tokyo");
const { pairOf, PAIRS } = require("../pairs");
const { atrWilder } = require("../indicators");
const J = require("../jst");

const at = (s) => J.parseIso(s);

// ---- 数値（ティック） ----
test("num: ceilTo/floorTo は『ちょうど』を動かさず、そうでなければ0.5pip単位（5ティック）へ", () => {
  assert.equal(N.ceilTo(100), 100);
  assert.equal(N.ceilTo(100.0000000001), 100);
  assert.equal(N.ceilTo(100.5), 105);
  assert.equal(N.floorTo(104.9999999999), 105);
  assert.equal(N.floorTo(104.5), 100);
  assert.equal(N.ceilTo(0), 0);
});
test("num: ティック変換・比較・ロット切り捨て", () => {
  const eu = pairOf("EURUSD"), jpy = pairOf("USDJPY"), xau = pairOf("XAUUSD");
  assert.equal(N.ticksPerPip(eu), 10);
  assert.equal(N.ticksPerPip(jpy), 10);
  assert.equal(N.ticksPerPip(xau), 10);
  assert.equal(N.fromTicks(N.toTicks(1.10455, eu), eu), 1.10455);
  assert.equal(N.fromTicks(N.toTicks(150.123, jpy), jpy), 150.123);
  assert.ok(N.gte(0.1 + 0.2, 0.3) && N.lte(0.3, 0.1 + 0.2) && !N.gt(0.1 + 0.2, 0.3) && !N.lt(0.1 + 0.2, 0.3));
  assert.equal(N.floorLot(0.2034), 0.2);
  assert.equal(N.floorLot(0.29), 0.29);
  assert.equal(N.floorLot(0.0099), 0);
  assert.equal(N.floorLot(-1), 0);
});

// ---- H1 ATR ----
test("ATR(H1, Wilder14): 一定のTRなら ATR = TR。本数が足りなければ null", () => {
  const bars = Array.from({ length: 40 }, (_, i) => ({ t: i * J.HR, o: 1, h: 1.001, l: 0.999, c: 1 }));
  assert.ok(Math.abs(atrWilder(bars) - 0.002) < 1e-12);
  assert.equal(atrWilder(bars.slice(0, 10)), null);
});

// ---- H1群・基準水準・障害 ----
test("levels: 連鎖クラスタ（隣り合う差が0.2×ATR以内、2本以上）と、24本の窓", () => {
  assert.deepEqual(chainClusters([1.0, 1.1, 1.5, 1.55, 2.0], 0.2), [{ min: 1.0, max: 1.1, count: 2 }, { min: 1.5, max: 1.55, count: 2 }]);
  // 隣り合う差がちょうど許容幅
  assert.equal(chainClusters([1.0, 1.2], 0.2).length, 1);
  // 連鎖: 端同士は許容幅を超えていてもつながっていれば1つの群
  assert.deepEqual(chainClusters([1.0, 1.15, 1.3, 1.45], 0.2), [{ min: 1.0, max: 1.45, count: 4 }]);
  assert.deepEqual(chainClusters([1.0, 2.0], 0.2), []);
  // 直近24本だけを見る（古い25本目以前の高値は群に入らない）
  const old = Array.from({ length: 30 }, (_, i) => ({ h: i < 6 ? 5.0 : 1 + i * 10, l: 0 + i * 10 }));
  const g = h1Groups(old, 0.5);
  assert.equal(g.window, 24);
  assert.equal(g.highs.length, 0);
});
test("levels: referenceLevel は売り=上で最も近い、買い=下で最も近い。群は上端／下端を使う", () => {
  const daily = { pivot: 1.1040, r1: 1.1150, r2: 1.1250, s1: 1.0900, s2: 1.0800, prev_high: 1.1200, prev_low: 1.0850 };
  const groups = { highs: [{ min: 1.1010, max: 1.1020, count: 2 }], lows: [{ min: 1.0960, max: 1.0970, count: 2 }], window: 24 };
  assert.deepEqual(referenceLevel("sell", 1.1000, daily, groups), { label: "H1高値群の上端", price: 1.102 });
  assert.deepEqual(referenceLevel("buy", 1.1000, daily, groups), { label: "H1安値群の下端", price: 1.096 });
  // S1/S2 は売りの基準水準に入らない（Pivot・R1・R2・前日高値・H1高値群の上端のみ）
  assert.deepEqual(referenceLevel("sell", 1.0700, { ...daily, pivot: 1.0 }, { highs: [], lows: [] }), { label: "S1".replace("S1", "R1"), price: 1.115 });
  assert.equal(referenceLevel("sell", 1.3, daily, { highs: [], lows: [] }), null);
});
test("levels: firstObstacle は Entry を含まず進行方向で最初の水準（群は Entry に近い端）", () => {
  const daily = { pivot: 1.1040, r1: 1.1150, r2: 1.1250, s1: 1.0900, s2: 1.0800, prev_high: 1.1200, prev_low: 1.0850 };
  const groups = { highs: [{ min: 1.0950, max: 1.0970, count: 2 }], lows: [], window: 24 };
  assert.deepEqual(firstObstacle("sell", 1.1040, daily, groups), { label: "H1高値群", price: 1.097 });
  assert.deepEqual(firstObstacle("sell", 1.1040, daily, { highs: [], lows: [] }), { label: "S1", price: 1.09 });
  assert.deepEqual(firstObstacle("buy", 1.1040, daily, { highs: [{ min: 1.1100, max: 1.1110, count: 2 }], lows: [] }), { label: "H1高値群", price: 1.11 });
  assert.equal(firstObstacle("buy", 1.4, daily, { highs: [], lows: [] }), null);
});

test("levels: firstObstacle の mode — 'both'（既定・現行）は高値群・安値群の両方、'forward' は進行方向側の群だけ（売り=安値群、買い=高値群）", () => {
  const daily = { pivot: 1.1040, r1: 1.1150, r2: 1.1250, s1: 1.0900, s2: 1.0800, prev_high: 1.1200, prev_low: 1.0850 };
  // 売り: Entry 1.1040 より下に、高値群（近い端=最大値 1.097）と安値群（近い端=最大値 1.093）。S1 1.09
  const g = { highs: [{ min: 1.0950, max: 1.0970, count: 2 }], lows: [{ min: 1.0910, max: 1.0930, count: 2 }], window: 24 };
  assert.deepEqual(firstObstacle("sell", 1.1040, daily, g), { label: "H1高値群", price: 1.097 });             // 既定 = 'both'
  assert.deepEqual(firstObstacle("sell", 1.1040, daily, g, "both"), { label: "H1高値群", price: 1.097 });
  assert.deepEqual(firstObstacle("sell", 1.1040, daily, g, "forward"), { label: "H1安値群", price: 1.093 }); // 売りは安値群だけ
  assert.deepEqual(firstObstacle("sell", 1.1040, daily, { highs: g.highs, lows: [] }, "forward"), { label: "S1", price: 1.09 }); // 逆側の高値群は数えない → 日次レベル
  assert.deepEqual(firstObstacle("sell", 1.1040, daily, { highs: g.highs, lows: [] }, "both"), { label: "H1高値群", price: 1.097 });
  // 買い: Entry 1.1040 より上に、安値群（近い端=最小値 1.106）と高値群（近い端=最小値 1.110）。R1 1.115
  const gb = { highs: [{ min: 1.1100, max: 1.1110, count: 2 }], lows: [{ min: 1.1060, max: 1.1070, count: 2 }], window: 24 };
  assert.deepEqual(firstObstacle("buy", 1.1040, daily, gb), { label: "H1安値群", price: 1.106 });
  assert.deepEqual(firstObstacle("buy", 1.1040, daily, gb, "forward"), { label: "H1高値群", price: 1.11 }); // 買いは高値群だけ
  assert.deepEqual(firstObstacle("buy", 1.1040, daily, { highs: [], lows: gb.lows }, "forward"), { label: "R1", price: 1.115 });
  // 日次レベル7本は同じ。群が無ければ両方の定義は同じ結果
  for (const side of ["sell", "buy"]) for (const e of [1.0, 1.0860, 1.1040, 1.1300]) {
    assert.deepEqual(firstObstacle(side, e, daily, { highs: [], lows: [] }, "forward"), firstObstacle(side, e, daily, { highs: [], lows: [] }, "both"));
  }
  // 障害が進行方向側の群だけのとき: 'forward' では逆側の群しかなければ障害なし
  const noDaily = { pivot: NaN };
  assert.equal(firstObstacle("sell", 1.1040, noDaily, { highs: g.highs, lows: [] }, "forward"), null);
  assert.deepEqual(firstObstacle("sell", 1.1040, noDaily, { highs: g.highs, lows: [] }, "both"), { label: "H1高値群", price: 1.097 });
  // Entry と同値の群は障害ではない（'forward' でも）
  assert.equal(firstObstacle("sell", 1.093, noDaily, { highs: [], lows: g.lows }, "forward"), null);
  assert.throws(() => firstObstacle("sell", 1.1, daily, g, "fwd"), /mode/);
});

// ---- サイズ ----
test("sizing: 1pipの円価値は決済通貨ごと。レートが無ければ null", () => {
  const rates = { USDJPY: 150, USDCAD: 1.35, USDCHF: 0.9, GBPUSD: 1.25 };
  assert.equal(pipValueJpy(pairOf("USDJPY"), rates), 1000);
  assert.equal(pipValueJpy(pairOf("EURJPY"), rates), 1000);
  assert.equal(pipValueJpy(pairOf("EURUSD"), rates), 1500);
  assert.equal(pipValueJpy(pairOf("XAUUSD"), rates), 1500);
  assert.equal(pipValueJpy(pairOf("NZDUSD"), rates), 1500);
  assert.ok(Math.abs(pipValueJpy(pairOf("USDCAD"), rates) - 1500 / 1.35) < 1e-9);
  assert.ok(Math.abs(pipValueJpy(pairOf("USDCHF"), rates) - 1500 / 0.9) < 1e-9);
  assert.ok(Math.abs(pipValueJpy(pairOf("EURGBP"), rates) - 10 * 1.25 * 150) < 1e-9);
  for (const c of ["EURUSD", "USDCAD", "USDCHF", "EURGBP"]) assert.equal(pipValueJpy(pairOf(c), {}), null);
});
test("sizing: コスト閾値(米ドル決済1.2／その他1.6)・TP手前幅(円0.7／その他0.5)・ロット式", () => {
  assert.equal(costThresholdPips(pairOf("XAUUSD")), 1.2);
  assert.equal(costThresholdPips(pairOf("USDJPY")), 1.6);
  assert.equal(costThresholdPips(pairOf("USDCAD")), 1.6);
  assert.equal(tpMarginPips(pairOf("EURJPY")), 0.7);
  assert.equal(tpMarginPips(pairOf("EURUSD")), 0.5);
  assert.equal(lotCap(lotRaw(610273, 0.5, 10, 1500)), 0.2);
  assert.equal(lotRaw(610273, 0.5, 0, 1500), null);
  assert.equal(lotRaw(NaN, 0.5, 10, 1500), null);
  assert.equal(lotCap(null), null);
});

test("pairs: 対象10銘柄・pip・向き", () => {
  assert.deepEqual(PAIRS.map((p) => p.code).sort(), ["AUDUSD", "EURGBP", "EURJPY", "EURUSD", "GBPUSD", "NZDUSD", "USDCAD", "USDCHF", "USDJPY", "XAUUSD"]);
  assert.equal(pairOf("XAUUSD").pip, 0.1);
  assert.equal(pairOf("USDJPY").note, "過去の実績が悪い");
  assert.equal(pairOf("XAUUSD").note, "過去の実績が悪い");
  assert.equal(pairOf("EURUSD").note, null);
});

// ---- 計画日・時間帯 ----
test("windows: plan_date は JST の（現在−3時間）の日付。翌日 02:59 までは前日の計画日、03:00 で切り替わる", () => {
  assert.equal(planDateOf(at("2026-10-08T06:30:00+09:00")), "2026-10-08");
  assert.equal(planDateOf(at("2026-10-09T02:59:59+09:00")), "2026-10-08");
  assert.equal(planDateOf(at("2026-10-09T03:00:00+09:00")), "2026-10-09");
  assert.equal(J.jstIso(expiresAtMs("2026-10-08")), "2026-10-09T03:00:00+09:00");
  assert.equal(J.jstIso(newEntryCutoffMs("2026-10-08")), "2026-10-09T01:00:00+09:00");
});
test("windows: 新規不可 = 9時台／翌1:00以降（1:00ちょうども不可）／土曜0:00以降／有効期限後", () => {
  const D = "2026-10-08"; // 木曜
  assert.equal(noNewEntryReason(at("2026-10-08T08:59:00+09:00"), D), null);
  assert.equal(noNewEntryReason(at("2026-10-08T09:00:00+09:00"), D), "9時台");
  assert.equal(noNewEntryReason(at("2026-10-08T09:59:59+09:00"), D), "9時台");
  assert.equal(noNewEntryReason(at("2026-10-08T10:00:00+09:00"), D), null);
  assert.equal(noNewEntryReason(at("2026-10-09T00:59:59+09:00"), D), null);
  assert.equal(noNewEntryReason(at("2026-10-09T01:00:00+09:00"), D), "翌1:00以降");
  assert.equal(noNewEntryReason(at("2026-10-09T03:00:00+09:00"), D), "失効");
  // 金曜の計画日: 土曜 0:00 以降は新規なし（1:00 より前でも）
  const F = "2026-10-09";
  assert.equal(noNewEntryReason(at("2026-10-09T23:59:00+09:00"), F), null);
  assert.equal(noNewEntryReason(at("2026-10-10T00:00:00+09:00"), F), "土曜0:00以降");
  assert.equal(noNewEntryReason(at("2026-10-10T00:30:00+09:00"), F), "土曜0:00以降");
});

// ---- イベント ----
const calendar = (o = {}) => ({
  as_of: "2026-10-08T21:10:00+09:00", date: "2026-10-08",
  events: [
    { time_jst: "21:30", datetime_jst: "2026-10-08T21:30:00+09:00", currency: "USD", impact: "High", event: "CPI" },
    { time_jst: "22:00", datetime_jst: "2026-10-08T22:00:00+09:00", currency: "EUR", impact: "Medium", event: "ECB Speaks" },
    { time_jst: "22:00", datetime_jst: "2026-10-08T22:00:00+09:00", currency: "JPY", impact: "Low", event: "ignored" },
  ],
  ...o,
});
test("events: カレンダーの使える条件（存在・date が当日・as_of が20分以内）。20分ちょうどは使える", () => {
  const now = at("2026-10-08T21:30:00+09:00");
  const ok = calendarStatus(calendar(), now); // as_of 21:10 → 21:30 は20分（超えない）
  assert.equal(ok.ok, true);
  assert.equal(ok.age_min, 20);
  assert.equal(calendarStatus(calendar(), at("2026-10-08T21:31:00+09:00")).ok, false);
  assert.match(calendarStatus(calendar(), at("2026-10-08T21:31:00+09:00")).reason, /20分超/);
  assert.equal(calendarStatus(null, now).ok, false);
  assert.equal(calendarStatus({ ...calendar(), events: null }, now).ok, false);
  assert.match(calendarStatus(calendar({ date: "2026-10-07" }), now).reason, /当日/);
  assert.equal(calendarStatus(calendar({ as_of: "broken" }), now).ok, false);
});
test("events: 停止時間は High・Medium の15分前〜30分後（両端を含む）。Low と他通貨は対象外。カレンダー不可なら停止なし", () => {
  const now = at("2026-10-08T21:20:00+09:00");
  const st = calendarStatus(calendar(), now);
  assert.equal(st.ok, true);
  const w = stopWindows(calendar(), ["EUR", "USD"], st);
  assert.deepEqual(w.map((x) => x.event), ["CPI", "ECB Speaks"]);
  assert.equal(J.jstIso(w[0].start), "2026-10-08T21:15:00+09:00");
  assert.equal(J.jstIso(w[0].end), "2026-10-08T22:00:00+09:00");
  assert.equal(activeStops(w, at("2026-10-08T21:14:59+09:00")).length, 0);
  assert.equal(activeStops(w, at("2026-10-08T21:15:00+09:00")).length, 1);
  assert.equal(activeStops(w, at("2026-10-08T22:00:00+09:00")).length, 2); // CPI の終端 + ECB の開始
  assert.equal(activeStops(w, at("2026-10-08T22:30:00+09:00")).length, 1);
  assert.equal(activeStops(w, at("2026-10-08T22:30:01+09:00")).length, 0);
  assert.deepEqual(stopWindows(calendar(), ["JPY"], st), []); // Low は対象外
  assert.deepEqual(stopWindows(calendar(), ["EUR", "USD"], { ok: false }), []);
  assert.deepEqual(stopWindows(calendar(), undefined, st), []);
});

// ---- 方向 ----
const sym = (symbol, score, dirs) => ({ symbol, alignment_score: score, monthly: { direction: dirs[0] }, weekly: { direction: dirs[1] }, daily: { direction: dirs[2] } });
const mtf = (o = {}) => ({
  status: "ok", data_base_date: "2026-10-07",
  symbols: [
    sym("EURUSD", "3/3 Down", ["↓", "↓", "↓"]), sym("AUDUSD", "2/3 Up", ["↑", "↑", "→"]), sym("USDJPY", "2/3 Down", ["↓", "↓", "↑"]),
    sym("GBPUSD", "1/3 Up", ["↑", "→", "→"]), sym("EURJPY", "Mixed", ["↑", "↓", "→"]), sym("USDCAD", "0/3", ["→", "→", "→"]),
  ],
  ...o,
});
test("direction: 3/3・2/3 は候補、0/3・1/3・Mixed は監視のみ、逆向きの時間足がある2/3も監視のみ、未収録は根拠なし", () => {
  const m = mtf();
  const g = globalMtfStatus(m, "2026-10-07");
  assert.equal(g.ok, true);
  assert.deepEqual(symbolDirection(m, "EURUSD", g), { ok: true, side: "sell", strength: 3, alignment: "3/3 Down", dirs: ["↓", "↓", "↓"] });
  assert.equal(symbolDirection(m, "AUDUSD", g).side, "buy");
  assert.equal(symbolDirection(m, "AUDUSD", g).strength, 2);
  assert.equal(symbolDirection(m, "USDJPY", g).kind, "watch"); // 2/3 Down だが日足が↑
  for (const c of ["GBPUSD", "EURJPY", "USDCAD"]) assert.equal(symbolDirection(m, c, g).kind, "watch");
  const n = symbolDirection(m, "NZDUSD", g);
  assert.equal(n.ok, false);
  assert.equal(n.kind, "no_basis");
  assert.match(n.reason, /未収録/);
});
test("direction: mtf-feed が ok でない／data_base_date が直近の確定営業日でない／ファイルなし は全銘柄『方向根拠なし』", () => {
  assert.equal(globalMtfStatus(mtf({ status: "partial" }), "2026-10-07").ok, false);
  assert.equal(globalMtfStatus(mtf({ status: "stale" }), "2026-10-07").ok, false);
  assert.equal(globalMtfStatus(mtf({ data_base_date: "2026-10-06" }), "2026-10-07").ok, false);
  assert.equal(globalMtfStatus(null, "2026-10-07").ok, false);
  const g = globalMtfStatus(mtf({ status: "partial" }), "2026-10-07");
  const d = symbolDirection(mtf({ status: "partial" }), "EURUSD", g);
  assert.equal(d.ok, false);
  assert.equal(d.kind, "no_basis");
});

// ---- 東京レンジ ----
const hbar = (planDate, hm, h, l, c = (h + l) / 2) => ({ t: J.jstAt(planDate, hm), o: c, h, l, c });
const rangeBars = (planDate, hi = 1.1100, lo = 1.1050) => ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00"].map((hm, i) => hbar(planDate, hm, i === 2 ? hi : hi - 0.0010, i === 4 ? lo : lo + 0.0010));
test("tokyo: 9:00〜14:00開始の6本の高安。15:00開始以降の足の終値で外に出たらブレイク", () => {
  const D = "2026-10-08";
  let r = tokyoRange(rangeBars(D), D);
  assert.equal(r.complete, true);
  assert.equal(r.high, 1.11);
  assert.equal(r.low, 1.105);
  assert.equal(r.breakUp || r.breakDown, false);
  r = tokyoRange([...rangeBars(D), hbar(D, "15:00", 1.1060, 1.1040, 1.1049)], D);
  assert.equal(r.breakDown, true);
  assert.equal(r.breakUp, false);
  r = tokyoRange([...rangeBars(D), hbar(D, "15:00", 1.1120, 1.1060, 1.1105)], D);
  assert.equal(r.breakUp, true);
  // 高値を超えても終値がレンジ内ならブレイクではない（ヒゲ）
  r = tokyoRange([...rangeBars(D), hbar(D, "15:00", 1.1130, 1.1060, 1.1090)], D);
  assert.equal(r.breakUp, false);
  // 終値がレンジ高値ちょうどはブレイクではない
  r = tokyoRange([...rangeBars(D), hbar(D, "15:00", 1.1130, 1.1060, 1.1100)], D);
  assert.equal(r.breakUp, false);
  // 両方向
  r = tokyoRange([...rangeBars(D), hbar(D, "15:00", 1.1120, 1.1060, 1.1105), hbar(D, "16:00", 1.1060, 1.1040, 1.1045)], D);
  assert.equal(r.breakUp && r.breakDown, true);
  // 14:00開始の足は『15:00確定』なのでレンジに入り、ブレイク判定には使わない（開始15:00以降だけ）
  r = tokyoRange(rangeBars(D, 1.1100, 1.1050).map((b, i) => (i === 5 ? { ...b, c: 1.1000, l: 1.1000 } : b)), D);
  assert.equal(r.low, 1.1);
  assert.equal(r.breakDown, false);
});
test("tokyo: 6本そろっていなければ未確定（15:30 の設計では 14:00開始の足まで）", () => {
  const D = "2026-10-08";
  assert.equal(tokyoRange(rangeBars(D).slice(0, 5), D).complete, false);
  const gap = rangeBars(D); gap.splice(2, 1);
  assert.equal(tokyoRange(gap, D).complete, false);
  // 15:30 時点の確定足は 14:00 開始まで → ブレイクは成立し得ない（Q09）
  const r = tokyoRange(rangeBars(D), D);
  assert.equal(r.breakUp || r.breakDown, false);
});

// ---- JST ----
test("jst: h1-bars.json と同じ日本時間表記の往復、曜日", () => {
  const ms = J.parseJstLabel("2026-10-08 21:00");
  assert.equal(J.jstLabel(ms), "2026-10-08 21:00");
  assert.equal(J.jstIso(ms), "2026-10-08T21:00:00+09:00");
  assert.equal(J.jstDow(ms), 4); // 木
  assert.equal(J.jstHour(J.parseJstLabel("2026-10-08 09:30")), 9);
  assert.ok(Number.isNaN(J.parseJstLabel("garbage")));
  assert.ok(Number.isNaN(J.parseIso("2026-10-08 21:00")));
  assert.equal(J.addDaysJst("2026-10-31", 1), "2026-11-01");
});
