"use strict";
/**
 * デイトレプラン自動生成（仕様 docs/daytrade-plan-spec.md 2〜5節・7節）。
 *   node scripts/daytrade-plan.js --run=design [--slot=1|2|3]   … 設計（Entry・SL・TP を決める）
 *   node scripts/daytrade-plan.js --run=status                  … 状態更新（距離・ADR消化・鮮度・到達／失効・停止中だけ）
 * workflow からは cron の文字列（環境変数 DAYTRADE_CRON）で起動の種類を決める（夏冬の判定を含む）。
 *   --resolve   種類を決めて key=value を出力するだけ（GITHUB_OUTPUT 用）
 *   --force     同じ枠の済み判定・遅れの判定を無視して必ず実行（手動実行用）
 *   --now=<ISO> 現在時刻を指定（試験用）  --data-dir=<dir>  --no-risk-feed  --dry-run（書き込まない）
 * 既存のファイル（fetch.js・daytrade.js・intraday.json など）は読むだけで、変更しない。
 */
const fs = require("fs");
const path = require("path");
const { parseArgs, repoRoot, dataDir: defaultDataDir } = require("./daytrade/cli");
const { loadInputs } = require("./daytrade/inputs");
const { fetchRiskFeed } = require("./daytrade/riskfeed");
const { buildDesign, buildStatus } = require("./daytrade/plan");
const { render } = require("./daytrade/render");
const { resolveAction, designStale } = require("./daytrade/schedule");
const { planDateOf } = require("./daytrade/windows");
const { parseIso, jstIso } = require("./daytrade/jst");
const L = require("./daytrade/log");
const store = require("../mtf/lib/store");

async function main(argv = process.argv.slice(2), env = process.env, io = { log: console.log }) {
  const args = parseArgs(argv);
  const nowMs = args.now ? parseIso(args.now) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`--now が読めません: ${args.now}`);
  const dataDir = args["data-dir"] ? path.resolve(args["data-dir"]) : defaultDataDir;

  // 1) 起動の種類
  let action, slot, reason = null;
  const cron = args.cron || env.DAYTRADE_CRON || "";
  if (cron) {
    const r = resolveAction(cron, nowMs);
    action = r.action; slot = r.slot ?? null; reason = r.reason ?? null;
  } else {
    action = args.run || env.DAYTRADE_RUN || "";
    const s = args.slot || env.DAYTRADE_SLOT || "";
    slot = s ? Number(s) : null;
    if (!["design", "status"].includes(action)) throw new Error("--run=design|status か、cron の文字列（DAYTRADE_CRON）を指定してください");
    if (slot !== null && ![1, 2, 3].includes(slot)) throw new Error(`--slot は 1〜3 です: ${s}`);
  }
  if (args.resolve) {
    io.log(`action=${action}`);
    io.log(`slot=${slot ?? ""}`);
    if (reason) io.log(`reason=${reason}`);
    return { action, slot };
  }
  if (action === "skip" || !action) { io.log(`[daytrade] 何もしません: ${reason || "対象外"}`); return { skipped: reason }; }

  // 2) 前回の計画
  const planPath = path.join(dataDir, "daytrade-plan.json");
  let prevPlan = null;
  if (fs.existsSync(planPath)) { try { prevPlan = JSON.parse(fs.readFileSync(planPath, "utf8")); } catch { prevPlan = null; } }
  const planDate = planDateOf(nowMs);
  const sameDay = prevPlan && prevPlan.plan_date === planDate;

  // 3) 済み・遅れの判定（手動の --force では無視）[Q22]
  if (!args.force) {
    if (action === "design" && slot !== null) {
      if (sameDay && prevPlan.design_slot === slot) { io.log(`[daytrade] 計画日 ${planDate} の設計${slot}は済んでいます。何もしません`); return { skipped: "done" }; }
      const stale = designStale({ slot, nowMs, lastDesignSlot: sameDay ? prevPlan.design_slot : null });
      if (stale) { io.log(`[daytrade] 設計${slot}は見送ります: ${stale}`); return { skipped: stale }; }
    }
    if (action === "status" && prevPlan?.status_updated_at) {
      const last = parseIso(prevPlan.status_updated_at);
      if (Number.isFinite(last) && Math.floor(last / 3600000) === Math.floor(nowMs / 3600000) && prevPlan.plan_date === planDate) {
        io.log("[daytrade] この時間の状態更新は済んでいます。何もしません"); return { skipped: "done" };
      }
    }
  }

  // 4) 入力
  const inputs = loadInputs({ dataDir, repoRoot, nowMs });
  const riskFeed = args["no-risk-feed"] ? { status: "未取得", reason: "取得しない指定", pairs: {} } : await fetchRiskFeed({ nowMs });
  const logPath = path.join(dataDir, "daytrade", "log.csv");
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const logRows = logText ? L.parseLog(logText) : [];

  // 5) 組み立て
  const { plan, logAppend } = action === "design"
    ? buildDesign({ inputs, riskFeed, nowMs, slot, prevPlan, logRows })
    : buildStatus({ inputs, riskFeed, nowMs, prevPlan, logRows });
  const txt = render(plan, inputs.accounts);

  // 6) 書き込み（全部できてから data/ に置く。一時ファイルは data/ の外）
  const entries = [
    { file: "daytrade-plan.json", content: JSON.stringify(plan, null, 2) + "\n" },
    { file: "daytrade-plan.txt", content: txt },
  ];
  if (logAppend && logAppend.length) entries.push({ file: path.join("daytrade", "log.csv"), content: L.appendedText(logText, logAppend) });
  if (args["dry-run"]) { io.log(txt); return { plan, dry: true }; }
  store.writeAll(dataDir, entries);
  io.log(`[daytrade] ${action}${slot ? `（設計${slot}）` : ""} 計画日 ${plan.plan_date} / 候補 ${plan.candidates.length}件 / 発注${plan.order_ok ? "可" : "不可"} / log追記 ${logAppend ? logAppend.length : 0}行 / ${jstIso(nowMs)}`);
  return { plan, logAppend };
}

if (require.main === module) {
  main().catch((e) => { console.error(`::error::daytrade-plan: ${e.stack || e.message}`); process.exit(1); });
}
module.exports = { main };
