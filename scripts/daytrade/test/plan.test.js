"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadInputs } = require("../inputs");
const { buildDesign, buildStatus, markSameDirection, rankCandidates } = require("../plan");
const { render } = require("../render");
const L = require("../log");
const { calendarStatus } = require("../events");
const { makeScenario } = require("./scenario");
const { rm } = require("./helpers");
const J = require("../jst");

const noFeed = { status: "未取得", reason: "試験", pairs: {} };
const build = (sc, { slot = 2, prevPlan = null, logRows = [], riskFeed = noFeed } = {}) => {
  const inputs = loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs });
  return { inputs, ...buildDesign({ inputs, riskFeed, nowMs: sc.nowMs, slot, prevPlan, logRows }) };
};
const symbols = (plan) => plan.candidates.map((c) => `${c.symbol}${c.setup}`);
const cleanup = (sc) => rm(path.dirname(sc.dataDir));

test("入力: 鮮度・日次レベル・MTF の基準日が整っていれば発注可", () => {
  const sc = makeScenario();
  try {
    const { inputs, plan } = build(sc);
    assert.equal(inputs.freshness.stale, false);
    assert.equal(inputs.freshness.daily.ok, true);
    assert.equal(inputs.expectedSession, "2026-10-07");
    assert.equal(Object.keys(inputs.accounts).length, 2);
    assert.equal(inputs.riskPct, 0.5);
    assert.equal(plan.order_ok, true);
    assert.deepEqual(plan.banners, []);
    assert.equal(inputs.h1.EURUSD.length, 60);
    assert.equal(J.jstLabel(inputs.h1.EURUSD.at(-1).t), "2026-10-08 14:00");
  } finally { cleanup(sc); }
});

test("設計②: 方向のある4銘柄が型Aの候補、型Bは15:30では成立しない（ブレイクが確定しない）", () => {
  const sc = makeScenario();
  try {
    const { plan } = build(sc);
    assert.equal(plan.plan_date, "2026-10-08");
    assert.equal(plan.design_slot, 2);
    assert.equal(plan.expires_at, "2026-10-09T03:00:00+09:00");
    // 順位: 方向の強さ → 銘柄の優先（AUDUSD・EURJPY ＞ GBPUSD・EURUSD ＞ その他）
    assert.deepEqual(symbols(plan), ["AUDUSDA", "EURUSDA", "XAUUSDA", "GBPUSDA"]);
    assert.deepEqual(plan.candidates.map((c) => c.rank), [1, 2, 3, 4]);
    const eu = plan.candidates.find((c) => c.symbol === "EURUSD");
    assert.equal(eu.side, "sell");
    assert.deepEqual(eu.band, { low: 1.104, high: 1.1042 });
    assert.equal(eu.schemes.A.sl, 1.105);
    assert.equal(eu.schemes.B.sl, 1.106);
    assert.equal(eu.schemes.A.tp1, 1.09005);
    assert.equal(eu.schemes.A.lots[701620], 0.2);
    assert.match(eu.confirm, /M15/);
    const xau = plan.candidates.find((c) => c.symbol === "XAUUSD");
    assert.equal(xau.side, "buy");
    assert.equal(xau.note, "過去の実績が悪い"); // 落とさずに注記
    const nb = plan.summary.not_formed.filter((x) => x.setup === "B");
    assert.equal(nb.length, 10); // 型Bの未成立は不採用の内訳に数えない（一覧にだけ出す）
    assert.equal(nb.filter((x) => /ブレイク未成立/.test(x.detail)).length, 4); // 方向のある4銘柄: 15:30 ではブレイクが確定しない
    assert.equal(nb.filter((x) => /MTFの向きなし/.test(x.detail)).length, 6);
    assert.equal(plan.summary.rejections.no_direction, 12); // 型Bの方向なしは入っていない
  } finally { cleanup(sc); }
});

test("設計①は型Aだけ。型Bの行は作らない", () => {
  const sc = makeScenario({ nowIso: "2026-10-08T06:30:00+09:00" });
  try {
    const { plan } = build(sc, { slot: 1 });
    assert.ok(plan.candidates.every((c) => c.setup === "A"));
    assert.equal(plan.summary.not_formed.length, 0);
  } finally { cleanup(sc); }
});

