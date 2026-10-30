"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ev = require("../lib/events");
const H = require("./helpers");

const rows = () => ev.parseEventsCsv(H.eventsText());
const at = (r, kind, date) => ev.toJstIso(r.find((x) => x.kind === kind && x.date === date).atMs);
const level = (now) => ev.eventLevel(rows(), H.jst(now));

test("予定表：8種類・144行。中央銀行は各年8回、米雇用統計・米CPIは各年12回（2026・2027年）", () => {
  const r = rows();
  assert.equal(r.length, 144);
  for (const kind of ["FOMC", "ECB", "BOJ", "BOE", "RBA", "BOC", "NFP", "CPI"]) {
    for (const y of ["2026", "2027"]) {
      const n = r.filter((x) => x.kind === kind && x.date.startsWith(y)).length;
      assert.equal(n, kind === "NFP" || kind === "CPI" ? 12 : 8, `${kind} ${y}`);
    }
  }
});

test("予定表：公式日程で確認した日付の例（2026年1月の米統計は予算失効による変更後の日付）", () => {
  const has = (kind, date) => rows().some((x) => x.kind === kind && x.date === date);
  assert.ok(has("NFP", "2026-02-11") && !has("NFP", "2026-02-06"));
  assert.ok(has("CPI", "2026-02-13") && !has("CPI", "2026-02-11"));
  for (const [k, d] of [["FOMC", "2026-10-28"], ["ECB", "2026-10-29"], ["BOJ", "2026-10-30"], ["BOC", "2026-10-28"],
    ["RBA", "2026-11-03"], ["BOE", "2026-11-05"], ["NFP", "2026-11-06"], ["CPI", "2026-11-10"]]) assert.ok(has(k, d), `${k} ${d}`);
});

test("日本時間への変換：夏時間・冬時間（米・欧・英・豪）と、時刻の記載が無い予定（現地の正午）", () => {
  const r = rows();
  assert.equal(at(r, "FOMC", "2026-10-28"), "2026-10-29T03:00+09:00"); // 米東部 夏時間
  assert.equal(at(r, "FOMC", "2026-12-09"), "2026-12-10T04:00+09:00"); // 米東部 冬時間
  assert.equal(at(r, "ECB", "2026-07-23"), "2026-07-23T21:15+09:00");  // フランクフルト 夏時間
  assert.equal(at(r, "ECB", "2026-10-29"), "2026-10-29T22:15+09:00");  // 冬時間（10/25 から）
  assert.equal(at(r, "RBA", "2026-06-16"), "2026-06-16T13:30+09:00");  // シドニー 冬（AEST）
  assert.equal(at(r, "RBA", "2026-11-03"), "2026-11-03T12:30+09:00");  // シドニー 夏（AEDT）
  assert.equal(at(r, "BOE", "2026-06-18"), "2026-06-18T20:00+09:00");  // 時刻の記載なし → ロンドンの正午（夏時間）
  assert.equal(at(r, "BOE", "2026-11-05"), "2026-11-05T21:00+09:00");
  assert.equal(at(r, "BOJ", "2026-10-30"), "2026-10-30T12:00+09:00");  // 時刻の記載なし → 正午
  assert.equal(at(r, "BOC", "2026-10-28"), "2026-10-28T22:45+09:00");
  assert.equal(at(r, "NFP", "2026-10-02"), "2026-10-02T21:30+09:00");
  assert.equal(at(r, "NFP", "2026-11-06"), "2026-11-06T22:30+09:00");  // 米国は 11/1 から冬時間
});

test("イベント警戒：7日以内に2件以上で High、それ未満で Normal（2026-10-30 ユーザー決定）", () => {
  const cases = [
    ["2026-10-26 10:00", "High", ["BOC", "FOMC", "ECB", "BOJ"]],
    ["2026-10-30 10:00", "High", ["BOJ", "RBA", "BOE"]],
    ["2026-11-02 10:00", "High", ["RBA", "BOE", "NFP"]],
    ["2026-11-06 10:00", "High", ["NFP", "CPI"]],                 // ちょうど2件
    ["2026-11-09 10:00", "Normal", ["CPI"]],
    ["2026-11-16 10:00", "Normal", []],
  ];
  for (const [now, lv, kinds] of cases) {
    const r = level(now);
    assert.equal(r.level, lv, now);
    assert.deepEqual(r.items.map((x) => x.kind), kinds, now);
    assert.equal(r.count, kinds.length);
    assert.equal(r.high_count, 2);
  }
});

