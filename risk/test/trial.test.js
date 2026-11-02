"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const T = require("../lib/trial");
const { run, trialNeedsRefresh } = require("../run-daily");
const H = require("./helpers");

const TEN = ["2 Yr", "5 Yr", "10 Yr", "30 Yr"];

test("米財務省のCSV（実データの切り出し）：4つの年限を bp の整数で、古い順に読む", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "..", "rates", "test", "fixtures", "ust-2026-tail.csv"), "utf8");
  const rows = T.parseParYieldCsv(text, TEN);
  assert.equal(rows[0].date, "2026-07-01");
  const last = rows[rows.length - 1];
  assert.equal(last.date, "2026-10-06");
  assert.deepEqual(last.bp, { "2 Yr": 479, "5 Yr": 503, "10 Yr": 527, "30 Yr": 564 });
  assert.throws(() => T.parseParYieldCsv('Date,"2 Yr"\n10/06/2026,4.79\n', TEN), /列名/);
  assert.deepEqual(T.parseParYieldCsv("", TEN, { allowEmpty: true }), []);
});

test("実際の値動きの大きさ：年限ごとの1日の変化（bp）の二乗平均平方根を、4つの年限で平均する。素朴な計算と一致", () => {
  const rows = H.syntheticYields("2025-01-01", "2025-06-30");
  const lb = 20;
  const s = T.realizedVolSeries(rows, TEN, lb);
  assert.equal(s.length, rows.length - lb);
  for (const k of [0, 7, s.length - 1]) {
    const i = k + lb;
    let sum = 0;
    for (const t of TEN) {
      const d = [];
      for (let j = i - lb + 1; j <= i; j++) d.push(rows[j].bp[t] - rows[j - 1].bp[t]);
      sum += Math.sqrt(d.reduce((a, x) => a + x * x, 0) / lb);
    }
    assert.ok(Math.abs(s[k].value - sum / 4) < 1e-9, k);
    assert.equal(s[k].date, rows[i].date);
  }
});

test("実際の値動きの大きさ：1つの年限でも値が無い日は、その日ごと使わない（前後の日をつないで数える）", () => {
  const rows = H.syntheticYields("2025-01-01", "2025-03-31");
  const holed = rows.map((r, i) => (i === 30 ? { date: r.date, bp: { ...r.bp, "30 Yr": null } } : r));
  const a = T.realizedVolSeries(holed, TEN, 20);
  const b = T.realizedVolSeries(rows.filter((_, i) => i !== 30), TEN, 20);
  assert.deepEqual(a, b);
});

test("順位：最新と直近の履歴。値を載せるかを選べる（NFCI は値を載せない）", () => {
  const series = Array.from({ length: 300 }, (_, i) => ({ date: `d${String(i).padStart(3, "0")}`, value: (i * 37) % 101 }));
  const a = T.rankSnapshot(series, { window: 252, thresholdPct: 80, historyN: 5, keepValue: true });
  assert.equal(a.window_start, "d048");
  assert.equal(a.history.length, 5);
  assert.ok("value" in a && "value" in a.history[0]);
  const b = T.rankSnapshot(series, { window: 52, thresholdPct: 70, historyN: 3, keepValue: false });
  assert.ok(!("value" in b) && !("value" in b.history[0]));
  assert.match(T.rankSnapshot(series.slice(0, 10), { window: 52, thresholdPct: 70, historyN: 3 }).error, /足りません/);
});

test("ZIP：無圧縮・deflate の両方を読む。ZIP でなければ失敗", () => {
  const zip = H.makeZip([{ name: "a.txt", data: Buffer.from("hello"), store: true }, { name: "b.xml", data: Buffer.from("<x>".repeat(100)) }]);
  const files = T.readZip(zip);
  assert.deepEqual(files.map((f) => f.name), ["a.txt", "b.xml"]);
  assert.equal(files[0].data.toString(), "hello");
  assert.equal(files[1].data.toString(), "<x>".repeat(100));
  assert.throws(() => T.readZip(Buffer.from("not a zip at all, definitely not")), /ZIP/);
});

