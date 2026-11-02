"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const L = require("../log");
const V = require("../versions");
const J = require("../jst");
const { scoreRows, previousDaySummary, pnlColumns } = require("../score");
const { simulate, coversUntil } = require("../fill");
const { trackLogRows, buildDesign } = require("../plan");
const { makeScenario } = require("./scenario");
const { loadInputs } = require("../inputs");
const { rm, jstAt, HR } = require("./helpers");

/**
 * ■1 到達したあとに取消された版も、最後まで採点する／■5 採点の行に案ごとの損益を残す。
 * 実データ: fixtures/cancelled-versions-2026-10.json = data/daytrade/log.csv の 取消(再設計) の16版（2026-10-09〜10-30）の設計の行・取消の行と、
 * data/h1-bars.json の足（その計画日の前日18時〜有効期限の2時間後）。ログの行は実データのまま。
 */
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "cancelled-versions-2026-10.json"), "utf8")).versions;
const barsOf = (v) => v.bars.map(([t, o, h, l, c]) => ({ t: J.parseJstLabel(t), o, h, l, c }));
const barsBySymbol = (vs) => {
  const m = {};
  for (const v of vs) {
    const sym = v.design.symbol;
    const have = new Map((m[sym] || []).map((b) => [b.t, b]));
    for (const b of barsOf(v)) have.set(b.t, b);
    m[sym] = [...have.values()].sort((a, b) => a.t - b.t);
  }
  return m;
};
const NOW = J.parseIso("2026-11-02T17:30:00+09:00");
const hm = (ms) => J.jstLabel(ms).slice(5);

// 依頼文の期待値（H1、fill.js の規則。2026-10-31 の週次まとめで再現した値）。[計画日, 型, 銘柄, 基準水準側のEntry端, 到達の足, { A案／B案: [先着, 先着の足] }]
const EXPECT = [
  ["2026-10-15", "A", "EURUSD", "1.11581", "10-15 07:00", { B: ["SL", "10-15 07:00"] }],
  ["2026-10-15", "A", "EURJPY", "177.241", "10-15 16:00", { A: ["TP1", "10-15 17:00"] }],
  ["2026-10-16", "A", "XAUUSD", "4177.81", "10-16 11:00", { A: ["SL", "10-16 12:00"] }],
  ["2026-10-21", "A", "XAUUSD", "4130.98", "10-21 20:00", { A: ["SL", "10-21 20:00"] }],
  ["2026-10-23", "A", "XAUUSD", "4019.83", "10-23 16:00", { A: ["SL", "10-23 18:00"] }],
  ["2026-10-26", "A", "USDJPY", "157.164", "10-26 10:00", { A: ["TP1", "10-26 11:00"] }],
  ["2026-10-27", "A", "EURJPY", "176.075", "10-27 08:00", { A: ["SL", "10-27 10:00"] }],
  ["2026-10-27", "A", "XAUUSD", "4008.28", "10-27 19:00", { A: ["SL", "10-27 19:00"], B: ["SL", "10-27 21:00"] }],
  ["2026-10-27", "B", "XAUUSD", "3999.84", "10-27 18:00", { A: ["SL", "10-27 19:00"] }],
  ["2026-10-28", "A", "XAUUSD", "4038.28", "10-28 16:00", { A: ["SL", "10-28 16:00"], B: ["SL", "10-28 17:00"] }],
  ["2026-10-29", "B", "NZDUSD", "0.56157", "10-29 20:00", { B: ["SL", "10-29 23:00"] }],
  ["2026-10-30", "B", "XAUUSD", "3988.10", "10-30 17:00", { A: ["SL", "10-30 17:00"] }],
];
const UNREACHED = [["2026-10-09", "A", "EURJPY"], ["2026-10-13", "A", "XAUUSD"], ["2026-10-19", "A", "XAUUSD"], ["2026-10-20", "B", "XAUUSD"]];
const rowsOf = () => FIX.flatMap((v) => [v.design, v.cancel]);
const find = (rows, [pd, setup, sym, entry]) => rows.find((r) => r.plan_date === pd && r.setup === setup && r.symbol === sym && (entry === undefined || Number(r.entry_low) === Number(entry)));

