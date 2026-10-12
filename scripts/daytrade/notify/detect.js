"use strict";
const { pairOf } = require("../pairs");
const { candRow } = require("../plan");
const L = require("../log");
const N = require("../num");
const { planDateOf, expiresAtMs, noNewEntryReason } = require("../windows");
const { jstDow, jstHour, jstIso, parseIso, HR, MIN } = require("../jst");
const { slotWindow, designsDone, isWeekdayPlanDate } = require("../schedule");
const { FRESH_LIMIT_MIN } = require("../inputs");

/**
 * Issue 通知の判定（純関数。ネットワーク・ファイルに触れない）。
 * 重複を出さない仕組み: 通知した出来事は、Issue の本文・コメントに隠しマーカー `<!-- daytrade-notify key=<鍵> -->` として残る。
 * 判定は『いまの計画・ログ・価格』と『その Issue にあるマーカー（古い順）』だけから決める（状態を別に持たない・コミットしない）。
 *
 * 鍵:
 *   new:<版>      案を通知した（版 = log.csv と同じ plan_date|型|銘柄|向き|Entry帯|SL(A)|SL(B)）。cancel:<版> が後に付くまで再通知しない
 *   cancel:<版>   取消（再設計）を通知した。これより後にまた案が出たら、new: を出し直す（取消のあとに同じ案が戻った）
 *   near:<版>     価格が帯の近く（帯の外で、帯から 0.1×H1 ATR 以内）に来たことを、版ごとに1回通知した
 *   band:<版>     価格が帯に入った（到達）ことを、版ごとに1回通知した。near: とは別の出来事（近く → 到達の順に両方出る。最初から帯の中なら到達だけ。
 *                 到達を通知したあとは、近くを出さない）
 *   score:<版>    採点の結果を通知した
 *   summary:<日>  計画日の終了のまとめを出した（Issue を閉じた）
 *   fail:<日 時>  ワークフローの失敗を、1時間に1回通知した
 *   nodesign:<日>:<枠>  設計の窓が終わっても設計が無いことを通知した
 *   stale:<フィード>:<as_of>  入力が1時間以上更新されていないことを、その as_of ごとに1回通知した
 *   pending:<日>  異常の通知が先に出て、設計の結果がまだ無い状態で作った Issue（本文に候補の件数が無い）。design:<日> が付くまで『設計の結果』のコメントを待つ
 *   design:<日>   その計画日の最初の設計の結果（候補の件数）を、本文またはコメントで知らせた
 * マーカーを信用するのは、Actions の bot（github-actions[bot]）が書いた本文・コメントだけ（Issue は公開で、誰でもコメントできるため。isTrusted）。
 * 外部由来の文字（カレンダーの題名など）は、マーカーや @ の呼び出しを作れないよう無害化してから文面に入れる（safeText）。
 */
const MENTION = "@MFlab-inc";
const LABEL = "daytrade";
const NEAR_ATR = 0.1;               // 帯の近く = 帯から 0.1×H1 ATR14 以内
const STALE_ALERT_MIN = 60;         // 入力の更新が止まった通知の基準（分）
const SCORE_WINDOW_HOURS = 72;      // 採点の通知は、採点から72時間以内の結果だけ（金曜分の採点は月曜、通知の失敗は次の実行で再試行される）
const SCORED = new Set(["到達", "未到達", "失効後到達"]);
const CANCELLED = "取消(再設計)";
const FEEDS = ["intraday.json", "h1-bars.json", "daytrade-context.json"];
const TRUSTED_AUTHORS = ["github-actions[bot]"]; // GITHUB_TOKEN で書いたときの書き手。手元で別のトークンを使うときは DAYTRADE_NOTIFY_TRUSTED（カンマ区切り）で足す

// ---- 鍵とマーカー ----
const clean = (s) => String(s).replace(/--+/g, "-_").replace(/[\r\n]+/g, " ").trim();
const K = {
  new: (v) => clean(`new:${v}`), cancel: (v) => clean(`cancel:${v}`), near: (v) => clean(`near:${v}`), band: (v) => clean(`band:${v}`), score: (v) => clean(`score:${v}`),
  pending: (d) => clean(`pending:${d}`), design: (d) => clean(`design:${d}`),
  summary: (d) => clean(`summary:${d}`), fail: (hourLabel) => clean(`fail:${hourLabel}`), nodesign: (d, slot) => clean(`nodesign:${d}:${slot}`),
  stale: (name, asOf) => clean(`stale:${name}:${asOf ?? "unreadable"}`),
};
const isTrusted = (user, trusted = TRUSTED_AUTHORS) => Boolean(user && typeof user.login === "string" && trusted.includes(user.login));

