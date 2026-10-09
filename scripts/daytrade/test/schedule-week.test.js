"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../schedule");
const { planDateOf } = require("../windows");
const J = require("../jst");

/**
 * 1週間分の intraday 完了（名目 :05,:20,:35,:50。UTCで月曜0:00〜日曜24:00）を順に流して、実行の種類の自動判定と
 * 『毎時1回まで』『設計は済んだら繰り返さない』を組み合わせた動きが、仕様の表（設計①②③・状態更新・土日は何もしない）になることを確かめる。
 * main の判定（daytrade-plan.js）と同じ手順: resolveAuto → 状態更新は同じ時間内なら何もしない → 設計は plan.designs に記録。
 */
function simulate(weekStartUtcMs, { missing = () => false } = {}) {
  let plan = null;
  const events = [];
  for (let t = weekStartUtcMs; t < weekStartUtcMs + 7 * J.DAY; t += 15 * J.MIN) {
    const nowMs = t + 5 * J.MIN;
    if (missing(nowMs)) continue; // その回の intraday が来なかった
    const r = S.resolveAuto({ nowMs, prevPlan: plan, logRows: [] });
    if (r.action === "skip") continue;
    const planDate = planDateOf(nowMs);
    if (r.action === "status") {
      const last = plan?.plan_date === planDate && plan.status_updated_at ? plan.status_updated_at : null;
      if (last !== null && Math.floor(last / 3600000) === Math.floor(nowMs / 3600000)) continue; // この時間の状態更新は済み
      plan = { ...(plan?.plan_date === planDate ? plan : { plan_date: planDate, designs: [] }), status_updated_at: nowMs };
      events.push({ nowMs, planDate, action: "status" });
    } else {
      const prevDesigns = plan?.plan_date === planDate ? plan.designs : [];
      plan = { plan_date: planDate, designs: [...prevDesigns, { slot: r.slot }], status_updated_at: nowMs };
      events.push({ nowMs, planDate, action: "design", slot: r.slot });
    }
  }
  return events;
}

for (const [season, week, firstHm] of [["夏", Date.parse("2026-07-13T00:00:00+09:00"), ["06", "21"]], ["冬", Date.parse("2026-12-14T00:00:00+09:00"), ["07", "22"]]]) {
  test(`schedule: ${season}時間の1週間 — 月〜金に設計①②③が1回ずつ（窓の最初の実行）、状態更新は毎時1回まで、土日は何もしない`, () => {
    const ev = simulate(week);
    const designs = ev.filter((e) => e.action === "design");
    for (const day of ["13", "14", "15", "16", "17"].map((d) => (season === "夏" ? `2026-07-${d}` : `2026-12-${String(Number(d) + 1)}`))) {
      const ds = designs.filter((e) => e.planDate === day);
      assert.deepEqual(ds.map((e) => e.slot), [1, 2, 3], day);
      // 窓の最初の実行 = 名目 :05 の intraday 完了
      assert.equal(J.jstHm(ds[0].nowMs), `${firstHm[0]}:05`, `${day} 設計①`);
      assert.equal(J.jstHm(ds[1].nowMs), "15:05", `${day} 設計②`);
      assert.equal(J.jstHm(ds[2].nowMs), `${firstHm[1]}:05`, `${day} 設計③`);
    }
    // 土日の計画日には何も実行しない
    assert.equal(ev.filter((e) => [6, 0].includes(J.jstDow(J.jstAt(e.planDate, "12:00")))).length, 0);
    // 状態更新: 同じ時間（JST）に2回以上出ない。時間帯は 07:00〜翌02:59
    const st = ev.filter((e) => e.action === "status");
    const keys = st.map((e) => J.jstIso(e.nowMs).slice(0, 13));
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(st.every((e) => { const h = J.jstHour(e.nowMs); return h >= 7 || h <= 2; }));
    // 設計の時間帯の状態更新は設計が兼ねる（同じ時間に設計と状態更新が並ばない）
    const designHours = new Set(designs.map((e) => J.jstIso(e.nowMs).slice(0, 13)));
    assert.ok(st.every((e) => !designHours.has(J.jstIso(e.nowMs).slice(0, 13))));
  });

  test(`schedule: ${season}時間 — 設計①の窓の最初の intraday が来なくても、窓の中の次の実行が設計になる。窓の外まで来なければ設計は抜ける（設計②で型Aを作り直す）`, () => {
    const d = season === "夏" ? "2026-07-15" : "2026-12-16";
    const from = J.jstAt(d, `${firstHm[0]}:00`), to = from + 3 * J.HR - 20 * J.MIN;
    const ev = simulate(week, { missing: (ms) => ms >= from && ms < to }); // 窓の最初の約2時間40分は来ない
    const ds = ev.filter((e) => e.action === "design" && e.planDate === d);
    assert.equal(ds[0].slot, 1);
    assert.equal(J.jstHm(ds[0].nowMs), `${String(Number(firstHm[0]) + 2).padStart(2, "0")}:50`);
    const all = simulate(week, { missing: (ms) => ms >= from && ms < from + 3 * J.HR });
    assert.deepEqual(all.filter((e) => e.action === "design" && e.planDate === d).map((e) => e.slot), [2, 3]);
  });
}