test("■1 取消の時刻の判定: 実データの取消16版を fill.js（reachUntilMs＝取消の時刻）で判定すると、到達していた12版は期待値のとおり、残り4版は未到達", () => {
  assert.equal(FIX.length, 16);
  for (const [pd, setup, sym, entry, reachedAt, hits] of EXPECT) {
    const v = FIX.find((x) => x.design.plan_date === pd && x.design.setup === setup && x.design.symbol === sym && Number(x.design.entry_low) === Number(entry));
    assert.ok(v, `${pd} ${sym}`);
    const j = V.judgeCancel({ designRow: v.design, bars: barsOf(v), cancelMs: J.parseIso(v.cancel.generated_at) });
    assert.equal(j.reached, true, `${pd} ${sym}`);
    assert.equal(hm(j.reached_at), reachedAt, `${pd} ${sym} 到達の足`);
    assert.deepEqual(Object.keys(j.sim.schemes).sort(), Object.keys(hits).sort(), `${pd} ${sym} 案`);
    for (const [n, [hit, at]] of Object.entries(hits)) {
      assert.equal(j.sim.schemes[n].first_hit, hit, `${pd} ${sym} ${n}案`);
      assert.equal(hm(j.sim.schemes[n].hit_at), at, `${pd} ${sym} ${n}案の先着の足`);
    }
  }
  for (const [pd, setup, sym] of UNREACHED) {
    const v = FIX.find((x) => x.design.plan_date === pd && x.design.setup === setup && x.design.symbol === sym);
    const j = V.judgeCancel({ designRow: v.design, bars: barsOf(v), cancelMs: J.parseIso(v.cancel.generated_at) });
    assert.equal(j.reached, false, `${pd} ${sym}`);
    assert.equal(j.known, true, "足がそろっているので『未到達』と確定できる");
  }
});

test("■1 取消の行を書くとき: 到達していれば 取消(到達後)（reached_at＝H1 の足の時刻）、していなければ従来どおり 取消(再設計)（reached_at 空）。取消の時刻より後の足は使わない", () => {
  const bars = barsBySymbol(FIX);
  for (const v of FIX) {
    const cancelMs = J.parseIso(v.cancel.generated_at);
    const out = trackLogRows({ cands: [], prevRows: [v.design], rows: [v.design], generatedAt: v.cancel.generated_at, nowMs: cancelMs, barsByCode: bars });
    assert.equal(out.length, 1);
    const exp = EXPECT.find(([pd, setup, sym, entry]) => v.design.plan_date === pd && v.design.setup === setup && v.design.symbol === sym && Number(v.design.entry_low) === Number(entry));
    if (exp) {
      assert.equal(out[0].reached, "取消(到達後)");
      assert.equal(hm(J.parseIso(out[0].reached_at)), exp[4]);
    } else {
      assert.equal(out[0].reached, "取消(再設計)");
      assert.equal(out[0].reached_at, "");
    }
    assert.equal(out[0].run, "status");
    assert.equal(out[0].first_hit_a, undefined === out[0].first_hit_a ? undefined : out[0].first_hit_a); // 先着は取消の時には書かない（採点のとき）
    assert.ok(!out[0].first_hit_a && !out[0].first_hit_b);
    assert.equal(L.keyOf(out[0]), L.keyOf(v.design)); // 同じ版
  }
  // 取消の時刻より後に帯へ触れる足があっても、到達にしない（10/29 NZDUSD の到達の足は 20:00。取消が 19:30 なら未到達）
  const v = FIX.find((x) => x.design.plan_date === "2026-10-29" && x.design.symbol === "NZDUSD");
  const early = trackLogRows({ cands: [], prevRows: [v.design], rows: [v.design], generatedAt: "2026-10-29T19:30:00+09:00", nowMs: J.parseIso("2026-10-29T19:30:00+09:00"), barsByCode: bars });
  assert.equal(early[0].reached, "取消(再設計)");
});

