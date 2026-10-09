"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadInputs, ACCOUNT_LABELS, equityEnvName } = require("../inputs");
const { buildDesign } = require("../plan");
const { render } = require("../render");
const L = require("../log");
const { main } = require("../../daytrade-plan");
const { makeScenario, EQUITY_ENV } = require("./scenario");
const { rm } = require("./helpers");

/**
 * 公開対策: 口座番号と資金（equity）はリポジトリの公開ファイルに置かない。
 *  - 口座はラベル A（デイトレ専用）・B（スイング＋デイトレ）。資金は環境変数 DAYTRADE_EQUITY_A／B（GitHub Actions の Variables）から読む
 *  - ファイル（accounts.json・計画の JSON／テキスト・log.csv）にも、実行ログにも、資金そのものを書かない
 *  - 未設定・不正なら、その口座の上限ロットは『未設定』と出して、発注不可にする
 */
const noFeed = { status: "未取得", reason: "試験", pairs: {} };
const design = (sc, { slot = 2 } = {}) => {
  const inputs = loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs, env: sc.env });
  return { inputs, ...buildDesign({ inputs, riskFeed: noFeed, nowMs: sc.nowMs, slot, prevPlan: null, logRows: [] }) };
};
const cleanup = (...scs) => { for (const sc of scs) rm(path.dirname(sc.dataDir)); };
const writeJson = (sc, rel, obj) => fs.writeFileSync(path.join(sc.dataDir, rel), JSON.stringify(obj));
const everything = (x) => (typeof x === "string" ? x : JSON.stringify(x));

test("資金が未設定の口座は『未設定』と出して発注不可。ほかの口座の上限ロットは出す。資金そのものは出力に出ない", () => {
  const sc = makeScenario({ env: { DAYTRADE_EQUITY_A: "" } });
  try {
    const { plan, inputs } = design(sc);
    assert.equal(plan.order_ok, false);
    assert.equal(plan.inputs_ok, false);
    assert.equal(plan.designs[0].inputs_ok, false); // 設計も『済み』にしない（窓の中の次の実行でやり直す）
    assert.match(plan.banners.join("\n"), /口座設定の問題: 口座 A の資金が未設定です（GitHub Actions の Secrets（または Variables）DAYTRADE_EQUITY_A を設定してください。上限ロットは出せません）/);
    assert.deepEqual(plan.accounts.A, { role: "daytrade", equity_status: "unset", daily_loss_limit_jpy: null });
    assert.deepEqual(plan.accounts.B, { role: "swing_daytrade", equity_status: "ok", daily_loss_limit_jpy: 45000 });
    const eu = plan.candidates.find((c) => c.symbol === "EURUSD");
    assert.equal(eu.schemes.A.lots.A, null);
    assert.equal(eu.schemes.A.commission_jpy.A, null);
    assert.equal(eu.schemes.A.lots.B, 1);
    const txt = render(plan, inputs.accounts);
    assert.match(txt, /発注可否: 発注不可/);
    assert.match(txt, /A（daytrade） 資金 未設定（Secrets／Variables） ／ 本日の損失上限 — ／ B（swing_daytrade） 本日の損失上限 45,000円（1\.5%）/);
    assert.match(txt, /上限ロット A=未設定 \/ B=1\.00（往復手数料 1,013円）/);
    // ログ（log.csv の行）: 未設定の口座の列は空
    const row = L.parseLog(L.appendedText("", plan.candidates.length ? design(sc).logAppend : []))[0];
    assert.equal(row.lot_cap_a_A, "");
    assert.equal(row.lot_cap_b_A, "");
    assert.equal(row.lot_cap_a_B, "1.00");
  } finally { cleanup(sc); }
});

test("両方の口座が未設定（Variables が無い）でも案は作り、上限ロットは『未設定』、発注不可。変数が undefined でも同じ", () => {
  for (const env of [{ DAYTRADE_EQUITY_A: "", DAYTRADE_EQUITY_B: "  " }, { DAYTRADE_EQUITY_A: undefined, DAYTRADE_EQUITY_B: undefined }]) {
    const sc = makeScenario({ env });
    try {
      const { plan, inputs } = design(sc);
      assert.equal(plan.order_ok, false);
      assert.ok(plan.candidates.length > 0);
      assert.equal(plan.accounts.A.equity_status, "unset");
      assert.equal(plan.accounts.B.equity_status, "unset");
      const txt = render(plan, inputs.accounts);
      assert.match(txt, /上限ロット A=未設定 \/ B=未設定/);
      assert.match(plan.banners.join("\n"), /口座 A の資金が未設定です/);
      assert.match(plan.banners.join("\n"), /口座 B の資金が未設定です/);
    } finally { cleanup(sc); }
  }
});

