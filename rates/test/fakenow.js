"use strict";
// 試験用：node -r rates/test/fakenow.js で、Date.now() を環境変数 FAKE_NOW_MS に固定する（build-feed.js の「いま」）
const t = Number(process.env.FAKE_NOW_MS);
if (Number.isFinite(t) && t > 0) Date.now = () => t;
