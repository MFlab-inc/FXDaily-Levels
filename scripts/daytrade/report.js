"use strict";
const csvio = require("./csvio");
const { jstIso } = require("./jst");
const { byId } = require("./decisions");
const { SL_FLOOR_MODES, SLOT_LABEL } = require("./backtest");

const f = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? "" : v.toFixed(d));
const pct = (v) => (v === null || v === undefined ? "" : `${(v * 100).toFixed(1)}%`);

// CSV の sl_floor 列の値（SL下限方式）。md にも書く
const SL_FLOOR_CODE = Object.fromEntries(SL_FLOOR_MODES.map((m) => [m.id, m.code]));

const CSV_COLUMNS = [
  "sl_floor", "setup", "atr_coef", "axis", "value", "n", "reached", "reach_rate", "tp1", "sl", "timeout", "win_rate", "plan_rr_avg",
  "real_r_gross_avg", "real_r_net_avg", "pips_gross_sum", "pips_net_sum", "pips_gross_avg", "pips_net_avg", "yen_net_1lot_avg",
  "max_loss_streak", "same_bar", "gap", "after_expiry", "cancelled_unreached",
];

function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    if (!SL_FLOOR_CODE[r.sl_floor]) throw new Error(`toCsv: 行の sl_floor が不正です（${String(r.sl_floor)}）`);
    lines.push(csvio.line(CSV_COLUMNS.map((c) => {
      const v = c === "sl_floor" ? SL_FLOOR_CODE[r.sl_floor] : r[c];
      if (typeof v === "number") return c === "atr_coef" ? v.toFixed(1) : c.endsWith("rate") ? v.toFixed(4) : Number.isInteger(v) ? v : v.toFixed(3);
      return v;
    })));
  }
  return lines.join("\n") + "\n";
}

const HEAD = ["n", "到達", "到達率", "TP1", "SL", "時間切れ", "勝率", "計画RR平均", "実現R(グロス)", "実現R(コスト込)", "pips合計(グロス)", "pips合計(コスト込)", "最大連敗", "同一足", "ギャップ", "失効後到達", "取消・未到達"];
const cells = (r) => [r.n, r.reached, pct(r.reach_rate), r.tp1, r.sl, r.timeout, pct(r.win_rate), f(r.plan_rr_avg, 2), f(r.real_r_gross_avg, 2), f(r.real_r_net_avg, 2), f(r.pips_gross_sum, 1), f(r.pips_net_sum, 1), r.max_loss_streak, r.same_bar, r.gap, r.after_expiry, r.cancelled_unreached];
const mdRow = (arr) => `| ${arr.join(" | ")} |`;
const mdTable = (head, body) => [mdRow(head), mdRow(head.map(() => "---")), ...body.map(mdRow)].join("\n");

// 軸ごとの表（1列目=値）
function table(rows) {
  return mdTable(["値", ...HEAD], rows.map((r) => [r.value, ...cells(r)]));
}

// (a) と (b) の比較用に使う列（全体の行）。依頼の項目: n・到達・到達率・TP1・SL・時間切れ・勝率・計画RR平均・実現R・pips合計・最大連敗
const CMP_HEAD = ["n", "到達", "到達率", "TP1", "SL", "時間切れ", "勝率", "計画RR平均", "実現R(グロス)", "実現R(コスト込)", "pips合計(グロス)", "pips合計(コスト込)", "最大連敗"];
const cmpCells = (r) => cells(r).slice(0, CMP_HEAD.length);

const schemeName = (setup, scheme) => `型${setup} × ${scheme}案（ATR係数 ${scheme === "A" ? "0.5" : "1.0"}）`;

/**
 * rows: aggregate() の行。meta: {
 *   nowMs, window:{first,last}, stats（共通の件数）, statsByMode:{reject,widen}（方式ごとの件数）, floorRows（floorBreakdown() の行。無くてもよい）,
 *   history:[{code,bars,first,last,gaps,verify}], regimeSource, noMtf:[codes]
 * }
 */
