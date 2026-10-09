"use strict";
const { PAIRS, pairOf } = require("./pairs");
const { REASONS, COUNTED } = require("./evaluate");
const { DAILY_LEVELS } = require("./levels");

/**
 * data/daytrade-plan.txt（仕様 5節。テンプレ v1.2 の7項目の順 = docs/daytrade-plan-spec.md 10節で確定）:
 *   1 データ鮮度 / 2 候補 / 3 不採用の理由（末尾に参考情報）/ 4 価格根拠 / 5 イベント / 6 前営業日の結果記録 / 7 出典
 * 判定文（『条件が緩い』等）は出さない。数字と状態だけ。JSON（daytrade-plan.json）が正本。
 */
const px = (v, pair) => (Number.isFinite(v) ? v.toFixed(pair.digits) : "—");
const SIDE = { sell: "売り", buy: "買い" };
const hm = (iso) => (iso ? String(iso).slice(11, 16) : "—");
const dt = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "—");
const yen = (v) => (Number.isFinite(v) ? `${Math.round(v).toLocaleString("en-US")}円` : "—");

function lotText(s, accts) {
  return Object.keys(accts).map((a) => {
    const v = s.lots?.[a];
    // 資金が未設定（GitHub Actions の Variables が無い）／不正な口座は、上限ロットを計算せず『未設定』と出す
    if (accts[a]?.equity_status === "unset") return `${a}=未設定`;
    if (accts[a]?.equity_status === "invalid") return `${a}=未設定（資金の設定が不正）`;
    if (v === null || v === undefined) return `${a}=—（上限ロットを計算できません）`;
    const c = s.commission_jpy?.[a];
    return `${a}=${v.toFixed(2)}${v === 0 ? "（資金に対してSL幅が大きい）" : ""}${Number.isFinite(c) ? `（往復手数料 ${yen(c)}）` : ""}`;
  }).join(" / ");
}

function schemeLine(name, s, pair, accts) {
  const label = name === "A" ? "A案(0.5×ATR)" : "B案(1.0×ATR)";
  if (!s.pass) return `    ${label}: 不採用（${s.reason_text ?? s.reason}）`;
  return `    ${label}: SL ${px(s.sl, pair)} TP1 ${px(s.tp1, pair)} ／ 損切り幅 ${s.sl_pips}pips 利益幅 ${s.profit_pips}pips RR ${s.rr} 追加コスト上限 ${s.cost_cap_pips}pips（閾値 ${s.cost_threshold_pips}） ／ 上限ロット ${lotText(s, accts)}`;
}

function stateText(c) {
  const es = c.entry_state, st = c.state || {};
  const reach = st.expired ? "失効" : st.reached === "到達" ? `到達（${hm(st.reached_at)}の足）` : st.reached === "失効後到達" ? `失効後到達（${hm(st.reached_at)}の足）` : st.price_in_band ? "現在値がEntry帯の中" : "未到達";
  return `${reach} ／ ${es.ok ? "新規可" : `新規不可・停止: ${es.reasons.join("、")}`}`;
}

function candidateBlock(c, accts) {
  const pair = pairOf(c.symbol);
  const L = [];
  L.push(`[${c.rank}] ${SIDE[c.side]} ${c.symbol} 型${c.setup}  MTF ${c.alignment}（月・週・日 ${c.dirs.join("")}）${c.note ? `  ※${c.note}` : ""}${c.same_direction_group ? `  同方向の印: ${c.same_direction_group}` : ""}${c.run === "design-b" ? `  ※型Bの追加（状態更新 ${hm(c.generated_at)}）` : ""}`);
  L.push(`    Entry帯 ${px(c.band.low, pair)}〜${px(c.band.high, pair)}（最悪Entry ${px(c.worst_entry, pair)}） ／ 現在値 ${px(c.price, pair)} 距離 ${c.distance_pips}pips（H1 ATR14 ${c.atr_pips}pips、ADR消化 ${c.adr_used_pct}%・残り ${c.adr_remaining_pips}pips） ／ 有効期限 ${dt(c.expires_at)}`);
  for (const n of ["A", "B"]) L.push(schemeLine(n, c.schemes[n], pair, accts));
  L.push(`    状態: ${stateText(c)}`);
  if (c.confirm) L.push(`    確認条件（執行時に本人が見る）: ${c.confirm}`);
  return L.join("\n");
}

