"use strict";
const { pairOf } = require("../pairs");
const { jstDow, jstAt, jstIso } = require("../jst");
const { REASONS, COUNTED } = require("../evaluate");
const { expiresAtMs } = require("../windows");
const D = require("./detect");

/**
 * Issue の題名・本文・コメントの文面（純関数）。判定文（『良い』『危ない』など）は書かず、数字と状態だけ。
 * Issue は公開されるので、口座の資金・損失上限は書かない（上限ロットは data/daytrade-plan.txt と同じく出す。Q68）。
 * どの本文・コメントも先頭で @MFlab-inc を呼び、末尾に重複防止のマーカー（detect.js の鍵）を付ける。
 */
const SIDE = { sell: "売り", buy: "買い" };
const SLOT = { 1: "①", 2: "②", 3: "③" };
const DOW = ["日", "月", "火", "水", "木", "金", "土"];
const hm = (iso) => (iso ? String(iso).slice(11, 16) : "—");
const md = (iso) => (iso ? String(iso).slice(5, 16).replace("T", " ") : "—");
const px = (v, pair) => (Number.isFinite(v) ? v.toFixed(pair.digits) : "—");

const issueTitle = (planDate) => `デイトレ ${planDate}（${DOW[jstDow(jstAt(planDate, "12:00"))]}）`;
const parseIssueDate = (title) => /^デイトレ (\d{4}-\d{2}-\d{2})（[日月火水木金土]）$/.exec(String(title))?.[1] ?? null;

const withMarkers = (lines, keys) => [...lines, "", ...keys.map(D.markerOf)].join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, keys.length ? "" : "\n");

function lotsText(s, accounts) {
  const ids = Object.keys(accounts || {}).length ? Object.keys(accounts) : Object.keys(s.lots || {});
  return ids.map((a) => {
    const st = accounts?.[a]?.equity_status;
    if (st === "unset" || st === "invalid") return `${a}=未設定`;
    const v = s.lots?.[a];
    return v === null || v === undefined ? `${a}=—` : `${a}=${v.toFixed(2)}`;
  }).join(" / ");
}

function schemeLine(name, s, pair, accounts) {
  const label = name === "A" ? "A案(0.5×ATR)" : "B案(1.0×ATR)";
  if (!s.pass) return `- ${label}: 不採用（${s.reason_text ?? s.reason}）`;
  return `- ${label}: SL ${px(s.sl, pair)}（${s.sl_pips}pips）／ TP1 ${px(s.tp1, pair)}（${s.profit_pips}pips）／ RR ${s.rr} ／ 上限ロット ${lotsText(s, accounts)}`;
}

// 停止時間（経済カレンダー由来の題名・通貨は外部の文字なので、無害化してから載せる）
const stopsText = (c) => ((c.stops || []).length ? c.stops.map((w) => `${hm(w.start)}〜${hm(w.end)} [${D.safeText(w.currency, 6)}] ${D.safeText(w.event)}`).join(" ／ ") : "なし");

// 1案の要点（Issue の本文・新しい案のコメントで同じ形）
function candidateBlock(c, accounts) {
  const pair = pairOf(c.symbol);
  const lines = [
    `#### [${c.rank}] ${c.symbol} ${SIDE[c.side]} 型${c.setup}${c.run === "design-b" ? `（型Bの追加 ${hm(c.generated_at)}）` : ""}`,
    `- Entry帯: ${px(c.band.low, pair)}〜${px(c.band.high, pair)}（最悪Entry ${px(c.worst_entry, pair)}）／ 現在値 ${px(c.price, pair)}（距離 ${c.distance_pips}pips）`,
    schemeLine("A", c.schemes.A, pair, accounts),
    schemeLine("B", c.schemes.B, pair, accounts),
    `- 有効期限: ${md(c.expires_at)}`,
    `- 確認条件: ${c.confirm}`,
    `- 停止時間: ${stopsText(c)}`,
  ];
  return lines.join("\n");
}