test("■1 取消の時刻までの H1 足が届いていないとき: 到達していれば（足が足りなくても）取消(到達後)、そうでなければ 取消(再設計) とし、採点のときに判定し直す", () => {
  const v = FIX.find((x) => x.design.plan_date === "2026-10-29" && x.design.symbol === "NZDUSD"); // 20:00 の足で到達、取消は 21:05
  const cancelMs = J.parseIso(v.cancel.generated_at);
  const all = barsOf(v);
  const lag = all.filter((b) => b.t < jstAt("2026-10-29", "20:00")); // 20:00 の足（21:00 に確定）が届いていない
  assert.equal(coversUntil(all, cancelMs), true);
  assert.equal(coversUntil(lag, cancelMs), false);
  const j = V.judgeCancel({ designRow: v.design, bars: lag, cancelMs });
  assert.equal(j.reached, false);
  assert.equal(j.known, false, "足が届いていないので『未到達』とは確定できない");
  const out = trackLogRows({ cands: [], prevRows: [v.design], rows: [v.design], generatedAt: v.cancel.generated_at, nowMs: cancelMs, barsByCode: { NZDUSD: lag } });
  assert.equal(out[0].reached, "取消(再設計)");
  // 採点のとき（足がそろった後）に判定し直す: 取消(再設計) の行 → 取消(到達後)（先着まで判定）
  const r = scoreRows({ rows: [v.design, out[0]], barsByCode: { NZDUSD: all }, nowMs: NOW });
  assert.equal(r.newRows.length, 1);
  assert.equal(r.newRows[0].reached, "取消(到達後)");
  assert.equal(hm(J.parseIso(r.newRows[0].reached_at)), "10-29 20:00");
  assert.equal(r.newRows[0].first_hit_b, "SL");
  // 足が設計時刻まで遡って届いていない（古くなって落ちた）判定し直せないものは、黙って何も足さない
  const tooNew = scoreRows({ rows: [v.design, out[0]], barsByCode: { NZDUSD: all.filter((b) => b.t >= jstAt("2026-10-30", "00:00")) }, nowMs: NOW });
  assert.deepEqual(tooNew.newRows, []);
});

test("■1 intraday の state.reached_at は到達の判定に使わない: 計画に state.reached_at が空でも、H1 足で届いていれば 取消(到達後)", () => {
  const sc1 = makeScenario(); // 15:30 の設計②
  const sc2 = makeScenario({
    nowIso: "2026-10-08T21:05:00+09:00", spec: { EURUSD: { score: "1/3 Down", dirs: ["↓", "→", "→"] } },
    // 17:00 の足だけが EURUSD の売りの帯（1.1040〜1.1042）に触れる
    barsEdit: { EURUSD: (bars) => bars.map((b) => (b.t === jstAt("2026-10-08", "17:00") ? { ...b, h: 1.1045, l: 1.1035 } : b)) },
  });
  try {
    const noFeed = { status: "未取得", reason: "x", pairs: {} };
    const inputs1 = loadInputs({ dataDir: sc1.dataDir, repoRoot: sc1.repoRoot, nowMs: sc1.nowMs, env: sc1.env });
    const first = buildDesign({ inputs: inputs1, riskFeed: noFeed, nowMs: sc1.nowMs, slot: 2, prevPlan: null, logRows: [] });
    const eu = first.plan.candidates.find((c) => c.symbol === "EURUSD");
    assert.equal(eu.state.reached_at, null, "設計の直後の計画には到達の時刻が無い");
    const inputs2 = loadInputs({ dataDir: sc2.dataDir, repoRoot: sc2.repoRoot, nowMs: sc2.nowMs, env: sc2.env });
    const d3 = buildDesign({ inputs: inputs2, riskFeed: noFeed, nowMs: sc2.nowMs, slot: 3, prevPlan: first.plan, logRows: first.logAppend });
    const cancelRow = d3.logAppend.find((r) => r.run === "status" && r.symbol === "EURUSD");
    assert.equal(cancelRow.reached, "取消(到達後)");
    assert.equal(cancelRow.reached_at, "2026-10-08T17:00:00+09:00");
  } finally { rm(path.dirname(sc1.dataDir)); rm(path.dirname(sc2.dataDir)); }
});

