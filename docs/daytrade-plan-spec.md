# デイトレプラン自動生成 仕様（v1.1）

作成：2026-10-08（Claude、デイトレ戦略スレッド）
改訂：
- v0.2（2026-10-08）候補数の上限（最大2銘柄）を撤廃。条件を満たす案はすべて出す（本人決定）
- v0.3（2026-10-08）本人回答を反映。①イベントは既存の自社データを読む ②生成時刻を「設計3回＋状態更新は毎時」に変更 ③自社MTFフィードが稼働済み ④置き場所はFXDaily-Levels内 ⑤対象は2口座
- v0.4（2026-10-08）EA-Risk-Monitor の「9/18で停止」は誤り（キャッシュ）。ライブで10/8 18:26生成を確認
- v0.5（2026-10-08）2口座は独立／候補はすべて表示・同方向は印のみ／判定文を廃止し数字だけ／門と型に分離、型B追加、バックテストをv1.0に
- v1.0（2026-10-08）確定。型B・バックテストは本人承認
- **v1.1（2026-10-08 23時）イベント源を変更。** FXDaily-Levels に既存の `data/economic-calendar.json`（Forex Factory、9通貨、High＋Medium、当日分）が稼働していることを確認（as_of 2026-10-08T16:22:42+09:00、5件）。これを直接読む。EA-Risk-Monitor への `calendar-all.json` 依頼と `events.json` は不要。第9節に実装側からの質問への回答を追加
状態：**確定**。実装は Claude Code で行う。実装中に定義の解釈で迷う点が出たら、デイトレ戦略スレッドに戻す。
目的：GPTに毎朝出させている「デイトレ日次プラン」を、FXDaily-Levels のデータから自動で生成し、公開する。GPTはレビュー役に回し、最終的には不要にする。本人が最終判断するための材料をすべて出す。判断を機械が代行しない。

---

## 0. 設計の考え方

ルールは2種類に分ける。

| 種類 | 役割 | 根拠 |
|---|---|---|
| **門（ゲート）** | 「入ってはいけない取引」を落とす。方向・RR・コスト・SL幅・ADR消化・距離・時間帯・イベント | 本人の取引履歴の赤字パターン（RR0.26、持ち越し、コスト未考慮、9時台）から作った。優位性を生むものではなく、損失の型を防ぐもの |
| **型（セットアップ）** | 「どこで・なぜ入るか」。優位性の候補 | 現時点では**未検証**。型A（レベルへの戻り）は10/5〜10/8の4日間で有効時間内の到達1件・勝ち0。型Bを追加し、両方をバックテストと前進検証で比べる |

門は固定して運用し、型はデータで選ぶ。パラメータ（ATR係数、帯幅、TPの置き方）は日々の結果で動かさず、バックテストと2週間以上の前進検証の結果でだけ変える。

## 1. 入力

| データ | 所在 | 用途 | 状態（2026-10-08確認） |
|---|---|---|---|
| `data/gpt-feed.txt`／`data/intraday.json` | FXDaily-Levels | 現在値、当日高安、ADR消化率、前日高安、Pivot・R1・R2・S1・S2 | 既存・稼働中 |
| `data/h1-bars.json` | FXDaily-Levels | H1 ATR14、直近H1の高安群、到達判定、東京レンジ（型B） | 既存・稼働中。日本時間表記、直近500本のローリング |
| `data/daytrade-context.json` | FXDaily-Levels（`daytrade.js` が生成） | 確定M15の最終足（鮮度確認用）。`gate.state` は参考表示のみ | 既存・稼働中 |
| `data/economic-calendar.json` | FXDaily-Levels（既存） | イベント停止の算出（下記1-1） | 既存・稼働中。Forex Factory、通貨 USD/JPY/EUR/GBP/AUD/NZD/CAD/CHF/CNY、impact High・Medium、当日分 |
| `config/daytrade-rules.json` | FXDaily-Levels（既存） | `pair_currencies`（銘柄→2通貨の対応表）を読み取り専用で流用 | 既存。**変更しない** |
| `data/mtf-feed.txt`／`.json` | FXDaily-Levels | 確定月足・週足・日足の向き、ALIGNMENT_SCORE | 稼働中。10/8 06:20生成、基準日10/7、status ok |
| `EA-Risk-Monitor/data/risk-feed.json` | `https://mflab-inc.github.io/EA-Risk-Monitor/data/risk-feed.json` | ボラティリティの状態を参考情報として表示。イベントには使わない | 稼働中（10/8 19:37生成）。収録は12ペアのみ |
| `data/daytrade/accounts.json` | FXDaily-Levels（新規） | 口座ごとの `equity_jpy`、共通の `commission_per_lot_jpy`（1013）、`risk_pct`（0.5）、`daily_loss_pct`（1.5） | 新規。本人が更新 |
| H1履歴（バックテスト用） | FXDaily-Levels `data/history/h1-<銘柄>.csv`（新規） | 過去1年のH1。Twelve Data から1回だけ取得 | 新規（第6節） |

