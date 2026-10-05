"use strict";
const { addDays } = require("./ny-time");
const { aggregateHourlyToNyDaily } = require("./daily-bars");
const { fetchRange } = require("./twelvedata");

/**
 * 1銘柄の過去分（start 以降〜cutoffDate）の日足を、1時間足から作る。
 *   取得の開始は start の3日前の0時（UTC）にする。取得範囲の左端の日は足が途中からしか無く捨てるので、
 *   その分を start より前に逃がして、start の日が完全な日足で残るようにする。
 */
async function fetchDailyHistory(client, sym, { start, cutoffDate, pageSize, log = () => {} }) {
  const startDt = `${addDays(start, -3)} 00:00:00`;
  const bars = await fetchRange(client, sym.td, startDt, { pageSize, log });
  const agg = aggregateHourlyToNyDaily(bars, { dropLeftEdge: true, cutoffDate });
  const rows = agg.rows.filter((r) => r.date >= start);
  return { rows, hourBars: bars.length, leftEdgeDropped: agg.leftEdgeDropped, weekendBars: agg.weekendBars };
}

// 取得が途中で切れていないかの確認（5000本の上限で先頭に届かなかった場合など）
function checkHistory(code, rows, { start, minRows }) {
  if (rows.length < minRows) throw new Error(`${code}: 日足が${rows.length}日分しか作れませんでした（${minRows}日以上を想定）`);
  if (rows[0].date > addDays(start, 7)) throw new Error(`${code}: 最古の日足が ${rows[0].date} で、取得開始日 ${start} に届いていません`);
}

module.exports = { fetchDailyHistory, checkHistory };