function toMarkdown(rows, meta) {
  if (!meta.statsByMode || !meta.statsByMode.reject || !meta.statsByMode.widen) throw new Error("toMarkdown: meta.statsByMode（reject／widen）が必要です");
  const st = meta.stats;
  const sm = meta.statsByMode;
  const ab = (g) => `(a) ${g(sm.reject)}／(b) ${g(sm.widen)}`;
  const L = [];
  L.push(`# デイトレプラン バックテスト（実行日 ${jstIso(meta.nowMs).slice(0, 10)}）`);
  L.push("");
  L.push("仕様 6-2。本人が読んで、パラメータと型の採否を決めるための集計です。**数字は『下の規則を選んだうえでの結果』で、上限・下限の保証ではありません。** パラメータ（ATR係数・帯幅・TPの置き方）は、この結果と2週間以上の前進検証でだけ動かします（仕様 0節・6-3）。");
  L.push("");
  L.push("## 読み方（先にここだけ）");
  L.push("- 過去1年の平日について、型A（基準水準への戻り）と型B（東京レンジをブレイクしたあとの戻り）の案を、**ライブの生成器と同じ関数**で機械的に作り、H1足で『Entry帯に届いたか』『SLとTP1のどちらが先か』を判定して集計しました。");
  L.push("- 案は **A案（SL＝0.5×ATR）** と **B案（SL＝1.0×ATR）** の2通りで、型A・型B × A案・B案の4つの組み合わせを別々に数えています。");
  L.push("- **SL下限方式を2通り** 計算して並べています。違いは『SL幅が10pipsに足りないときの扱い』だけで、ほかの門と判定は同じです。");
  for (const m of SL_FLOOR_MODES) {
    L.push(m.id === "reject"
      ? `  - **${m.label}**（CSV の sl_floor = \`${m.code}\`）: ライブの規則。SL＝基準価格 ± 係数×ATR を、損切りが遠くなる側へ 0.5pip 単位に丸める。**丸めたあとの SL 幅が 10pips 未満なら『SL幅不足』で不採用**（その案は作らない）。`
      : `  - **${m.label}**（CSV の sl_floor = \`${m.code}\`）: 比較のための試算。**SL幅＝max(係数×ATR, 10pips)** を、損切りが遠くなる側へ 0.5pip 単位に丸め、SL幅では不採用にしない（常に10pips以上）。RR・コスト上限・ADR消化・届くか・ロットは、広げた後のSL幅で計算し直して (a) と同じ基準で判定する。`);
  }
  L.push("- **ライブの規則は (a) のままです。** (b) に変えるかどうかは、この結果を見てから本人が決めます（バックテストの結果で自動的には変えません）。");
  L.push("- **型B の出し方は本人の回答（Q09）で変わりました**: 設計②（15:30）では作らず、毎時 16:00〜21:00 の状態更新で『東京レンジをMTFの向きにブレイクし、戻っていない』銘柄に追加します。型A は設計①②③のみです。詳細は下の『条件』。");
  L.push("- 『pips合計』は銘柄を混ぜると XAUUSD（1pip＝0.1ドル）が支配的になります。銘柄の軸で見てください。");
  L.push("");

  // ---- (a) と (b) の比較 ----
  L.push("## (a) と (b) の比較（全体）");
  const totals = rows.filter((r) => r.axis === "全体");
  const body = [];
  for (const setup of ["A", "B"]) for (const scheme of ["A", "B"]) {
    for (const m of SL_FLOOR_MODES) {
      const r = totals.find((x) => x.sl_floor === m.id && x.setup === setup && x.scheme === scheme);
      body.push([schemeName(setup, scheme), m.tag, ...(r ? cmpCells(r) : CMP_HEAD.map(() => "—"))]);
    }
  }
  L.push(mdTable(["型 × 案", "SL下限方式", ...CMP_HEAD], body));
  L.push("");
  L.push("- n＝作った案の数（A案とB案は別に数える）。到達率＝到達÷n、勝率＝TP1先着÷到達（時間切れは勝ちに数えず、分母には入れる）。実現R＝損益÷SL幅（最悪Entryで約定、グロス＝コスト0、コスト込＝往復で 1.2／1.6pips を引く）。最大連敗は決済時刻順にコスト込pipsが負の連続。");
  L.push("- (b) は (a) の案に加えて、『SL幅不足』で落ちていた案が加わります。そのため n は (b) のほうが多くなります。ただし (b) で広げた案が先に約定すると、(a) では数えていた後の版が『同じ考えの先の版が約定済み』として数えられなくなるので、(a) にもある案の件数が (a) より少しだけ減ることがあります（下の『条件』の『数えなかった版』）。型Bの追加でも同じで、(b) で広げた版が先に追加されると、(a) で後の時刻に追加されていた版が『同じ銘柄・向きが既にある』として追加されなくなります（先に門を通った版が勝つ）。");
  L.push("");
  if (meta.floorRows && meta.floorRows.length) {
    L.push("### (b) の内訳：SLを10pips下限で広げた案と、広げなかった案");
    L.push("『広げた案』＝(b) のSLが、下限なしの計算結果と違う案（＝(a) なら『SL幅不足』で不採用になる案）。『広げなかった案』は (a) と同じSLの案です。(b) の増分が結果をどう変えたかは、この2行の差で分かります。");
    L.push("");
    L.push(mdTable(["型 × 案", "区分", "n", "到達", "到達率", "TP1", "SL", "時間切れ", "勝率", "実現R(グロス)", "実現R(コスト込)", "pips合計(グロス)", "pips合計(コスト込)"],
      meta.floorRows.map((r) => [schemeName(r.setup, r.scheme), r.value, r.n, r.reached, pct(r.reach_rate), r.tp1, r.sl, r.timeout, pct(r.win_rate), f(r.real_r_gross_avg, 2), f(r.real_r_net_avg, 2), f(r.pips_gross_sum, 1), f(r.pips_net_sum, 1)])));
    L.push("");
  }
  const bSlots = rows.filter((r) => r.axis === "設計の回" && r.setup === "B");
  if (bSlots.length) {
    L.push("### 型B の内訳：設計③で作った案と、状態更新（毎時16:00〜21:00）で追加した案");
    L.push(`型Bは設計②（15:30）では作らず、毎時 16:00〜21:00 の状態更新で『東京レンジをMTFの向きにブレイクし、戻っていない』銘柄に追加します（詳細は下の『条件』）。設計③は型A・型Bを再設計します。`);
    L.push("");
    L.push(mdTable(["SL下限方式", "型 × 案", "設計の回", "n", "到達", "到達率", "TP1", "SL", "時間切れ", "勝率", "実現R(コスト込)", "pips合計(コスト込)"],
      bSlots.map((r) => [SL_FLOOR_MODES.find((m) => m.id === r.sl_floor).tag, schemeName(r.setup, r.scheme), r.value, r.n, r.reached, pct(r.reach_rate), r.tp1, r.sl, r.timeout, pct(r.win_rate), f(r.real_r_net_avg, 2), f(r.pips_net_sum, 1)])));
    L.push("");
  }

  // ---- 条件 ----
  L.push("## 条件");
  L.push(`- 期間: 計画日 ${meta.window.first} 〜 ${meta.window.last}（完了した日だけ。平日）。評価 ${st.evaluations}件。有効期限まで足がそろわず除いた版 ${ab((s) => s.incomplete)}、先の版が約定済みで数えなかった版 ${ab((s) => s.suppressed ?? 0)}`);
  L.push(`- 設計の出来事（計画日ごと、時刻順）: 設計①（NY17:30＝夏06:30/冬07:30、**型Aのみ**）→ 設計②（15:30、**型Aのみ**）→ 型B追加（毎時 16:00〜21:00、**型Bのみ**）→ 設計③（NY8:00＝夏21:00/冬22:00、型A・型B）。設計の予定 ${st.designs}回（月曜の設計①は直前の1時間の足が無く評価しない）、型B追加の出来事 ${st.adds}回。毎時のその他の状態更新は案を変えないので再現しない`);
  L.push("- **型B の規則（本人の回答 Q09 で変更）**: 設計②（15:30）では作らない（15:00開始のH1は16:00に確定するので、15:30にはブレイクが成立し得ない）。毎時 16:00〜21:00 の状態更新で、直前に確定したH1までに東京レンジ（開始 9:00〜14:00 の6本）を**MTFの向きに終値でブレイク**していて（両方向ブレイクではない）、かつ価格（直前に確定したH1の終値）が**ブレイク後にレンジ内へ戻っていない**（売り＝Entry帯の上端以下、買い＝下端以上）とき、その時点で型Bの案を新しく設計して追加する。判定はライブと同じ `evaluate(型B)`、時刻の定義は `typeb.js`（ライブと共通）");
  L.push("  - 追加は**追加だけ**: 既存の案を取消さず、再設計もしない。同じ計画日・同じ銘柄・同じ向きの型Bが既にあれば（有効でも取消済みでも）追加しない。追加した版は、毎時00分の評価の5分後（intraday の完了と生成器の実行の遅れ）に出たものとして追跡する（その時間に始まる足は使わない。ライブでは追加の時刻が最大1時間早くなり得る）");
  L.push("  - 設計③の名目時刻と重なる追加時刻（夏の21:00）は追加ではなく設計③そのもの。冬は 21:00 が追加で、設計③は 22:00");
  L.push("  - 設計③は追加された型Bの版も再設計する: 同じ版（Entry帯・SLが同一）は継続、違う版・無くなった版は設計③の時刻に取消（未到達なら『取消・未到達』）し、新しい版が設計③の時刻に生まれる。追加した版が既に約定していれば、同じ基準水準・同じ向きの設計③の版は数えない");
  L.push(`  - 型B追加の件数: 追加した版 ${ab((s) => s.bAdded)}、同じ銘柄・向きが既にあり追加しなかった ${ab((s) => s.bAddDup)}（毎時の評価で同じブレイクが続いて見つかる分）。表の『設計の回』は『${SLOT_LABEL[4]}』が追加した版`);
  L.push("- 型A: 設計①②③のみ（毎時の状態更新では追加しない）");
  L.push("- 型A・型B × ATR係数（A案=0.5／B案=1.0）。門・型はライブの生成器と同じ関数（`scripts/daytrade/evaluate.js`）で、判定は採点（`daytrade-score.js`）と同じ `fill.js`。H1足の高安だけで判定するため、足の中の順序は分からない");
  L.push("- SL下限方式 (a)／(b) の定義は上の『読み方』のとおり。(b) は `evaluate()` の `opts.slFloor = 'widen'` で計算（ライブの生成器は常に (a)）。CSV の先頭列 `sl_floor` は、`a_reject`＝(a)、`b_widen`＝(b)");
  L.push("- 入力の再現: 現在値=直前に確定したH1の終値、当日高安=NY17時以降の確定足、日次レベル・ADR20・MTFの向きは日足（`data/mtf`）から PR #11 の計算定義で再計算");
  L.push("");
  L.push("### 確定した規則（本人が PR #15 で確認。仕様が沈黙している点。decisions.js の Q 番号）");
  for (const id of ["Q25", "Q26", "Q27", "Q28", "Q29", "Q30", "Q31", "Q32", "Q33", "Q34", "Q35"]) {
    const q = byId.get(id);
    L.push(`- **${id}** ${q.title} → ${q.provisional}`);
  }
  L.push("- 上の Q31 の『設計の回』は、本人の回答 Q09 の変更で『状態更新（型B追加）』が加わり、設計①・②・③・状態更新（型B追加）の4区分になった");
  L.push(`- ボラ状態の閾値: ${meta.regimeSource}`);
  L.push("- 到達はH1足の高安がEntry帯と重なった足で判定する。設計時刻・取消時刻をまたぐ足は使わない（次の版も使わない）。帯を飛び越えた足（高安が帯と重ならない）は『未到達』のまま（エントリー側のギャップは約定させない）。");
  L.push("- 同じ基準水準・同じ向きの先の版が既に約定していれば、後の版は数えない（二重に建てない）。Entry帯またはSLが変わった再設計は、前の版を取消して新しい版として数える（ライブの log.csv と同じ）");
  L.push("");
  L.push("### この結果の限界・仮置きのまま残るもの");
  L.push("- 約定は最悪Entryで成立したとみなす。M15の確認条件（型A・型Bとも）は反映していない。イベント停止はない（過去のカレンダーが無い）。9時台・翌1:00以降・土曜0:00以降は新規なし（到達は『失効後到達』に回す）");
  L.push("- 月曜の設計①（NY日曜17:30）は直前の1時間の足が無いので再現しない");
  L.push("- H1 ATR14 が小さい銘柄（EURUSD・AUDUSD・USDCHF・EURGBP）は、(a) では SL幅10pips以上の門を A案（0.5×ATR）がほとんど通らない。(b) はその案を10pipsのSLで採用した場合の試算");
  L.push("- コスト込み = 往復で 2-2 の下限（ドル建て・XAUUSD…米ドル決済 1.2pips、その他 1.6pips）を一律に引いた値。`commission_per_lot_jpy`・スプレッドの実数は使っていない（Q30）");
  L.push("- 『時間切れ』= 有効期限（翌3:00）までSLにもTP1にも届かず、最終足の終値で決済した扱い。勝ちには数えず、勝率の分母には入れる。『同一足』= 同じH1足にSLとTP1の両方が入った件数（SL先着として数えている）。『ギャップ』= SLが始値のギャップで損失が計画より大きくなった件数");
  L.push("- 『取消・未到達』= 次の設計で取消された案のうち到達しなかった件数（到達率の分母に入れている）。同じEntry帯・SLの再設計は継続とみなして二重に数えていない");
  if (meta.noMtf.length) L.push(`- ${meta.noMtf.join("・")} は MTF の日足が無く向きを再計算できないため、案を作っていない（ライブと同じ: Q05・Q34。MTFフィードに足す対応は別の PR）`);
  L.push("");
  L.push("## H1履歴の品質（data/history/h1-<銘柄>.csv）");
  for (const h of meta.history) L.push(`- ${h.code}: ${h.bars}本（${h.first} 〜 ${h.last}）、3〜40時間の抜け ${h.gaps}箇所、h1-bars.json との重なり ${h.verify ? `${h.verify.overlap}本中 不一致 ${h.verify.mismatch}本` : "（照合なし）"}${h.fetched ? "（今回取得）" : "（既存を使用）"}`);
  L.push("");

  // ---- 方式別の詳細（(a) → (b)）----
  for (const m of SL_FLOOR_MODES) {
    L.push(`## ${m.label}（詳細）`);
    L.push("");
    for (const setup of ["A", "B"]) for (const scheme of ["A", "B"]) {
      L.push(`### ${m.tag} ${schemeName(setup, scheme)}`);
      const grp = rows.filter((r) => r.sl_floor === m.id && r.setup === setup && r.scheme === scheme);
      if (!grp.length) { L.push("該当する案はありません。"); L.push(""); continue; }
      const axes = [...new Set(grp.map((r) => r.axis))];
      for (const ax of axes) {
        L.push(`#### 軸: ${ax}${ax === "約定時刻(JST)" ? "（約定した案だけ。n=約定件数、到達率は常に100%）" : ""}`);
        L.push(table(grp.filter((r) => r.axis === ax)));
        L.push("");
      }
    }
  }
  return L.join("\n");
}

module.exports = { CSV_COLUMNS, SL_FLOOR_CODE, toCsv, toMarkdown };