test("不採用の内訳: 単位は案（型×銘柄×A/B案）。方向なしは数え、型Bの未成立は数えない", () => {
  const sc = makeScenario();
  try {
    const { plan } = build(sc);
    const s = plan.summary;
    assert.equal(s.candidate_rows, 4);
    assert.deepEqual(s.scheme_pass, { A: 4, B: 4 });
    // 方向なし6銘柄（監視のみ4＋MTF未収録2）× 型A × A/B案 = 12
    assert.equal(s.rejections.no_direction, 12);
    for (const k of ["unreachable", "sl_narrow", "rr_low", "cost_low", "adr_over"]) assert.equal(s.rejections[k], 0);
    assert.deepEqual(s.watch_only.map((w) => w.symbol).sort(), ["EURGBP", "EURJPY", "USDCAD", "USDJPY"]);
    assert.deepEqual(s.no_basis.map((w) => w.symbol).sort(), ["NZDUSD", "USDCHF"]);
    assert.match(s.no_basis[0].detail, /MTF未収録/);
  } finally { cleanup(sc); }
});

test("同方向の印: 同じ通貨を同じ向きに賭ける組に『|』区切りで全部付ける（落とさない）", () => {
  const sc = makeScenario();
  try {
    const { plan } = build(sc);
    const g = (c) => plan.candidates.find((x) => x.symbol === c).same_direction_group;
    assert.equal(g("EURUSD"), "USD買い"); // EURUSD売り・GBPUSD売り = USD買い
    assert.equal(g("GBPUSD"), "USD買い");
    assert.equal(g("AUDUSD"), "USD売り"); // AUDUSD買い・XAUUSD買い = USD売り
    assert.equal(g("XAUUSD"), "USD売り");
    assert.equal(plan.candidates.length, 4); // 印だけで、候補は減らさない
  } finally { cleanup(sc); }
  // 通貨が複数重なる例: EURUSD買い × EURGBP買い = EUR買い、EURUSD買い × GBPUSD売り = USD売り…と複数のキー
  const cands = [
    { symbol: "EURUSD", side: "buy" }, { symbol: "EURGBP", side: "buy" }, { symbol: "GBPUSD", side: "sell" },
  ];
  markSameDirection(cands, { EURUSD: ["EUR", "USD"], EURGBP: ["EUR", "GBP"], GBPUSD: ["GBP", "USD"] });
  assert.equal(cands[0].same_direction_group, "EUR買い"); // EURUSD買い = EUR買い(EURGBP買いと共通)・USD売り(共通なし)
  assert.equal(cands[1].same_direction_group, "EUR買い|GBP売り"); // EURGBP買い = EUR買い(EURUSD買いと共通)・GBP売り(GBPUSD売りと共通)
  assert.equal(cands[2].same_direction_group, "GBP売り"); // GBPUSD売り = GBP売り(EURGBP買いと共通)・USD買い(共通なし)
  // 共通の通貨がなければ印なし
  const solo = [{ symbol: "EURUSD", side: "buy" }, { symbol: "USDJPY", side: "buy" }];
  markSameDirection(solo, { EURUSD: ["EUR", "USD"], USDJPY: ["USD", "JPY"] });
  assert.equal(solo[0].same_direction_group, ""); // EUR買い・USD売り vs USD買い・JPY売り
});

test("順位: 方向の強さ → 銘柄の優先 → RR。同点は銘柄名 → 型A → 型B", () => {
  const mk = (symbol, setup, strength, rr) => ({ symbol, setup, strength, schemes: { A: { pass: true, rr }, B: { pass: false } } });
  const cs = [mk("USDCAD", "A", 3, 9), mk("GBPUSD", "A", 3, 2), mk("EURJPY", "B", 2, 9), mk("EURUSD", "B", 3, 8), mk("EURUSD", "A", 3, 8), mk("AUDUSD", "A", 3, 1)];
  rankCandidates(cs);
  assert.deepEqual(cs.map((c) => `${c.symbol}${c.setup}`), ["AUDUSDA", "EURUSDA", "EURUSDB", "GBPUSDA", "USDCADA", "EURJPYB"]);
  assert.deepEqual(cs.map((c) => c.rank), [1, 2, 3, 4, 5, 6]);
});