const groupText = (gs, pair) => (gs.length ? gs.map((g) => `${px(g.min, pair)}〜${px(g.max, pair)}（${g.count}本）`).join("、") : "なし");

function basisBlock(c) {
  const pair = pairOf(c.symbol);
  const lv = c.levels;
  const L = [];
  L.push(`  [${c.rank}] ${c.symbol} ${SIDE[c.side]} 型${c.setup}`);
  L.push(`    Entry: 基準水準 ${px(c.ref.price, pair)}（${c.ref.label}）→ 帯 ${px(c.band.low, pair)}〜${px(c.band.high, pair)}（水準から0.1×ATR）`);
  for (const n of ["A", "B"]) {
    const s = c.schemes[n];
    if (!s.pass) continue;
    L.push(`    SL(${n}案): ${px(s.sl, pair)} = 基準水準 ${c.side === "sell" ? "＋" : "−"} ${n === "A" ? "0.5" : "1.0"}×H1 ATR14（${lv ? lv.atr_pips : c.atr_pips}pips）を0.5pip単位で外側へ丸め（${s.sl_pips}pips）`);
  }
  const tpS = c.schemes.A.pass ? c.schemes.A : c.schemes.B.pass ? c.schemes.B : null;
  if (c.obstacle && tpS) L.push(`    TP1: ${px(tpS.tp1, pair)} = 最初の障害 ${c.obstacle.label} ${px(c.obstacle.price, pair)} の手前 ${(Math.abs(c.obstacle.price - tpS.tp1) / pair.pip).toFixed(1)}pips（利益幅 ${tpS.profit_pips}pips）`);
  if (lv) {
    L.push(`    日次レベル: ${DAILY_LEVELS.map(([label]) => `${label} ${px(lv.daily[label], pair)}`).join(" ／ ")}`);
    L.push(`    H1高値群（直近${lv.h1_window ?? 24}本）: ${groupText(lv.h1_high_groups, pair)} ／ H1安値群: ${groupText(lv.h1_low_groups, pair)}`);
    if (lv.tokyo) L.push(`    東京レンジ（9:00〜15:00のH1）: 高値 ${px(lv.tokyo.high, pair)} 安値 ${px(lv.tokyo.low, pair)}`);
  }
  return L.join("\n");
}

