"use strict";
/**
 * デイトレプラン自動生成（仕様 docs/daytrade-plan-spec.md 2〜5節・7節、10節の確定した解釈）。
 *   node scripts/daytrade-plan.js                               … 自動: 実行時刻と済みの設計から、設計①②③／状態更新／何もしない、を決める（workflow_run 用）
 *   node scripts/daytrade-plan.js --run=design --slot=2         … 手動: 設計（枠 1=NY17:30 / 2=15:30 / 3=NY8:00）
 *   node scripts/daytrade-plan.js --run=status                  … 手動: 状態更新（距離・ADR消化・鮮度・到達／失効・停止中。JST 16:00〜21:59 は型Bの追加も）
 * 環境変数 DAYTRADE_RUN / DAYTRADE_SLOT でも指定できる（workflow_dispatch の入力）。
 *   --resolve   種類を決めて key=value を出力するだけ（GITHUB_OUTPUT 用）
 *   --force     済み・同じ時間内の判定を無視して必ず実行（手動の試験用）
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
const { resolveAuto, designsDone } = require("./daytrade/schedule");
const { planDateOf } = require("./daytrade/windows");
const { parseIso, jstIso } = require("./daytrade/jst");
const L = require("./daytrade/log");
const store = require("../mtf/lib/store");

async function main(argv = process.argv.slice(2), env = process.env, io = { log: console.log }) {
  const args = parseArgs(argv);
  const nowMs = args.now ? parseIso(args.now) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`--now が読めません: ${args.now}`);
  const dataDir = args["data-dir"] ? path.resolve(args["data-dir"]) : defaultDataDir;

  // 前回の計画とログ（自動の種類の判定にも使う）
  const planPath = path.join(dataDir, "daytrade-plan.json");
  let prevPlan = null;
  if (fs.existsSync(planPath)) { try { prevPlan = JSON.parse(fs.readFileSync(planPath, "utf8")); } catch { prevPlan = null; } }
  const planDate = planDateOf(nowMs);
  const logPath = path.join(dataDir, "daytrade", "log.csv");
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  // log.csv が壊れていても生成は止めない（追記だけ行わず、バナーで知らせる）。壊れたファイルを上書きしない
  let logRows = [], logBroken = null;
  try { logRows = logText ? L.parseLog(logText) : []; } catch (e) { logBroken = String(e.message || e).slice(0, 160); }

  // 1) 起動の種類: 手動（run を指定）か、自動（実行時刻と済みの設計で決める）
  let action, slot = null, reason = null;
  const run = args.run || env.DAYTRADE_RUN || "";
  const slotArg = args.slot || env.DAYTRADE_SLOT || "";
  const manual = Boolean(run);
  if (manual) {
    action = run;
    slot = slotArg ? Number(slotArg) : null;
    if (!["design", "status"].includes(action)) throw new Error("--run は design か status です（自動で決めるときは --run を付けない）");
    if (slot !== null && ![1, 2, 3].includes(slot)) throw new Error(`--slot は 1〜3 です: ${slotArg}`);
    if (action === "design" && slot === null) throw new Error("run=design には設計の枠（--slot=1|2|3 または DAYTRADE_SLOT）が必要です");
  } else {
    const r = resolveAuto({ nowMs, prevPlan, logRows });
    action = r.action; slot = r.slot ?? null; reason = r.reason ?? null;
  }
  if (args.resolve) {
    io.log(`action=${action}`);
    io.log(`slot=${slot ?? ""}`);
    io.log(`now=${jstIso(nowMs)}`); // 後続の手順に同じ時刻を渡す（手順ごとに時刻を取り直すと、判定が変わり得る）
    if (reason) io.log(`reason=${reason}`);
    return { action, slot };
  }
  if (action === "skip") { io.log(`[daytrade] 何もしません: ${reason || "対象外"}`); return { skipped: reason }; }

  // 2) 済み・同じ時間内の判定（手動の --force では無視）
  if (!args.force) {
    if (manual && action === "design" && designsDone({ planDate, prevPlan, logRows }).has(slot)) { io.log(`[daytrade] 計画日 ${planDate} の設計${slot}は済んでいます。何もしません`); return { skipped: "done" }; }
    if (action === "status" && prevPlan?.status_updated_at) {
      const last = parseIso(prevPlan.status_updated_at);
      // 同じ時間内の状態更新は1回まで。ただし、前の実行が発注できる状態の入力でなかった（古い入力など）ときは、新しい入力でやり直す
      if (Number.isFinite(last) && Math.floor(last / 3600000) === Math.floor(nowMs / 3600000) && prevPlan.plan_date === planDate && prevPlan.inputs_ok !== false) {
        io.log("[daytrade] この時間の状態更新は済んでいます。何もしません"); return { skipped: "done" };
      }
    }
  }

  // 3) 入力
  const inputs = loadInputs({ dataDir, repoRoot, nowMs });
  const riskFeed = args["no-risk-feed"] ? { status: "未取得", reason: "取得しない指定", pairs: {} } : await fetchRiskFeed({ nowMs });

  // 4) 組み立て
  const { plan, logAppend } = action === "design"
    ? buildDesign({ inputs, riskFeed, nowMs, slot, prevPlan, logRows })
    : buildStatus({ inputs, riskFeed, nowMs, prevPlan, logRows });
  if (logBroken) plan.banners.push(`log.csv を読めないため、ログの追記を行っていません（${logBroken}）`);
  const txt = render(plan, inputs.accounts);

  // 5) 書き込み（全部できてから data/ に置く。一時ファイルは data/ の外）。ログを先に置く（途中で止まっても、計画だけが先に公開されて案の記録が抜ける、を避ける）
  const entries = [];
  if (!logBroken && logAppend && logAppend.length) entries.push({ file: path.join("daytrade", "log.csv"), content: L.appendedText(logText, logAppend) });
  entries.push({ file: "daytrade-plan.json", content: JSON.stringify(plan, null, 2) + "\n" }, { file: "daytrade-plan.txt", content: txt });
  if (args["dry-run"]) { io.log(txt); return { plan, logAppend, dry: true }; }
  store.writeAll(dataDir, entries);
  io.log(`[daytrade] ${action}${action === "design" ? `（設計${slot}）` : ""} 計画日 ${plan.plan_date} / 候補 ${plan.candidates.length}件 / 発注${plan.order_ok ? "可" : "不可"} / log追記 ${logBroken ? 0 : logAppend ? logAppend.length : 0}行 / ${jstIso(nowMs)}`);
  return { plan, logAppend };
}

if (require.main === module) {
  main().catch((e) => { console.error(`::error::daytrade-plan: ${e.stack || e.message}`); process.exit(1); });
}
module.exports = { main };
