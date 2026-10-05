"use strict";

/**
 * 過去分の取得・試験運転が、daily / intraday と Twelve Data の呼び出しを重ねないための確認。
 *   ・他の Daily FX Data / Intraday Snapshot が実行中・待機中なら待つ（GitHub API で確認。確認できなければ中止）
 *   ・daily / intraday が起動する分（UTC の分 :00 :02 :15 :17 :20 :30 :32 :45 :47 :50）には呼ばない
 *     - intraday: 2,17,32,47 / daily・各種の定期起動: 0,15,30,45 / 外部cron: 21:20・22:20・23:20 と 23:50 UTC
 */
const WATCH_NAMES = ["Daily FX Data", "Intraday Snapshot"];
const TRIGGER_MINUTES = new Set([0, 2, 15, 17, 20, 30, 32, 45, 47, 50]);

const inTriggerMinute = (ms) => TRIGGER_MINUTES.has(new Date(ms).getUTCMinutes());

function createGuard({
  repo, token, selfRunId = "",
  fetchImpl = (...a) => fetch(...a),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  maxWaitMs = 10 * 60000,
  pollMs = 10000,
  log = () => {},
  watchNames = WATCH_NAMES,
} = {}) {
  async function ghGet(path) {
    const r = await fetchImpl(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`GitHub API HTTP ${r.status}`);
    return r.json();
  }

  async function activeOthers() {
    const found = [];
    for (const status of ["in_progress", "queued"]) {
      const j = await ghGet(`/repos/${repo}/actions/runs?status=${status}&per_page=100`);
      for (const run of j.workflow_runs || []) {
        if (watchNames.includes(run.name) && String(run.id) !== String(selfRunId)) found.push(`${run.name}#${run.id}(${status})`);
      }
    }
    return found;
  }

  // 呼び出しの直前に毎回呼ぶ。静かになるまで待つ。確認できない・長引く場合は例外（Twelve Data は呼ばない）
  async function waitQuiet() {
    const deadline = now() + maxWaitMs;
    for (;;) {
      let active = null;
      for (let i = 0; i < 3 && active === null; i++) {
        try { active = await activeOthers(); }
        catch (e) {
          if (i === 2) throw new Error(`他ワークフローの稼働を確認できないため中止します（Twelve Dataは呼んでいません）: ${e.message}`);
          await sleep(5000);
        }
      }
      // 直後の数秒で起動分に入る場合も避ける（このあと間隔調整で数秒待つことがあるため）
      const trigger = inTriggerMinute(now()) || inTriggerMinute(now() + 5000);
      if (!active.length && !trigger) return;
      log(`[guard] 待機: ${trigger ? "daily/intraday の起動分 " : ""}${active.join(", ")}`);
      if (now() > deadline) throw new Error("他ワークフローの稼働・起動時間帯が長引いたため中止します");
      await sleep(trigger && !active.length ? 5000 : pollMs);
    }
  }

  // 開始の枠: 毎時 :10 :25 :40 :55（どの起動分からも離れている）の 10〜11分台に始める
  async function waitStartWindow() {
    for (;;) {
      const t = new Date(now());
      const m = t.getUTCMinutes() % 15, s = t.getUTCSeconds();
      if (m === 10 || (m === 11 && s < 30)) return;
      const ms = ((10 - m + 15) % 15) * 60000 - s * 1000;
      log(`[window] 開始枠まで待機: 現在 ${t.toISOString()} → 約${Math.round(ms / 1000)}秒`);
      await sleep(Math.min(Math.max(ms, 1000), 60000));
    }
  }

  return { waitQuiet, waitStartWindow, activeOthers };
}

module.exports = { createGuard, inTriggerMinute, TRIGGER_MINUTES, WATCH_NAMES };