function rejectionLine(plan) {
  const sm = plan?.summary;
  if (!sm || !sm.rejections) return null;
  const parts = COUNTED.map((k) => `${REASONS[k]} ${sm.rejections[k] ?? 0}`);
  return `不採用の内訳（件数）: ${parts.join(" ／ ")}`;
}

const FOOT = (repoUrl) => [
  "",
  "---",
  "この Issue のコメントで、次をお知らせします（同じ出来事は1回だけ）: 新しい案（設計②③・型Bの追加）／案の取消・再設計／価格が Entry 帯に入った・近づいた／採点の結果／異常（Daytrade Plan の失敗・設計なし・入力の更新停止）。",
  `計画日が終わる（有効期限 翌日 03:00）と、まとめを書いて閉じます。数字の詳細: ${repoUrl ? `${repoUrl}/blob/main/data/daytrade-plan.txt` : "data/daytrade-plan.txt"}`,
];

// 発注できる状態の設計（order_ok）がその計画日にあるか。無ければ、候補を載せない
const hasDesign = (plan, planDate) => Boolean(plan && plan.plan_date === planDate && Array.isArray(plan.designs) && plan.designs.length && plan.order_ok === true);

// 設計の結果の見出し（候補の件数・不採用の内訳）
function designHead(plan) {
  const d = plan.designs[plan.designs.length - 1];
  const out = [`- 設計${SLOT[d.slot] ?? ""}（${hm(d.generated_at)}）時点の候補: **${plan.candidates.length}件**`];
  const rj = rejectionLine(plan);
  if (rj) out.push(`- ${rj}`);
  return out;
}

// 計画日の Issue の本文。その計画日の設計があれば、候補の件数と要点（0件でも作る）。
// 無ければ（異常の通知が先に出る日。失敗の通知は公開前の計画を信用しない）、その旨と pending の印。設計ができたら、結果をコメントで知らせる（designResultComment）
function issueBody({ planDate, plan, repoUrl = null }) {
  const has = hasDesign(plan, planDate);
  const head = [
    `${D.MENTION} デイトレプラン ${planDate}（${DOW[jstDow(jstAt(planDate, "12:00"))]}）の通知用 Issue です（自動作成）。`,
    "",
    `- 計画日: ${planDate} ／ 有効期限: ${has ? md(plan.expires_at) : "翌日 03:00"}`,
  ];
  const keys = [];
  if (!has) {
    head.push("- 設計: 発注できる状態の設計はまだありません（設計ができたら、結果をコメントでお知らせします）");
    keys.push(D.K.pending(planDate));
  } else {
    head.push(...designHead(plan), "");
    if (!plan.candidates.length) head.push("候補はありません。");
    for (const c of plan.candidates) { head.push(candidateBlock(c, plan.accounts), ""); keys.push(D.K.new(D.versionKey(c))); }
    keys.push(D.K.design(planDate));
  }
  return { body: withMarkers([...head, ...FOOT(repoUrl)], keys), keys };
}

// pending の Issue（本文に設計の結果が無い）に、最初の設計の結果を知らせる。候補が0件でも出す。載せた案は通知済みの印を付ける
function designResultComment({ plan }) {
  const keys = [];
  const lines = [`${D.MENTION} 設計の結果`, "", ...designHead(plan), ""];
  if (!plan.candidates.length) lines.push("候補はありません。");
  for (const c of plan.candidates) { lines.push(candidateBlock(c, plan.accounts), ""); keys.push(D.K.new(D.versionKey(c))); }
  keys.push(D.K.design(plan.plan_date));
  return { body: withMarkers(lines, keys), keys };
}

// 新しい案（設計②③・型Bの追加。取消のあとに同じ案が戻った場合も）。1回の実行で出た案を1つのコメントにまとめる
function newCandidatesComment({ cands, plan }) {
  const keys = cands.map((c) => D.K.new(D.versionKey(c)));
  const t = hm(plan.generated_at && cands.every((c) => c.run !== "design-b") ? plan.generated_at : cands[0].generated_at);
  const lines = [`${D.MENTION} 新しい案 ${cands.length}件（${t}）`, ""];
  for (const c of cands) lines.push(candidateBlock(c, plan.accounts), "");
  lines.pop();
  return { body: withMarkers(lines, keys), keys };
}