test("鮮度超過（20分超）は『発注不可』にして、計算と出力は続ける", () => {
  const sc = makeScenario({ intradayLagMin: 25 });
  try {
    const { plan, inputs } = build(sc);
    assert.equal(inputs.freshness.stale, true);
    assert.equal(plan.order_ok, false);
    assert.match(plan.banners.join("\n"), /発注不可（鮮度超過）: intraday\.json\(25分前\)/);
    assert.equal(plan.candidates.length, 4);
    const txt = render(plan, inputs.accounts);
    assert.match(txt, /発注可否: 発注不可/);
  } finally { cleanup(sc); }
  // ちょうど20分は許容、h1-bars.json / daytrade-context.json も対象
  const ok = makeScenario({ intradayLagMin: 20, h1LagMin: 20, ctxLagMin: 20 });
  try { assert.equal(build(ok).plan.order_ok, true); } finally { cleanup(ok); }
  for (const key of ["h1LagMin", "ctxLagMin"]) {
    const sc2 = makeScenario({ [key]: 21 });
    try { assert.equal(build(sc2).plan.order_ok, false, key); } finally { cleanup(sc2); }
  }
});

test("入力ファイルが無い／読めない: 例外にせず『発注不可』と問題を出す", () => {
  const sc = makeScenario({ tweak: (f) => { f["h1-bars.json"] = null; f["daytrade-context.json"] = null; } });
  try {
    const { plan, inputs } = build(sc);
    assert.equal(plan.order_ok, false);
    assert.ok(inputs.problems.some((p) => /h1-bars\.json/.test(p)));
  } finally { cleanup(sc); }
  const bad = makeScenario();
  try {
    fs.writeFileSync(path.join(bad.dataDir, "intraday.json"), "{not json");
    const { plan, inputs } = build(bad);
    assert.equal(plan.order_ok, false);
    assert.equal(plan.candidates.length, 0);
    assert.ok(inputs.problems.some((p) => /intraday\.json/.test(p)));
  } finally { cleanup(bad); }
});

test("日次レベルが直近の確定営業日でない／errors がある → 候補を出さない（入力欠落）", () => {
  for (const o of [{ dailySession: "2026-10-06" }, { dailyErrors: ["x"] }]) {
    const sc = makeScenario(o);
    try {
      const { plan } = build(sc);
      assert.equal(plan.candidates.length, 0);
      assert.equal(plan.order_ok, false);
      assert.match(plan.banners.join("\n"), /日次レベル未更新/);
    } finally { cleanup(sc); }
  }
});

test("MTF が ok でない／基準日が前営業日でない → 全銘柄『方向根拠なし』で候補ゼロ", () => {
  for (const o of [{ mtfStatus: "partial" }, { mtfBase: "2026-10-06" }]) {
    const sc = makeScenario(o);
    try {
      const { plan } = build(sc);
      assert.equal(plan.candidates.length, 0);
      assert.equal(plan.order_ok, false);
      assert.match(plan.banners.join("\n"), /方向根拠なし/);
      assert.equal(plan.summary.rejections.no_direction, 20); // 10銘柄 × 型A × A/B案
    } finally { cleanup(sc); }
  }
});

test("イベント未取得（date が当日でない・古い・ファイルなし）→ 『イベント未取得』と明記して停止時間なしで生成", () => {
  const usd = [{ time_jst: "15:40", datetime_jst: "2026-10-08T15:40:00+09:00", currency: "USD", impact: "High", event: "CPI" }];
  for (const o of [{ calDate: "2026-10-07", events: usd }, { calLagMin: 30, events: usd }, { tweak: (f) => { f["economic-calendar.json"] = null; } }]) {
    const sc = makeScenario(o);
    try {
      const { plan, inputs } = build(sc);
      assert.equal(plan.events.status, "イベント未取得");
      assert.match(plan.banners.join("\n"), /イベント未取得/);
      assert.equal(plan.candidates.length, 4); // エラーにしない
      assert.ok(plan.candidates.every((c) => c.entry_state.ok && c.stops.length === 0 && c.calendar_ok === false));
      assert.match(render(plan, inputs.accounts), /イベント未取得のため、停止時間は出せません/);
    } finally { cleanup(sc); }
  }
});