// 外部由来の文字（経済カレンダーの題名・実行の URL など）を、1行の無害な文字にする。
// '<' '>' を全角にしてマーカー（HTML コメント）を作れなくし、'@' を全角にして呼び出しを作れなくし、[ ] と :// を崩してリンクを作れなくする。長さも切る
const safeText = (s, max = 80) => String(s ?? "")
  .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, " ")
  .replace(/</g, "＜").replace(/>/g, "＞").replace(/`/g, "'").replace(/@/g, "＠").replace(/\[/g, "［").replace(/\]/g, "］").replace(/:\/\//g, "：//")
  .replace(/\s+/g, " ").trim().slice(0, max);

const markerOf = (key) => `<!-- daytrade-notify key=${clean(key)} -->`;
// テキスト（Issue の本文・コメントの本文）にあるマーカーの鍵を、書かれた順に返す
const parseMarkers = (text) => [...String(text ?? "").matchAll(/<!-- daytrade-notify key=(.*?) -->/g)].map((m) => m[1]);

const versionKey = (c) => clean(L.keyOf(candRow(c, "design", c.generated_at)));
// 版の鍵の形（log.csv の keyOf の形）。マーカーから読んだ鍵がこの形でなければ、案として扱わない
const VERSION_RE = /^\d{4}-\d{2}-\d{2}\|[AB]\|[A-Z]{6}\|(buy|sell)\|\d+(\.\d+)?\|\d+(\.\d+)?\|(\d+(\.\d+)?)?\|(\d+(\.\d+)?)?$/;
const validVersion = (v) => VERSION_RE.test(v) && Boolean(pairOf(v.split("|")[2]));
function parseVersionKey(v) {
  const [plan_date, setup, symbol, side, entry_low, entry_high, sl_a, sl_b] = String(v).split("|");
  return { plan_date, setup, symbol, side, entry_low, entry_high, sl_a, sl_b };
}
// 版ごとの『最後に通知した状態』（new か cancel）。markers は古い順
function announcedState(markers) {
  const m = new Map();
  for (const k of markers) {
    const mm = /^(new|cancel):(.+)$/.exec(k);
    if (mm && validVersion(mm[2])) m.set(mm[2], mm[1]); // 版の鍵（clean 済み）。形が違うものは読まない
  }
  return m;
}

// ---- 時間帯 ----
// 異常（更新の停止・設計なし・失敗）を通知してよい時間: 平日の計画日の、市場が動いている時間（JST 06:00〜翌02:59）。それ以外（週末・月曜早朝など）は、入力が止まっているのが普通なので通知しない
function isOperating(nowMs) {
  const pd = planDateOf(nowMs);
  if (!isWeekdayPlanDate(pd)) return false;
  const h = jstHour(nowMs);
  return h >= 6 || h <= 2;
}
const hourLabel = (ms) => jstIso(ms).slice(0, 13).replace("T", " ");

// ---- 案の通知（new / cancel / near） ----
// 現在の計画から見た、その計画日の Issue への通知。plan が今日の計画でない・有効期限後・発注できる状態でない（order_ok が true でない）ときは何も出さない
// （古い入力・設定の問題で一時的に案が消えても、取消を通知しない。入力が戻れば、通知済みの案は続きとして扱われ、新しい通知は出ない）
function candidateEvents({ nowMs, plan, intraday, markers }) {
  const none = { active: false, newCands: [], cancelled: [], near: [] };
  if (!plan || !plan.plan_date || plan.plan_date !== planDateOf(nowMs)) return none;
  if (nowMs >= expiresAtMs(plan.plan_date) || !isWeekdayPlanDate(plan.plan_date)) return none;
  if (!Array.isArray(plan.designs) || !plan.designs.length || plan.order_ok !== true) return none;
  const state = announcedState(markers);
  const done = new Set(markers);
  const current = new Map();
  for (const c of plan.candidates || []) current.set(versionKey(c), c);

  const newCands = [...current].filter(([v]) => state.get(v) !== "new").map(([, c]) => c);
  const cancelled = [...state].filter(([v, s]) => s === "new" && !current.has(v)).map(([v]) => ({ v, info: parseVersionKey(v) }));

  // 帯への接近（near:）と到達（band:）。別々の出来事として、どちらも版ごとに1回。到達を通知したあとは何も出さない（最初から帯の中なら到達だけ）。
  // 価格は intraday.json の現在値で、鮮度（20分）を満たすときだけ
  const near = [];
  const asOf = parseIso(intraday?.as_of);
  if (Number.isFinite(asOf) && nowMs - asOf <= FRESH_LIMIT_MIN * MIN) {
    for (const [v, c] of current) {
      if (done.has(K.band(v))) continue;
      const pair = pairOf(c.symbol);
      const price = intraday?.pairs?.[c.symbol]?.price;
      if (!pair || !Number.isFinite(price) || !c.band || !Number.isFinite(c.atr_pips)) continue;
      const dist = price < c.band.low ? c.band.low - price : price > c.band.high ? price - c.band.high : 0;
      const inBand = dist === 0;
      if (!inBand && !N.lte(dist, NEAR_ATR * c.atr_pips * pair.pip)) continue;
      const kind = inBand ? "in_band" : "near";
      if (kind === "near" && done.has(K.near(v))) continue;
      near.push({ v, c, kind, key: inBand ? K.band(v) : K.near(v), price, distance_pips: Number((dist / pair.pip).toFixed(1)), entry_reasons: entryBlockers(c, nowMs, plan.plan_date) });
    }
  }
  return { active: true, newCands, cancelled, near };
}

// その時刻に新規を出せない理由（時間帯のルール＋停止中のイベント）。空なら新規可
function entryBlockers(c, nowMs, planDate) {
  const out = [];
  const t = noNewEntryReason(nowMs, planDate);
  if (t) out.push(t);
  for (const w of c.stops || []) {
    const s = parseIso(w.start), e = parseIso(w.end);
    if (Number.isFinite(s) && Number.isFinite(e) && nowMs >= s && nowMs <= e) out.push(`停止中: ${safeText(w.time_jst, 8)} [${safeText(w.currency, 6)}] ${safeText(w.event)}`);
  }
  return out;
}

// ---- 採点の通知 ----
// 計画日 planDate の版ごとの最終状態と、まだ通知していない採点の結果
function scoreEvents({ logRows, planDate, markers, nowMs }) {
  const latest = [...L.latestByKey((logRows || []).filter((r) => r.plan_date === planDate)).entries()];
  const all = latest.map(([v, row]) => ({
    v, row,
    state: row.run === "status" && SCORED.has(row.reached) ? "scored" : row.run === "status" && row.reached === CANCELLED ? "cancelled" : row.run === "status" ? "other" : "open",
  }));
  const done = new Set(markers);
  const due = all.filter((x) => {
    if (x.state !== "scored" || done.has(K.score(x.v))) return false;
    const t = parseIso(x.row.generated_at); // 採点を書いた時刻
    return Number.isFinite(t) && nowMs - t <= SCORE_WINDOW_HOURS * HR;
  });
  return { all, due };
}

// ---- 計画日の終了 ----
const isExpired = (nowMs, planDate) => nowMs >= expiresAtMs(planDate);
const closeDue = ({ nowMs, issueDate, markers }) => isExpired(nowMs, issueDate) && !markers.includes(K.summary(issueDate));

// 終了のまとめの材料（log.csv のその計画日の版ごとの最終状態と、通知した件数）
function daySummary({ logRows, planDate, markers }) {
  const latest = [...L.latestByKey((logRows || []).filter((r) => r.plan_date === planDate)).values()];
  const cancelled = latest.filter((r) => r.run === "status" && r.reached === CANCELLED).length;
  const scored = latest.filter((r) => r.run === "status" && SCORED.has(r.reached)).length;
  return {
    versions: latest.length, cancelled, scored, valid_at_expiry: latest.length - cancelled,
    near_notified: markers.filter((k) => k.startsWith("near:") || k.startsWith("band:")).length,
    new_notified: markers.filter((k) => k.startsWith("new:")).length,
  };
}

// ---- 異常 ----
function anomalyEvents({ nowMs, plan, logRows, feeds, failure, markers }) {
  const out = [];
  if (!isOperating(nowMs)) return out;
  const done = new Set(markers);
  const planDate = planDateOf(nowMs);
  if (failure) {
    const k = K.fail(hourLabel(nowMs));
    if (!done.has(k)) out.push({ kind: "failure", key: k, failure });
  }
  // 設計の窓が終わっても、その枠の設計が無い（入力が整わず『済み』にならなかった設計も含む）
  const prev = plan && plan.plan_date === planDate ? plan : null;
  const dn = designsDone({ planDate, prevPlan: prev, logRows: logRows || [] });
  for (const slot of [1, 2, 3]) {
    const w = slotWindow(slot, planDate, nowMs);
    if (nowMs < w.end || nowMs >= expiresAtMs(planDate) || dn.has(slot)) continue;
    const k = K.nodesign(planDate, slot);
    if (!done.has(k)) out.push({ kind: "nodesign", key: k, slot, window: w });
  }
  // 入力の更新が1時間以上止まっている
  for (const f of feeds || []) {
    const asOf = parseIso(f.as_of);
    const age = Number.isFinite(asOf) ? Math.round((nowMs - asOf) / MIN) : null;
    if (age !== null && age < STALE_ALERT_MIN) continue;
    const k = Number.isFinite(asOf) ? K.stale(f.name, f.as_of) : K.stale(f.name, `unreadable@${hourLabel(nowMs)}`);
    if (!done.has(k)) out.push({ kind: "stale", key: k, name: f.name, as_of: f.as_of ?? null, age_min: age });
  }
  return out;
}

module.exports = {
  MENTION, LABEL, NEAR_ATR, STALE_ALERT_MIN, SCORE_WINDOW_HOURS, SCORED, CANCELLED, FEEDS, TRUSTED_AUTHORS, K,
  isTrusted, safeText, markerOf, parseMarkers, versionKey, validVersion, parseVersionKey, announcedState, isOperating, hourLabel, entryBlockers,
  candidateEvents, scoreEvents, isExpired, closeDue, daySummary, anomalyEvents, jstDow,
};
