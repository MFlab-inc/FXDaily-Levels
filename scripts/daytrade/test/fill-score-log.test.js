"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { simulate, coversExpiry, overlaps } = require("../fill");
const { scoreRows, previousDaySummary, candFromRow } = require("../score");
const L = require("../log");
const csvio = require("../csvio");
const S = require("../schedule");
const { fetchRiskFeed, volatilityOf, URL: RF_URL } = require("../riskfeed");
const J = require("../jst");

const D = "2026-10-08"; // 木曜の計画日。有効期限 10-09 03:00
const bar = (hm, h, l, o = (h + l) / 2, c = (h + l) / 2, date = D) => ({ t: J.jstAt(date, hm), o, h, l, c });
const cand = (o = {}) => ({
  side: "sell", plan_date: D, generated_at_ms: J.jstAt(D, "15:30"), entry_low: 1.1040, entry_high: 1.1042,
  schemes: { A: { sl: 1.1050, tp: 1.0990 }, B: { sl: 1.1060, tp: 1.0990 } }, ...o,
});
// 到達する足（16:00）。帯 1.1040〜1.1042 に触れ、SL(1.1050) には届かない
const reach = () => bar("16:00", 1.1045, 1.1035, 1.1038, 1.1036);
const quiet = (hm, date = D) => bar(hm, 1.1030, 1.1020, 1.1025, 1.1025, date);

