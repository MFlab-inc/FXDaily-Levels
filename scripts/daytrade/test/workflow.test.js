"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const S = require("../schedule");
const J = require("../jst");
const { planDateOf } = require("../windows");

const ROOT = path.join(__dirname, "..", "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const PLAN = read(".github/workflows/daytrade.yml");
const BACKTEST = read(".github/workflows/daytrade-backtest.yml");

const cronsOf = (yml) => [...yml.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)].map((m) => m[1]);

// 最小の cron 展開（GitHub の書式: 数値・リスト・範囲・*）
function expand(field, lo, hi) {
  const out = new Set();
  for (const part of field.split(",")) {
    if (part === "*") { for (let i = lo; i <= hi; i++) out.add(i); continue; }
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    assert.ok(m, `解釈できない cron の欄: ${field}`);
    for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) out.add(i);
  }
  return out;
}
// 指定の週（UTC の日曜 0:00 から7日間）に cron が起動する時刻(ms)の一覧
function fires(cron, weekStartUtcMs) {
  const [mi, ho, dom, mo, dow] = cron.split(" ");
  assert.equal(dom, "*"); assert.equal(mo, "*");
  const M = expand(mi, 0, 59), Hh = expand(ho, 0, 23), D = expand(dow, 0, 6);
  const out = [];
  for (let d = 0; d < 7; d++) {
    if (!D.has(d)) continue;
    for (const h of Hh) for (const m of M) out.push(weekStartUtcMs + d * J.DAY + h * J.HR + m * J.MIN);
  }
  return out;
}

const SUMMER_WEEK = Date.parse("2026-07-12T00:00:00Z"); // 日曜
const WINTER_WEEK = Date.parse("2026-12-13T00:00:00Z"); // 日曜

test("workflow: daytrade.yml の cron は schedule.js の CRON 表と一致する", () => {
  assert.deepEqual([...cronsOf(PLAN)].sort(), Object.keys(S.CRON).sort());
});

for (const [season, week] of [["夏", SUMMER_WEEK], ["冬", WINTER_WEEK]]) {
  test(`workflow: ${season}時間の1週間 — 設計①②③は月〜金に1回ずつ、名目時刻どおり`, () => {
    const designs = [];
    for (const cron of cronsOf(PLAN)) for (const t of fires(cron, week)) {
      const r = S.resolveAction(cron, t);
      if (r.action === "design") designs.push({ slot: r.slot, t });
    }
    for (const slot of [1, 2, 3]) {
      const d = designs.filter((x) => x.slot === slot);
      assert.equal(d.length, 5, `設計${slot}`);
      const days = d.map((x) => J.jstDow(x.t)).sort();
      assert.deepEqual(days, [1, 2, 3, 4, 5], `設計${slot}の曜日（JST 月〜金）`);
      for (const x of d) assert.equal(x.t, S.slotNominalMs(slot, planDateOf(x.t), x.t), `設計${slot}の時刻 ${J.jstIso(x.t)}`);
    }
    // 夏冬の時刻の確認
    const hm = (slot) => J.jstHm(designs.find((x) => x.slot === slot).t);
    assert.deepEqual([hm(1), hm(2), hm(3)], season === "夏" ? ["06:30", "15:30", "21:00"] : ["07:30", "15:30", "22:00"]);
  });

  test(`workflow: ${season}時間の1週間 — 状態更新は 月〜金 07:00〜23:00 と 火〜土 00:00〜02:00 の毎時00分（設計の時刻は設計が兼ねる）`, () => {
    const hourly = new Map(); // JST の時刻 → 起動の種類
    for (const cron of cronsOf(PLAN)) for (const t of fires(cron, week)) {
      const r = S.resolveAction(cron, t);
      if (r.action === "skip") continue;
      if (new Date(t).getUTCMinutes() !== 0) continue;
      const k = J.jstIso(t).slice(0, 13);
      assert.ok(!hourly.has(k), `同じ時刻に2本: ${k}`);
      hourly.set(k, r.action);
    }
    const want = new Set();
    for (let t = Date.parse(`${season === "夏" ? "2026-07-13" : "2026-12-14"}T00:00:00+09:00`); t < Date.parse(`${season === "夏" ? "2026-07-19" : "2026-12-20"}T00:00:00+09:00`); t += J.HR) {
      const dow = J.jstDow(t), h = J.jstHour(t);
      const live = (dow >= 1 && dow <= 5 && h >= 7) || (dow >= 2 && dow <= 6 && h <= 2);
      if (live) want.add(J.jstIso(t).slice(0, 13));
    }
    // 設計③の時刻は設計、その他は状態更新。設計②は 15:30 なので毎時00分には影響しない
    for (const k of want) assert.ok(hourly.has(k), `起動が無い: ${k}`);
    for (const k of hourly.keys()) assert.ok(want.has(k), `余計な起動: ${k}`);
    const designHours = [...hourly].filter(([, a]) => a === "design").map(([k]) => k.slice(11));
    assert.equal(designHours.length, 5);
    assert.ok(designHours.every((h) => h === (season === "夏" ? "21" : "22")));
  });
}

test("workflow: 書き込むのは計画の3ファイルだけ（git add data/ や -A をしない）。secrets を使わない", () => {
  const adds = [...PLAN.matchAll(/git add ([^\n]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(adds, ["data/daytrade-plan.txt data/daytrade-plan.json data/daytrade/log.csv"]);
  assert.ok(!/secrets\./.test(PLAN), "daytrade.yml は secrets を使わない");
  assert.match(PLAN, /group: daytrade-plan/);
  assert.match(PLAN, /cancel-in-progress: false/);
  assert.match(PLAN, /contents: write/);
  // 既存のワークフローとは別ファイル。daily.yml を起動・参照しない
  assert.ok(!/workflow_run/.test(PLAN));
});

test("workflow: if 条件で secrets を直接参照しない（job の env 経由）", () => {
  for (const [name, yml] of [["daytrade.yml", PLAN], ["daytrade-backtest.yml", BACKTEST]]) {
    for (const m of yml.matchAll(/^\s*(?:-\s*)?if:\s*(.+)$/gm)) assert.ok(!/secrets\./.test(m[1]), `${name}: if に secrets: ${m[1]}`);
  }
});

test("workflow: バックテストは手動実行（workflow_dispatch）だけ。書き込み先は履歴CSVと結果だけ", () => {
  const on = BACKTEST.slice(BACKTEST.indexOf("\non:"), BACKTEST.indexOf("\npermissions:"));
  assert.match(on, /workflow_dispatch:/);
  for (const t of ["schedule:", "push:", "pull_request", "workflow_run"]) assert.ok(!on.includes(t), t);
  const adds = [...BACKTEST.matchAll(/git add ([^\n]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(adds, ["data/history data/daytrade/backtest-*.md data/daytrade/backtest-*.csv"]);
  assert.match(BACKTEST, /actions: read/);
  assert.match(BACKTEST, /TWELVE_DATA_API_KEY: \$\{\{ secrets\.TWELVE_DATA_API_KEY \}\}/);
});

test("workflow: 既存のワークフロー・スクリプトを変更していない（このブランチの差分に含まれない）", () => {
  // 差分は git の管理下でしか確認できないので、ここでは『読み取り専用の既存ファイルが存在し、daytrade.yml が参照しない』ことだけ確かめる
  for (const f of ["fetch.js", "build-feed.js", "daytrade.js", ".github/workflows/daily.yml", "config/daytrade-rules.json"]) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  assert.ok(!/daily\.yml|fetch\.js|build-feed\.js/.test(PLAN.replace(/^#.*$/gm, "")));
});
