# 日米2年金利フィード 仕様書

- 版：v1.2（2026-10-08）
- 目的：USD/JPY の「日米の政策比較」の材料として、公開データの日米2年国債利回りと、その金利差の5営業日の動きを、機械的に分類した結果（判定）とともに、`data/rates.json` と GPT フィード（`data/gpt-feed.txt`・`data/gpt-feed.html`）に出す。
- 範囲：値・日付・5営業日差・判定・出典を出す。トレード判定ではない。既存の `fetch.js`・`intraday.js`・`daily-levels.json` には触れない（`build-feed.js` に区画を足しただけ。7節）。
- 根拠の調査：swing-flow リポジトリの `out/rates_survey_20261007.md`（2026-10-07。入手先・形式・公表時刻・利用条件・5営業日差の分布）。

## 1. 用語

| 語 | 意味 |
|---|---|
| 米2年 | 米財務省 Daily Treasury Par Yield Curve Rates の `2 Yr`（%）。par yield（債券等価ベース） |
| 日2年 | 財務省「国債金利情報」の `2年`（%）。流通市場の固定利付国債の実勢価格に基づく半複利最終利回り |
| 金利差 | 米2年 − 日2年。**両方に値がある日だけ**作る |
| 5営業日差 | その系列で値がある日を数え、5つ前の日との差（bp）。米2年・日2年・金利差それぞれ、自分の系列の日で数える（祝日が日米で違うため、遡る日が系列ごとに違う） |
| ミリ% | 0.001%を1とする整数。計算はすべてこれで行う（1bp ＝ 0.01% ＝ 10ミリ%） |

## 2. 取得先

| 項目 | 内容 |
|---|---|
| 米2年（一次） | 米財務省のCSV（年ごと）`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/<年>/all?type=daily_treasury_yield_curve&field_tdr_date_value=<年>&page&_format=csv`。UTF-8、日付 `MM/DD/YYYY`、新しい日付が先頭、列 `2 Yr` |
| 米2年（照合） | **同じ財務省のXML** `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=<年>`（Atomフィード。`NEW_DATE`・`BC_2YEAR`）。CSVと値を比べ、`xml_check.status` を次のとおりにする：`match`（判定に使う日付〔最新日と5営業日前の日〕がXMLにあり、共通の日付がすべて同じ値）／**`mismatch`（共通の日付で値が違う日が1日でもある。取得・照合の問題として記録し、判定できません）**／`incomplete`（値の違いは無いが、判定に使う日付がXMLに無い、または共通の日が無い＝照合できていない。XMLの更新が遅れた場合など）／`unavailable`（XMLを取得できない）。**`incomplete`・`unavailable` は判定を止めない**（照合できていないことを `xml_check` とフィードに出す。止めるかどうかは運用で決める）。`match` と書くのは、判定に使う値を実際に照合できたときだけ |
| **FREDは使わない** | 米2年は財務省のCSVを一次とする（調査で、財務省CSV・XMLとFRED DGS2は値が一致したが、FREDは1営業日遅い。FREDの規約に自動取得（scraping等）の禁止の文があり、位置づけを確認できていないため） |
| 日2年 | 財務省「国債金利情報」`https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv`（当月）と `.../data/jgbcm_all.csv`（過去分）。**Shift_JIS（CP932）**、日付は**和暦の略号**（`R8.10.6`＝令和8年10月6日。S=昭和 H=平成 R=令和。月日は0埋めなし）、古い日付が先頭、列 `基準日,1年,2年,…`、休日の行は無い、満期の値が無い所は `-`、末尾に空のカンマ行と「※…」の注意書き。当月ファイルの行が12行未満（月初）のときだけ、全期間ファイル（約1.2MB）も取って重ねる。全期間ファイルを取得できなくても、当月ファイルだけで5営業日差まで足りれば続行する（足りなければ取得の問題として記録し、判定できません）。公式の公表は「翌営業日午前9時30分頃」（財務省FAQ）。実測では `jgbcm.csv` の Last-Modified が日本時間の8:30（2026-10-07）で公式より早いが、ファイルがいつから取れるかは確認できていないため、9:40 を「公表済みとみなす時刻」にしている |
| 祝日 | 内閣府「国民の祝日」CSV（Shift_JIS）`https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv`。取得できなければ、同梱の `rates/jp-holidays.csv`（2022〜2027年）だけで続行する。`--check-fresh` は同梱の表だけを使う（外部へ接続しない） |

形式が想定と違うとき（列名・日付・値）は、黙って捨てずに取得の失敗として扱う。ただし**年初**は、その年の最初の行が出るまで、財務省のその年のCSVが**本文が空のHTTP 200**で返る（2027年のCSVで確認）。行が無い年は空として扱い、前の年のCSVで続行する（米国の値の年は米東部の年。両方の年とも1行も無ければ失敗）。

