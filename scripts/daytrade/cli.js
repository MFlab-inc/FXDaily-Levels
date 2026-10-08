"use strict";
const path = require("path");

// --key=value / --flag の最小パーサ
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
const repoRoot = path.join(__dirname, "..", "..");
module.exports = { parseArgs, repoRoot, dataDir: path.join(repoRoot, "data") };