test("■1 採点（過去分の移行）: 取消(再設計) の16版のうち、H1 で到達していた12版に 取消(到達後) の採点の行（先着つき）を1行ずつ足す。期待値と一致。2回目は何も足さない。旧行は変えない", () => {
  const rows = rowsOf();
  const bars = barsBySymbol(FIX);
  const r = scoreRows({ rows, barsByCode: bars, nowMs: NOW });
  assert.equal(r.newRows.length, 12);
  assert.deepEqual(r.held, []);
  for (const exp of EXPECT) {
    const row = find(r.newRows, exp);
    assert.ok(row, `${exp[0]} ${exp[2]}`);
    assert.equal(row.run, "status");
    assert.equal(row.reached, "取消(到達後)");
    assert.equal(hm(J.parseIso(row.reached_at)), exp[4]);
    assert.equal(row.generated_at, "2026-11-02T17:30:00+09:00", "書いた時刻");
    assert.equal(row.first_hit_a, exp[5].A ? exp[5].A[0] : "", `${exp[0]} ${exp[2]} A案`);
    assert.equal(row.first_hit_b, exp[5].B ? exp[5].B[0] : "", `${exp[0]} ${exp[2]} B案`);
    const d = r.details.find((x) => x.row === row);
    assert.equal(d.kind, "migrate-scored");
    for (const [n, [, at]] of Object.entries(exp[5])) assert.equal(hm(d.sim.schemes[n].hit_at), at);
  }
  for (const u of UNREACHED) assert.equal(find(r.newRows, u), undefined, `${u[0]} ${u[2]} は取消(再設計)のまま`);
  // 1回だけ: 追記した行を足したログをもう一度採点しても、新しい行は出ない
  const again = scoreRows({ rows: [...rows, ...r.newRows], barsByCode: bars, nowMs: NOW + HR });
  assert.deepEqual(again.newRows, []);
  // 旧行は書き換えない: 追記の本文は、元の本文の末尾に足すだけ（見出し行だけが新しい列の形になる）
  const old = L.appendedText("", rows.map((x) => ({ ...x })), L.LEGACY_COLUMNS);
  const text = L.appendedText(old, r.newRows);
  assert.equal(text.split("\n").slice(1, 1 + rows.length).join("\n"), old.split("\n").slice(1, 1 + rows.length).join("\n"));
  assert.equal(text.split("\n")[0], L.COLUMNS.join(","));
  assert.equal(L.parseLog(text).length, rows.length + 12);
});