test("イベント停止: その銘柄の通貨の High・Medium の15分前〜30分後は新規のみ禁止（候補は残す）", () => {
  const ev = [
    { time_jst: "15:40", datetime_jst: "2026-10-08T15:40:00+09:00", currency: "EUR", impact: "Medium", event: "ECB Speaks" },
    { time_jst: "15:40", datetime_jst: "2026-10-08T15:40:00+09:00", currency: "JPY", impact: "Low", event: "ignored" },
  ];
  const sc = makeScenario({ events: ev });
  try {
    const { plan } = build(sc);
    const eu = plan.candidates.find((c) => c.symbol === "EURUSD");
    assert.equal(eu.entry_state.ok, false);
    assert.match(eu.entry_state.reasons.join(), /停止中: 15:40 \[EUR\] ECB Speaks/);
    assert.equal(eu.stops[0].start, "2026-10-08T15:25:00+09:00");
    assert.equal(eu.stops[0].end, "2026-10-08T16:10:00+09:00");
    assert.equal(plan.candidates.find((c) => c.symbol === "AUDUSD").entry_state.ok, true); // EUR を含まない
    assert.equal(plan.stop_windows.EURGBP.length, 1);
    assert.equal(plan.stop_windows.USDJPY.length, 0);
  } finally { cleanup(sc); }
});

test("型B（設計③ 21:00）: 東京レンジを下に抜けた売りのMTF銘柄で成立する", () => {
  const sc = makeScenario({ nowIso: "2026-10-08T21:00:00+09:00", spec: { EURUSD: { bars: { dir: "down" } } } });
  try {
    const { plan } = build(sc, { slot: 3 });
    const bs = plan.candidates.filter((c) => c.setup === "B");
    // EURUSD は下抜け（売りのMTFと一致）、AUDUSD・XAUUSD は上抜け（買いのMTFと一致）。GBPUSD は売りのMTFなのに上抜けなので不成立
    assert.deepEqual(bs.map((c) => c.symbol).sort(), ["AUDUSD", "EURUSD", "XAUUSD"]);
    const b = bs.find((c) => c.symbol === "EURUSD");
    assert.equal(b.side, "sell");
    assert.equal(b.ref.label, "東京レンジ安値");
    assert.equal(b.confirm, null); // 型Bには M15 確認条件を付けない（Q39）
    assert.equal(bs.find((c) => c.symbol === "AUDUSD").ref.label, "東京レンジ高値");
    const gb = plan.summary.not_formed.find((x) => x.symbol === "GBPUSD" && x.setup === "B");
    assert.match(gb.detail, /不一致/);
  } finally { cleanup(sc); }
});

// ---- 状態更新 ----
test("状態更新: Entry・SL・TP は変えず、距離・ADR・停止中・到達だけ更新する", () => {
  const sc = makeScenario();
  try {
    const { plan: design, inputs } = build(sc);
    // 17:00 の状態更新: 価格が動き、16:00 開始の足（設計後の最初の確定足）が EURUSD の帯に触れた。EUR の High が 17:10 にある
    const later = J.parseIso("2026-10-08T17:00:00+09:00");
    const st = { ...inputs, raw: { ...inputs.raw } };
    st.raw.intraday = JSON.parse(JSON.stringify(inputs.raw.intraday));
    st.raw.intraday.pairs.EURUSD.price = 1.1038;
    st.raw.intraday.pairs.EURUSD.adr_used_pct = 61.2;
    st.raw.calendar = { ...inputs.raw.calendar, as_of: "2026-10-08T16:58:00+09:00", events: [{ time_jst: "17:10", datetime_jst: "2026-10-08T17:10:00+09:00", currency: "EUR", impact: "High", event: "ECB" }] };
    st.h1 = { ...inputs.h1, EURUSD: [...inputs.h1.EURUSD, { t: J.jstAt("2026-10-08", "16:00"), o: 1.1035, h: 1.1045, l: 1.1030, c: 1.1038 }] };
    st.freshness = { ...inputs.freshness, stale: false };
    const { plan } = buildStatus({ inputs: st, riskFeed: noFeed, nowMs: later, prevPlan: design, logRows: [] });
    assert.equal(plan.run, "status");
    assert.equal(plan.design_slot, 2);
    assert.equal(plan.generated_at, design.generated_at);
    const before = design.candidates.find((c) => c.symbol === "EURUSD");
    const after = plan.candidates.find((c) => c.symbol === "EURUSD");
    // 変えないもの
    assert.deepEqual(after.band, before.band);
    assert.deepEqual(after.worst_entry, before.worst_entry);
    for (const n of ["A", "B"]) { assert.equal(after.schemes[n].sl, before.schemes[n].sl); assert.equal(after.schemes[n].tp1, before.schemes[n].tp1); assert.equal(after.schemes[n].rr, before.schemes[n].rr); }
    assert.equal(after.id, before.id);
    assert.equal(after.rank, before.rank);
    // 変えるもの
    assert.equal(after.price, 1.1038);
    assert.equal(after.distance_pips, 2);
    assert.equal(after.adr_used_pct, 61.2);
    assert.equal(after.state.reached, "到達");
    assert.equal(after.state.reached_at, "2026-10-08T16:00:00+09:00");
    assert.equal(after.state.price_in_band, false); // 1.1038 は帯 1.1040〜1.1042 の外
    assert.equal(after.entry_state.ok, false); // 17:10 の EUR High の停止窓（16:55〜17:40）の中
    assert.match(after.entry_state.reasons.join(), /ECB/);
    // 他の銘柄は到達していない
    assert.equal(plan.candidates.find((c) => c.symbol === "AUDUSD").state.reached, "未到達");
  } finally { cleanup(sc); }
});