## 3. 計算

- 値は小数第3位までを整数（ミリ%）にして持つ。足し引き・比較はすべて整数（浮動小数の丸めを使わない。境界ちょうどの判定がずれないため）。
- 金利差 ＝ 米2年 − 日2年（両方に値がある日だけ）。単位 %pt。
- 5営業日差（bp）＝（最新日の値 − 5つ前の日の値）÷ 10ミリ%。小数第1位まで（ミリ%の整数の差を10で割るので、丸めは入らない）。
- 履歴の穴の確認：直近30行の範囲に、開いているはずの日（日本は営業日、米国は規則で「開」の日）の行が無ければ、5営業日差が正しく出ないので取得の問題として記録し、判定できません。

## 4. 判定

金利差の5営業日差が

| 条件 | 判定 |
|---|---|
| −10bp 以下 | **円高方向**（米金利が日本より下がった＝金利差の縮小） |
| +10bp 以上 | **円安方向** |
| その間 | **はっきりしない** |

- しきい値は `rates/config.js` の `THRESHOLD_BP`（10）。**境界（ちょうど ±10bp）を含む**（−10.0bp は円高方向、+10.0bp は円安方向）。
- 判定の結果としきい値は、`rates.json` の `judgment`（`label`・`threshold_bp`・`rule`・`basis`）と、フィードの区画に出す。
- 次のいずれかのとき、判定は **「判定できません」** にする（`judgment.available=false`、理由を `reason` に書く）：
  - 米2年・日2年のどちらかが、期待する最新日（5節。**金利差を作れる最新の営業日**）まで更新されていない（古い）。
  - どちらかが `stale`（取得に失敗して前回の値のまま）、または値が無い。
  - 財務省のCSVとXMLが一致しない、履歴に穴がある、祝日表が足りない等、取得・照合の問題が残っている。
  - 金利差の5営業日差を計算できない（両方に値がある日が足りない、最新日が期待より古い）。
- 古さは**取得した時点ではなく、表示する時点の時刻で判定し直す**（`rates/lib/view.js` の `evaluate`）。取得に失敗して `rates.json` が更新されないまま日が進んでも、古い判定が出続けない。

## 5. 鮮度・時刻・失敗時の扱い

### 5-1. 期待する最新日

| 系列 | 期待する最新日 |
|---|---|
| 日2年 | D日の値は、次の営業日の午前9時30分頃に公表される（財務省FAQ）。**いま公表済みの営業日**（今日が営業日で9:40以降なら今日、そうでなければ直前の営業日）の、**1つ前の営業日**。営業日は、土日・内閣府の祝日・12/31・1/1〜1/3 を除く（2023-01〜2026-10 の財務省の全行と一致。試験で確認） |
| 米2年 | 米財務省は通常、米東部18:00までに掲載する。米東部18:30以降なら現地の今日、前なら前日から数え、休場の日を飛ばした最初の日 |
| **古さを見る基準（必要な最新日）** | 米・日それぞれの期待する最新日の**古い方**。米2年も日2年も、この日まで更新されていれば「古くない」。日2年は翌営業日の9:30頃にしか新しくならないため、公表前（毎朝 9:40 まで）と週末・月曜の朝は、米2年だけ新しい日があっても金利差は作れない。米のほうが先に新しくなる時間帯を「米が古い」と数えると、毎朝約2時間と、土曜の朝から月曜の朝まで、判定できません になってしまうため。金利差の最新日がこの日より古いときも、判定できません |

- 米国の休場は、連邦の祝日などの規則（日曜の祝日は翌月曜が休場）で決める。**規則だけでは決まらない日**（聖金曜、土曜の祝日の振替の金曜）は「不確か」とし、行が無いまま米東部18:30から24時間が過ぎたら休場だったと見なす（2023-04-07・2023-11-10・2026-04-03は開、2024-03-29・2025-04-18・2026-07-03は閉。試験で確認）。
- 祝日表にその年が無いときは営業日を決められない。取得の問題として記録し、判定できません。同梱の `rates/jp-holidays.csv` は、内閣府CSVが次の年の分を載せたら更新する（年1回）。

### 5-2. 実行の状態（`generation.status`）

| status | 意味 | `rates.yml` の最後の確認 |
|---|---|---|
| `ok` | 取得・照合の問題が無く、米・日とも最新 | 緑 |
| `pending` | 取得の問題は無いが、まだ最新でない。**日本の営業日の10:30より前**（公表待ち） | 緑（再試行を待つ） |
| `partial` | 取得・照合の問題がある、または10:30を過ぎても最新でない | 赤 |
| （作らない） | 米・日ともに取得できない：`rates.json` を更新せず終了コード1 | 古ければ赤 |

