"use strict";
const { PAIRS, pairOf } = require("./pairs");
const { REASONS, COUNTED } = require("./evaluate");

/**
 * data/daytrade-plan.txt。判定文（『条件が緩い』等）は出さない。数字と状態だけ。
 * 区画の順は『テンプレv1.2の7項目の順』だが、その本文が仕様書・リポジトリのどこにも無いため仮の名前・順 [Q01]。
 * 確定しているのは『6項目目=前日の結果』だけ。
 */
const px = (v, pair) => (Number.isFinite(v) ? v.toFixed(pair.digits) : "—");
const SIDE = { sell: "売り", buy: "買い" };
const hm = (iso) => (iso ? String(iso).slice(11, 16) : "—");
const dt = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "—");

function lotText(s, accts) {
  return Object.keys(accts).map((a) => {
    const v = s.lots?.[a];
    return `${a}=${v === null || v === undefined ? "—（円換算レート不足）" : v.toFixed(2)}${v === 0 ? "（資金に対してSL幅が大きい）" : ""}`;
  }).join(" / ");
}

function schemeLine(name, s, pair, accts) {
  const label = name === "A" ? "A案(0.5×ATR)" : "B案(1.0×ATR)";
  if (!s.pass) return `    ${label}: 不採用（${s.reason_text ?? s.reason}）${Number.isFinite(s.sl) ? ` ※参考 SL ${px(s.sl, pair)}(${s.sl_pips}pips)` : ""}`;
  return `    ${label}: SL ${px(s.sl, pair)}（${s.sl_pips}pips） TP1 ${px(s.tp1, pair)}（利益幅 ${s.profit_pips}pips） RR ${s.rr} コスト上限 ${s.cost_cap_pips}pips（閾値 ${s.cost_threshold_pips}） 上限ロット ${lotText(s, accts)}`;
}

function candidateBlock(c, accts) {
  const pair = pairOf(c.symbol);
  const L = [];
  L.push(`[${c.rank}] ${SIDE[c.side]} ${c.symbol} 型${c.setup}  MTF ${c.alignment}（月・週・日 ${c.dirs.join("")}）${c.note ? `  ※${c.note}` : ""}${c.same_direction_group ? `  同方向: ${c.same_direction_group}` : ""}`);
  L.push(`    基準水準 ${px(c.ref.price, pair)}（${c.ref.label}） Entry帯 ${px(c.band.low, pair)}〜${px(c.band.high, pair)} 最悪Entry ${px(c.worst_entry, pair)} 現在値 ${px(c.price, pair)} 距離 ${c.distance_pips}pips（H1 ATR14 ${c.atr_pips}pips）`);
  for (const n of ["A", "B"]) L.push(schemeLine(n, c.schemes[n], pair, accts));
  L.push(`    TP1の根拠 ${c.obstacle ? `${c.obstacle.label} ${px(c.obstacle.price, pair)} の手前` : "—"} ／ ADR消化 ${c.adr_used_pct}%（残り ${c.adr_remaining_pips}pips）`);
  const es = c.entry_state;
  const st = c.state || {};
  L.push(`    状態: ${st.expired ? "失効" : st.reached === "到達" ? `到達（${hm(st.reached_at)}の足）` : st.reached === "失効後到達" ? `失効後到達（${hm(st.reached_at)}の足）` : st.price_in_band ? "現在値がEntry帯の中" : "未到達"} ／ ${es.ok ? "新規可" : `新規不可・停止: ${es.reasons.join("、")}`} ／ 有効期限 ${dt(c.expires_at)}`);
  if (c.confirm) L.push(`    確認条件（執行時に本人が見る）: ${c.confirm}`);
  return L.join("\n");
}