test("状態更新: 有効期限（翌3:00）で失効。当日の設計が無ければ『設計なし』", () => {
  const sc = makeScenario();
  try {
    const { plan: design, inputs } = build(sc);
    const exp = J.parseIso("2026-10-09T03:00:00+09:00");
    const { plan } = buildStatus({ inputs, riskFeed: noFeed, nowMs: exp + 5 * J.MIN, prevPlan: { ...design, plan_date: "2026-10-08" }, logRows: [] });
    // 03:05 は次の計画日（10-09）。10-08 の設計は引き継がない
    assert.equal(plan.plan_date, "2026-10-09");
    assert.equal(plan.design_missing, true);
    assert.deepEqual(plan.candidates, []);
    assert.match(plan.banners[0], /設計なし/);
    const nodesign = buildStatus({ inputs, riskFeed: noFeed, nowMs: sc.nowMs, prevPlan: null, logRows: [] }).plan;
    assert.equal(nodesign.design_missing, true);
    // 失効の印: 計画日内（02:59）はまだ失効ではない
    const nearEnd = buildStatus({ inputs, riskFeed: noFeed, nowMs: exp - J.MIN, prevPlan: design, logRows: [] }).plan;
    assert.ok(nearEnd.candidates.every((c) => c.state.expired === false && c.entry_state.ok === false)); // 翌1:00以降は新規不可
  } finally { cleanup(sc); }
});

// ---- ログ ----
test("log: 設計のたびに版ごとに追記。同じ版は追記せず、消えた版は『取消(再設計)』を追記", () => {
  const sc = makeScenario();
  try {
    const first = build(sc);
    assert.equal(first.logAppend.length, 4);
    assert.ok(first.logAppend.every((r) => r.run === "design" && r.reached === ""));
    const eu = first.logAppend.find((r) => r.symbol === "EURUSD");
    assert.equal(eu.entry_low, "1.10400");
    assert.equal(eu.sl_a, "1.10500");
    assert.equal(eu.tp_a, "1.09005");
    assert.equal(eu.lot_cap_a_701620, "0.20");
    assert.equal(eu.lot_cap_b_701620, "0.10");
    assert.equal(eu.same_direction_group, "USD買い");
    assert.equal(eu.filled_ticket_701620, "");
    const rows1 = first.logAppend;
    // 同じ入力でもう一度 → 追記なし
    const second = build(sc, { prevPlan: first.plan, logRows: rows1 });
    assert.equal(second.logAppend.length, 0);
    // EURUSD の方向が消えた設計 → EURUSD の旧版に取消の行
    const sc2 = makeScenario({ spec: { EURUSD: { score: "1/3 Down", dirs: ["↓", "→", "→"] } } });
    try {
      const third = build(sc2, { prevPlan: first.plan, logRows: rows1 });
      assert.equal(third.logAppend.length, 1);
      assert.equal(third.logAppend[0].run, "status");
      assert.equal(third.logAppend[0].reached, "取消(再設計)");
      assert.equal(third.logAppend[0].symbol, "EURUSD");
      assert.equal(L.keyOf(third.logAppend[0]), L.keyOf(eu));
    } finally { cleanup(sc2); }
  } finally { cleanup(sc); }
});