- `generation.errors` に取得・照合の問題を書く。`retry_expected` は、`rates.yml` の schedule（月〜金 JST 〜13:45）による同日中の再試行が残っているかの目安（status が ok でなく、実行が JST 14時前）。`rates.yml` は `intraday.yml`・`daily.yml` の完了（`workflow_run`）でも起動するため、**14時以降も自動の再取得は続きうる**。`retry_expected` が false でも「自動の再試行が無い」とは限らない（実際より悲観的に言う側。8-2）。
- 片方だけ失敗したときは、成功した側だけ更新し、失敗した側は前回の値に `stale: true` を付けて残す（null で上書きしない）。
- 前回と内容（取得時刻などを除く）が同じなら、`rates.json` を書き換えない（再試行のたびにコミットが増えない）。
- 時刻の注意：日本の値は東京の、米国の値は米東部の観測日。同じ暦日どうしを並べているが、約13時間ずれる。

## 6. 出典（フィードの区画に必ず書く）

- 米財務省：`出典：米財務省 Daily Treasury Par Yield Curve Rates（https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics）`
- 財務省（日本）：公共データ利用規約（第1.0版）PDL1.0 の書き方（出典、加工した旨と主体）
  `出典：財務省「国債金利情報」（https://www.mof.go.jp/jgbs/reference/interest_rate/index.htm）、PDL1.0（https://www.digital.go.jp/resources/open_data/public_data_license_v1.0）を加工して作成（5営業日の差と金利差の計算：MFlab-inc／FXDaily-Levels）`
  加工の主体の名称は `rates/config.js` の `PROCESSOR_NAME`。
- 米財務省のデータの利用条件・出典の書き方を定めた文は、調査した範囲では確認できなかった（出典は自主的に記載している）。

## 7. 出力

### 7-1. `data/rates.json`（`schema: "fxdaily-levels/rates/v1"`）

`as_of`（JST）／`us2y`・`jp2y`（`date`・`value`・`unit`・`source`・`fetched_at`・`stale`・`expected_date`・`fresh`。米は `xml_check`、日は `last_modified`・`published_hint`）／`spread`（`date`・`value`・`unit`）／`change_5d`（`us`・`jp`・`spread`：`value_bp`・`date`・`base_date`・`value`・`base_value`）／`judgment`（`available`・`label`・`threshold_bp`・`rule`・`basis`・`reason`）／`generation`／`calendar_source`／`citations`／`notes`。

### 7-2. フィード（`build-feed.js`）

- `data/rates.json` があるときだけ、`gpt-feed.txt`・`gpt-feed.html` に出す。**無いとき、フィードの出力は従来と同じ**（試験で確認）。
  - `daily as_of` のヘッダ行（txt は3行目、html は `<p>` の行）の末尾に ` | rates as_of: <JST>` を足す。
  - サマリーの `【Market Sentiment】` の後に `【JP-US 2Y Rates】` の区画（値と日付、金利差、5営業日差、判定としきい値、観測時刻の注意、出典2行）を足す。
  - 末尾に `Raw: rates.json（表示時点の判定に直したもの）` を足す。
- 区画の判定は、表示する時点で鮮度を判定し直した値（4節）。古い／stale のときは「判定できません」と理由を出す。
- **フィードを作る（`build-feed.js` を実行して `data/gpt-feed.*` をコミットする）のは `daily.yml` と `intraday.yml` だけ**。`rates.yml` はフィードを作らない。`data/rates.json` の更新は、次にそのどちらかが走ったときにフィードへ反映される（8-1）。
- フィードの先頭の注意書き「事実データのみ。トレード判定は含まない」は変えていない。区画の判定は金利差の変化の機械的な分類で、トレード判定ではない旨を区画に書いている。

## 8. ワークフロー