test("窓の端：基準時刻（その日の9:00）ちょうどの予定は含み、7日後の9:00ちょうどは含まない。9:00より前に計算しても基準はその日の9:00", () => {
  const r = level("2026-10-29 05:00");   // FOMC は 10/29 03:00 で、基準（10/29 9:00）より前 → 含まない
  assert.equal(r.base_jst, "2026-10-29T09:00+09:00");
  assert.equal(r.window_end_jst, "2026-11-05T09:00+09:00");
  assert.ok(!r.items.some((x) => x.kind === "FOMC"));
  const s = level("2026-12-03 23:59");   // 12/10 04:00 の FOMC は窓（〜12/10 9:00）の中
  assert.ok(s.items.some((x) => x.kind === "FOMC"));
  // 時刻ちょうどの境界（合成の予定表）
  const csv = (lines) => ["date,time,tz,kind", ...lines].join("\n");
  const base = ["2026-11-02,09:00,Asia/Tokyo,BOJ", "2026-11-09,09:00,Asia/Tokyo,BOJ"];
  const fill = ["FOMC", "ECB", "BOE", "RBA", "BOC", "NFP", "CPI"].map((k) => {
    const tz = { FOMC: "America/New_York", ECB: "Europe/Berlin", BOE: "Europe/London", RBA: "Australia/Sydney", BOC: "America/Toronto", NFP: "America/New_York", CPI: "America/New_York" }[k];
    return `2027-12-31,12:00,${tz},${k}`;
  });
  const t = ev.eventLevel(ev.parseEventsCsv(csv([...base, ...fill])), H.jst("2026-11-02 08:00"));
  assert.deepEqual(t.items.map((x) => x.at_jst), ["2026-11-02T09:00+09:00"]);
});

test("予定表の終わり：窓の終わりまで届かなければ unknown。ただし既に2件以上なら High は確定", () => {
  assert.equal(rows().length > 0, true);
  const cov = ev.toJstIso(ev.coverageUntilMs(rows()));
  assert.equal(cov, "2027-12-03T22:30+09:00");   // 種類ごとの最後のうち最も早い＝2027年11月分の雇用統計
  const u = level("2027-11-29 10:00");           // 窓 〜12/6 9:00。雇用統計の1件だけ・表が足りない
  assert.equal(u.level, "unknown");
  assert.match(u.reason, /risk\/events\.csv の更新が必要/);
  const h = level("2027-12-03 10:00");           // 雇用統計・カナダ中銀・FOMC の3件 → 表が足りなくても High
  assert.equal(h.level, "High");
  assert.equal(h.reason, null);
});

test("予定表の不備は、行番号つきで失敗にする", () => {
  const head = "date,time,tz,kind\n";
  const bad = [
    ["2026-11-05,,Europe/London,BOE_X", /数える予定の種類にありません/],
    ["2026-11-05,,Europe/Paris,BOE", /時間帯/],
    ["2026-02-30,,Europe/London,BOE", /日付が不正/],
    ["2026-11-05,12,Europe/London,BOE", /HH:MM/],
    ["2026-11-05,,Europe/London", /列の数/],
  ];
  for (const [line, re] of bad) assert.throws(() => ev.parseEventsCsv(head + line), re, line);
  assert.throws(() => ev.parseEventsCsv(head + "2026-11-05,,Europe/London,BOE\n2026-11-05,,Europe/London,BOE"), /重複/);
  assert.throws(() => ev.parseEventsCsv("date,kind\n"), /見出し/);
  assert.throws(() => ev.coverageUntilMs(ev.parseEventsCsv(head + "2026-11-05,,Europe/London,BOE")), /FOMC の行がありません/);
});
