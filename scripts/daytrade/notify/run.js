"use strict";
const fs = require("fs");
const path = require("path");
const D = require("./detect");
const F = require("./format");
const { planDateOf } = require("../windows");
const { parseH1 } = require("../inputs");
const { pairOf } = require("../pairs");
const { designRowOf, entryGapPips } = require("../gap");
const { jstIso } = require("../jst");
const L = require("../log");

/**
 * Issue 通知の1回分（daytrade.yml の各実行の最後に呼ぶ）。ファイルは読むだけで、書くのは GitHub の Issue だけ（コミットしない）。
 * 状態は持たない: Issue の本文・コメントにあるマーカーと、いまの計画・ログ・価格から、出す通知を決める（detect.js）。
 * どの通知も途中で失敗してよい: マーカーが付かなかった通知は、次の実行でもう一度出る（同じ出来事は1回だけ、の逆側の保証）。
 */
const readJson = (dir, rel) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8")); } catch { return null; }
};

async function runNotify({ dataDir, nowMs, client, failure = null, repoUrl = null, log = () => {} }) {
  const errors = [];
  const guard = async (what, f) => { try { await f(); } catch (e) { errors.push(`${what}: ${String(e.message || e).slice(0, 300)}`); log(`[notify] ${what} に失敗: ${String(e.message || e).slice(0, 300)}`); } };

  const plan = readJson(dataDir, "daytrade-plan.json");
  const intraday = readJson(dataDir, "intraday.json");
  let logRows = [];
  try { logRows = L.readLog(dataDir); } catch (e) { log(`[notify] log.csv を読めません（${String(e.message || e).slice(0, 120)}）。採点・まとめの通知は行いません`); logRows = null; }
  const feeds = D.FEEDS.map((name) => ({ name, as_of: readJson(dataDir, name)?.as_of ?? null }));
  const planDate = planDateOf(nowMs);
  const title = F.issueTitle(planDate);

  const issues = await client.findIssues({ label: D.LABEL });
  const byTitle = new Map(issues.map((i) => [i.title, i]));
  const cache = new Map(); // Issue 番号 → マーカー（古い順）
  const markersOf = async (issue) => {
    if (!cache.has(issue.number)) {
      const keys = D.parseMarkers(issue.body);
      if (issue.comments > 0) for (const c of await client.listComments(issue.number)) keys.push(...D.parseMarkers(c.body));
      cache.set(issue.number, keys);
    }
    return cache.get(issue.number);
  };
  const post = async (issue, built) => {
    await client.addComment(issue.number, built.body);
    (await markersOf(issue)).push(...built.keys);
  };
  let labelReady = false;
  const create = async (date, plan_) => {
    if (!labelReady) { await client.ensureLabel(D.LABEL, "0e8a16", "デイトレプランの通知（自動）").catch(() => {}); labelReady = true; }
    const { body, keys } = F.issueBody({ planDate: date, plan: plan_, repoUrl });
    const issue = await client.createIssue({ title: F.issueTitle(date), body, labels: [D.LABEL] });
    byTitle.set(issue.title, issue);
    cache.set(issue.number, [...keys]);
    return issue;
  };

  // 失敗の通知（ワークフローの失敗手順から）。ほかの通知は、入力が壊れている可能性があるので行わない
  if (failure) {
    await guard("失敗の通知", async () => {
      const mk = await (async () => { const i = byTitle.get(title); return i ? markersOf(i) : []; })();
      const evs = D.anomalyEvents({ nowMs, plan, logRows: logRows || [], feeds: [], failure, markers: mk }).filter((e) => e.kind === "failure");
      if (!evs.length) return;
      const issue = byTitle.get(title) || await create(planDate, plan);
      await post(issue, F.anomalyComment({ evs, planDate }));
    });
    return { errors };
  }

  // 1) 期限が来た Issue: まとめを書いて閉じる
  for (const issue of issues.filter((i) => i.state === "open")) {
    const date = F.parseIssueDate(issue.title);
    if (!date) continue;
    await guard(`まとめ ${date}`, async () => {
      const mk = await markersOf(issue);
      if (!D.isExpired(nowMs, date)) return;
      if (logRows === null) return; // ログを読めないときは、まとめを出さずに閉じない（次の実行で再試行）
      if (D.closeDue({ nowMs, issueDate: date, markers: mk })) await post(issue, F.summaryComment({ planDate: date, summary: D.daySummary({ logRows, planDate: date, markers: mk }) }));
      await client.closeIssue(issue.number);
    });
  }

  // 2) 採点の結果（採点から72時間以内の結果だけ。閉じた Issue にも書く）
  if (logRows) {
    const recent = logRows.filter((r) => r.run === "status" && D.SCORED.has(r.reached) && nowMs - Date.parse(r.generated_at) <= D.SCORE_WINDOW_HOURS * 3600000);
    for (const date of [...new Set(recent.map((r) => r.plan_date))].sort()) {
      const issue = byTitle.get(F.issueTitle(date));
      if (!issue) continue;
      await guard(`採点 ${date}`, async () => {
        const mk = await markersOf(issue);
        const { all, due } = D.scoreEvents({ logRows, planDate: date, markers: mk, nowMs });
        if (!due.length) return;
        const gaps = new Map();
        const bars = parseH1(readJson(dataDir, "h1-bars.json"));
        for (const x of due.filter((y) => y.row.reached === "未到達")) {
          const g = entryGapPips(designRowOf(logRows, x.v), bars[x.row.symbol], pairOf(x.row.symbol));
          if (g !== null) gaps.set(x.v, g);
        }
        await post(issue, F.scoreComment({ planDate: date, due, all, gaps }));
      });
    }
  }

  // 3) 今日の計画: Issue（無ければ作る）→ 新しい案／取消／帯への接近
  await guard("今日の計画", async () => {
    let issue = byTitle.get(title) || null;
    let mk = issue ? await markersOf(issue) : [];
    const probe = D.candidateEvents({ nowMs, plan, intraday, markers: mk });
    if (!issue && probe.active) { issue = await create(planDate, plan); mk = await markersOf(issue); }
    if (!issue) return;
    const ev = D.candidateEvents({ nowMs, plan, intraday, markers: mk });
    if (ev.cancelled.length) await post(issue, F.cancelComment({ cancelled: ev.cancelled, newCands: ev.newCands, nowMs }));
    if (ev.newCands.length) await post(issue, F.newCandidatesComment({ cands: ev.newCands, plan }));
    if (ev.near.length) await post(issue, F.nearComment({ events: ev.near, nowMs }));
  });

  // 4) 異常（設計なし・入力の更新停止）
  await guard("異常の通知", async () => {
    let issue = byTitle.get(title) || null;
    const mk = issue ? await markersOf(issue) : [];
    const evs = D.anomalyEvents({ nowMs, plan, logRows: logRows || [], feeds, failure: null, markers: mk });
    if (!evs.length) return;
    if (!issue) issue = await create(planDate, plan);
    const groups = new Map(); // stale は1つのコメントにまとめる。設計なしは枠ごと
    for (const e of evs) {
      const g = e.kind === "nodesign" ? `nodesign:${e.slot}` : e.kind;
      groups.set(g, [...(groups.get(g) || []), e]);
    }
    for (const g of groups.values()) await post(issue, F.anomalyComment({ evs: g, planDate }));
  });

  return { errors, at: jstIso(nowMs) };
}

module.exports = { runNotify };