| ファイル | 内容 |
|---|---|
| `.github/workflows/rates.yml`（JP-US 2Y Rates） | 起動は3系統。(1) `schedule`：`40,55 0 * * 1-5`（JST 09:40・09:55）と `*/15 1-4 * * 1-5`（JST 10:00〜13:45、15分毎）。(2) **`workflow_run`：`Intraday Snapshot`（`intraday.yml`）または `Daily FX Data`（`daily.yml`）が完了するたび**（`types: [completed]`、`branches: [main]`。上流の成否は問わない。`intraday.yml`・`daily.yml` は変更していない）。(3) `workflow_dispatch`（手動・外部cron）。**(1)(2) と、`if_stale=true` の (3) は `--if-stale`**：公表前・最新で健全なら外部へ接続せず終了する（最新でない間は、起動のたびに取得し直す）。`if_stale` オフの手動実行だけは、常に取得する。取得 → `data/rates.json` をコミット（push が拒否されたら rebase して再試行、3回まで）→ 最後に `--check-fresh` で赤くする（先にpushしてから赤にする）。`concurrency: rates-data`（`cancel-in-progress: false`）で、同時に複数起動しても動くのは1つずつ（実行中1つ＋待機中1つまで。待機中の run が、新しい待機中の run に置き換えられて取り消されることがある。10節）。`actions/checkout` は `ref: ${{ github.ref }}` を明示し、実行を始めた時点のブランチの先頭を読む（待たされた run が古い `rates.json` を読まないため）。**書くファイルは `data/rates.json` だけ**（`data/gpt-feed.*` は書かない。フィードへの反映は `intraday.yml`・`daily.yml` に任せる。8-1）。起動の回数と所要時間の見込みは 8-2 |
| `.github/workflows/rates-tests.yml` | `rates/`・`build-feed.js`・`.github/workflows/rates*.yml`・`intraday.yml`・`daily.yml` を変える PR と main への push で、`node --test rates/test/*.test.js` を実行する（外部へは接続しない。本番のデータ更新とは独立）。`intraday.yml`・`daily.yml` を含めるのは、`rates.yml` の `workflow_run` が参照する `name:` の一致を `rates/test/workflows.test.js` が確かめるため |
| `.github/workflows/rates-freshness-check.yml` | JST 10:37・11:37（月〜金）に `--check-fresh`。朝のうちに更新されていなければ赤にする。`rates.yml` が1本も起動しなかった場合（scheduleも、`intraday.yml`・`daily.yml` の完了による `workflow_run` も）の見張り。この見張り自体も schedule なので、発火が遅れる・抜ける可能性は残る |
| 外部cron（リポジトリ外・**任意**） | 登録しなくても、`rates.yml` は schedule と `workflow_run`（`intraday.yml`・`daily.yml` の完了）で起動する。**UTC 00:45（＝JST 09:45）月〜金**に確実に1回起動したいときだけ、`rates.yml` を `workflow_dispatch`（`if_stale=true`）で呼ぶ（`daily.yml` と同じ運用）。`workflow_run` の起動は上流の完了を待つので時刻どおりではない（8-2）。登録の手順は [CRON_SETUP.md](CRON_SETUP.md) |

- Twelve Data は使わない（APIキー不要）。`mtf/lib/guard.js` の待機の対象（Daily FX Data・Intraday Snapshot）と呼び出しは重ならない。
- `rates.yml` の schedule（cron）の最終時刻を変えたら、`rates/config.js` の `SAME_DAY_RETRY_UNTIL_JST_HOUR` も揃える。この値は schedule 基準の目安で、`workflow_run` による再取得はその後も起こりうる（5-2）。

### 8-1. フィードへの反映（`rates.yml` はフィードを作らない）

- `data/gpt-feed.*`・`data/feed.csv`・`data/history.csv` を書くワークフローは `daily.yml` と `intraday.yml` の2つのまま増やさない（`intraday.yml` の `git pull --rebase` の衝突の原因を増やさないため）。
- `rates.yml` が `data/rates.json` をコミットしたあと、フィードの【JP-US 2Y Rates】の区画とヘッダの `| rates as_of: …` に載るのは、次に `intraday.yml`（schedule `2,17,32,47 * * * 1-5` ほか。`daily.yml` の完了でも起動する）か `daily.yml`（外部cronの JST 06:20・07:20・08:20 ほか）が `build-feed.js` を実行したとき。
- **反映までの時間は、15分とは限らない**。`intraday.yml` の schedule は GitHub の配信が遅れる・抜けるため、実際の起動は 15 分毎より少ない。実測（GitHub Actions の実行履歴、2026-09-29〜10-07 の `intraday.yml` の直近60回）：schedule 28・`daily.yml` 完了による起動 29・手動 3。**`rates.json` の更新からフィードに載るまでを実測できたのは1回だけ**：10/7 19:47 の `rates.json`（手動実行）が、10/8 01:19 の `intraday.yml` で初めてフィードに載った（5時間31分後。その間の `intraday.yml` の起動は無く、18:01 の次が 01:19）。参考（試算）：`rates.json` が 9:45 に更新されたと仮定すると、JST 09:45 以降の最初の `intraday.yml` の起動は、10/2（金）10:24（39分後）、10/5（月）12:50（3時間5分後）、10/6（火）09:57（12分後）、10/7（水）10:15（30分後）。この4日は `rates.json` が実際には更新されておらず（`rates.json` の初回のコミットは 10/7 19:47）、今後の遅れを保証するものでもない。
- **`workflow_run` を足したあとの注意**：`rates.yml` の起動は上流（`intraday.yml`・`daily.yml`）の完了の直後なので、その上流が作ったフィードは、完了前の `rates.json` を読んでいる。更新を載せたフィードは、必ず**さらに次の** `intraday.yml`／`daily.yml` の実行で出る。上の実測は `workflow_run` を足す前のもので、足したあとの遅れは未測定（確認できていない）。`rates.json` 自体の更新は、外部cronを登録していない間は、最初の上流の完了まで待つ（8-2）。9:45 の外部cronを登録していれば、実績の営業日33日のうち32日は外部cronのほうが先に更新する（9:45 より前に最初の完了があったのは、9/4 の手動実行の1日だけ）。
- 区画の判定は `build-feed.js` が走った時点の `data/rates.json` を、その時点の時刻で見直して出す（4節）。反映前は、前回の `rates.json` が古ければ「判定できません」と出るので、古い値が最新として載ることはない。
- `rates.yml` の最後の `--check-fresh`（と `rates-freshness-check.yml`）が見るのは `data/rates.json` の鮮度で、フィードへの反映は見ない。