test("■1 採点: 取消(到達後) の行は、有効期限の前は採点せず、期限後に有効期限まで SL/TP1 を追う（reached は 取消(到達後) のまま）。H1 足が期限まで届かなければ保留", () => {
  const v = FIX.find((x) => x.design.plan_date === "2026-10-15" && x.design.symbol === "EURJPY");
  const pending = { ...v.cancel, reached: "取消(到達後)", reached_at: "2026-10-15T16:00:00+09:00" };
  const bars = barsOf(v);
  const exp = J.parseIso(v.design.expires_at);
  assert.deepEqual(scoreRows({ rows: [v.design, pending], barsByCode: { EURJPY: bars }, nowMs: exp - 60000 }).newRows, []);
  const held = scoreRows({ rows: [v.design, pending], barsByCode: { EURJPY: bars.filter((b) => b.t < jstAt("2026-10-15", "23:00")) }, nowMs: exp + 60000 });
  assert.equal(held.newRows.length, 0);
  assert.match(held.held[0].reason, /有効期限まで届いていません/);
  const ok = scoreRows({ rows: [v.design, pending], barsByCode: { EURJPY: bars }, nowMs: exp + 3 * HR });
  assert.equal(ok.newRows.length, 1);
  const row = ok.newRows[0];
  assert.equal(row.reached, "取消(到達後)");
  assert.equal(row.first_hit_a, "TP1");
  assert.equal(row.reached_at, "2026-10-15T16:00:00+09:00");
  assert.equal(row.generated_at, J.jstIso(exp + 3 * HR));
  // 採点済みの行（先着が入った行）は、もう採点しない
  assert.deepEqual(scoreRows({ rows: [v.design, pending, row], barsByCode: { EURJPY: bars }, nowMs: exp + 4 * HR }).newRows, []);
});

test("■1 採点: 取消の時刻に H1 足がそろっていない移行（期限前）は、先着を判定せず 取消(到達後) の行だけ足す。期限後の次の採点で先着を足す", () => {
  const v = FIX.find((x) => x.design.plan_date === "2026-10-15" && x.design.symbol === "EURJPY");
  const bars = barsOf(v);
  const exp = J.parseIso(v.design.expires_at);
  const first = scoreRows({ rows: [v.design, v.cancel], barsByCode: { EURJPY: bars }, nowMs: exp - 2 * HR });
  assert.equal(first.newRows.length, 1);
  assert.equal(first.newRows[0].reached, "取消(到達後)");
  assert.equal(first.newRows[0].first_hit_a, "");
  assert.equal(first.details[0].kind, "migrate-pending");
  const second = scoreRows({ rows: [v.design, v.cancel, first.newRows[0]], barsByCode: { EURJPY: bars }, nowMs: exp + HR });
  assert.equal(second.newRows.length, 1);
  assert.equal(second.newRows[0].first_hit_a, "TP1");
  // 取消の時刻は最初の取消の行（v.cancel）のもの。移行の行の書いた時刻ではない
  assert.equal(hm(J.parseIso(second.newRows[0].reached_at)), "10-15 16:00");
});

test("■1 前営業日の集計（出力の6項目目）: 取消(到達後) を数え、先着まで追った分は A案／B案の先着にも含める。txt にも出る", () => {
  const rows = rowsOf();
  const r = scoreRows({ rows, barsByCode: barsBySymbol(FIX), nowMs: NOW });
  const day = previousDaySummary([...rows, ...r.newRows], "2026-10-28");
  assert.equal(day.plan_date, "2026-10-27");
  assert.equal(day.n, 3);
  assert.equal(day.cancelled_after_reach, 3);
  assert.equal(day.cancelled, 0);
  assert.deepEqual(day.a, { tp1: 0, sl: 3, open: 0 });
  assert.deepEqual(day.b, { tp1: 0, sl: 1, open: 0 });
  const { render } = require("../render");
  const sc = makeScenario({ nowIso: "2026-10-28T15:30:00+09:00" });
  let txt;
  try {
    const inputs = loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs, env: sc.env });
    const { plan } = buildDesign({ inputs, riskFeed: { status: "未取得", reason: "x", pairs: {} }, nowMs: sc.nowMs, slot: 2, prevPlan: null, logRows: [...rows, ...r.newRows] });
    assert.equal(plan.previous_day.plan_date, "2026-10-27");
    assert.equal(plan.previous_day.cancelled_after_reach, 3);
    txt = render(plan, {});
  } finally { rm(path.dirname(sc.dataDir)); }
  assert.match(txt, /到達 0・未到達 0・失効後到達 0・取消 0・取消\(到達後\) 3/);
  assert.match(txt, /取消\(到達後\)も有効期限まで追った分を含む/);
  assert.match(txt, /EURJPY 売り 型A: 取消\(到達後\)（2026-10-27 08:00）/);
});