function render(plan, accountsParam = {}) {
  const L = [];
  const accts = plan.accounts || accountsParam;
  // 仕様 1節「出力の先頭に『発注不可（鮮度超過）』を付ける」: 鮮度超過のバナーは見出しより前の1行目に置く
  const staleBanner = plan.banners.find((b) => b.startsWith("発注不可（鮮度超過）"));
  if (staleBanner) L.push(staleBanner);
  L.push("# デイトレプラン（自動生成）");
  L.push(`plan_date: ${plan.plan_date} / run: ${plan.run}${plan.design_slot ? `（直近の設計: 設計${plan.design_slot}）` : ""} / 設計: ${dt(plan.generated_at)} / 状態更新: ${dt(plan.status_updated_at)} / 有効期限: ${dt(plan.expires_at)}`);
  const open = plan.provisional?.open_questions || [];
  if (open.length) L.push(`暫定: 仕様が沈黙している点を暫定の読みで処理しています（${open.length}件: ${open.join("、")}。docs/daytrade-plan-impl-notes.md）。`);
  L.push(plan.order_ok ? "発注可否: 発注可（鮮度は20分以内）" : "発注可否: 発注不可");
  for (const b of plan.banners) if (b !== staleBanner) L.push(`  ※ ${b}`);

  // 1. データ鮮度
  const fr = plan.freshness;
  const feed = (name) => fr.feeds.find((f) => f.name === name);
  const feedText = (f) => (f ? `as_of ${dt(f.as_of)}（${f.age_min === null ? "読めない" : `${f.age_min}分前`}）${f.stale ? " ＝基準（20分）超過" : " ＝基準内"}` : "—");
  L.push("");
  L.push("== 1. データ鮮度 ==");
  L.push("  Feed生成時刻と鮮度（基準: 生成から20分以内）");
  L.push(`    Intraday : intraday.json ${feedText(feed("intraday.json"))}`);
  L.push(`    H1       : h1-bars.json ${feedText(feed("h1-bars.json"))} ／ 最終確定足（開始）最古 ${fr.h1_last_closed?.oldest ?? "—"}・最新 ${fr.h1_last_closed?.newest ?? "—"}`);
  const cm = fr.ctx_m15;
  L.push(`    M15      : daytrade-context.json ${feedText(feed("daytrade-context.json"))} ／ 確定M15の最終足 最古 ${cm?.oldest_last_closed ?? "—"}・最新 ${cm?.newest_last_closed ?? "—"}${cm?.not_ok?.length ? ` ／ data_status が OK でない銘柄: ${cm.not_ok.join("、")}` : ""}（M15の最終足は発注可否には使わない）`);
  L.push(`    Daily    : daily-levels.json as_of ${dt(fr.daily.as_of)} ／ 最終確定の営業日 session_date ${fr.daily.session_date ?? "—"}（直近に確定した営業日 ${plan.mtf.expected_session}）${fr.daily.ok ? " ＝基準内" : ` ＝未更新: ${fr.daily.reason}`}`);
  const ids = Object.keys(accts);
  if (!ids.length) L.push("  口座: 設定がありません（data/daytrade/accounts.json）。上限ロットは出せません");
  if (ids.length) {
    // 資金そのものは出さない（公開されるため）。未設定の口座は『資金 未設定』と出す
    const loss = (a) => (accts[a].daily_loss_limit_jpy === null || accts[a].daily_loss_limit_jpy === undefined ? "—" : yen(accts[a].daily_loss_limit_jpy));
    const pct = plan.settings?.daily_loss_pct;
    const pctText = (a) => (accts[a].daily_loss_limit_jpy !== null && accts[a].daily_loss_limit_jpy !== undefined && pct !== null && pct !== undefined ? `（${pct}%）` : "");
    const equityNote = (a) => (accts[a].equity_status === "unset" ? " 資金 未設定（Variables） ／" : accts[a].equity_status === "invalid" ? " 資金 未設定（設定が不正） ／" : "");
    L.push(`  口座: ${ids.map((a) => `${a}（${accts[a].role ?? "—"}）${equityNote(a)} 本日の損失上限 ${loss(a)}${pctText(a)}`).join(" ／ ")}`);
  }

  // 2. 候補
  L.push("");
  L.push(`== 2. 候補（${plan.candidates.length}件。順位は 方向の強さ → 銘柄の優先 → RR）==`);
  if (plan.design_missing && !plan.candidates.length) L.push("  設計がありません。");
  else if (!plan.candidates.length) L.push("  条件を満たす案はありません。");
  for (const c of plan.candidates) { L.push(candidateBlock(c, accts)); L.push(""); }
  if (plan.candidates.length) L.pop();

  // 3. 不採用の理由（1案1行）＋参考情報
  L.push("");
  L.push("== 3. 不採用の理由（1案1行。単位=型×銘柄×A/B案）==");
  const sm = plan.summary;
  if (!sm) L.push("  （設計がありません）");
  else {
    if (sm.rejected_cases === undefined) L.push("  （旧形式の計画のため一覧はありません。次の設計で作り直します）");
    else if (!sm.rejected_cases.length) L.push("  なし");
    for (const r of sm.rejected_cases || []) L.push(`  ${r.symbol} 型${r.setup} ${r.scheme}案: ${r.reason_text}${r.detail ? `: ${r.detail}` : ""}${r.counted ? "" : "（6分類外）"}`);
    L.push("  ── 参考情報 ──");
    L.push(`  候補数: ${sm.candidate_rows}件（A案を通った案 ${sm.scheme_pass.A}、B案を通った案 ${sm.scheme_pass.B}）`);
    L.push(`  不採用の内訳（件数）: ${COUNTED.map((k) => `${REASONS[k]} ${sm.rejections[k]}`).join(" ／ ")}`);
    L.push(`    6分類に数えない理由: ${Object.entries(sm.extra).map(([k, v]) => `${k} ${v}`).join(" ／ ")}`);
    const nf = sm.not_formed.filter((x) => x.setup === "B");
    const bAdded = plan.candidates.filter((c) => c.setup === "B" && c.run === "design-b").length;
    const hasD3 = (plan.designs || []).some((d) => d.slot === 3);
    L.push(`  型B（未成立。不採用に数えない）: ${nf.length ? [...new Set(nf.map((x) => `${x.symbol}（${x.detail}）`))].join(" ／ ") : "なし"}${bAdded ? ` ／ 状態更新で追加した型B ${bAdded}件（候補欄を参照）` : ""}${hasD3 ? "" : "（型Bは設計③と、16:00〜21:59の状態更新で追加される。追加時に門で不採用だった型Bは一覧しない）"}`);
  }
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

  // 4. 価格根拠
  L.push("");
  L.push("== 4. 価格根拠（Entry・SL・TP1 の元になった実在の水準）==");
  if (!plan.candidates.length) L.push("  候補がないので、なし");
  for (const c of plan.candidates) L.push(basisBlock(c));

  // 5. イベント
  L.push("");
  L.push("== 5. イベント（日本時間。economic-calendar.json の当日分。停止時間: 前15分〜後30分、新規のみ禁止）==");
  if (plan.events.status !== "ok") L.push(`  イベント未取得（${plan.events.reason}）。停止時間なしで生成しています。`);
  else if (!plan.events_today?.length) L.push("  当日分の High・Medium のイベントはありません。");
  else for (const e of plan.events_today) L.push(`  ${hm(e.datetime_jst)} [${e.currency}/${e.impact}] ${e.event} → 停止 ${hm(e.start)}〜${hm(e.end)}（対象: ${e.symbols.length ? e.symbols.join("、") : "なし"}）`);
  L.push(`  新規不可: 9時台（JST）／翌1:00以降／土曜0:00以降。有効期限: 翌日3:00（JST）。${plan.events.note}`);

  // 6. 前営業日の結果記録
  L.push("");
  L.push("== 6. 前営業日の結果記録（採点。1案1行）==");
  const pd = plan.previous_day;
  if (!pd) L.push("  採点済みの案はありません。");
  else {
    L.push(`  計画日 ${pd.plan_date}: 案 ${pd.n}件 ／ 到達 ${pd.reached}・未到達 ${pd.not_reached}・失効後到達 ${pd.after_expiry}・取消 ${pd.cancelled}`);
    L.push(`  先着（到達した案）: A案 TP1 ${pd.a.tp1}・SL ${pd.a.sl}・未決 ${pd.a.open} ／ B案 TP1 ${pd.b.tp1}・SL ${pd.b.sl}・未決 ${pd.b.open}`);
    for (const i of pd.items) L.push(`    ${i.symbol} ${SIDE[i.side] ?? i.side} 型${i.setup}: ${i.reached}${i.reached_at ? `（${dt(i.reached_at)}）` : ""}${i.first_hit_a ? ` A案 ${i.first_hit_a}` : ""}${i.first_hit_b ? ` B案 ${i.first_hit_b}` : ""}`);
  }

  // 7. 出典
  L.push("");
  L.push("== 7. 出典 ==");
  const mt = plan.mtf;
  L.push(`  MTF: mtf-feed.json 生成 ${dt(mt.generated_at)} ／ data_base_date ${mt.data_base_date ?? "—"} ／ status ${mt.status ?? "—"}${mt.ok ? "" : ` ／ 方向根拠なし: ${mt.reason}`}`);
  L.push(`  Feed: intraday.json ${dt(feed("intraday.json")?.as_of)} ／ h1-bars.json ${dt(feed("h1-bars.json")?.as_of)} ／ daytrade-context.json ${dt(feed("daytrade-context.json")?.as_of)} ／ daily-levels.json ${dt(fr.daily.as_of)}（session_date ${fr.daily.session_date ?? "—"}）`);
  L.push(`  H1: h1-bars.json の最終確定足（開始）最新 ${fr.h1_last_closed?.newest ?? "—"} ／ M15: daytrade-context.json の確定M15の最終足 最新 ${cm?.newest_last_closed ?? "—"}`);
  L.push(`  カレンダー: economic-calendar.json ${plan.events.status === "ok" ? "" : "（未取得）"}as_of ${dt(plan.events.as_of)} ／ date ${plan.events.date ?? "—"} ／ ${plan.events.source ?? "—"}`);
  L.push(`  risk-feed: https://mflab-inc.github.io/EA-Risk-Monitor/data/risk-feed.json ${rf.generated_intraday ? `generated_intraday ${dt(rf.generated_intraday)}` : `（${rf.status}）`}`);
  if (plan.designs?.length) L.push(`  設計の履歴: ${plan.designs.map((d) => `設計${d.slot} ${dt(d.generated_at)}`).join(" ／ ")}`);
  if (plan.additions_b?.length) L.push(`  型Bの追加（この状態更新）: ${plan.additions_b.join("、")}`);
  if (plan.inputs_problems?.length) L.push(`  入力の問題: ${plan.inputs_problems.join(" ／ ")}`);
  return L.join("\n") + "\n";
}

module.exports = { render };