test("fill: 到達後の最初の足で TP1 に届けば TP1（TP1 の価格で決済）", () => {
  const r = simulate(cand(), [bar("15:00", 1.1050, 1.1030), reach(), bar("17:00", 1.1030, 1.0985)]);
  assert.equal(r.reached, "到達");
  assert.equal(J.jstLabel(r.reached_at), "2026-10-08 16:00"); // 15:00 開始（設計前）の足は使わない
  assert.equal(r.schemes.A.first_hit, "TP1");
  assert.equal(r.schemes.A.exit_price, 1.099);
  assert.equal(r.schemes.A.same_bar, false);
});
test("fill: 先に SL に届けば SL。A案は届かずB案も届かない足ではA案だけが決着する", () => {
  const r = simulate(cand(), [reach(), bar("17:00", 1.1055, 1.1030), bar("18:00", 1.1070, 1.0980)]);
  assert.equal(r.schemes.A.first_hit, "SL"); // 17:00 の高値 1.1055 ≥ A案SL 1.1050
  assert.equal(r.schemes.B.first_hit, "SL"); // 18:00 の高値 1.1070 ≥ B案SL 1.1060 が先（TP1 1.0990 も同じ足で届くが SL 先）
  assert.equal(r.schemes.B.same_bar, true);
  assert.equal(J.jstLabel(r.schemes.B.hit_at), "2026-10-08 18:00");
});
test("fill: 同じ足に SL と TP1 の両方が入れば SL 先（足の中の順序は分からないので不利な方）", () => {
  const r = simulate(cand(), [reach(), bar("17:00", 1.1052, 1.0980)]);
  assert.equal(r.schemes.A.first_hit, "SL");
  assert.equal(r.schemes.A.same_bar, true);
  assert.equal(r.schemes.A.exit_price, 1.105);
});
test("fill: 到達した足では SL だけ判定する（同じ足の TP1 は数えない）", () => {
  const r = simulate(cand(), [bar("16:00", 1.1051, 1.0980)]);
  assert.equal(r.schemes.A.first_hit, "SL");
  // 到達した足で SL に届かず TP1 に届いても、TP1 は次の足から
  const r2 = simulate(cand(), [bar("16:00", 1.1045, 1.0980), quiet("17:00")]);
  assert.equal(r2.schemes.A.first_hit, "未決");
});
test("fill: SL が始値のギャップを越えて始まれば、始値で損切り（損失を縮めない）", () => {
  const r = simulate(cand(), [reach(), bar("17:00", 1.1075, 1.1062, 1.1070, 1.1065)]);
  assert.equal(r.schemes.A.first_hit, "SL");
  assert.equal(r.schemes.A.gap, true);
  assert.equal(r.schemes.A.exit_price, 1.107);
});
test("fill: 有効期限（翌3:00）までに決着しなければ『未決』、最終足の終値で扱う。期限後の足は見ない", () => {
  const bars = [reach(), quiet("17:00"), quiet("23:00"), bar("02:00", 1.1030, 1.1020, 1.1025, 1.1024, "2026-10-09"), bar("03:00", 1.1100, 1.0900, 1.1, 1.1, "2026-10-09")];
  const r = simulate(cand(), bars);
  assert.equal(r.schemes.A.first_hit, "未決");
  assert.equal(r.schemes.A.exit_price, 1.1024);
  assert.equal(r.schemes.A.exit_kind, "timeout");
});
test("fill: 帯に届かなければ『未到達』。帯に触れる（高値＝帯下端ちょうど）だけでも到達", () => {
  assert.equal(simulate(cand(), [quiet("16:00"), quiet("17:00")]).reached, "未到達");
  assert.equal(simulate(cand(), [bar("16:00", 1.1040, 1.1030)]).reached, "到達");
  assert.equal(overlaps({ h: 1.1040, l: 1.1030 }, 1.1040, 1.1042), true);
  assert.equal(overlaps({ h: 1.10399, l: 1.1030 }, 1.1040, 1.1042), false);
});
test("fill: 新規不可の時間帯（9時台・翌1:00以降）に初めて届いたら『失効後到達』。その後に許される足で届けば『到達』", () => {
  const c = cand({ generated_at_ms: J.jstAt(D, "06:30") });
  const hit9 = bar("09:00", 1.1045, 1.1035);
  let r = simulate(c, [hit9, quiet("10:00")]);
  assert.equal(r.reached, "失効後到達");
  assert.equal(r.late_reason, "9時台");
  r = simulate(c, [hit9, bar("10:00", 1.1045, 1.1035)]);
  assert.equal(r.reached, "到達");
  assert.equal(J.jstLabel(r.reached_at), "2026-10-08 10:00");
  r = simulate(cand(), [quiet("16:00"), bar("01:00", 1.1045, 1.1035, 1.104, 1.104, "2026-10-09")]);
  assert.equal(r.reached, "失効後到達");
  assert.equal(r.late_reason, "翌1:00以降");
});
test("fill: reachUntilMs（次の設計で取消）以後に始まる足では到達を見ない", () => {
  const bars = [quiet("16:00"), bar("17:00", 1.1045, 1.1035)];
  assert.equal(simulate(cand(), bars, { reachUntilMs: J.jstAt(D, "17:00") }).reached, "未到達");
  assert.equal(simulate(cand(), bars, { reachUntilMs: J.jstAt(D, "18:00") }).reached, "到達");
});
test("fill: 買いの対称性（SLは下、TP1は上、ギャップは下）", () => {
  const c = cand({ side: "buy", entry_low: 1.1038, entry_high: 1.1040, schemes: { A: { sl: 1.1030, tp: 1.1090 } } });
  let r = simulate(c, [bar("16:00", 1.1045, 1.1035), bar("17:00", 1.1095, 1.1040)]);
  assert.equal(r.schemes.A.first_hit, "TP1");
  r = simulate(c, [bar("16:00", 1.1045, 1.1035), bar("17:00", 1.1020, 1.1010, 1.1015, 1.1012)]);
  assert.equal(r.schemes.A.first_hit, "SL");
  assert.equal(r.schemes.A.gap, true);
  assert.equal(r.schemes.A.exit_price, 1.1015);
});
test("fill: coversExpiry は最後の足の終了が有効期限以降のときだけ真", () => {
  assert.equal(coversExpiry([], D), false);
  assert.equal(coversExpiry([bar("02:00", 1, 1, 1, 1, "2026-10-09")], D), true); // 02:00開始 = 03:00終了
  assert.equal(coversExpiry([bar("01:00", 1, 1, 1, 1, "2026-10-09")], D), false);
});