test("■1 見出しの移行: 古い見出し（27列）の log.csv も読める。追記のとき見出し行だけを新しい形（33列）にし、既存の行は一字も変えない", () => {
  const row = (o) => ({ ...Object.fromEntries(L.COLUMNS.map((c) => [c, ""])), plan_date: "2026-10-08", generated_at: "2026-10-08T15:30:00+09:00", run: "design", setup: "A", symbol: "EURUSD", side: "sell", entry_low: "1.10400", entry_high: "1.10420", ...o });
  const legacy = L.appendedText("", [row({}), row({ symbol: "GBPUSD" })], L.LEGACY_COLUMNS);
  assert.equal(legacy.split("\n")[0].split(",").length, 27);
  assert.equal(legacy.split("\n")[1].split(",").length, 27);
  const rows = L.parseLog(legacy);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].exit_a, "");
  const next = L.appendedText(legacy, [row({ run: "status", reached: "到達", exit_a: "1.09900", pips_a: "50.5", r_a: "5.05" })]);
  assert.equal(next.split("\n")[0], L.COLUMNS.join(","));
  assert.equal(next.split("\n").slice(1, 3).join("\n"), legacy.split("\n").slice(1, 3).join("\n"), "既存の行は一字も変えない");
  assert.equal(next.split("\n")[3].split(",").length, 33);
  assert.equal(L.parseLog(next).length, 3);
  assert.equal(L.parseLog(next)[2].r_a, "5.05");
  assert.throws(() => L.parseLog("plan_date,generated_at\n1,2\n"), /見出し行/);
});

// ---- ■5 損益の列 ----
const sim = (side, entry, schemes) => ({ side, schemes });
const mk = (o) => ({ symbol: "EURUSD", side: "sell", entry_low: "1.10400", entry_high: "1.10420", sl_a: "1.10500", sl_b: "1.10600", ...o });
test("■5 損益の列: 最悪Entry（売り=帯の下端、買い=帯の上端）を基準に、コスト0。exit＝決済の価格、pips、r＝pips÷SL幅（SL 先なら -1.00）", () => {
  // 売り: TP1 1.0990 → (1.1040-1.0990)/0.0001 = 50.0pips、SL幅 10.0pips → R 5.00。B案は SL（1.1060）→ -20.0pips、R -1.00
  const c = pnlColumns(mk({}), { schemes: { A: { exit_price: 1.099 }, B: { exit_price: 1.106 } } });
  assert.deepEqual(c, { exit_a: "1.09900", pips_a: "50.0", r_a: "5.00", exit_b: "1.10600", pips_b: "-20.0", r_b: "-1.00" });
  // 買い: Entry は帯の上端
  const buy = pnlColumns(mk({ side: "buy", entry_low: "1.09980", entry_high: "1.10000", sl_a: "1.09900", sl_b: "" }), { schemes: { A: { exit_price: 1.1015 } } });
  assert.deepEqual(buy, { exit_a: "1.10150", pips_a: "15.0", r_a: "1.50" });
  // 円ペア（pip 0.01）・XAUUSD（pip 0.1）
  const jpy = pnlColumns(mk({ symbol: "EURJPY", entry_low: "177.241", entry_high: "177.263", sl_a: "177.355", sl_b: "" }), { schemes: { A: { exit_price: 177.0 } } });
  assert.deepEqual(jpy, { exit_a: "177.000", pips_a: "24.1", r_a: "2.11" });
  const xau = pnlColumns(mk({ symbol: "XAUUSD", entry_low: "4177.81", entry_high: "4179.15", sl_a: "4184.50", sl_b: "" }), { schemes: { A: { exit_price: 4184.5 } } });
  assert.deepEqual(xau, { exit_a: "4184.50", pips_a: "-66.9", r_a: "-1.00" });
  // SL を越えて始まった足（ギャップ）は、始値で決済するので R が -1 より悪くなる
  assert.deepEqual(pnlColumns(mk({ sl_b: "" }), { schemes: { A: { exit_price: 1.107 } } }), { exit_a: "1.10700", pips_a: "-30.0", r_a: "-3.00" });
  // 損益 0 は「-0.0」にしない
  assert.equal(pnlColumns(mk({ sl_b: "" }), { schemes: { A: { exit_price: 1.104 } } }).pips_a, "0.0");
  // 案の無い列は空（その案が通っていない）。円の金額の列は無い
  assert.deepEqual(Object.keys(pnlColumns(mk({ sl_a: "", sl_b: "1.10600" }), { schemes: { B: { exit_price: 1.1 } } })).sort(), ["exit_b", "pips_b", "r_b"]);
  assert.ok(L.PNL_COLUMNS.every((x) => !/jpy|yen|円/i.test(x)));
});