test("値が正の整数でないときも、上限ロットを出さず発注不可にする。不正な値そのものは出力に出ない", () => {
  const bads = ["500,000", "6.1e5", "0", "-5", "abc-secret", "500000.5", "0500000", "＋５００", "１２３４５６", "1_000", "1000000000000000000"];
  for (const v of bads) {
    const sc = makeScenario({ env: { DAYTRADE_EQUITY_A: v } });
    try {
      const { plan, inputs } = design(sc);
      assert.equal(plan.order_ok, false, v);
      assert.equal(plan.accounts.A.equity_status, "invalid", v);
      assert.equal(plan.accounts.A.daily_loss_limit_jpy, null, v);
      assert.match(plan.banners.join("\n"), /口座 A の資金（DAYTRADE_EQUITY_A）が正の整数（円）ではありません。上限ロットは出せません/, v);
      const txt = render(plan, inputs.accounts);
      assert.match(txt, /上限ロット A=未設定（資金の設定が不正）/, v);
      assert.match(txt, /A（daytrade） 資金 未設定（設定が不正） ／ 本日の損失上限 —/, v);
      if (v.length >= 5) for (const out of [txt, everything(plan)]) assert.ok(!out.includes(v), `不正な値がそのまま出力に出ている: ${v}`); // 短い値（0・-5 など）は他の数字と区別できないので除く
    } finally { cleanup(sc); }
  }
});

test("正の整数（前後の空白は無視）は有効。1 円でも有効（上限ロットは 0.00）", () => {
  for (const [v, okLot] of [[" 500000 ", 0.16], ["500000", 0.16], ["1", 0]]) {
    const sc = makeScenario({ env: { DAYTRADE_EQUITY_A: v } });
    try {
      const { plan } = design(sc);
      assert.equal(plan.order_ok, true, v);
      assert.equal(plan.accounts.A.equity_status, "ok");
      assert.equal(plan.candidates.find((c) => c.symbol === "EURUSD").schemes.A.lots.A, okLot, v);
    } finally { cleanup(sc); }
  }
});

test("資金の値は、ファイル（計画の JSON・テキスト・log.csv）にも実行ログにも書かない（設計・状態更新・手動の実行のあと、データ全体を走査）", async () => {
  const A = "123456789", B = "987654321"; // 目印にする架空の資金
  const sc = makeScenario({ env: { DAYTRADE_EQUITY_A: A, DAYTRADE_EQUITY_B: B } });
  try {
    const logs = [];
    const io = { log: (m) => logs.push(String(m)) };
    const base = [`--data-dir=${sc.dataDir}`, "--no-risk-feed"];
    await main([...base, `--now=${sc.nowIso}`, "--run=design", "--slot=2"], sc.env, io);
    await main([...base, "--now=2026-10-08T17:10:00+09:00", "--run=status"], sc.env, io);
    await main([...base, `--now=${sc.nowIso}`, "--resolve"], sc.env, io);
    await main([...base, `--now=${sc.nowIso}`, "--run=design", "--slot=2", "--dry-run"], sc.env, io);
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
    walk(sc.dataDir);
    assert.ok(files.some((f) => f.endsWith("daytrade-plan.json")) && files.some((f) => f.endsWith("daytrade-plan.txt")) && files.some((f) => f.endsWith("log.csv")));
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      assert.ok(!text.includes(A) && !text.includes(B), `${path.basename(f)} に資金がある`);
      assert.ok(!/equity_jpy/.test(text), `${path.basename(f)} に equity_jpy`);
    }
    for (const l of logs) assert.ok(!l.includes(A) && !l.includes(B), "実行ログに資金がある");
    // 上限ロットは資金から計算されている（A=123456789円 → 0.5% で 411 ロット級ではなく、上限の丸めを通る）
    const plan = JSON.parse(fs.readFileSync(path.join(sc.dataDir, "daytrade-plan.json"), "utf8"));
    assert.ok(plan.candidates[0].schemes.A.lots.A > 1);
    assert.deepEqual(Object.keys(plan.accounts.A).sort(), ["daily_loss_limit_jpy", "equity_status", "role"]);
  } finally { cleanup(sc); }
});

