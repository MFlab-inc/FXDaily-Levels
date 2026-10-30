"use strict";

/**
 * Cboe「VIX_History.csv」の読み取り（SPEC 2節）。
 * 形式（2026-10-30 に公式のリンクで確認）：1行目が `DATE,OPEN,HIGH,LOW,CLOSE`、日付は `MM/DD/YYYY`、
 * 値は小数6桁（例 `01/02/1990,17.240000,17.240000,17.240000,17.240000`）、古い日付が先頭。
 *
 * 想定と違う形（列名・日付・値・重複）は黙って捨てない：
 *   - 1行目（見出し）と、末尾の strictTail 行（順位と履歴に使う範囲を含む）に問題があれば、行番号つきで失敗にする。
 *   - それより古い行の問題は、その行を飛ばして skipped に記録する（1990年代の行の不備で、毎日の更新が止まらないように）。
 */
const cfg = require("../config");

class ParseError extends Error {}

const STRICT_TAIL_ROWS = 400; // 252（順位の範囲）＋60（履歴）を十分に含む

function toIsoDate(s, lineNo) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) throw new ParseError(`${lineNo}行目: 日付が MM/DD/YYYY ではありません: ${JSON.stringify(s)}`);
  const iso = `${m[3]}-${m[1]}-${m[2]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  // 2月30日のような存在しない日を弾く
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
    throw new ParseError(`${lineNo}行目: 存在しない日付です: ${s}`);
  }
  return iso;
}

function parseRow(line, lineNo, header, iDate, iClose) {
  const cols = line.split(",").map((s) => s.trim());
  if (cols.length !== header.length) throw new ParseError(`${lineNo}行目: 列の数が見出し（${header.length}列）と違います: ${line}`);
  const date = toIsoDate(cols[iDate], lineNo);
  if (!/^\d+(\.\d+)?$/.test(cols[iClose])) throw new ParseError(`${lineNo}行目: CLOSE が数値ではありません: ${JSON.stringify(cols[iClose])}`);
  const close = Number(cols[iClose]);
  if (!(close > cfg.VIX.closeMinExclusive && close < cfg.VIX.closeMaxExclusive)) {
    throw new ParseError(`${lineNo}行目: CLOSE ${close} が想定の範囲（${cfg.VIX.closeMinExclusive}より大きく${cfg.VIX.closeMaxExclusive}未満）の外です`);
  }
  return { date, close };
}

function parseVixCsv(text, { strictTail = STRICT_TAIL_ROWS } = {}) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  const nonEmpty = lines.map((l, i) => ({ l: l.trim(), no: i + 1 })).filter((x) => x.l !== "");
  if (!nonEmpty.length) throw new ParseError("ファイルが空です");
  const header = nonEmpty[0].l.split(",").map((s) => s.trim().toUpperCase());
  const iDate = header.indexOf("DATE"), iClose = header.indexOf("CLOSE");
  if (iDate < 0 || iClose < 0) throw new ParseError(`1行目に DATE・CLOSE の列がありません: ${nonEmpty[0].l}`);

  const body = nonEmpty.slice(1);
  const strictFrom = body.length - strictTail;
  const rows = [], seen = new Set(), skipped = [];
  body.forEach(({ l, no }, j) => {
    const strict = j >= strictFrom;
    let row;
    try {
      row = parseRow(l, no, header, iDate, iClose);
      if (seen.has(row.date)) throw new ParseError(`${no}行目: ${row.date} の行が重複しています`);
    } catch (e) {
      if (strict || !(e instanceof ParseError)) throw e;
      skipped.push(e.message);
      return;
    }
    seen.add(row.date);
    rows.push(row);
  });
  if (!rows.length) throw new ParseError("データ行がありません");
  // ファイルは古い順だが、並びが変わっても計算が狂わないよう、日付で並べ直す（重複は上で弾いている）
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { rows, skipped };
}

module.exports = { parseVixCsv, ParseError, STRICT_TAIL_ROWS };