test("■5 採点の行: 到達・取消(到達後) の行にだけ損益を入れる。未到達・失効後到達の行は空。移行の行にも入る。未決は有効期限の直前の足の終値", () => {
  // 未決（期限まで決着せず）: 最終足の終値で計算する
  const D = "2026-10-08";
  const bar = (hm2, h, l, c, date = D) => ({ t: jstAt(date, hm2), o: c, h, l, c });
  const design = { ...Object.fromEntries(L.COLUMNS.map((x) => [x, ""])), plan_date: D, generated_at: "2026-10-08T15:30:00+09:00", run: "design", setup: "A", symbol: "EURUSD", side: "sell", entry_low: "1.10400", entry_high: "1.10420", sl_a: "1.10500", tp_a: "1.09900", sl_b: "1.10600", tp_b: "1.09900", expires_at: "2026-10-09T03:00:00+09:00" };
  const bars = [bar("16:00", 1.1045, 1.1035, 1.1036), bar("20:00", 1.1030, 1.1020, 1.1025), bar("02:00", 1.1030, 1.1020, 1.1024, "2026-10-09")];
  const now = J.parseIso("2026-10-09T06:30:00+09:00");
  const r = scoreRows({ rows: [design], barsByCode: { EURUSD: bars }, nowMs: now });
  const row = r.newRows[0];
  assert.equal(row.reached, "到達");
  assert.equal(row.first_hit_a, "未決");
  assert.deepEqual([row.exit_a, row.pips_a, row.r_a, row.exit_b, row.pips_b, row.r_b], ["1.10240", "16.0", "1.60", "1.10240", "16.0", "0.80"]);
  const none = scoreRows({ rows: [design], barsByCode: { EURUSD: [bar("16:00", 1.1030, 1.1020, 1.1025), bar("02:00", 1.1030, 1.1020, 1.1024, "2026-10-09")] }, nowMs: now }).newRows[0];
  assert.equal(none.reached, "未到達");
  for (const c of L.PNL_COLUMNS) assert.equal(none[c] ?? "", "", c);
  // 既存の行（損益の列が空）は書き換えない: 採点済みの旧い行を含むログを採点しても、旧い行は対象外
  assert.deepEqual(scoreRows({ rows: [design, { ...design, run: "status", reached: "到達", first_hit_a: "TP1" }], barsByCode: { EURUSD: bars }, nowMs: now }).newRows, []);
  // 実データ（移行）: 取消(到達後) の行に入る
  const v = FIX.find((x) => x.design.plan_date === "2026-10-15" && x.design.symbol === "EURJPY");
  const mig = scoreRows({ rows: [v.design, v.cancel], barsByCode: { EURJPY: barsOf(v) }, nowMs: NOW }).newRows[0];
  assert.deepEqual([mig.exit_a, mig.pips_a, mig.r_a, mig.exit_b], ["177.000", "24.1", "2.11", ""]);
});