鮮度：フィードの生成時刻から20分を超えていれば、出力の先頭に「発注不可（鮮度超過）」を付ける。計算はする。GitHub Pagesの取得は生成日時を必ず読み、必要なら `?nocache=<時刻>` で取り直す。

### 1-1. イベント（v1.1で確定）

イベント源は FXDaily-Levels 既存の `data/economic-calendar.json` を直接読む。

- 形：`{ "as_of", "date", "timezone":"Asia/Tokyo", "source", "filters", "events":[ { "time_jst", "datetime_jst", "currency", "impact":"High|Medium", "event", "forecast", "previous", "scheduled_time_passed" } ] }`
- 停止の対象：その銘柄の2通貨（`config/daytrade-rules.json` の `pair_currencies`）に該当する High・Medium のイベント。`datetime_jst` の15分前〜30分後。停止中は新規のみ禁止。
- 既存の `daytrade.js` の窓（High 前15/後15、Medium は警告のみ、中銀 前30/後60 など）とは**別のルール**。既存の `gate.state` は「参考：既存ゲート」として表示だけし、停止判定には使わない。
- 当日分（JST 0:00〜24:00）しか入っていない。翌0:00〜3:00のイベントは、日付が変わった後の状態更新（毎時）で拾う。21:00の設計の出力には「翌日分のイベントは未取得」と明記する。
- ファイルが無い、`date` が当日でない、`as_of` が20分より古い場合はエラーにせず、出力に「イベント未取得」と明記して停止時間なしで生成する。
- 補完元（精度が足りないとき）：日次レポート（da-vinci-code.info SECTION 04）の元データ。中間JSONの所在は実装時に確認。

risk-feed.json はイベント源として**使わない**（12ペア固定で GBPUSD・EURJPY・NZDUSD・USDCHF が無く、`types` 14種に絞られ、窓が時間単位のため）。ボラ状態の参考情報としてだけ使う。

## 2. 門（ゲート）：全ての型に共通。`claude/GPT依頼テンプレート_デイトレ日次プラン.md` v1.2 と同じ

### 2-1. 方向
- `mtf-feed` の確定の向き。3/3 または 2/3 で向きがそろった銘柄だけ候補。0/3・1/3・Mixed は「監視のみ」。
- `mtf-feed` の `status` が ok でない、または `data_base_date` が前営業日（月曜は金曜）でないときは候補を出さず「方向根拠なし」。

### 2-2. SL（2案）・TP1・RR・コスト・ロット
- A案：基準水準の外側＋0.5×H1 ATR14。B案：＋1.0×ATR（ロットは半分）。外側へ丸める（ドル建て0.00005、円0.005）。SL幅10pips未満は不採用。
- TP1：Entryから進行方向で最初の障害（日次レベル・直近24本のH1高安群）の手前（ドル建て0.5pips、円0.7pips）。利益幅がSL幅の1.0倍未満なら不採用。
- RR＝利益幅÷損切り幅（最悪Entry基準）。追加コスト上限＝(利益幅−1.5×損切り幅)÷2.5。ドル建て1.2pips未満・クロス円1.6pips未満は不採用。
- 1pipの円価値（1ロット）：ドル建て＝10ドル×ドル円、クロス円＝1,000円、XAUUSD＝10ドル×ドル円、ドル以外決済通貨＝対円レートから換算。
- 上限ロット＝equity×risk_pct ÷ (SL幅×1pipの円価値)。0.01単位に切り捨て。**口座ごとに独立して計算**（口座をまたぐルールはない）。

### 2-3. 距離・ADR・時間帯・イベント
- 基準水準までの距離がADRの残り（ADR×(1−消化率)）を超える案は「届かない」。ADR消化80%超は不採用。
- 有効期限：翌日3:00 JST。新規は翌1:00まで。9時台と土曜0:00以降は新規なし。
- `economic-calendar.json` のうち、その銘柄の通貨に該当する行だけ、開始15分前〜開始30分後を停止時間にする。停止中は新規のみ禁止。

### 2-4. 銘柄
- 対象10銘柄（USDJPY, EURUSD, GBPUSD, AUDUSD, NZDUSD, USDCAD, USDCHF, EURJPY, EURGBP, XAUUSD）。
- 優先順位の表示：AUDUSD・EURJPY ＞ GBPUSD・EURUSD ＞ その他。USDJPY・XAUUSDは「過去の実績が悪い」の注記を付けて出す（落とさない）。