// ---- 出力 ----
test("出力: 7つの区画が順に並び、判定文を出さず、参考：既存ゲートとボラの『未収録』『未取得』を示す", () => {
  const sc = makeScenario();
  try {
    const riskFeed = {
      status: "ok", reason: null, generated_intraday: "2026-10-08T15:20:00+09:00", age_min: 10,
      pairs: { EURUSD: { intraday: { range_today: 52.1, range_vs_adr: 0.84, spike_flag: false, updated_at: "2026-10-08T15:20:00+09:00" } } },
    };
    const { plan, inputs } = build(sc, { riskFeed });
    const txt = render(plan, inputs.accounts);
    const heads = [...txt.matchAll(/^== (\d)\. /gm)].map((m) => m[1]);
    assert.deepEqual(heads, ["1", "2", "3", "4", "5", "6", "7"]);
    assert.match(txt, /参考：既存ゲート/);
    assert.match(txt, /GBPUSD: 未収録/);
    assert.match(txt, /EURUSD: 当日レンジ 52\.1 ／ ADR比 0\.84 ／ 急変フラグ false/);
    assert.match(txt, /ボラの状態（risk-feed ok/);
    for (const w of ["緩い", "厳しい", "推奨", "おすすめ", "見送り推奨"]) assert.ok(!txt.includes(w), w);
    // 未取得
    const t2 = render(build(sc).plan, inputs.accounts);
    assert.match(t2, /ボラの状態（risk-feed 未取得/);
    assert.match(t2, /EURUSD: 未取得/);
    // 上限ロット: 口座ごと、0.00 は 0.00 と出す
    assert.match(txt, /701620=0\.20 \/ 702449=1\.56/);
  } finally { cleanup(sc); }
});

test("出力 JSON: 暫定判断の番号を持ち、候補に上限を設けない", () => {
  const sc = makeScenario();
  try {
    const { plan } = build(sc);
    assert.ok(plan.provisional.open_questions.includes("Q01"));
    assert.equal(plan.schema_version, 1);
    assert.equal(typeof plan.reference.existing_gate.states.EURUSD, "string");
    assert.equal(plan.reference.existing_gate.note.includes("参考：既存ゲート"), true);
  } finally { cleanup(sc); }
});

test("ロット: 資金が小さく 0.00 になる案も残し、『0.00』と表示する", () => {
  const sc = makeScenario();
  try {
    fs.writeFileSync(path.join(sc.dataDir, "daytrade", "accounts.json"), JSON.stringify({
      accounts: { 701620: { equity_jpy: 1000, role: "daytrade" } }, commission_per_lot_jpy: 1013, risk_pct: 0.5, daily_loss_pct: 1.5,
    }));
    const { plan, inputs } = build(sc);
    assert.equal(plan.candidates[0].schemes.A.lots[701620], 0);
    assert.match(render(plan, inputs.accounts), /701620=0\.00（資金に対してSL幅が大きい）/);
  } finally { cleanup(sc); }
});

// ---- 独立レビューで見つかった不具合の回帰試験 ----
test("鮮度: 『20分を超えて』は秒・ミリ秒まで見る（20分ちょうどは許容、20分29秒は超過）。カレンダーも同じ", () => {
  const sc = makeScenario({ intradayLagMin: 20, h1LagMin: 20, ctxLagMin: 20, calLagMin: 20 });
  try {
    const at = (extraMs) => loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs + extraMs });
    assert.equal(at(0).freshness.stale, false);
    assert.equal(at(29000).freshness.stale, true); // 表示の分は四捨五入で20分だが、20分を超えている
    assert.equal(at(29000).freshness.feeds[0].age_min, 20);
    const cal = JSON.parse(fs.readFileSync(path.join(sc.dataDir, "economic-calendar.json"), "utf8"));
    assert.equal(calendarStatus(cal, sc.nowMs).ok, true);
    assert.equal(calendarStatus(cal, sc.nowMs + 29000).ok, false);
  } finally { cleanup(sc); }
});