// 版の鍵・ログの行にある Entry 帯の価格を、銘柄の桁にそろえて出す（候補の表示と同じ桁）
const bandText = (i) => { const pair = pairOf(i.symbol); const f = (v) => (pair && Number.isFinite(Number(v)) ? Number(v).toFixed(pair.digits) : v); return `Entry ${f(i.entry_low)}〜${f(i.entry_high)}`; };
// 取消（再設計）。newCands は同じ実行で出た新しい案（同じ型・銘柄・向きがあれば『再設計』）
function cancelComment({ cancelled, newCands, nowMs }) {
  const keys = cancelled.map((x) => D.K.cancel(x.v));
  const lines = [`${D.MENTION} 案を取消しました（${hm(jstIso(nowMs))}）`, ""];
  for (const { info } of cancelled) {
    const re = newCands.find((c) => c.setup === info.setup && c.symbol === info.symbol && c.side === info.side);
    const pair = pairOf(info.symbol);
    lines.push(`- ${info.symbol} ${SIDE[info.side] ?? info.side} 型${info.setup}（${bandText(info)}） → ${re ? `再設計: 新しい案は ${px(re.band.low, pair)}〜${px(re.band.high, pair)}（別コメント）` : "該当する案なし"}`);
  }
  return { body: withMarkers(lines, keys), keys };
}

// 価格が帯に入った／帯の近く（0.1×H1 ATR 以内）に来た
function nearComment({ events, nowMs }) {
  const keys = events.map((e) => D.K.near(e.v));
  const lines = [];
  for (const e of events) {
    const pair = pairOf(e.c.symbol);
    const head = e.kind === "in_band"
      ? `${e.c.symbol} ${SIDE[e.c.side]}：帯に到達（現在値 ${px(e.price, pair)}）。M15の確認条件を見る`
      : `${e.c.symbol} ${SIDE[e.c.side]}：帯の近く（現在値 ${px(e.price, pair)}、帯まで ${e.distance_pips}pips）。M15の確認条件を見る`;
    lines.push(`${lines.length ? "" : `${D.MENTION} `}${head}`);
    lines.push(`  - 型${e.c.setup} ／ Entry帯 ${px(e.c.band.low, pair)}〜${px(e.c.band.high, pair)} ／ 確認条件: ${e.c.confirm}`);
    if (e.entry_reasons.length) lines.push(`  - 新規不可: ${e.entry_reasons.join("、")}`);
  }
  lines.push("", `（${md(jstIso(nowMs))} 時点の判定）`);
  return { body: withMarkers(lines, keys), keys };
}

const HIT = { TP1: "TP1先", SL: "SL先", 未決: "未決（有効期限まで決着せず）" };
function scoreLine(row, gap) {
  const base = `${row.symbol} ${SIDE[row.side] ?? row.side} 型${row.setup}（${bandText(row)}）`;
  if (row.reached === "到達") {
    const hits = [row.first_hit_a ? `A案 ${HIT[row.first_hit_a] ?? row.first_hit_a}` : null, row.first_hit_b ? `B案 ${HIT[row.first_hit_b] ?? row.first_hit_b}` : null].filter(Boolean);
    return `- ${base}: 到達（${md(row.reached_at)}の足）${hits.length ? ` ／ ${hits.join("、")}` : ""}`;
  }
  if (row.reached === "未到達") return `- ${base}: 未到達${Number.isFinite(gap) ? `（Entry帯まで ${gap}pips 足りず）` : ""}`;
  if (row.reached === "失効後到達") return `- ${base}: 失効後到達（${md(row.reached_at)}の足）`;
  return `- ${base}: ${row.reached}`;
}