## 3. 型（セットアップ）：v1.0 は2つ

### 型A：レベルへの戻り（現行。GPT案と同じ）
- 売り：現在値より上で最も近い水準（Pivot・R1・R2・前日高値、または0.2×ATR以内に2本以上あるH1高値群の上端）を基準水準にする。Entry帯＝基準水準〜基準水準＋0.1×ATR。最悪Entry＝帯の下端。買いは反転。
- 確認条件（本人が執行時に見る。生成器は条件を文字で出す）：帯到達後、M15が基準価格より下で陰線確定。

### 型B：東京レンジのブレイク後の戻り（本人の黒字時間帯16〜21時に合わせた型）
- 東京レンジ＝日本時間9:00〜15:00のH1の高値・安値（`h1-bars.json` から計算。`daytrade-context.json` の `sessions_today.tokyo` は 09:00〜17:00 なので使わない）。
- 15:00以降にH1終値がレンジの外で確定し、その方向がMTFの向きと一致したら「ブレイク成立」。
- Entry帯＝レンジ端（ブレイクした側）〜レンジ端＋0.1×ATR（売りならレンジ安値へのリテスト。買いは反転）。追いかけない点は型Aと同じ。
- SL＝レンジの内側へ0.5×ATR（A案）／1.0×ATR（B案）。TP1＝最初の障害（前日安値・S1など）の手前。門は2節と同じ。
- 型Bは15:30の設計②から出す（06:30時点ではレンジが未確定）。

### 両方に共通
- 1つの銘柄に型Aと型Bの両方が成立する日は、両方出す（どちらを使うかは本人）。
- 出力の各案に `setup`（A／B）を付け、log.csv にも残す。型ごとの到達率・結果を分けて集計する。

## 4. 採否と表示
- 不採用条件に当たらない案は、何銘柄でも価格を付けて出す。上限なし。
- 同方向の印：候補同士で同じ通貨を同じ方向に賭けている組（例：EURUSD売り・GBPUSD売り・USDCHF買い＝ドル買い）に `same_direction` を付ける。**印だけで、落とさない。**
- 参考情報として、毎回次を数字で出す：候補数、不採用の内訳（方向根拠なし／届かない／SL幅不足／RR不足／コスト不足／ADR消化超過、各件数）、ボラの状態（risk-feed の値。収録外の銘柄は「未収録」）、既存ゲートの状態（`daytrade-context.json` の `gate.state`）。**判定文（「条件が緩い」等）は出さない。判断は本人。**
- 順位は参考として付ける：方向の強さ → 銘柄の優先 → RR。

## 5. 出力
- `data/daytrade-plan.txt`：テンプレv1.2の7項目の順。候補は条件を満たすものすべて（型A／B、A案・B案併記、同方向の印、口座別の上限ロット、距離、有効期限）＋参考情報（候補数・不採用の内訳・ボラの状態）。
- `data/daytrade-plan.json`：同じ内容を構造化。
- `data/daytrade/log.csv`（追記）：`plan_date, generated_at, run (design|status), setup (A|B), symbol, side, same_direction_group, entry_low, entry_high, sl_a, tp_a, sl_b, tp_b, rr_a, rr_b, cost_cap_a, lot_cap_a_701620, lot_cap_b_701620, lot_cap_a_702449, lot_cap_b_702449, expires_at, reached, reached_at, first_hit_a, first_hit_b, filled_ticket_701620, filled_ticket_702449`。
- 公開URL：`https://mflab-inc.github.io/FXDaily-Levels/data/daytrade-plan.txt`。

## 6. 検証（v1.0の範囲に含める）

### 6-1. 結果記録（自動、毎朝）
- 06:30の実行で前日の各案を `h1-bars.json` で採点：到達／未到達／失効後到達、到達時刻、A案・B案それぞれでSLとTP1のどちらが先か。`log.csv` を更新し、出力の6項目目に載せる。
- 約定との突き合わせは週1回、MT4取引記録の取引一覧と照合して `filled_ticket_*` を埋める（当面は手作業）。

### 6-2. バックテスト（v1.0で実装。パラメータを決めるのはここ）
- H1履歴を過去1年分、Twelve Data から1回だけ取得して `data/history/h1-<銘柄>.csv` に保存（MTFフィードの日足バックフィルと同じ手順。1銘柄あたり数リクエスト）。時刻は `h1-bars.json` と同じ日本時間表記（Twelve Data の `timezone=Asia/Tokyo`）。CSVの先頭行にタイムゾーンを書く。
- MTFの過去の向きは `mtf-feed` の履歴がないため、同じ計算定義で日足から再計算する（PR #11 の `mtf/lib/` を流用）。
- 型A・型Bそれぞれについて、門を通った案を機械的に生成し、H1で到達・SL/TP先着を判定する。イベント停止は過去分のカレンダーがなければ「停止なし」で計算し、その旨を明記する。
- 集計：到達率、勝率、平均RR、仮想損益（コスト込み）、最大連敗。軸は、型（A／B）、ATR係数（0.5／1.0）、銘柄、エントリー時間帯、曜日、ボラ状態。
- 出力は `data/daytrade/backtest-<日付>.md` と `.csv`。本人が読んで、パラメータと型の採否を決める。