test("出力: 鮮度超過は見出しより前の1行目に出す", () => {
  const sc = makeScenario({ intradayLagMin: 25 });
  try {
    const { plan, inputs } = build(sc);
    const txt = render(plan, inputs.accounts);
    assert.match(txt.split("\n")[0], /^発注不可（鮮度超過）: intraday\.json\(25分前\)/);
    assert.equal(txt.split("\n")[1], "# デイトレプラン（自動生成）");
    assert.equal((txt.match(/発注不可（鮮度超過）/g) || []).length, 1); // 二重に出さない
    const ok = makeScenario();
    try { const b = build(ok); assert.equal(render(b.plan, b.inputs.accounts).split("\n")[0], "# デイトレプラン（自動生成）"); } finally { cleanup(ok); }
  } finally { cleanup(sc); }
});

test("状態更新: 設計が無いまま次の状態更新が来ても『設計なし』のまま（候補なしの設計と取り違えない）", () => {
  const sc = makeScenario({ nowIso: "2026-10-08T07:00:00+09:00" });
  try {
    const inputs = loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs });
    const first = buildStatus({ inputs, riskFeed: noFeed, nowMs: sc.nowMs, prevPlan: null, logRows: [] }).plan;
    assert.equal(first.design_missing, true);
    const second = buildStatus({ inputs, riskFeed: noFeed, nowMs: sc.nowMs + J.HR, prevPlan: first, logRows: [] }).plan;
    assert.equal(second.design_missing, true);
    assert.match(second.banners[0], /設計なし/);
    assert.match(render(second, inputs.accounts), /設計がありません/);
  } finally { cleanup(sc); }
});

test("log: 取消(再設計)の後に同じ版が再び出たら、新しい design の行として追記する（ログ・採点から漏れない）", () => {
  const sc = makeScenario();
  const gone = makeScenario({ mtfStatus: "partial" }); // 方向根拠なし → 候補ゼロ → 旧版がすべて取消になる
  try {
    const first = build(sc);
    assert.equal(first.logAppend.length, 4);
    const second = build(gone, { prevPlan: first.plan, logRows: first.logAppend });
    assert.equal(second.plan.candidates.length, 0);
    assert.equal(second.logAppend.length, 4);
    assert.ok(second.logAppend.every((r) => r.run === "status" && r.reached === "取消(再設計)"));
    const rows = [...first.logAppend, ...second.logAppend];
    // 元の入力で同じ案が戻ってくる
    const third = build(sc, { prevPlan: second.plan, logRows: rows });
    assert.equal(third.logAppend.length, 4);
    assert.ok(third.logAppend.every((r) => r.run === "design"));
    const latest = [...L.latestByKey([...rows, ...third.logAppend]).values()];
    assert.equal(latest.filter((r) => r.run === "design").length, 4); // 採点の対象（直近の行が design）に戻る
    // 同じ版が続くだけなら追記しない
    assert.equal(build(sc, { prevPlan: third.plan, logRows: [...rows, ...third.logAppend] }).logAppend.length, 0);
  } finally { cleanup(sc); cleanup(gone); }
});

test("出力: daytrade-context の確定M15の最終足と data_status を参考表示する（発注可否には使わない）", () => {
  const sc = makeScenario({ tweak: (f) => {
    for (const [code, p] of Object.entries(f["daytrade-context.json"].pairs)) p.m15 = { last_closed: { time_jst: code === "XAUUSD" ? "2026-10-08 14:45" : "2026-10-08 15:15" } };
    f["daytrade-context.json"].pairs.XAUUSD.data_status = "DEGRADED";
  } });
  try {
    const { plan, inputs } = build(sc);
    assert.equal(plan.freshness.ctx_m15.oldest_last_closed, "2026-10-08 14:45");
    assert.deepEqual(plan.freshness.ctx_m15.not_ok, ["XAUUSD:DEGRADED"]);
    assert.equal(plan.order_ok, true);
    assert.match(render(plan, inputs.accounts), /確定M15の最終足: 最古 2026-10-08 14:45 ／ data_status が OK でない銘柄: XAUUSD:DEGRADED。発注可否には使わない/);
  } finally { cleanup(sc); }
});