test("FRB の CP：2つの系列を名前で探し、n.a.（-9999）の日を除いて、金利差を bp で出す", () => {
  const xml = H.syntheticCpXml("2025-01-01", "2025-01-10", { naDates: ["2025-01-03"] });
  const found = T.parseCpXml(xml, ["RIFSPPNA2P2D30_N.B", "RIFSPPNAAD30_N.B"]);
  assert.ok(!found.get("RIFSPPNA2P2D30_N.B").has("2025-01-03"));
  const s = T.cpSpreadSeries(found, "RIFSPPNA2P2D30_N.B", "RIFSPPNAAD30_N.B");
  assert.ok(!s.some((x) => x.date === "2025-01-03"));
  const d = "2025-01-02";
  const lo = found.get("RIFSPPNA2P2D30_N.B").get(d), hi = found.get("RIFSPPNAAD30_N.B").get(d);
  assert.equal(s.find((x) => x.date === d).value, (lo - hi) / 10);
  // 名前の記号の違い（FRED の書き方）でも見つかる
  assert.ok(T.parseCpXml(xml, ["RIFSPPNA2P2D30NB", "RIFSPPNAAD30NB"]).size === 2);
  assert.throws(() => T.parseCpXml(xml, ["NOPE"]), /見つかりません.*見つかった系列の数 3/);
  const spread = T.cpSpreadSeries(new Map([["L", new Map([["2025-01-02", 4210]])], ["H", new Map([["2025-01-02", 4050]])]]), "L", "H");
  assert.deepEqual(spread, [{ date: "2025-01-02", value: 16 }]);
});

test("NFCI：日付（M/D/YYYY・YYYY-MM-DD）と Credit の列を読む。列が無ければ失敗", () => {
  const rows = T.parseNfciCsv(H.syntheticNfciCsv("2025-01-01", "2025-02-28"), "Credit");
  assert.equal(rows[0].date, "2025-01-03");
  assert.equal(rows[0].value, -0.4);
  assert.deepEqual(T.parseNfciCsv("Date,Credit\n2025-01-03,0.5\n2025-01-10,\n", "Credit"), [{ date: "2025-01-03", value: 0.5 }]);
  assert.throws(() => T.parseNfciCsv("Date,Risk\n2025-01-03,0.5\n", "Credit"), /列 Credit がありません/);
});