### 8-2. 起動の回数と所要時間（`workflow_run` を足したあと）

`workflow_run` による起動の回数は、`intraday.yml` と `daily.yml` の完了の回数と同じになる見込み（`daily.yml`→`intraday.yml` の組では、8/28 以降の111件がすべて1対1で、完了の1〜4秒後に起動した。`intraday.yml`→`rates.yml` の組は、マージ後の確認〔下記〕で確かめる）。`daily.yml` が1回完了すると、`daily.yml` 自身の完了と、その完了で起動した `intraday.yml` の完了で、約30秒の間隔をおいて2回起動する。

- **実績（見込みの基準）**：GitHub Actions の実行履歴（`intraday.yml` 600件・`daily.yml` 171件）の完了時刻を JST に直して数えた。2026-09-08〜10-07 の月〜金22日で、**1日あたり平均12.9回（最小3・最大17）**。曜日別は、月 平均4.3（3〜5）、火〜金 平均14.8（12〜17）、土 平均13.0（12〜16）、日 0。直近10営業日（9/24〜10/7）は 平均11.9回（最大16）。2026-08-19〜8/26 は、火〜金の日が 1日37〜43回（月曜 8/24 は26回。37は 8/25 の main のみの数で、全ブランチなら40）だった。この間も `intraday.yml` の schedule は 4本/時（1日96本）のうち 1日34〜41本（8/19〜8/26 の合計 229/588＝約39%）しか起動せず、8/19 の起動間隔は中央31分・最大81分だった。8/27 以降に減った原因は確認できていない。
- **理論上の上限**：すべての cron が欠けずに届いた場合の完了数は、月 72・火〜金 152（外部cronの `daily.yml` 呼び出しの分を足すと158）・土 92（98）・日 0。実績は上限の約1割。上限に達した日は観測されていない（最も届いていた 8/19〜8/26 でも、火〜金は上限の約24〜28%）。schedule の配信が戻る見込みの根拠は無いので、この数は計算上の天井としてだけ読む。
- **`rates.yml` 全体の1日の起動**：`workflow_run` 分（上の実績。平均12.9）＋`rates.yml` 自身の schedule（月〜金で最大18本。`rates.yml` で届く割合は未測定で、10/8 は 9:40〜11:20 に0本だった。参考：`intraday.yml` の schedule は 9/8〜10/7 で名目の6.2%）＋外部cron（登録した場合は平日に1回）＋手動実行。schedule が届いても、日の最初の取得のあとは即終了なので、「大半が即終了」は変わらない。
- **時間帯**：月〜金の完了の 36% が 9:40 JST より前、27% が 9:40〜13:45、37% が 13:46 以降。外部cronの `daily.yml` 呼び出し（JST 06:20・07:20・08:20）と、その完了で起動する `intraday.yml` は、必ず 9:40 より前に完了する。
- **外部へ接続しない即終了が大半**：外部へ取りに行くのは、営業日の最初の1回だけ。残りは、公表前（日本の営業日の 9:40 より前）か、最新で健全なので、外部へ接続せずに終了する。リポジトリの判定（`run-daily.js --if-stale`）を過去の完了時刻に当てはめた再現（取得は常に成功すると仮定）では、8/19〜10/7 の36平日で、起動580回のうち取得32回（5.5%）、**即終了548回（94.5%）**（公表前 227・最新で健全 321）。直近10営業日は、119回のうち取得10回、即終了109回（91.6%）。取得は1日に最大1回で、日本の祝日の日は0回。
- **所要時間**：取得の手順（`node rates/run-daily.js --if-stale`）自体は、外部へ接続しないとき数ミリ秒〜0.1秒未満。ジョブ全体（ランナーの起動・checkout・setup-node を含む）は**十数秒**の見込み：`daily.yml` の外部へ接続しない実行が 12〜20秒（9/8 以降の中央値 16秒）、`rates.yml` の取得ありの手動実行が約50秒（10/7 52秒・10/8 50秒。うち取得37秒）。**「数秒」ではなく「十数秒」**。`rates.yml` の即終了そのものの実測はまだ無い（マージ後の最初の `workflow_run` の実行で確かめる）。
- **課金**：このリポジトリは public で、標準の GitHub ホストランナーは無料（GitHub Docs「GitHub Actions billing」〔旧題 About billing for GitHub Actions〕）。private にした場合は、ジョブごとに分単位に切り上げられる（GitHub Docs「Actions runner pricing」）ため、1回の起動が1分として数えられる（起動回数 × 1分が下限）。
- **取得が失敗している間**：未公表・財務省の障害などで「最新でない」状態が続くと、`--if-stale` は起動のたびに取得し直す。取得先への GET は、1回あたり通常4回（祝日CSV・米CSV・米XML・日の月次CSV）、日の月次ファイルが12行未満の月の最初の約12営業日は5回、1月の年初は最大6回。429・5xx・タイムアウトは1URLにつき最大3回まで試すので、全断のときは9回、一部だけ落ち続けるときは最大12回。日本の営業日の公表後（9:40 JST 以降）の起動数は、直近20平日（9/10〜10/7）のうち祝日3日を除く営業日17日で、1日平均8.0回（最大13回）。障害が起きた当日は、その回数の取得と、同じ数の赤い実行（`Assert rates freshness`。単なる未公表なら 9:40〜10:30 の分は pending で緑）が出る。**取得に成功しても直らない種類の状態**（履歴に欠けた営業日があるときの `generation.errors`）は、欠けた日から約30営業日（約6週間）続き、その間は起動のたびに取得し直して `partial`＝赤になる（夜間・9:40 前・土曜の起動も含む全起動で、平日平均12.9回）。上流が行を補えば、次の取得で ok に戻る。
- **起動の時刻**：`workflow_run` の起動は上流の完了を待つので、時刻どおりではない。9:40 JST 以降の最初の完了は、8/19〜10/7 の36平日（日本の祝日3日と、最初の完了が手動実行〔workflow_dispatch〕だった日11日を含む）で、9:40 の 3〜191分後（中央34分、p90〔10回に9回はこの時間以内〕77分、最大191分〔10/5 月曜〕）。手動実行も `workflow_run` を発火させるので、当時あれば実際に起きた起動時刻としては正しい。手を出さない場合の目安として、日本の営業日33日で、手動実行の日をその日の次の自動の完了に置き換えると、中央43分、p90 約2時間、最大191分。9:40〜13:45 に完了が1件も無い平日は、この期間には無かった。**外部cronを登録しない場合**、その日の最初の完了が 10:37 JST より遅い営業日は、33日のうち8日（手動実行を除いて数えると10日）、直近10営業日で5日あり、その日は 10:37 の見張り（`rates-freshness-check.yml`）が赤になりうる（見張り自体も schedule なので、10:37 近くに届いた場合に限る）。時刻どおりに起動したいときは、外部cronを併用する（任意。CRON_SETUP.md）。2026-10-08 は、`rates.yml` の schedule が 9:40〜11:20 に起動しなかったが、`workflow_run` があれば 10:09 の `intraday.yml` の完了で取得でき、手動実行（11:20）より約70分早かった計算。
- **マージ後の確認**：`workflow_run` は main にあるファイルでだけ効くため、PR の段階では起動を確かめられない。マージ後、Actions → JP-US 2Y Rates を event=`workflow_run` で絞り込み、(a) `Intraday Snapshot`／`Daily FX Data` の完了の直後に起動していること、(b) `Fetch JP-US 2Y rates` のログが「公表前…スキップ」「既に最新のためスキップ」のどちらか（営業日の最初の1回は「取得が必要」）であること、(c) 所要時間、を確かめる。