// ---- ログ ----
const row = (o = {}) => ({
  plan_date: D, generated_at: "2026-10-08T15:30:00+09:00", run: "design", setup: "A", symbol: "EURUSD", side: "sell",
  same_direction_group: "", entry_low: "1.10400", entry_high: "1.10420", sl_a: "1.10500", tp_a: "1.09900", sl_b: "1.10600", tp_b: "1.09900",
  rr_a: "5.0", rr_b: "2.5", cost_cap_a: "9.2", lot_cap_a_701620: "0.20", lot_cap_b_701620: "0.10", lot_cap_a_702449: "1.56", lot_cap_b_702449: "0.78",
  expires_at: "2026-10-09T03:00:00+09:00", reached: "", reached_at: "", first_hit_a: "", first_hit_b: "", filled_ticket_701620: "", filled_ticket_702449: "",
  ...o,
});
test("log: 列は仕様どおり27列。往復できる。引用符・カンマを含む値も壊れない", () => {
  assert.equal(L.COLUMNS.length, 27);
  const rows = [row(), row({ symbol: "USDJPY", same_direction_group: 'USD売り,"x"' })];
  const text = L.appendedText("", rows);
  assert.equal(text.split("\n")[0], L.COLUMNS.join(","));
  assert.deepEqual(L.parseLog(text), rows);
  assert.throws(() => L.parseLog("a,b\n1,2\n"), /見出し行/);
  assert.deepEqual(csvio.parse('a,"b,c","d""e"\n'), [["a", "b,c", 'd"e']]);
});
test("log: 追記のみ。既存の本文は一字も変えず、末尾に足す（人が埋めた filled_ticket も保持）", () => {
  const first = L.appendedText("", [row({ filled_ticket_701620: "T123" })]);
  const second = L.appendedText(first, [row({ run: "status", reached: "到達" })]);
  assert.ok(second.startsWith(first));
  assert.equal(L.parseLog(second).length, 2);
  assert.equal(L.parseLog(second)[0].filled_ticket_701620, "T123");
  assert.equal(L.appendedText(first, []), first);
});
test("log: 版の識別は (計画日・型・銘柄・向き・帯・SL) の一致。最新の行が版の現在の状態", () => {
  const a = row(), b = row({ run: "status", reached: "到達" }), c = row({ sl_a: "1.10520" });
  assert.equal(L.keyOf(a), L.keyOf(b));
  assert.notEqual(L.keyOf(a), L.keyOf(c));
  const m = L.latestByKey([a, b, c]);
  assert.equal(m.size, 2);
  assert.equal(m.get(L.keyOf(a)).run, "status");
});

