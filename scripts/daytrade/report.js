"use strict";
const csvio = require("./csvio");
const { jstIso } = require("./jst");
const { byId } = require("./decisions");

const f = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? "" : v.toFixed(d));
const pct = (v) => (v === null || v === undefined ? "" : `${(v * 100).toFixed(1)}%`);

const CSV_COLUMNS = [
  "setup", "atr_coef", "axis", "value", "n", "reached", "reach_rate", "tp1", "sl", "timeout", "win_rate", "plan_rr_avg",
  "real_r_gross_avg", "real_r_net_avg", "pips_gross_sum", "pips_net_sum", "pips_gross_avg", "pips_net_avg", "yen_net_1lot_avg",
  "max_loss_streak", "same_bar", "gap", "after_expiry", "cancelled_unreached",
];

function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(csvio.line(CSV_COLUMNS.map((c) => {
      const v = r[c];
      if (typeof v === "number") return c.endsWith("rate") ? v.toFixed(4) : Number.isInteger(v) ? v : v.toFixed(3);
      return v;
    })));
  }
  return lines.join("\n") + "\n";
}

function table(rows) {
  const L = ["| 値 | n | 到達 | 到達率 | TP1 | SL | 時間切れ | 勝率 | 計画RR平均 | 実現R(グロス) | 実現R(コスト込) | pips合計(グロス) | pips合計(コスト込) | 最大連敗 | 同一足 | ギャップ | 失効後到達 | 取消・未到達 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of rows) {
    L.push(`| ${r.value} | ${r.n} | ${r.reached} | ${pct(r.reach_rate)} | ${r.tp1} | ${r.sl} | ${r.timeout} | ${pct(r.win_rate)} | ${f(r.plan_rr_avg, 2)} | ${f(r.real_r_gross_avg, 2)} | ${f(r.real_r_net_avg, 2)} | ${f(r.pips_gross_sum, 1)} | ${f(r.pips_net_sum, 1)} | ${r.max_loss_streak} | ${r.same_bar} | ${r.gap} | ${r.after_expiry} | ${r.cancelled_unreached} |`);
  }
  return L.join("\n");
}

/**
 * meta: { nowMs, window:{first,last}, stats, history:[{code,bars,first,last,gaps,verify}], regimeSource, fetched:[codes], noMtf:[codes] }
 */
