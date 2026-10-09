"use strict";

/**
 * 仕様 v1.1（docs/daytrade-plan-spec.md）が沈黙・矛盾している点の一覧と、それぞれに「いま実装している仮置きの読み」。
 * 推測で決めないための台帳。仮置きの読みは、候補を増やさない・危険側に倒れない方を選び、ここ（と、それを使う1か所）に隔離する。
 * 本人（デイトレ戦略スレッド）が回答したら、該当箇所を差し替え、status を "confirmed" にする（answer に回答の要旨）。
 * Q01〜Q44 は PR #15 のレビューで回答済み（docs/daytrade-plan-spec.md 10節）: 回答のない番号は『暫定の読みで確定』、
 * 変わったもの（Q01・Q09・Q14・Q22・Q23・Q36・Q39）は新しい読みを provisional に書いて確定。Q45〜 は実装中に新しく出た迷った点で、暫定のまま。
 * 出力（data/daytrade-plan.txt/.json）の先頭に、status が confirmed でない件数と ID を出す。
 * 詳細・代替案・根拠は docs/daytrade-plan-impl-notes.md と PR の説明。
 */
const QUESTIONS = [
  { id: "Q01", impact: "blocking", status: "confirmed", answer: "7項目の順と見出しをテンプレ v1.2 に変更", title: "txt の『テンプレv1.2の7項目の順』の中身がどこにも無い（6項目目=前日結果だけ分かる）", provisional: "7項目はテンプレ v1.2 の順に確定: 1 データ鮮度／2 候補／3 不採用の理由（末尾に参考情報）／4 価格根拠／5 イベント／6 前営業日の結果記録／7 出典。見出しもこのとおり。JSON が正本" },
  { id: "Q02", impact: "blocking", status: "confirmed", answer: "暫定の読みで確定", title: "『H1高値群（0.2×ATR以内に2本以上）』の作り方と、基準水準に使う本数の窓", provisional: "直近24本の確定H1。隣り合う高値（安値）の差が0.2×ATR以内でつながった2本以上の塊の最外端（高値群は最大、安値群は最小）" },
  { id: "Q03", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "TP1の『最初の障害』の集合（週足レベルを含むか、高値群・安値群の両方か、群のどの端か）", provisional: "日次レベル7本（Pivot・R1・R2・S1・S2・前日高値・前日安値）＋直近24本のH1高値群・安値群の両方。Entryに近い端の手前" },
  { id: "Q04", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "『3/3 または 2/3 で向きがそろった』に、残り1本が逆向きの 2/3 を含めるか", provisional: "逆向きの時間足が1本でもあれば候補にしない（監視のみ）" },
  { id: "Q05", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "NZDUSD は mtf-feed に無い（9銘柄）。2-1どおりだと常に候補にならない", provisional: "常に『方向根拠なし（MTF未収録）』。mtf 関連は変更しない" },
  { id: "Q06", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "『ドル建て／クロス円』の分類（USDJPY・EURGBP・USDCAD・USDCHF・XAUUSD）、XAUUSDの丸め単位、USDJPYの1pip円価値", provisional: "丸め・TP手前幅は円決済=円（0.005／0.7pips）、それ以外=ドル建て（0.00005／0.5pips）。XAUUSDの丸めは0.5pip=0.05。コスト閾値は米ドル決済の5銘柄=1.2pips、他（USDJPY・EURJPY・USDCAD・USDCHF・EURGBP）=1.6pips。1pip円価値は実際の値（USDJPY=1,000円）" },
  { id: "Q07", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "B案『ロットは半分』— 式がSL幅で割るので結果として半分になる。さらに半分にするか", provisional: "B案の上限 = min(式をB案のSL幅で計算した値, floor(A案の式の値×0.5, 0.01))" },
  { id: "Q08", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "A案・B案の片方だけが門を通るときの扱い（行・件数の単位・log.csvの列）", provisional: "通った案だけを出し、落ちた案は空欄＋『不採用（理由）』。件数の単位は『案』" },
  { id: "Q09", impact: "material", status: "confirmed", answer: "型Bの追加を状態更新の中（16:00〜21:00の毎時）に変更", title: "型B：15:30の設計②では、ブレイク成立（15:00開始足が16:00に確定）が原理的に起こらない", provisional: "型Bは設計②では作らない（設計②は型Aの再設計だけ）。JST 16:00〜21:59 の状態更新（run=status）の中で、東京レンジのブレイクが確定してMTFの向きと一致し、帯の外へ戻っていない銘柄を新規に設計して追加する。log.csv には run=design-b で残す。同じ計画日・同じ銘柄・同じ向きの型Bが既にあれば追加しない。型Aは設計①②③のみ" },
  { id: "Q10", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "型B：ブレイク後に価格がレンジ内へ戻っている／同日に両方向へブレイクしたときの扱い", provisional: "価格がブレイク側または帯の中にあるときだけ成立。レンジ内へ戻り済み・両方向ブレイクは不成立" },
  { id: "Q11", impact: "minor", status: "confirmed", answer: "暫定の読みで確定", title: "基準水準が見つからない／進行方向に障害が無い場合、TP1・Entry帯端の丸め", provisional: "どちらも不採用（4節の6分類とは別枠の件数）。TP1はEntry側へ0.5pip単位で丸める。Entry帯の端は価格の桁に四捨五入" },
  { id: "Q12", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "不採用の内訳の数え方（単位・評価順・『監視のみ』・NZDUSD）", provisional: "単位=案（型×銘柄×A/B案）、最初に当たった理由1つだけ数える。評価順は4節の列挙順（方向→届かない→SL幅→RR→コスト→ADR消化）。監視のみ・MTF未収録は『方向根拠なし』に数え、名前を併記" },
  { id: "Q13", impact: "minor", status: "confirmed", answer: "暫定の読みで確定", title: "plan_date の日付境界、有効期限・新規禁止の境界、停止中の案の扱い", provisional: "plan_date = JSTで『現在−3時間』の日付（06:30〜翌02:59が同じ日）。時刻はJST固定、01:00ちょうどは新規不可。案は残し、『新規不可』『停止中』の印を併記" },
  { id: "Q14", impact: "material", status: "confirmed", answer: "判定はそのまま。起動を intraday の直後にして満たす", title: "鮮度20分の対象と、入力の更新間隔の実績との乖離（毎時00分の実行の約9割が20分超）。入力を更新する責任", provisional: "鮮度は intraday.json・daytrade-context.json・h1-bars.json の as_of が20分超なら『発注不可（鮮度超過）』（判定はそのまま）。daytrade.yml は intraday の完了直後に動くので満たす。intraday.yml の更新頻度の改善は別件で、このPRでは触らない" },
  { id: "Q15", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "日次レベル（daily-levels.json）とMTFの日付確認。『前営業日』の基準（暦日かNY17時区切りか）", provisional: "daily-levels.json の session_date と mtf-feed の data_base_date が、直近に確定したNYセッション日（mtf/lib の lastCompletedSessionDate）と一致しなければ候補を出さない。errors が空であることも確認" },
  { id: "Q16", impact: "minor", status: "confirmed", answer: "暫定の読みで確定", title: "同方向の印の作り方（通貨×向き、XAUUSD、同一銘柄の型A・型B）", provisional: "通貨×向きのキーで2件以上になるものを『|』区切りで全部付ける。XAUUSDはUSD脚のみ。同一銘柄の型A・型Bも数える" },
  { id: "Q17", impact: "minor", status: "confirmed", answer: "暫定の読みで確定", title: "順位（方向の強さ→銘柄の優先→RR）の細部", provisional: "3/3＞2/3、銘柄の優先は3段、RRはA案・B案のうち小さい方（通っている案のみ）の高い順、同点は銘柄名→型A→型B" },
  { id: "Q18", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "log.csv の追記方針（statusの行、取消の表現、版の識別、採点結果、filled_ticket）", provisional: "追記のみ。designの行は設計時のみ。取消・採点の結果は run=status の新しい行。版は(plan_date,setup,symbol,side,entry_low,entry_high,sl_a,sl_b)で結ぶ。毎時のstatusはlog.csvに書かない。filled_ticket_*は過去の行から引き継ぎ、botは書き換えない" },
  { id: "Q19", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "『到達』の定義（Entry帯のどこに触れたら）。H1足しか無い限界", provisional: "H1足の高安がEntry帯と重なった最初の足（設計時刻以後に始まる足）。足の開始時刻が新規可能な時間帯の外なら『失効後到達』" },
  { id: "Q20", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "SL/TP1の先着：同一H1足に両方入る／到達した足／始値のギャップ／期限まで未決", provisional: "到達した足ではSLだけ判定、TP1は次の足から。同一足に両方ならSL先。期限（翌3:00）まで未決は『未決』" },
  { id: "Q21", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "採点の対象（『前日』の範囲）と、必要なH1足が届いていないとき", provisional: "失効を過ぎて未採点のplan_dateすべてを06:30の設計①の前に採点。足が失効まで届いていなければ採点を保留（未到達と確定させない）" },
  { id: "Q22", impact: "material", status: "confirmed", answer: "起動を workflow_run に変更、cron は削除", title: "起動方式：GitHubのscheduleは欠落・遅延する／冬時間の切替／設計③と毎時statusの重複／遅れて動いた設計", provisional: "daytrade.yml は cron を削除し、Intraday Snapshot の完了（workflow_run）で起動。実行の種類は実行時刻（JST）の窓と『その計画日・その枠の設計が済んでいるか』で決める（設計①＋採点 06:00〜08:59〔冬 07:00〜09:59〕、設計② 15:00〜16:59、設計③ 21:00〜22:59〔冬 22:00〜23:59〕の最初の実行、それ以外は状態更新）。workflow_dispatch（run・slot 指定）は手動用に残す" },
  { id: "Q23", impact: "material", status: "confirmed", answer: "Q14・Q22 とあわせて起動方式の変更で解消", title: "イベント：calendar の as_of が20分超（約9割）／date が当日でないとき『イベント未取得＝停止なし』で案が出る", provisional: "起動が intraday の直後になるので、カレンダーの as_of も20分以内になる。20分超・date が当日でないときは仕様どおり『イベント未取得』" },
  { id: "Q24", impact: "minor", status: "confirmed", answer: "暫定の読みで確定", title: "ボラ状態の表示項目（regime・flags を含めるか）", provisional: "pairs.<ペア>.intraday 配下（range_today・range_vs_adr・spike_flag・updated_at）のみ。無い・nullの項目は出さない。取得失敗は『未取得』、収録外は『未収録』" },
  { id: "Q25", impact: "blocking", status: "confirmed", answer: "暫定の読みで確定", title: "バックテスト：設計3回・再設計の重複計上と追跡の打ち切り", provisional: "各設計の案は次の設計時刻まで追跡し、未到達なら取消（未到達として分母に入れる）。Entry帯とSLが同一の再設計は継続とみなし二重に数えない。基準水準・向きが同じ先の版が既に約定していれば、後の版は数えない" },
  { id: "Q26", impact: "blocking", status: "confirmed", answer: "暫定の読みで確定", title: "バックテスト：約定価格・始値のギャップ・M15確認条件（H1では検証不能）", provisional: "約定は最悪Entry。SLの始値ギャップは始値で損切り、TP1は価格で利確。M15確認条件は未反映と明記" },
  { id: "Q27", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "バックテスト：過去の設計時点の現在値・当日高安（ADR消化率）の再現", provisional: "現在値=直前に確定したH1の終値。当日高安=NY17時（JST6:00/7:00）以降の確定足" },
  { id: "Q28", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "バックテスト：イベント停止（過去のカレンダーが無い）", provisional: "全期間『停止なし』（仕様の文言どおり）と明記" },
  { id: "Q29", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "バックテスト：軸『ボラ状態』の過去分が無い", provisional: "日足（data/mtf）から、risk-feedと同じ定義（ATR14÷終値の過去250営業日パーセンタイル、境界は risk-feed の meta.thresholds）で再計算した近似。見出しに明記" },
  { id: "Q30", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "バックテスト：『コスト込み』のコスト、仮想損益の単位", provisional: "グロス（コスト0）と、往復コスト=2-2の下限（1.2／1.6pips）を引いた値の2本。主指標はpipsとR。円は1ロット換算の参考列" },
  { id: "Q31", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "バックテスト：『エントリー時間帯』『曜日』の基準（未到達の案には約定時刻が無い）", provisional: "全指標を設計の回（06:30／15:30／21:00）と設計日の曜日で出す。約定後の指標だけ、約定時刻（JST1時間刻み）の表を別に出す" },
  { id: "Q32", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "バックテスト：平均RR・勝率・最大連敗の定義", provisional: "『計画RR平均』と『実現R平均』を別の名前で両方出す。勝率=TP1先着÷約定。最大連敗=集計グループ内を決済時刻順に並べた連続損失。件数(n)を併記、足切りなし" },
  { id: "Q33", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "バックテスト：出力の形（軸の掛け合わせ、CSVの中身、ファイル名の日付）", provisional: "型×ATR係数ごとに、各軸の値別の周辺集計。CSVは長形式。ファイル名は実行日（JST）" },
  { id: "Q34", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "バックテスト：NZDUSD は MTF の日足が無く向きを再計算できない", provisional: "H1は取得するが案は作らない（ライブと同じ）。mdに明記" },
  { id: "Q35", impact: "minor", status: "confirmed", answer: "暫定の読みで確定", title: "バックテスト：取得（timezone=Asia/Tokyo の日付解釈）、CSV先頭行の書式、期間とウォームアップ", provisional: "timezone=Asia/Tokyo で取得し、h1-bars.json との重なりでOHLCを自己検証。1行目 `# timezone=Asia/Tokyo`、2行目が見出し。窓=完了した365日、取得は窓の3日前から" },
  { id: "Q36", impact: "minor", status: "confirmed", answer: "表示に使う", title: "accounts.json の daily_loss_pct・commission_per_lot_jpy の使い道が仕様本文に無い", provisional: "daily_loss_pct は1項目目に口座別の『本日の損失上限 ◯円（x%）』を表示するだけに使う。commission_per_lot_jpy は各案の往復手数料（円）の表示に使う（バックテストのコストには使わない: Q30）" },
  { id: "Q37", impact: "minor", status: "confirmed", answer: "暫定の読みで確定", title: "ロット上限が0.00になる案の扱い", provisional: "不採用にせず、0.00と表示（資金に対してSL幅が大きい旨の注記）" },
  { id: "Q38", impact: "minor", status: "confirmed", answer: "暫定の読みで確定", title: "仕様の入力表は Pivot・前日高安を『gpt-feed.txt／intraday.json』と書くが、intraday.json に無い（daily-levels.json にある）", provisional: "gpt-feed.txt の元データである data/daily-levels.json を読む（同じ値）" },
  { id: "Q39", impact: "minor", status: "confirmed", answer: "型Bにも確認条件を出す", title: "型Bの『確認条件』が仕様に無い（型Aは『帯到達後、M15が基準価格より下で陰線確定』）", provisional: "型Bにも型Aと同じ M15 の確認条件を出す（売り：帯到達後、M15 がレンジ安値より下で陰線確定。買いは反転）" },
  { id: "Q40", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "イベント停止の窓の両端（『15分前〜30分後』）を含むか。毎時00分の状態更新が :15／:30 のイベントの端に当たる", provisional: "両端を含む（既存 daytrade.js の判定と同じ）。:30 のイベントは翌:00の状態更新でも『停止中』になる" },
  { id: "Q41", impact: "minor", status: "confirmed", answer: "暫定の読みで確定", title: "SL幅10pips未満の判定は、外側への丸めの前か後か（実効の下限が9.5〜10pipsで変わる）", provisional: "丸めた後のSL幅で判定（仕様の文の順どおり）" },
  { id: "Q42", impact: "material", status: "confirmed", answer: "暫定の読みで確定", title: "daytrade-context.json は『確定M15の最終足（鮮度確認用）』とあるが、20分の判定をファイルの as_of とM15最終足のどちらで行うか", provisional: "判定は as_of のみ。M15最終足の最古の時刻と data_status が OK でない銘柄は、出力に参考表示するだけで発注可否には使わない" },
  { id: "Q43", impact: "minor", status: "confirmed", answer: "暫定の読みで確定", title: "日付をまたぐイベント（23:30〜23:59 の窓が翌0:00以降に及ぶ）の扱い。カレンダーは当日分のみ", provisional: "窓の後半は適用しない（日付が変わるとカレンダーから消える／未取得のため）。仕様の『翌0:00〜3:00は日付が変わった後の状態更新で拾う』の範囲のみ" },
  { id: "Q44", impact: "minor", status: "confirmed", answer: "暫定の読みで確定", title: "risk_pct=0.5 の単位（式は equity×risk_pct と書かれ、文字どおりだと50%）", provisional: "パーセント（0.5% ）として equity×0.5÷100 で計算" },
  { id: "Q45", impact: "minor", title: "Q09 は『設計②は型Aの再設計だけ』と書くが、設計③の型Bの扱いは書かれていない", provisional: "設計③は仕様 7節どおり型A・型Bの両方を再設計する（状態更新で追加した型Bと同じ版なら続き、版が違えば取消して新しい版）" },
  { id: "Q46", impact: "minor", title: "Q09『16:00〜21:00 の毎時実行』の範囲。実行は intraday の完了ごとで、毎時とは限らない", provisional: "状態更新（run=status）の実行時刻が JST 16:00〜21:59 のものを対象にする（22:00 以降は追加しない）" },
  { id: "Q47", impact: "minor", title: "Q09『直前に確定した H1 がレンジの外で終値確定し MTF と一致した時点』の判定を、直前の1本に限るか", provisional: "追加の時点で、15:00開始以降に確定した足のどれかがレンジ外で終値確定（evaluate の型B条件＝片方向のみ・MTFと一致・帯の外へ戻っていない）していれば追加する。直前の1本に限らない（実行が間引かれても取りこぼさない）" },
  { id: "Q48", impact: "minor", title: "設計①②③がすべて抜けた日にも、状態更新で型Bを追加するか", provisional: "追加する（候補は型Bだけ。『設計なし』の印は残り、発注不可）" },
  { id: "Q49", impact: "minor", title: "Q22『最初の実行は log.csv のその計画日・その枠の design 行で判定』— 候補が0件の設計は log.csv に行が残らない。手動で窓の外に作った設計の枠", provisional: "plan.json の設計の履歴（designs）を正とし、履歴が無いときだけ log.csv の design 行を生成時刻の窓で枠に当てはめる" },
  { id: "Q50", impact: "minor", title: "workflow_run の起動条件（Intraday Snapshot が失敗・キャンセルしたとき、main 以外のとき）", provisional: "main の Intraday Snapshot が success または failure で完了したときだけ動く（cancelled・skipped と main 以外は除く）。失敗でも入力の鮮度は出力に出る" },
  { id: "Q51", impact: "minor", title: "起動が intraday の完了ごと（名目15分ごと）になるため、状態更新の頻度と時間帯・土日の扱い", provisional: "状態更新は JST 07:00〜翌02:59 の実行だけ、1時間に1回まで（同じ時間内の2回目以降は何もしない）。土日の計画日（金曜の有効期限＝土曜3:00 以降）は何もしない" },
  { id: "Q52", impact: "minor", title: "『各案の往復手数料（円）』— commission_per_lot_jpy が往復か片道か、何に掛けるか", provisional: "commission_per_lot_jpy を往復・1ロットあたりと読み、各案の口座別の上限ロット×commission_per_lot_jpy（円未満は四捨五入）を表示する" },
  { id: "Q53", impact: "minor", title: "『本日の損失上限 ◯円（1.5%）』の計算", provisional: "口座別に floor(equity_jpy × daily_loss_pct ÷ 100)。表示だけで、判定には使わない" },
  { id: "Q54", impact: "minor", title: "3項目『不採用の理由（1案1行）』の単位と範囲、MTFの方向の一覧の置き場所（7項目に専用の区画がない）", provisional: "1案＝型×銘柄×A/B案。6分類に入らない理由（基準水準なし・障害なし・入力欠落）は『（6分類外）』と併記。型Bの未成立は不採用に数えず参考情報に1行。MTFの方向は、候補の各行（MTF 3/3 Down…）と不採用の理由（方向根拠なし〔監視のみ …〕）に出し、全銘柄の方向は JSON の directions に残す" },
];

const byId = new Map(QUESTIONS.map((q) => [q.id, q]));
const provisionalIds = () => QUESTIONS.filter((q) => q.status !== "confirmed").map((q) => q.id);

module.exports = { QUESTIONS, byId, provisionalIds };
