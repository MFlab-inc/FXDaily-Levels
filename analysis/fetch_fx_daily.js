"use strict";
/**
 * 一度きりの集計（analysis/rates_vol_threshold.py）のために、8銘柄の日足を Twelve Data から取る（最大5000本＝約19年）。
 *   ・本番の daily / intraday と Twelve Data の呼び出しを重ねない（mtf/lib/guard.js をそのまま使う）
 *   ・呼び出しは8回だけ。10秒おき
 *   ・APIキーはどこにも出さない
 * 使い方：node analysis/fetch_fx_daily.js <出力の JSON>
 * 出力：{ "USDJPY": [{date, open, high, low, close}, ...古い順], ... }（集計にだけ使い、コミットしない）
 */
const fs = require("fs");
const { createGuard } = require("../mtf/lib/guard");

const SYMS = {
  USDJPY: "USD/JPY", EURUSD: "EUR/USD", GBPUSD: "GBP/USD", AUDUSD: "AUD/USD",
  EURJPY: "EUR/JPY", EURGBP: "EUR/GBP", USDCAD: "USD/CAD", XAUUSD: "XAU/USD",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const env = process.env;
  const apiKey = env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error("TWELVE_DATA_API_KEY がありません");
  const scrub = (s) => String(s).split(apiKey).join("***").replace(/apikey=[^&\s"']+/gi, "apikey=***");
  let guard = null;
  if (env.GITHUB_TOKEN && env.GITHUB_REPOSITORY) {
    guard = createGuard({ repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, selfRunId: env.GITHUB_RUN_ID,
      log: console.log, watchNames: ["Daily FX Data", "Intraday Snapshot", "MTF Backfill", "Daytrade Backtest"] });
    await guard.waitStartWindow();
  }
  const out = {};
  for (const [key, sym] of Object.entries(SYMS)) {
    let last = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (guard) await guard.waitQuiet();
      const q = new URLSearchParams({ symbol: sym, interval: "1day", outputsize: "5000", timezone: "UTC", apikey: apiKey });
      try {
        const res = await fetch(`https://api.twelvedata.com/time_series?${q}`, { signal: AbortSignal.timeout(90000) });
        const body = await res.json();
        if (body.status === "error") throw new Error(`code=${body.code} ${body.message}`);
        if (!Array.isArray(body.values)) throw new Error("values がありません");
        out[key] = body.values.map((v) => ({
          date: String(v.datetime).slice(0, 10),
          open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
        })).filter((b) => [b.open, b.high, b.low, b.close].every((x) => Number.isFinite(x) && x > 0)).reverse();
        console.log(`${key}: ${out[key].length}本（${out[key][0].date}〜${out[key][out[key].length - 1].date}）`);
        last = null;
        break;
      } catch (e) {
        last = e;
        console.log(`${key}: ${scrub(e.message)} → 再試行 ${attempt}`);
        await sleep(/429/.test(String(e.message)) ? 65000 : 10000);
      }
    }
    if (last) throw new Error(`${key}: ${scrub(last.message)}`);
    await sleep(10000);
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
}

main().catch((e) => {
  console.log(`::error::${String(e.message).slice(0, 2000)}`);
  process.exit(1);
});