// ---- 採点 ----
const fullBars = (extra = []) => [reach(), quiet("17:00"), bar("00:00", 1.1030, 1.0985, 1.1, 1.0990, "2026-10-09"), bar("02:00", 1.1030, 1.1020, 1.1025, 1.1024, "2026-10-09"), ...extra];
test("score: 有効期限を過ぎた未採点の案を採点し、run=status の行を追記（旧行は変えない）", () => {
  const rows = [row()];
  const now = J.parseIso("2026-10-09T06:30:00+09:00");
  const { newRows, held } = scoreRows({ rows, barsByCode: { EURUSD: fullBars() }, nowMs: now });
  assert.equal(held.length, 0);
  assert.equal(newRows.length, 1);
  const n = newRows[0];
  assert.equal(n.run, "status");
  assert.equal(n.reached, "到達");
  assert.equal(n.reached_at, "2026-10-08T16:00:00+09:00");
  assert.equal(n.first_hit_a, "TP1");
  assert.equal(n.first_hit_b, "TP1");
  assert.equal(L.keyOf(n), L.keyOf(rows[0]));
  // 採点済み（最新の行が status）の版は二度採点しない
  assert.equal(scoreRows({ rows: [...rows, n], barsByCode: { EURUSD: fullBars() }, nowMs: now }).newRows.length, 0);
});
test("score: 有効期限前は採点しない／H1足が有効期限まで届いていなければ保留（『未到達』と確定させない）", () => {
  assert.equal(scoreRows({ rows: [row()], barsByCode: { EURUSD: fullBars() }, nowMs: J.parseIso("2026-10-09T02:00:00+09:00") }).newRows.length, 0);
  const now = J.parseIso("2026-10-09T06:30:00+09:00");
  const short = [reach(), quiet("17:00")];
  const r = scoreRows({ rows: [row()], barsByCode: { EURUSD: short }, nowMs: now });
  assert.equal(r.newRows.length, 0);
  assert.equal(r.held.length, 1);
  assert.match(r.held[0].reason, /届いていません/);
  assert.equal(scoreRows({ rows: [row()], barsByCode: {}, nowMs: now }).held.length, 1);
});
test("score: 取消(再設計)済みの版は採点しない／到達しなければ未到達（先着の列は空）", () => {
  const now = J.parseIso("2026-10-09T06:30:00+09:00");
  const cancelled = row({ run: "status", reached: "取消(再設計)" });
  assert.equal(scoreRows({ rows: [row(), cancelled], barsByCode: { EURUSD: fullBars() }, nowMs: now }).newRows.length, 0);
  const calm = [quiet("16:00"), quiet("17:00"), quiet("02:00", "2026-10-09")];
  const n = scoreRows({ rows: [row()], barsByCode: { EURUSD: calm }, nowMs: now }).newRows[0];
  assert.equal(n.reached, "未到達");
  assert.equal(n.first_hit_a, "");
});
test("score: 金曜の計画日の案は月曜に採点される（有効期限は土曜3:00）", () => {
  const F = "2026-10-09";
  const r = row({ plan_date: F, generated_at: "2026-10-09T15:30:00+09:00", expires_at: "2026-10-10T03:00:00+09:00" });
  const bars = [bar("16:00", 1.1045, 1.1035, 1.1, 1.1, F), bar("02:00", 1.1030, 1.1020, 1.1025, 1.1024, "2026-10-10")];
  const out = scoreRows({ rows: [r], barsByCode: { EURUSD: bars }, nowMs: J.parseIso("2026-10-12T06:30:00+09:00") });
  assert.equal(out.newRows.length, 1);
  assert.equal(out.newRows[0].reached, "到達");
});
test("score: 行 → 案の復元（空欄の案は含めない）", () => {
  const c = candFromRow(row({ sl_b: "", tp_b: "" }));
  assert.deepEqual(Object.keys(c.schemes), ["A"]);
  assert.equal(c.entry_low, 1.104);
  assert.equal(c.generated_at_ms, J.parseIso("2026-10-08T15:30:00+09:00"));
});
test("score: 前日の結果の集計（最新の採点済みの計画日。版ごとの直近の行）", () => {
  const rows = [
    row(), row({ run: "status", reached: "到達", reached_at: "2026-10-08T16:00:00+09:00", first_hit_a: "TP1", first_hit_b: "SL" }),
    row({ symbol: "USDJPY", entry_low: "150.400" }), row({ symbol: "USDJPY", entry_low: "150.400", run: "status", reached: "未到達" }),
    row({ symbol: "AUDUSD" }), // 未採点
    row({ plan_date: "2026-10-07", symbol: "GBPUSD", run: "status", reached: "到達", first_hit_a: "SL" }),
  ];
  const s = previousDaySummary(rows, "2026-10-09");
  assert.equal(s.plan_date, "2026-10-08");
  assert.equal(s.n, 3);
  assert.equal(s.reached, 1);
  assert.equal(s.not_reached, 1);
  assert.equal(s.unscored, 1);
  assert.deepEqual(s.a, { tp1: 1, sl: 0, open: 0 });
  assert.deepEqual(s.b, { tp1: 0, sl: 1, open: 0 });
  assert.equal(previousDaySummary(rows, "2026-10-07"), null);
  assert.equal(previousDaySummary([], "2026-10-09"), null);
});