## 9. 試験

```
node --test rates/test/*.test.js
```

- `table20.test.js`：**調査（2026-10-07）の「直近20営業日の表」を、実データ（`rates/test/fixtures/`）から再現する**。金利差・5営業日差・5/10/15bp の判定が表と一致すること（計算の単位）と、10bp の列がフィードの計算（`buildSnapshot`）で一致すること。
- `snapshot.test.js`：境界（±10.0bp は含む、±9.9bp は含まない）、古い・stale・取得失敗・CSVとXMLの不一致・履歴の穴・祝日表不足で「判定できません」になること、10/12 の週。
- `calendar.test.js`：日本の営業日の規則が財務省の全918行と、米国の規則が財務省CSVの全941行と一致すること、期待する最新日。
- `calc.test.js`：整数での判定・表示（境界、小数のしきい値、`-0.00` を出さない）。
- `parse.test.js`・`http.test.js`・`view.test.js`・`run-daily.test.js`：形式、再試行、表示時点の鮮度（週末・月曜の朝、公表待ち）、取得の失敗時の挙動、年初（本文が空のCSV）、全期間ファイルの失敗、9:40の境界、`retry_note` の文言（ok・14時前・14時以降）。
- `workflows.test.js`：`rates.yml` の起動条件が壊れていないこと（外部へは接続しない。YAML の読み込みライブラリは使わず、必要な行だけを読む。コメント・空行・CRLF は読み飛ばす）。検査の関数 `validate()` を、(1) 実ファイル、(2) 19通りの改悪、(3) 意味が同じ7通りの書き換え、に当てて、検出と誤検出なしを確かめる。検査する項目：`workflow_run` の上流名が `intraday.yml`・`daily.yml` の `name:` と一致すること、`types: [completed]`・`branches: [main]`、自分自身を上流に入れていないこと、schedule 2本・`workflow_dispatch`（`if_stale` の型と既定）・`concurrency`（`rates-data`、`cancel-in-progress: false`）・`permissions`（`contents: write`）が残っていること、ジョブ直下に `if:` が無いこと、`checkout` の `ref`、取得の式（手動実行で `if_stale` オフのときだけ全取得、それ以外は `--if-stale`。式の真理値表）、`git add` が `data/rates.json` だけであること。(2) の改悪：上流名の誤記・上流を落とす・自己参照、`types`・`branches` の変更、式の改悪（旧式・常に空・正しい式をコメントにして別の式を置く）、`ref` の削除・コメント化・別の式、`git add data/`、`cancel-in-progress`・`group` の変更、cron のコメントアウト・旧い値を行末コメントに残す改悪、`if_stale` の既定、ジョブ直下の `if:`、`permissions` の変更。(3) の書き換え：行末コメント・コメント行・CRLF・cron の引用符・`group` の引用符・`checkout` のバージョン・`ref` の引用符。`workflow_run` は PR の段階で起動を確かめられないため、名前の書き間違い・変更で黙って起動しなくなるのをここで防ぐ。**見ないもの**：YAML の文法・字下げの誤り（actionlint などで別に確かめる）、`timeout-minutes`・`runs-on`・`Assert` の中身、push の再試行ループ、他のトリガーの追加。
- `build-feed.test.js`：**rates.json が無いとき、フィードが従来（`rates/` を足す前の `build-feed.js`）の出力とバイトまで一致する**（`fixtures/feed-golden/`）、フィードの判定が「いま」で見直されること（時刻を固定して実行）、ヘッダ、壊れた・欠けた rates.json でもフィードを作ること。

