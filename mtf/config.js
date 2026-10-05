"use strict";
const path = require("path");

// digits は fetch.js の PAIRS と同じ価格の桁数。standardBars は NY17時区切りの1日の標準本数
// （XAUUSD は1日1時間の休止があるため23本）。
const SYMBOLS = [
  { code: "USDJPY", td: "USD/JPY", digits: 3, standardBars: 24 },
  { code: "EURUSD", td: "EUR/USD", digits: 5, standardBars: 24 },
  { code: "GBPUSD", td: "GBP/USD", digits: 5, standardBars: 24 },
  { code: "AUDUSD", td: "AUD/USD", digits: 5, standardBars: 24 },
  { code: "EURJPY", td: "EUR/JPY", digits: 3, standardBars: 24 },
  { code: "EURGBP", td: "EUR/GBP", digits: 5, standardBars: 24 },
  { code: "USDCAD", td: "USD/CAD", digits: 5, standardBars: 24 },
  { code: "XAUUSD", td: "XAU/USD", digits: 2, standardBars: 23 },
  { code: "USDCHF", td: "USD/CHF", digits: 5, standardBars: 24 },
];

const BACKFILL_START = "2024-07-01";
const VERSION = "MTF-1.0（Block② MTF_Structure_Module.xlsx の Methodology 準拠）";
const DATA_DIR = path.join(__dirname, "..", "data");

module.exports = { SYMBOLS, BACKFILL_START, VERSION, DATA_DIR };