// ---- スケジュール ----
const SUMMER = J.parseIso("2026-07-15T06:30:00+09:00");
const WINTER = J.parseIso("2026-12-15T07:30:00+09:00");
test("schedule: 夏冬の判定（NY夏時間）と各 cron の解決。該当しない側は何もしない", () => {
  assert.equal(S.isNyDst(SUMMER), true);
  assert.equal(S.isNyDst(WINTER), false);
  const r = (cron, ms) => S.resolveAction(cron, ms);
  assert.deepEqual(r("30 21 * * 0-4", SUMMER), { action: "design", slot: 1 });
  assert.equal(r("30 21 * * 0-4", WINTER).action, "skip");
  assert.deepEqual(r("30 22 * * 0-4", WINTER), { action: "design", slot: 1 });
  assert.equal(r("30 22 * * 0-4", SUMMER).action, "skip");
  assert.deepEqual(r("30 6 * * 1-5", SUMMER), { action: "design", slot: 2 });
  assert.deepEqual(r("30 6 * * 1-5", WINTER), { action: "design", slot: 2 });
  assert.deepEqual(r("0 12 * * 1-5", SUMMER), { action: "design", slot: 3 });
  assert.deepEqual(r("0 12 * * 1-5", WINTER), { action: "status", slot: null });
  assert.deepEqual(r("0 13 * * 1-5", WINTER), { action: "design", slot: 3 });
  assert.deepEqual(r("0 13 * * 1-5", SUMMER), { action: "status", slot: null });
  assert.equal(r("0 22,23 * * 0-4", SUMMER).action, "status");
  assert.equal(r("0 0-11,14-17 * * 1-5", WINTER).action, "status");
  assert.equal(r("1 2 3 4 5", SUMMER).action, null);
});
test("schedule: ミリ秒つきの現在時刻（Date.now()）でも夏冬を正しく判定する", () => {
  for (const ms of [0, 1, 123, 999]) {
    assert.equal(S.isNyDst(SUMMER + ms), true);
    assert.equal(S.isNyDst(WINTER + ms), false);
    assert.deepEqual(S.resolveAction("30 21 * * 0-4", SUMMER + ms), { action: "design", slot: 1 });
    assert.equal(S.resolveAction("30 22 * * 0-4", SUMMER + ms).action, "skip");
    assert.deepEqual(S.resolveAction("0 12 * * 1-5", J.parseIso("2026-07-15T21:00:00+09:00") + ms), { action: "design", slot: 3 });
    assert.deepEqual(S.resolveAction("0 13 * * 1-5", J.parseIso("2026-07-15T22:00:00+09:00") + ms), { action: "status", slot: null });
    assert.deepEqual(S.resolveAction("30 22 * * 0-4", WINTER + ms), { action: "design", slot: 1 });
    assert.equal(J.jstHm(S.slotNominalMs(1, "2026-07-15", SUMMER + ms)), "06:30");
  }
});
test("schedule: 夏冬の切り替え日（NY 3/8・11/1）でも判定が合う", () => {
  assert.equal(S.isNyDst(Date.parse("2026-03-08T06:59:00Z")), false);
  assert.equal(S.isNyDst(Date.parse("2026-03-08T07:00:00Z")), true);
  assert.equal(S.isNyDst(Date.parse("2026-11-01T05:59:00Z")), true);
  assert.equal(S.isNyDst(Date.parse("2026-11-01T06:00:00Z")), false);
});
test("schedule: 設計の枠の名目時刻（夏 06:30/21:00、冬 07:30/22:00、②は 15:30 固定）", () => {
  const hm = (slot, d, ms) => J.jstHm(S.slotNominalMs(slot, d, ms));
  assert.equal(hm(1, "2026-07-15", SUMMER), "06:30");
  assert.equal(hm(1, "2026-12-15", WINTER), "07:30");
  assert.equal(hm(2, "2026-07-15", SUMMER), "15:30");
  assert.equal(hm(2, "2026-12-15", WINTER), "15:30");
  assert.equal(hm(3, "2026-07-15", SUMMER), "21:00");
  assert.equal(hm(3, "2026-12-15", WINTER), "22:00");
});
test("schedule: 遅れて動いた設計は見送る（次の枠の名目時刻以後、後の枠の設計が既にある、設計③は翌1:00以後）", () => {
  const t = (s) => J.parseIso(s);
  assert.equal(S.designStale({ slot: 1, nowMs: t("2026-07-15T08:00:00+09:00"), lastDesignSlot: null }), null);
  assert.match(S.designStale({ slot: 1, nowMs: t("2026-07-15T15:30:00+09:00"), lastDesignSlot: null }), /次の枠/);
  assert.match(S.designStale({ slot: 1, nowMs: t("2026-07-15T08:00:00+09:00"), lastDesignSlot: 2 }), /後の枠/);
  assert.equal(S.designStale({ slot: 2, nowMs: t("2026-07-15T16:10:00+09:00"), lastDesignSlot: 1 }), null);
  assert.match(S.designStale({ slot: 2, nowMs: t("2026-07-15T21:00:00+09:00"), lastDesignSlot: 1 }), /次の枠/);
  assert.equal(S.designStale({ slot: 3, nowMs: t("2026-07-16T00:59:00+09:00"), lastDesignSlot: 2 }), null);
  assert.match(S.designStale({ slot: 3, nowMs: t("2026-07-16T01:00:00+09:00"), lastDesignSlot: 2 }), /翌1:00/);
});