## 10. 既知の限界・保守

- 米国の休場は規則で決められない日がある（5-1）。祝日表（`rates/jp-holidays.csv`）は年1回の更新が必要。来年分が無くなると、`--check-fresh` が GitHub Actions の注釈（`::warning`）で更新を促す。2029年に入ると（表が2028年の分まで無いまま）日本の営業日を決められず、判定できません になる。
- フィードへの反映は、`rates.yml` ではなく次の `intraday.yml`・`daily.yml` の実行で行う（8-1）。そのため、`data/rates.json` が更新されてからフィードに載るまで、実測できたのは10/7の1回（5時間31分）で、9:45 に更新されたと仮定した4日の試算が12分〜3時間5分だった（8-1。schedule が遅れる・抜ける日は、さらに遅れうる）。`workflow_run` を足したあとは、更新を載せたフィードが必ず「さらに次の」実行になる（8-1）。`gpt-feed.*` を書くワークフローは増やしていないので、`intraday.yml` の `git pull --rebase` の衝突の機会は、本機能の追加で増えない。`rates.json` を書く `rates.yml` は別のファイルだけをコミットするため、他のワークフローとの rebase で衝突しない（`rates.yml` のコミット手順を、競合する push を模した手元の git〔bare リポジトリ＋2つの clone〕で動かし、push の拒否 → rebase → push の成功を確認した。リポジトリの自動試験には入れていない）。
- **`workflow_run` は main にあるファイルでだけ効く**（GitHub Docs）。PR の段階では起動を確かめられず、マージ後の確認が必要（8-2）。上流の `name:` を変えると、エラーも出さずに起動しなくなるため、`rates/test/workflows.test.js` で見張る（`rates-tests.yml` の対象に `intraday.yml`・`daily.yml` を入れてある）。
- **同時起動と取り消し**：`concurrency: rates-data` は、実行中1つ＋待機中1つまで。待機中の run があるところへ新しい起動が来ると、待機中の run は取り消される（Actions の一覧に cancelled が並ぶ）。`--if-stale` の起動どうしは同じ判定をするので問題ないが、`if_stale` オフの手動実行（必ず取得）が待機中のときに別の起動が来ると、その手動実行は取り消されうる（手動で必ず取得したいときは、実行中の run が無い時間に行う）。`concurrency` には `queue: max`（待機を最大100件まで保つ。2026-05-07〜、GitHub Docs）もあるが、`concurrency` は変えない方針なので採用していない。
- **`checkout` の `ref`**：`ref` を省略すると、そのイベントのコミット（`GITHUB_SHA`）を読む。`concurrency` で待たされた run が、先行の run が `rates.json` をコミットする前のコミットを読むと、古い `rates.json` から取得し直して push が拒否され、続く `git pull --rebase` が同じファイルで衝突して赤くなりうる（手元の bare リポジトリ＋2つの clone で、この衝突を再現した）。そのため `ref: ${{ github.ref }}` を明示している。GitHub 上での実際の挙動は、マージ前には確かめられていない。
- **赤い実行が増える**：`Assert rates freshness` は `workflow_run` の起動でも走る。健全な日は赤にならない（取得に成功すれば、次の営業日の 9:40 まで ok、9:40〜10:30 は pending で緑）。赤になるのは、営業日の 10:30 以降に未更新のまま、`generation.errors` が残っている間、米・日とも取得に失敗している間。以前は schedule の時間帯（月〜金 9:40〜13:45）に限られていたが、今は上流が動く間は夜間や土曜でも出る。赤い実行の数は、8-2 のとおり：障害が起きた当日は公表後の起動数と同じ（直近の営業日17日で 1日平均8.0回・最大13回。単なる未公表の 9:40〜10:30 分は pending で緑）。履歴に欠けた営業日があるときは、全起動と同じ数（平日平均12.9回）が約6週間続く。通知が誰に届くかは確認できていない。
- **`retry_note` の文言を変えたことによる、最大1回の余分なコミット**：`retry_note` は内容の比較（`stable()`）から除いていないため、文言を3通り（ok・同日中に再試行が残る・残らない）に分けたこの変更のあと、`rates.json` が `ok` でない状態（`partial` など）のまま取得し直す最初の1回は、データが同じでも文言が違うので1回コミットされる。`ok` で最新のときは `--if-stale` が取得せずに終わる（`rates.json` は書き換わらない）ため、文言は次の取得のときに新しくなる（その取得は新しい営業日のデータを含むので、追加のコミットにはならない）。無害。
- **14時をまたぐ1回の余分なコミット**：`retry_expected`・`retry_note` は、内容の比較（`stable()`）から除いていない。status が ok でない状態が14時をまたいで続くと、14時以降の最初の起動で `retry_expected` が true から false に変わり、内容が違うとして1回コミットされる（以前は 13:45 で起動が止まるので起きなかった）。無害。
- 現行フィードの `US2Y`（`yahoo:2YY=F`）は、財務省の2年とは別の値（2026-10-07 11:22 JSTで 4.647%、財務省の 10/6 は 4.79%）。本フィードの米2年は財務省の値。
- 日2年は半複利最終利回り、米2年は par yield（債券等価ベース）。同じ定義とは確認できない。
- 米財務省のデータの再利用の条件は確認できていない（6節）。

## 11. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-07 | 初版 |
| v1.1 | 2026-10-07 | `rates.yml` の「Rebuild GPT feed」の手順を外し、フィードへの反映を `intraday.yml`・`daily.yml` に任せる（7-2・8・8-1・10）。外部cronの登録手順（`CRON_SETUP.md`）を追加 |
| v1.2 | 2026-10-08 | `rates.yml` に `workflow_run`（`Intraday Snapshot`・`Daily FX Data` の完了のたび、`--if-stale`）を追加。取得の式を「手動実行で `if_stale` オフのときだけ全取得、それ以外は `--if-stale`」に変更し、`checkout` に `ref` を明示。外部cronを「任意」に変更。起動の回数・所要時間・赤の条件を 8-2 に、限界を 10節に追記（5-2・8・8-1・9・10）。`rates/test/workflows.test.js` を追加。`retry_note` の文言を3通り（ok・再試行が残る・残らない）に分けた（14時以降も `workflow_run` で再取得は続きうるため。5-2・10） |