test("accounts.json に equity_jpy や口座番号が残っていても読まない。入力の問題として知らせるが、その値は出力に出ない", () => {
  const sc = makeScenario();
  try {
    const OLD_NO = "999111", OLD_EQ = 424242;
    writeJson(sc, "daytrade/accounts.json", {
      accounts: { A: { equity_jpy: OLD_EQ, role: "daytrade" }, B: { role: "swing_daytrade" }, [OLD_NO]: { equity_jpy: 777777, role: "legacy" } },
      commission_per_lot_jpy: 1013, risk_pct: 0.5, daily_loss_pct: 1.5,
    });
    const { plan, inputs } = design(sc);
    // 資金は Variables（環境変数）だけから読む: A の上限ロットはファイルの 424242 ではなく環境変数の 500000 で計算される
    assert.equal(plan.candidates.find((c) => c.symbol === "EURUSD").schemes.A.lots.A, 0.16);
    assert.equal(plan.accounts.A.daily_loss_limit_jpy, 7500);
    assert.match(plan.inputs_problems.join("\n"), /accounts\.json に equity_jpy があります（読みません。公開されるので削除してください/);
    assert.match(plan.banners.join("\n"), /口座のラベルは A・B だけです（それ以外の口座は読みません）/);
    assert.equal(plan.order_ok, false); // ラベル以外の口座が残っている設定は、直すまで発注不可
    assert.deepEqual(Object.keys(plan.accounts), ["A", "B"]);
    const out = render(plan, inputs.accounts) + everything(plan);
    for (const v of [OLD_NO, String(OLD_EQ), "777777"]) assert.ok(!out.includes(v), `古い値が出力に出ている: ${v}`);
  } finally { cleanup(sc); }
});

test("口座のラベルは A・B。log.csv の口座の列は lot_cap_{a,b}_{A,B}・filled_ticket_{A,B}（口座番号を使わない）", () => {
  assert.deepEqual(ACCOUNT_LABELS, ["A", "B"]);
  assert.equal(equityEnvName("A"), "DAYTRADE_EQUITY_A");
  assert.equal(equityEnvName("B"), "DAYTRADE_EQUITY_B");
  const cols = L.COLUMNS;
  assert.deepEqual(cols.filter((c) => /^(lot_cap|filled_ticket)/.test(c)), ["lot_cap_a_A", "lot_cap_b_A", "lot_cap_a_B", "lot_cap_b_B", "filled_ticket_A", "filled_ticket_B"]);
  assert.ok(cols.every((c) => !/\d{4,}/.test(c)));
});

test("loadInputs の env の既定は process.env（本番の CLI は実行環境の環境変数を渡す）", () => {
  const sc = makeScenario();
  const saved = { A: process.env.DAYTRADE_EQUITY_A, B: process.env.DAYTRADE_EQUITY_B };
  try {
    process.env.DAYTRADE_EQUITY_A = "500000"; delete process.env.DAYTRADE_EQUITY_B;
    const inputs = loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs });
    assert.equal(inputs.accounts.A.equity_status, "ok");
    assert.equal(inputs.accounts.B.equity_status, "unset");
    // env を渡せば process.env は見ない
    const other = loadInputs({ dataDir: sc.dataDir, repoRoot: sc.repoRoot, nowMs: sc.nowMs, env: EQUITY_ENV });
    assert.equal(other.accounts.B.equity_status, "ok");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[`DAYTRADE_EQUITY_${k}`]; else process.env[`DAYTRADE_EQUITY_${k}`] = v; }
    cleanup(sc);
  }
});

test("リポジトリのファイルに、口座番号と資金（旧設定の値）が残っていない", () => {
  // 検索する値は連結して組み立てる（この試験自身のソースに値が現れないように）
  const needles = [["7016", "20"], ["7024", "49"], ["610", "273"], ["4682", "566"], ["610,", "273"], ["4,682,", "566"]].map((p) => p.join(""));
  const ROOT = path.join(__dirname, "..", "..", "..");
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", ".claude", "node_modules"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|json|md|yml|yaml|csv|txt|html|sh)$/.test(e.name)) continue;
      if (fs.statSync(p).size > 8 * 1024 * 1024) continue;
      const text = fs.readFileSync(p, "utf8");
      for (const n of needles) if (new RegExp(`(?<![0-9.])${n}(?![0-9])`).test(text)) hits.push(`${path.relative(ROOT, p)}: ${n}`);
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, []);
});