function toMarkdown(rows, meta) {
  const L = [];
  L.push(`# デイトレプラン バックテスト（実行日 ${jstIso(meta.nowMs).slice(0, 10)}）`);
  L.push("");
  L.push("仕様 6-2。本人が読んで、パラメータと型の採否を決めるための集計です。**数字は『下の規則を選んだうえでの結果』で、上限・下限の保証ではありません。** パラメータ（ATR係数・帯幅・TPの置き方）は、この結果と2週間以上の前進検証でだけ動かします（仕様 0節・6-3）。");
  L.push("");
  L.push("## 条件");
  L.push(`- 期間: 計画日 ${meta.window.first} 〜 ${meta.window.last}（完了した日だけ。平日）。設計の回数 ${meta.stats.designs}、評価 ${meta.stats.evaluations}件、有効期限まで足がそろわず除いた版 ${meta.stats.incomplete}、先の版が約定済みで数えなかった版 ${meta.stats.suppressed ?? 0}`);
  L.push("- 設計: 平日の 設計①（NY17:30＝夏06:30/冬07:30、型Aのみ）・設計②（15:30、型A・型B）・設計③（NY8:00＝夏21:00/冬22:00、型A・型B）。毎時の状態更新は案を変えないので再現しない");
  L.push("- 型A・型B × ATR係数（A案=0.5／B案=1.0）。門・型はライブの生成器と同じ関数（`scripts/daytrade/evaluate.js`）で、判定は採点（`daytrade-score.js`）と同じ `fill.js`。H1足の高安だけで判定するため、足の中の順序は分からない");
  L.push("- 入力の再現: 現在値=直前に確定したH1の終値、当日高安=NY17時以降の確定足、日次レベル・ADR20・MTFの向きは日足（`data/mtf`）から PR #11 の計算定義で再計算");
  L.push("");
  L.push("### 仮置きの規則（仕様が沈黙している点。decisions.js の Q 番号）");
  for (const id of ["Q25", "Q26", "Q27", "Q28", "Q29", "Q30", "Q31", "Q32", "Q33", "Q34", "Q35"]) {
    const q = byId.get(id);
    L.push(`- **${id}** ${q.title} → ${q.provisional}`);
  }
  L.push(`- ボラ状態の閾値: ${meta.regimeSource}`);
  L.push("- 到達はH1足の高安がEntry帯と重なった足で判定する。設計時刻・取消時刻をまたぐ足は使わない（次の版も使わない）。帯を飛び越えた足（高安が帯と重ならない）は『未到達』のまま（エントリー側のギャップは約定させない）。月曜の設計①（NY日曜17:30）は直前の1時間の足が無いので再現しない");
  L.push("- 同じ基準水準・同じ向きの先の版が既に約定していれば、後の版は数えない（二重に建てない）。Entry帯またはSLが変わった再設計は、前の版を取消して新しい版として数える（ライブの log.csv と同じ）");
  L.push("- 『pips合計』は銘柄を混ぜると XAUUSD（1pip=0.1ドル）が支配的になる。銘柄の軸で見ること。H1 ATR14 が小さい銘柄（EURUSD・AUDUSD・USDCHF・EURGBP）は、SL幅10pips以上の門を A案（0.5×ATR）がほとんど通らない");
  L.push("- 約定は最悪Entryで成立したとみなす。M15の確認条件（型A）は反映していない。イベント停止はない。9時台・翌1:00以降・土曜0:00以降は新規なし（到達は『失効後到達』に回す）");
  L.push("- コスト込み = 往復で 2-2 の下限（ドル建て・XAUUSD…米ドル決済 1.2pips、その他 1.6pips）を一律に引いた値。`commission_per_lot_jpy`・スプレッドの実数は使っていない（Q30・Q36）");
  L.push("- 『時間切れ』= 有効期限（翌3:00）までSLにもTP1にも届かず、最終足の終値で決済した扱い。勝ちには数えず、勝率の分母には入れる。『同一足』= 同じH1足にSLとTP1の両方が入った件数（SL先着として数えている）。『ギャップ』= SLが始値のギャップで損失が計画より大きくなった件数");
  L.push("- 『取消・未到達』= 次の設計で取消された案のうち到達しなかった件数（到達率の分母に入れている）。同じEntry帯・SLの再設計は継続とみなして二重に数えていない");
  if (meta.noMtf.length) L.push(`- ${meta.noMtf.join("・")} は MTF の日足が無く向きを再計算できないため、案を作っていない（ライブと同じ: Q34）`);
  L.push("");
  L.push("## H1履歴の品質（data/history/h1-<銘柄>.csv）");
  for (const h of meta.history) L.push(`- ${h.code}: ${h.bars}本（${h.first} 〜 ${h.last}）、3〜40時間の抜け ${h.gaps}箇所、h1-bars.json との重なり ${h.verify ? `${h.verify.overlap}本中 不一致 ${h.verify.mismatch}本` : "（照合なし）"}${h.fetched ? "（今回取得）" : "（既存を使用）"}`);
  L.push("");
  for (const setup of ["A", "B"]) for (const scheme of ["A", "B"]) {
    L.push(`## 型${setup} × ${scheme}案（ATR係数 ${scheme === "A" ? "0.5" : "1.0"}）`);
    const grp = rows.filter((r) => r.setup === setup && r.scheme === scheme);
    if (!grp.length) { L.push("該当する案はありません。"); L.push(""); continue; }
    const axes = [...new Set(grp.map((r) => r.axis))];
    for (const ax of axes) {
      L.push(`### 軸: ${ax}${ax === "約定時刻(JST)" ? "（約定した案だけ。n=約定件数、到達率は常に100%）" : ""}`);
      L.push(table(grp.filter((r) => r.axis === ax)));
      L.push("");
    }
  }
  return L.join("\n");
}

module.exports = { CSV_COLUMNS, toCsv, toMarkdown };