// 採点の結果。その計画日の全部の版の最終状態（取消も）を並べる。通知の鍵は、今回新しく採点が付いた版
function scoreComment({ planDate, due, all, gaps }) {
  const keys = due.map((x) => D.K.score(x.v));
  const lines = [`${D.MENTION} 採点の結果（計画日 ${planDate}）`, ""];
  const order = { scored: 0, cancelled: 1, open: 2, other: 3 };
  for (const x of [...all].sort((a, b) => order[a.state] - order[b.state])) {
    if (x.state === "cancelled") lines.push(`- ${x.row.symbol} ${SIDE[x.row.side] ?? x.row.side} 型${x.row.setup}（${bandText(x.row)}）: 取消(再設計)`);
    else if (x.state === "scored") lines.push(scoreLine(x.row, gaps?.get(x.v)));
    else lines.push(`- ${x.row.symbol} ${SIDE[x.row.side] ?? x.row.side} 型${x.row.setup}（${bandText(x.row)}）: 未採点`);
  }
  return { body: withMarkers(lines, keys), keys };
}

// 計画日の終了のまとめ（Issue を閉じる前の最後のコメント）
function summaryComment({ planDate, summary }) {
  const key = D.K.summary(planDate);
  const lines = [
    `${D.MENTION} 計画日 ${planDate} が終了しました（有効期限 ${md(jstIso(expiresAtMs(planDate)))}）。`,
    "",
    `- 設計で出た案: ${summary.versions}件（取消 ${summary.cancelled}件、期限まで有効だった案 ${summary.valid_at_expiry}件）`,
    `- お知らせした新しい案: ${summary.new_notified}件 ／ 帯への到達・接近のお知らせ: ${summary.near_notified}件`,
    summary.scored ? `- 採点済み: ${summary.scored}件（結果は別コメント）` : "- 採点は次の営業日の設計①の前に行い、結果をこの Issue に追記します。",
  ];
  return { body: withMarkers(lines, [key]), keys: [key] };
}

// 異常。stale は同じ実行で出た分（intraday・h1・context がまとめて止まるのが普通）を1つのコメントにまとめる
function anomalyComment({ evs, planDate }) {
  const lines = [];
  const keys = evs.map((e) => e.key);
  const first = evs[0];
  if (first.kind === "failure") {
    lines.push(`${D.MENTION} **Daytrade Plan が失敗しました**`);
    const items = [];
    if (first.failure.detail) items.push(`- 失敗した手順: ${D.safeText(first.failure.detail, 60)}`);
    if (/^https:\/\/[\w.\/-]+$/.test(first.failure.run_url || "")) items.push(`- 実行: ${first.failure.run_url}`);
    if (items.length) lines.push("", ...items);
    lines.push("", "計画（data/daytrade-plan.txt）は前回の内容のままです。次の Intraday Snapshot の完了で再実行されます。");
  } else if (first.kind === "nodesign") {
    lines.push(`${D.MENTION} **設計${SLOT[first.slot]}がありません**（窓 ${hm(jstIso(first.window.start))}〜${hm(jstIso(first.window.end))} が終わりました。計画日 ${planDate}）`, "",
      "窓の中に Intraday Snapshot の完了が無かった／入力が整わず設計が『済み』にならなかった可能性があります。Actions の Daytrade Plan で `run=design`・該当の `slot` を指定して手動実行すると設計できます。");
  } else if (first.kind === "stale") {
    lines.push(`${D.MENTION} **入力の更新が止まっています**（1時間以上）`, "");
    for (const e of evs) lines.push(`- ${D.safeText(e.name, 40)}: ${e.age_min === null ? "読めません" : `as_of ${D.safeText(e.as_of, 40)}（${e.age_min}分前）`}`);
    lines.push("", "更新されるまで、計画は『発注不可（鮮度超過）』になります。");
  }
  return { body: withMarkers(lines, keys), keys };
}

module.exports = { SIDE, SLOT, issueTitle, parseIssueDate, issueBody, designResultComment, candidateBlock, newCandidatesComment, cancelComment, nearComment, scoreComment, summaryComment, anomalyComment };
