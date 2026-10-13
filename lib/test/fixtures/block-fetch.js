"use strict";
// 試験用: --require で読み込み、fetch が1回でも呼ばれたら記録して終了コード 86 で止める（ネットワークには出ない）
const fs = require("fs");
globalThis.fetch = async (url) => {
  fs.appendFileSync(process.env.FETCH_LOG, `${String(url).replace(/apikey=[^&]*/, "apikey=***")}\n`);
  process.exit(86);
};