function render(plan, accounts = {}) {
  const L = [];
  const accts = accounts;
  // 仕様 1節「出力の先頭に『発注不可（鮮度超過）』を付ける」: 鮮度超過のバナーは見出しより前の1行目に置く
  const staleBanner = plan.banners.find((b) => b.startsWith("発注不可（鮮度超過）"));
  if (staleBanner) L.push(staleBanner);
  L.push("# デイトレプラン（自動生成）");
  L.push(`plan_date: ${plan.plan_date} / run: ${plan.run}${plan.design_slot ? `（設計${plan.design_slot}）` : ""} / 設計: ${dt(plan.generated_at)} / 状態更新: ${dt(plan.status_updated_at)} / 有効期限: ${dt(plan.expires_at)}`);
  L.push(`暫定: 仕様 v1.1 が沈黙・矛盾している点（${plan.provisional.open_questions.length}件: ${plan.provisional.open_questions[0]}〜${plan.provisional.open_questions[plan.provisional.open_questions.length - 1]}）を暫定の読みで処理しています。区画の順・名前は仮です（Q01: テンプレv1.2の7項目の本文が無い）。`);
  L.push(plan.order_ok ? "発注可否: 発注可（鮮度は20分以内）" : "発注可否: 発注不可");
  for (const b of plan.banners) if (b !== staleBanner) L.push(`  ※ ${b}`);

  // 1. 前提と鮮度
  L.push("");
  L.push("== 1. 前提と鮮度 ==");
  for (const f of plan.freshness.feeds) L.push(`  ${f.name}: as_of ${dt(f.as_of)}（${f.age_min === null ? "読めない" : `${f.age_min}分前`}）${f.stale ? " 20分超" : ""}`);
  const cm = plan.freshness.ctx_m15;
  if (cm) L.push(`  （参考）daytrade-context の確定M15の最終足: 最古 ${cm.oldest_last_closed ?? "—"}${cm.not_ok.length ? ` ／ data_status が OK でない銘柄: ${cm.not_ok.join("、")}` : ""}。発注可否には使わない`);
  L.push(`  daily-levels.json: session_date ${plan.freshness.daily.session_date ?? "—"}（直近に確定した営業日 ${plan.mtf.expected_session}）${plan.freshness.daily.ok ? "" : ` 未更新: ${plan.freshness.daily.reason}`}`);
  L.push(`  mtf-feed.json: status ${plan.mtf.status ?? "—"} / data_base_date ${plan.mtf.data_base_date ?? "—"}${plan.mtf.ok ? "" : ` 方向根拠なし: ${plan.mtf.reason}`}`);
  L.push(`  イベント: ${plan.events.status === "ok" ? "取得済み（economic-calendar.json）" : `イベント未取得（${plan.events.reason}）。停止時間なしで生成`} ／ ${plan.events.note}`);

  // 2. 方向
  L.push("");
  L.push("== 2. 方向（MTF）==");
  for (const pair of PAIRS) {
    const d = plan.directions?.[pair.code];
    if (!d) continue;
    L.push(`  ${pair.code}: ${d.kind === "ok" ? `${d.alignment}（月・週・日 ${d.dirs.join("")}）→ ${SIDE[d.side]}の候補` : `${d.alignment ? `${d.alignment}（月・週・日 ${d.dirs?.join("") ?? "—"}）→ ` : ""}${d.kind === "watch" ? d.reason : `方向根拠なし（${d.reason}）`}`}`);
  }

  // 3. 候補
  L.push("");
  L.push(`== 3. 候補（${plan.candidates.length}件。順位は 方向の強さ → 銘柄の優先 → RR）==`);
  if (plan.design_missing) L.push("  設計がありません。");
  else if (!plan.candidates.length) L.push("  条件を満たす案はありません。");
  for (const c of plan.candidates) { L.push(candidateBlock(c, accts)); L.push(""); }
  if (plan.candidates.length) L.pop();

  // 4. 同方向の印
  L.push("");
  L.push("== 4. 同方向の印（同じ通貨を同じ方向に賭けている組。印だけで、落とさない）==");
  const groups = new Map();
  for (const c of plan.candidates) for (const k of (c.same_direction_group || "").split("|").filter(Boolean)) {
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(`${c.symbol}${SIDE[c.side]}(型${c.setup})`);
  }
  if (!groups.size) L.push("  なし");
  for (const [k, v] of groups) L.push(`  ${k}: ${v.join("、")}`);

  // 5. 参考情報
  L.push("");
  L.push("== 5. 参考情報 ==");
  const sm = plan.summary;
  if (sm) {
    L.push(`  候補数: ${sm.candidate_rows}件（A案を通った案 ${sm.scheme_pass.A}、B案を通った案 ${sm.scheme_pass.B}）`);
    L.push(`  不採用の内訳（単位=${sm.unit}）: ${COUNTED.map((k) => `${REASONS[k]} ${sm.rejections[k]}`).join(" ／ ")}`);
    L.push(`    ほかに数えない理由: ${Object.entries(sm.extra).map(([k, v]) => `${k} ${v}`).join(" ／ ")}`);
    L.push(`  監視のみ（方向根拠なしに数える）: ${sm.watch_only.length ? sm.watch_only.map((w) => `${w.symbol}`).join("、") : "なし"} ／ 方向根拠なし: ${sm.no_basis.length ? sm.no_basis.map((w) => `${w.symbol}（${w.detail}）`).join("、") : "なし"}`);
    L.push(`  型B未成立（数えない）: ${sm.not_formed.filter((x) => x.setup === "B").length ? [...new Set(sm.not_formed.filter((x) => x.setup === "B").map((x) => x.detail))].join(" ／ ") : "なし"}${plan.design_slot === 1 ? "（設計①は型Aだけ）" : ""}`);
  } else L.push("  （設計がありません）");
  const rf = plan.reference.volatility.risk_feed;
  L.push(`  ボラの状態（risk-feed ${rf.status}${rf.generated_intraday ? `、生成 ${dt(rf.generated_intraday)}・${rf.age_min}分前` : rf.reason ? `：${rf.reason}` : ""}）:`);
  for (const pair of PAIRS) {
    const v = plan.reference.volatility.pairs[pair.code];
    if (v.state !== "ok") { L.push(`    ${pair.code}: ${v.state}`); continue; }
    const it = v.items;
    const parts = [];
    if ("range_today" in it) parts.push(`当日レンジ ${it.range_today}`);
    if ("range_vs_adr" in it) parts.push(`ADR比 ${it.range_vs_adr}`);
    if ("spike_flag" in it) parts.push(`急変フラグ ${it.spike_flag}`);
    if ("updated_at" in it) parts.push(`更新 ${hm(it.updated_at)}`);
    L.push(`    ${pair.code}: ${parts.length ? parts.join(" ／ ") : "（表示できる項目なし）"}`);
  }
  const eg = plan.reference.existing_gate;
  L.push(`  参考：既存ゲート（gate.state。${dt(eg.as_of)} 時点のスナップショット。停止判定には使わない）: ${PAIRS.map((p) => `${p.code} ${eg.states[p.code] ?? "—"}`).join(" ／ ")}`);

  // 6. 前日の結果
  L.push("");
  L.push("== 6. 前日の結果（採点）==");
  const pd = plan.previous_day;
  if (!pd) L.push("  採点済みの案はありません。");
  else {
    L.push(`  計画日 ${pd.plan_date}: 案 ${pd.n}件 ／ 到達 ${pd.reached}・未到達 ${pd.not_reached}・失効後到達 ${pd.after_expiry}・取消 ${pd.cancelled}`);
    L.push(`  先着（到達した案）: A案 TP1 ${pd.a.tp1}・SL ${pd.a.sl}・未決 ${pd.a.open} ／ B案 TP1 ${pd.b.tp1}・SL ${pd.b.sl}・未決 ${pd.b.open}`);
    for (const i of pd.items) L.push(`    ${i.symbol} ${SIDE[i.side] ?? i.side} 型${i.setup}: ${i.reached}${i.reached_at ? `（${dt(i.reached_at)}）` : ""}${i.first_hit_a ? ` A案 ${i.first_hit_a}` : ""}${i.first_hit_b ? ` B案 ${i.first_hit_b}` : ""}`);
  }

  // 7. 停止時間と新規不可
  L.push("");
  L.push("== 7. 停止時間と新規不可の時間帯 ==");
  L.push("  新規不可: 9時台（JST）／翌1:00以降／土曜0:00以降。有効期限: 翌日3:00（JST）。イベント停止: その銘柄の通貨の High・Medium の15分前〜30分後（新規のみ禁止）");
  if (plan.events.status !== "ok") L.push("  イベント未取得のため、停止時間は出せません。");
  else for (const pair of PAIRS) {
    const w = plan.stop_windows?.[pair.code] || [];
    L.push(`  ${pair.code}: ${w.length ? w.map((x) => `${hm(x.start)}〜${hm(x.end)} [${x.currency}/${x.impact}] ${x.event}`).join(" ／ ") : "なし"}`);
  }
  if (plan.inputs_problems?.length) { L.push(""); L.push(`入力の問題: ${plan.inputs_problems.join(" ／ ")}`); }
  return L.join("\n") + "\n";
}

module.exports = { render };