### 6-3. 前進検証と切替
1. 実装PR（ブランチ上）、模擬データで単体試験。
2. 2週間の並行運用：自動案とGPT案を並べ、差異を記録。GPTにはテンプレv1.2で出させ続け、MTFの参照先は `mtf-feed.txt` に切替。
3. 自動案の到達率・結果を型別に集計。
4. 切替：自動案を正とし、GPTは「イベントの照合」と「レビュー」だけに。
5. パラメータの変更は 6-2 と 6-3 の結果でだけ行う。

## 7. 実行
| 時刻（JST） | 種別 | 内容 |
|---|---|---|
| 06:30（冬時間07:30） | 設計①＋採点 | 日次レベル確定直後。前日分を採点し、型Aの設計を出す |
| 15:30 | 設計② | 欧州時間の直前。型Aを再設計、型Bを初めて出す |
| 21:00（冬時間22:00） | 設計③ | NY時間の直前。両方を再設計 |
| 毎時00分（07:00〜翌02:00） | 状態更新 | Entry・SL・TPは変えない。距離・ADR消化・鮮度・到達／失効・停止中の印だけ更新 |

- 再設計で案を作り直すときは、前の案を「取消（再設計）」として log.csv に残す。
- GitHub Actions の別ワークフロー（`daytrade.yml`）。失敗しても `daily.yml` を止めない。

## 8. 決定済み事項の記録
1. イベント源：1-1のとおり（既存の `data/economic-calendar.json` を直接読む。risk-feed.json・EA-Risk-Monitor への追加依頼は使わない）。
2. 型B：3節の定義で採用（2026-10-08 本人承認）。
3. バックテスト：過去1年・Twelve Data（2026-10-08 本人承認）。
4. 2口座は独立。口座をまたぐルールは設けない。
5. 候補数の上限・診断文は設けない。数字だけ出す。

## 9. 実装時の補足（Claude Code からの質問への回答、2026-10-08）
1. **既存の `daytrade.js`・`config/daytrade-rules.json`・`data/daytrade-context.json` との関係：併用。** 既存の3つは intraday の手順が使っているので**変更しない**。新しい生成器は `scripts/daytrade-plan.js` として別に作り、`daytrade-context.json`・`economic-calendar.json`・`daytrade-rules.json`（`pair_currencies` のみ）は読むだけ。既存の `daytrade.js` のゲート（窓の長さ・Medium の扱い）と本仕様の停止ルールが違うのは承知の上で、本仕様の停止ルール（High・Medium、前15分〜後30分）を生成器の中で別に計算する。既存ルールと重なる定義があれば、PR の説明に差分を列挙するだけでよい（統合しない）。
2. **risk-feed.json の取得先：** `https://mflab-inc.github.io/EA-Risk-Monitor/data/risk-feed.json`（取得時に `?nocache=<時刻>` を付け、`meta.generated_intraday` を読む）。構造は `meta` / `market` / `pairs.<ペア>`。収録は12ペア（GBPJPY, AUDCAD, EURGBP, EURUSD, USDCAD, USDJPY, XAUUSD, AUDNZD, AUDUSD, EURAUD, EURNZD, EURCAD）のみなので、GBPUSD・EURJPY・NZDUSD・USDCHF は「未収録」と表示する。ボラ状態の項目名は実物に合わせる（`pairs.<ペア>.intraday` 配下を優先。無い項目は表示しない）。取得失敗は「未取得」。
3. **H1データ：** 提示どおり。`data/h1-bars.json`（日本時間、直近500本）は日々の生成・採点に使い、バックテストの過去1年分は Twelve Data から別途取得して `data/history/h1-<銘柄>.csv` に保存する。時刻は `h1-bars.json` と同じ日本時間表記にそろえる。
4. **MTFの再利用：** 提示どおり。PR #11 の `mtf/lib/` を再利用し、ブランチは main から切る（PR #12 は未マージのため触らない）。
5. **`events.json` は作らない。** 依頼文①の「events.json を読む仕組み」は、`data/economic-calendar.json` を直接読む仕組みに読み替える（形は1-1のとおり）。