// ---- risk-feed ----
const feed = () => ({
  meta: { generated_intraday: "2026-10-08T16:10:00+09:00" },
  pairs: {
    EURUSD: { intraday: { range_today: 52.1, range_vs_adr: 0.84, spike_flag: false, updated_at: "2026-10-08T16:10:00+09:00" } },
    USDJPY: { intraday: { range_today: null, range_vs_adr: null, spike_flag: false, updated_at: null } },
  },
});
test("riskfeed: ?nocache= を付けて取得し、meta.generated_intraday を読む。失敗は『未取得』", async () => {
  let url = null;
  const now = J.parseIso("2026-10-08T16:20:00+09:00");
  const ok = await fetchRiskFeed({ nowMs: now, fetchImpl: async (u) => { url = u; return { ok: true, status: 200, json: async () => feed() }; } });
  assert.ok(url.startsWith(`${RF_URL}?nocache=`));
  assert.equal(url, `${RF_URL}?nocache=${Math.floor(now / 1000)}`);
  assert.equal(ok.status, "ok");
  assert.equal(ok.generated_intraday, "2026-10-08T16:10:00+09:00");
  assert.equal(ok.age_min, 10);
  assert.equal((await fetchRiskFeed({ fetchImpl: async () => ({ ok: false, status: 503 }) })).status, "未取得");
  assert.equal((await fetchRiskFeed({ fetchImpl: async () => { throw new Error("boom"); } })).status, "未取得");
  assert.equal((await fetchRiskFeed({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }) })).status, "未取得");
});
test("riskfeed: 銘柄ごと — 未収録／未取得／あるものだけ表示（null・未計算の急変フラグは出さない）", async () => {
  const rf = await fetchRiskFeed({ nowMs: J.parseIso("2026-10-08T16:20:00+09:00"), fetchImpl: async () => ({ ok: true, status: 200, json: async () => feed() }) });
  assert.deepEqual(volatilityOf(rf, "EURUSD"), { state: "ok", items: { range_today: 52.1, range_vs_adr: 0.84, spike_flag: false, updated_at: "2026-10-08T16:10:00+09:00" } });
  assert.deepEqual(volatilityOf(rf, "USDJPY"), { state: "ok", items: {} });
  for (const c of ["GBPUSD", "EURJPY", "NZDUSD", "USDCHF"]) assert.deepEqual(volatilityOf(rf, c), { state: "未収録" });
  assert.deepEqual(volatilityOf({ status: "未取得", pairs: {} }, "EURUSD"), { state: "未取得" });
  assert.deepEqual(volatilityOf(null, "EURUSD"), { state: "未取得" });
});
