"use strict";

/**
 * 仕様 v1.1（docs/daytrade-plan-spec.md）が沈黙・矛盾している点の一覧と、それぞれに「いま実装している仮置きの読み」。
 * 推測で決めないための台帳。仮置きの読みは、候補を増やさない・危険側に倒れない方を選び、ここ（と、それを使う1か所）に隔離する。
 * 本人（デイトレ戦略スレッド）が回答したら、該当箇所を差し替え、このファイルの status を "confirmed" にする。
 * 出力（data/daytrade-plan.txt/.json）の先頭に、status が provisional の件数と ID を出す。
 * 詳細・代替案・根拠は docs/daytrade-plan-impl-notes.md と PR の説明。
 */
const QUESTIONS = [
  { id: "Q01", impact: "blocking", title: "txt の『テンプレv1.2の7項目の順』の中身がどこにも無い（6項目目=前日結果だけ分かる）", provisional: "7つの区画を仮の名前・順で出す（6番目=前日の結果）。JSON を正本にする" },
  { id: "Q02", impact: "blocking", title: "『H1高値群（0.2×ATR以内に2本以上）』の作り方と、基準水準に使う本数の窓", provisional: "直近24本の確定H1。隣り合う高値（安値）の差が0.2×ATR以内でつながった2本以上の塊の最外端（高値群は最大、安値群は最小）" },
  { id: "Q03", impact: "material", title: "TP1の『最初の障害』の集合（週足レベルを含むか、高値群・安値群の両方か、群のどの端か）", provisional: "日次レベル7本（Pivot・R1・R2・S1・S2・前日高値・前日安値）＋直近24本のH1高値群・安値群の両方。Entryに近い端の手前" },
  { id: "Q04", impact: "material", title: "『3/3 または 2/3 で向きがそろった』に、残り1本が逆向きの 2/3 を含めるか", provisional: "逆向きの時間足が1本でもあれば候補にしない（監視のみ）" },
  { id: "Q05", impact: "material", title: "NZDUSD は mtf-feed に無い（9銘柄）。2-1どおりだと常に候補にならない", provisional: "常に『方向根拠なし（MTF未収録）』。mtf 関連は変更しない" },
  { id: "Q06", impact: "material", title: "『ドル建て／クロス円』の分類（USDJPY・EURGBP・USDCAD・USDCHF・XAUUSD）、XAUUSDの丸め単位、USDJPYの1pip円価値", provisional: "丸め・TP手前幅は円決済=円（0.005／0.7pips）、それ以外=ドル建て（0.00005／0.5pips）。XAUUSDの丸めは0.5pip=0.05。コスト閾値は米ドル決済の5銘柄=1.2pips、他（USDJPY・EURJPY・USDCAD・USDCHF・EURGBP）=1.6pips。1pip円価値は実際の値（USDJPY=1,000円）" },
  { id: "Q07", impact: "material", title: "B案『ロットは半分』— 式がSL幅で割るので結果として半分になる。さらに半分にするか", provisional: "B案の上限 = min(式をB案のSL幅で計算した値, floor(A案の式の値×0.5, 0.01))" },
  { id: "Q08", impact: "material", title: "A案・B案の片方だけが門を通るときの扱い（行・件数の単位・log.csvの列）", provisional: "通った案だけを出し、落ちた案は空欄＋『不採用（理由）』。件数の単位は『案』" },
  { id: "Q09", impact: "material", title: "型B：15:30の設計②では、ブレイク成立（15:00開始足が16:00に確定）が原理的に起こらない", provisional: "文字どおり。15:30の型Bは『ブレイク未成立』で0件。型Bが出るのは21:00（冬22:00）の設計③から" },
  { id: "Q10", impact: "material", title: "型B：ブレイク後に価格がレンジ内へ戻っている／同日に両方向へブレイクしたときの扱い", provisional: "価格がブレイク側または帯の中にあるときだけ成立。レンジ内へ戻り済み・両方向ブレイクは不成立" },
  { id: "Q11", impact: "minor", title: "基準水準が見つからない／進行方向に障害が無い場合、TP1・Entry帯端の丸め", provisional: "どちらも不採用（4節の6分類とは別枠の件数）。TP1はEntry側へ0.5pip単位で丸める。Entry帯の端は価格の桁に四捨五入" },
  { id: "Q12", impact: "material", title: "不採用の内訳の数え方（単位・評価順・『監視のみ』・NZDUSD）", provisional: "単位=案（型×銘柄×A/B案）、最初に当たった理由1つだけ数える。評価順は4節の列挙順（方向→届かない→SL幅→RR→コスト→ADR消化）。監視のみ・MTF未収録は『方向根拠なし』に数え、名前を併記" },
  { id: "Q13", impact: "minor", title: "plan_date の日付境界、有効期限・新規禁止の境界、停止中の案の扱い", provisional: "plan_date = JSTで『現在−3時間』の日付（06:30〜翌02:59が同じ日）。時刻はJST固定、01:00ちょうどは新規不可。案は残し、『新規不可』『停止中』の印を併記" },
  { id: "Q14", impact: "material", title: "鮮度20分の対象と、入力の更新間隔の実績との乖離（毎時00分の実行の約9割が20分超）。入力を更新する責任", provisional: "intraday.json・daytrade-context.json・h1-bars.json の as_of が1つでも20分超なら『発注不可（鮮度超過）』。daytrade.yml は入力を更新せず、読むだけ（APIも呼ばない）" },
  { id: "Q15", impact: "material", title: "日次レベル（daily-levels.json）とMTFの日付確認。『前営業日』の基準（暦日かNY17時区切りか）", provisional: "daily-levels.json の session_date と mtf-feed の data_base_date が、直近に確定したNYセッション日（mtf/lib の lastCompletedSessionDate）と一致しなければ候補を出さない。errors が空であることも確認" },
  { id: "Q16", impact: "minor", title: "同方向の印の作り方（通貨×向き、XAUUSD、同一銘柄の型A・型B）", provisional: "通貨×向きのキーで2件以上になるものを『|』区切りで全部付ける。XAUUSDはUSD脚のみ。同一銘柄の型A・型Bも数える" },
  { id: "Q17", impact: "minor", title: "順位（方向の強さ→銘柄の優先→RR）の細部", provisional: "3/3＞2/3、銘柄の優先は3段、RRはA案・B案のうち小さい方（通っている案のみ）の高い順、同点は銘柄名→型A→型B" },
  { id: "Q18", impact: "material", title: "log.csv の追記方針（statusの行、取消の表現、版の識別、採点結果、filled_ticket）", provisional: "追記のみ。designの行は設計時のみ。取消・採点の結果は run=status の新しい行。版は(plan_date,setup,symbol,side,entry_low,entry_high,sl_a,sl_b)で結ぶ。毎時のstatusはlog.csvに書かない。filled_ticket_*は過去の行から引き継ぎ、botは書き換えない" },
  { id: "Q19", impact: "material", title: "『到達』の定義（Entry帯のどこに触れたら）。H1足しか無い限界", provisional: "H1足の高安がEntry帯と重なった最初の足（設計時刻以後に始まる足）。足の開始時刻が新規可能な時間帯の外なら『失効後到達』" },
  { id: "Q20", impact: "material", title: "SL/TP1の先着：同一H1足に両方入る／到達した足／始値のギャップ／期限まで未決", provisional: "到達した足ではSLだけ判定、TP1は次の足から。同一足に両方ならSL先。期限（翌3:00）まで未決は『未決』" },
  { id: "Q21", impact: "material", title: "採点の対象（『前日』の範囲）と、必要なH1足が届いていないとき", provisional: "失効を過ぎて未採点のplan_dateすべてを06:30の設計①の前に採点。足が失効まで届いていなければ採点を保留（未到達と確定させない）" },
  { id: "Q22", impact: "material", title: "起動方式：GitHubのscheduleは欠落・遅延する／冬時間の切替／設計③と毎時statusの重複／遅れて動いた設計", provisional: "schedule＋workflow_dispatch。夏冬の2本ずつのcronを置き、実行時にNY時間で季節を判定。設計③の時刻はstatusを兼ねる。遅れた設計は、後の枠の設計が既にある／次の枠の名目時刻を過ぎていれば何もしない" },
  { id: "Q23", impact: "material", title: "イベント：calendar の as_of が20分超（約9割）／date が当日でないとき『イベント未取得＝停止なし』で案が出る", provisional: "仕様どおり『イベント未取得』を先頭と各案に明記して、停止時間なしで生成" },
  { id: "Q24", impact: "minor", title: "ボラ状態の表示項目（regime・flags を含めるか）", provisional: "pairs.<ペア>.intraday 配下（range_today・range_vs_adr・spike_flag・updated_at）のみ。無い・nullの項目は出さない。取得失敗は『未取得』、収録外は『未収録』" },
  { id: "Q25", impact: "blocking", title: "バックテスト：設計3回・再設計の重複計上と追跡の打ち切り", provisional: "各設計の案は次の設計時刻まで追跡し、未到達なら取消（未到達として分母に入れる）。同一のEntry/SL/TPの再設計は継続とみなし二重に数えない" },
  { id: "Q26", impact: "blocking", title: "バックテスト：約定価格・始値のギャップ・M15確認条件（H1では検証不能）", provisional: "約定は最悪Entry。SLの始値ギャップは始値で損切り、TP1は価格で利確。M15確認条件は未反映と明記" },
  { id: "Q27", impact: "material", title: "バックテスト：過去の設計時点の現在値・当日高安（ADR消化率）の再現", provisional: "現在値=直前に確定したH1の終値。当日高安=NY17時（JST6:00/7:00）以降の確定足" },
  { id: "Q28", impact: "material", title: "バックテスト：イベント停止（過去のカレンダーが無い）", provisional: "全期間『停止なし』（仕様の文言どおり）と明記" },
  { id: "Q29", impact: "material", title: "バックテスト：軸『ボラ状態』の過去分が無い", provisional: "日足（data/mtf）から、risk-feedと同じ定義（ATR14÷終値の過去250営業日パーセンタイル、境界は risk-feed の meta.thresholds）で再計算した近似。見出しに明記" },
  { id: "Q30", impact: "material", title: "バックテスト：『コスト込み』のコスト、仮想損益の単位", provisional: "グロス（コスト0）と、往復コスト=2-2の下限（1.2／1.6pips）を引いた値の2本。主指標はpipsとR。円は1ロット換算の参考列" },
  { id: "Q31", impact: "material", title: "バックテスト：『エントリー時間帯』『曜日』の基準（未到達の案には約定時刻が無い）", provisional: "全指標を設計の回（06:30／15:30／21:00）と設計日の曜日で出す。約定後の指標だけ、約定時刻（JST1時間刻み）の表を別に出す" },
  { id: "Q32", impact: "material", title: "バックテスト：平均RR・勝率・最大連敗の定義", provisional: "『計画RR平均』と『実現R平均』を別の名前で両方出す。勝率=TP1先着÷約定。最大連敗=集計グループ内を決済時刻順に並べた連続損失。件数(n)を併記、足切りなし" },
  { id: "Q33", impact: "material", title: "バックテスト：出力の形（軸の掛け合わせ、CSVの中身、ファイル名の日付）", provisional: "型×ATR係数ごとに、各軸の値別の周辺集計。CSVは長形式。ファイル名は実行日（JST）" },
  { id: "Q34", impact: "material", title: "バックテスト：NZDUSD は MTF の日足が無く向きを再計算できない", provisional: "H1は取得するが案は作らない（ライブと同じ）。mdに明記" },
  { id: "Q35", impact: "minor", title: "バックテスト：取得（timezone=Asia/Tokyo の日付解釈）、CSV先頭行の書式、期間とウォームアップ", provisional: "timezone=Asia/Tokyo で取得し、h1-bars.json との重なりでOHLCを自己検証。1行目 `# timezone=Asia/Tokyo`、2行目が見出し。窓=完了した365日、取得は窓の3日前から" },
  { id: "Q36", impact: "minor", title: "accounts.json の daily_loss_pct・commission_per_lot_jpy の使い道が仕様本文に無い", provisional: "読み込むが、生成器では使わない（バックテストのコストにも使わない: Q30）。値は保持" },
  { id: "Q37", impact: "minor", title: "ロット上限が0.00になる案の扱い", provisional: "不採用にせず、0.00と表示（資金に対してSL幅が大きい旨の注記）" },
  { id: "Q38", impact: "minor", title: "仕様の入力表は Pivot・前日高安を『gpt-feed.txt／intraday.json』と書くが、intraday.json に無い（daily-levels.json にある）", provisional: "gpt-feed.txt の元データである data/daily-levels.json を読む（同じ値）" },
  { id: "Q39", impact: "minor", title: "型Bの『確認条件』が仕様に無い（型Aは『帯到達後、M15が基準価格より下で陰線確定』）", provisional: "型Bには確認条件の行を出さない" },
];

const byId = new Map(QUESTIONS.map((q) => [q.id, q]));
const provisionalIds = () => QUESTIONS.filter((q) => q.status !== "confirmed").map((q) => q.id);

module.exports = { QUESTIONS, byId, provisionalIds };