// ---------- run-daily との結合 ----------
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "risk-trial-"));
const readRisk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "risk.json"), "utf8"));
function server({ to = "2026-10-29", fail = {} } = {}) {
  const calls = [];
  const yields = H.syntheticYields("2023-06-01", to);
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [frag, st] of Object.entries(fail)) if (url.includes(frag)) return new Response("x", { status: st });
    if (url.includes("daily-treasury-rates.csv/")) return new Response(H.toTreasuryCsv(yields, /csv\/(\d{4})\//.exec(url)[1]), { status: 200 });
    if (url.includes("FRB_CP_xml.zip")) return new Response(H.makeZip([{ name: "FRB_CP.xml", data: Buffer.from(H.syntheticCpXml("2024-06-03", to)) }]), { status: 200 });
    if (url.includes("nfci-data-series-csv.csv")) return new Response(H.syntheticNfciCsv("2024-06-07", to), { status: 200 });
    if (url.includes("cdn-api.cboe.com")) return new Response(H.toCboeCsv(H.syntheticRows("2024-06-03", to)), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls, n: (frag) => calls.filter((u) => u.includes(frag)).length };
}
const go = (dir, srv, now, argv = [], logs = []) =>
  run({ argv, nowMs: H.jst(now), fetchImpl: srv.fetchImpl, sleep: async () => {}, dataDir: dir, log: (m) => logs.push(m), env: {} });

test("試し運転の3指標を risk.json の trial に出す。NFCI は値を載せず順位だけ", async () => {
  const dir = tmp(), srv = server();
  assert.equal(await go(dir, srv, "2026-10-30 10:00"), 0);
  const t = readRisk(dir).trial;
  assert.match(t.note, /試し運転/);
  assert.equal(t.rates_vol.date, "2026-10-29");
  assert.equal(t.rates_vol.threshold_pct, 80);
  assert.equal(t.rates_vol.window, 252);
  assert.equal(t.rates_vol.history.length, 60);
  assert.equal(typeof t.rates_vol.value, "number");
  assert.equal(t.cp_spread.date, "2026-10-29");
  assert.equal(t.cp_spread.threshold_pct, 70);
  assert.equal(t.nfci_credit.date, "2026-10-23"); // 金曜ごと
  assert.equal(t.nfci_credit.window, 52);
  assert.ok(!("value" in t.nfci_credit) && t.nfci_credit.history.every((h) => !("value" in h)));
  assert.deepEqual(t.warnings, []);
  // 素朴な計算と一致（米国債の値動き）
  const rows = H.syntheticYields("2023-06-01", "2026-10-29");
  const s = T.realizedVolSeries(rows, TEN, 20);
  const vals = s.map((x) => x.value), i = vals.length - 1;
  assert.equal(t.rates_vol.rank_pct, H.naiveRank(vals, i, 252));
});

test("試し運転の取得に失敗しても、実行は赤くしない（errors にせず、trial.warnings に記録）", async () => {
  const dir = tmp(), srv = server({ fail: { "nfci-data-series-csv.csv": 404, "FRB_CP_xml.zip": 500 } });
  const logs = [];
  assert.equal(await go(dir, srv, "2026-10-30 10:00", [], logs), 0);
  const r = readRisk(dir);
  assert.equal(r.generation.status, "ok");
  assert.match(r.trial.nfci_credit.error, /HTTP 404/);
  assert.match(r.trial.cp_spread.error, /HTTP 500/);
  assert.equal(r.trial.warnings.length, 2);
  assert.equal(r.trial.rates_vol.date, "2026-10-29");
  const out = [];
  assert.equal(await go(dir, server(), "2026-10-30 10:05", ["--check-fresh"], out), 0);
  assert.match(out.join("\n"), /TRIAL（試し運転・判定には使わない）: 米国債の値動き 2026-10-29 順位[\d.]+%／CP金利差 取得失敗／NFCIの信用 取得失敗/);
});

test("取り直しの条件：その日（日本時間）に未取得なら取る。同じ日は60分たち、米国債の値の公表待ち・失敗があるときだけ", () => {
  const base = (fetched, rvDate, extra = {}) => ({
    fetched_at: fetched, rates_vol: { date: rvDate, history: [{ date: rvDate }] },
    cp_spread: { date: rvDate }, nfci_credit: { date: "2026-10-23" }, ...extra,
  });
  const now = H.jst("2026-10-30 10:00");
  assert.equal(trialNeedsRefresh(null, now), true);
  assert.equal(trialNeedsRefresh(base("2026-10-29T23:00:00+09:00", "2026-10-29"), now), true);   // 前の日
  assert.equal(trialNeedsRefresh(base("2026-10-30T09:30:00+09:00", "2026-10-28"), now), false);  // 60分たっていない
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-28"), now), true);   // 10/29 の値が公表済みのはず
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-29"), now), false);  // 最新
  assert.equal(trialNeedsRefresh(base("2026-10-30T08:30:00+09:00", "2026-10-29", { cp_spread: { error: "x" } }), now), true);
});

test("--if-stale：VIX が最新でも、その日の試し運転がまだなら取り直す（Cboe へは接続しない）", async () => {
  const dir = tmp();
  await go(dir, server({ to: "2026-10-30" }), "2026-10-31 10:00");
  const srv = server({ to: "2026-10-30" });
  assert.equal(await go(dir, srv, "2026-11-01 10:00", ["--if-stale"]), 0);
  assert.equal(srv.n("cdn-api.cboe.com"), 0);
  assert.ok(srv.n("daily-treasury-rates.csv") >= 1 && srv.n("FRB_CP_xml.zip") === 1 && srv.n("nfci") === 1);
  assert.equal(readRisk(dir).trial.fetched_at, "2026-11-01T10:00:00+09:00");
  // 同じ日の30分後は、どこへも接続しない
  const srv2 = server({ to: "2026-10-30" });
  assert.equal(await go(dir, srv2, "2026-11-01 10:30", ["--if-stale"]), 0);
  assert.equal(srv2.calls.length, 0);
});

test("最新の値が古ければ警告する（日次は7日、週1回は14日より古いとき）。止めはしない", async () => {
  const dir = tmp();
  // NFCI だけ、4月で止まったファイルを返す
  const srv = server();
  const base = srv.fetchImpl;
  srv.fetchImpl = async (url) => (url.includes("nfci") ? new Response(H.syntheticNfciCsv("2024-06-07", "2026-04-24"), { status: 200 }) : base(url));
  assert.equal(await go(dir, srv, "2026-10-30 10:00"), 0);
  const t = readRisk(dir).trial;
  assert.equal(t.nfci_credit.date, "2026-04-24");
  assert.equal(t.nfci_credit.stale, true);
  assert.match(t.warnings.join("\n"), /NFCIの信用の部分：最新の値が 2026-04-24 で、14日より古くなっています/);
  assert.ok(!t.rates_vol.stale && !t.cp_spread.stale);
  assert.equal(readRisk(dir).generation.status, "ok");
});
