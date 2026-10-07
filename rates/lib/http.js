"use strict";

/**
 * 読み取り専用のGET（タイムアウト・一時障害の再試行つき）。
 * 429/5xx/ネットワーク障害だけ再試行する。4xx（429を除く）は再試行しても変わらないのでそのまま失敗にする。
 * fetchImpl・sleep は試験で差し替える。
 */
const cfg = require("../config");

const isRetryableStatus = (s) => s === 408 || s === 425 || s === 429 || (s >= 500 && s <= 599);

async function httpGet(url, {
  label = url, fetchImpl = (...a) => fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = cfg.HTTP.timeoutMs, retries = cfg.HTTP.retries, backoffMs = cfg.HTTP.backoffMs,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    let err;
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": cfg.HTTP.userAgent, Accept: "*/*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        err = new Error(`HTTP ${res.status} (${label})`);
        err.retryable = isRetryableStatus(res.status);
      } else {
        return { bytes: Buffer.from(await res.arrayBuffer()), lastModified: res.headers.get("last-modified") };
      }
    } catch (e) {
      // タイムアウト（DOMException。messageを書き換えられない）・接続の失敗は、包み直して再試行する
      err = new Error(`${e.name === "TimeoutError" ? `タイムアウト（${timeoutMs / 1000}秒）` : e.message} (${label})`, { cause: e });
      err.retryable = true;
    }
    if (!err.retryable || attempt >= retries) throw err;
    await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)] + Math.floor(Math.random() * 500));
  }
}

module.exports = { httpGet };
