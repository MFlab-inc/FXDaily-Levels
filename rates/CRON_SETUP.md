# （任意）外部cronの登録手順：`rates.yml` を毎営業日 JST 09:45 に呼ぶ

**この登録は任意。登録しなくても `rates.yml` は動く。** `rates.yml` は次の3つで起動する（SPEC 8節）。

1. GitHub の schedule（月〜金 JST 09:40・09:55、10:00〜13:45 の15分毎）
2. `intraday.yml`（Intraday Snapshot）と `daily.yml`（Daily FX Data）が完了するたび（`workflow_run`）
3. 手動、または外部cronからの `workflow_dispatch`（この文書）

外部cronを足すと、**9:45 JST に1回、`rates.yml` を起動する要求を送れる**（GitHub が確実に届けるとは保証されていない。登録済みの `daily.yml` 用の外部cronは、直近10件すべて指定の時刻（:20）に起動した。下の「確認できたこと」）。`workflow_run` の起動は、上流（`intraday.yml`・`daily.yml`）の完了を待つので時刻どおりではない。9:40 JST 以降の最初の完了は、2026-08-19〜10-07 の36平日（日本の祝日3日と、最初の完了が手動実行だった日11日を含む）で 9:40 の 3〜191分後（中央34分、最大191分）、手動実行の日を次の自動の完了に置き換えた営業日33日では中央43分・p90 約2時間・最大191分だった（SPEC 8-2）。9:45 の起動で `rates.json` が早く更新されることだけが、外部cronを足す利点。

登録するときは、`daily.yml` で使っている外部cronと**同じサービスの画面で、既存のジョブを複製して3か所だけ変える**やり方で行う（この文書もその形で書いている）。仕様は [SPEC.md](SPEC.md) の8節。

## 0. 先に知っておくこと（確認できたこと・できていないこと）

**確認できたこと**（GitHub Actions の実行履歴とジョブのログ。2026-10-07 に確認）

- `daily.yml`（Daily FX Data）は、外部から `workflow_dispatch` で **UTC 21:20・22:20・23:20**（JST 06:20・07:20・08:20）の **:20:09〜:20:10 秒**に起動されている（実行履歴の直近 `workflow_dispatch` 10 件〔UTC 10/1 23:20 〜 10/6 23:20〕すべて。実行者は `MFlab-inc`、結果は success）。
- そのうち1件（UTC 10/6 23:20）のジョブのログに `node fetch.js --if-stale` と出ている。つまり、外部cronが渡す `if_stale=true` は、少なくともこの1件では `daily.yml` へ届いている（他の9件のログは見ていない）。
- GitHub の API の仕様（GitHub Docs「Create a workflow dispatch event」）：`POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`。`workflow_id` にはワークフローのファイル名（`rates.yml`）を指定できる。`ref`（ブランチ名）は必須、`inputs` は任意。クラシックのトークンは `repo` スコープが必要。成功時の番号は API のバージョンで違う：`X-GitHub-Api-Version` を付けない場合と `2022-11-28` では **204**（本文なし）、`2026-03-10` では **200**（本文に run の ID と URL）。

**確認できていないこと**

- **外部cronのサービス名**。このリポジトリのファイル・コミット履歴・PR #10 の説明文にも、GitHub の記録にも書かれていない。現時点で確認できる信頼性のある情報は存在しません。そのため下の手順は、サービス名や画面の名前（ボタンの文言）を使わず、「既存の `daily.yml` 用のジョブを複製する」形で書いている。
- 既存ジョブの URL・ヘッダ・本文・トークンの種類（クラシックか、特定のリポジトリ用か）。**画面で見て、同じにする**（手順2）。
- 既存ジョブが `X-GitHub-Api-Version` を付けているか。付けていて `2026-03-10` なら、成功は 200。サービス側が「204 だけを成功」と決め打ちしていると失敗扱いになる。

**前提**：`rates.yml` は main に入っている（PR #13、2026-10-07）。外部cronの登録は、いつでもよい。

## 1. 登録する内容

| 項目 | 値 |
|---|---|
| 方法 | `POST` |
| URL | `https://api.github.com/repos/MFlab-inc/FXDaily-Levels/actions/workflows/rates.yml/dispatches` |
| ヘッダ | 既存の `daily.yml` 用ジョブと同じ（`Authorization: Bearer <トークン>`、`Accept: application/vnd.github+json`、`X-GitHub-Api-Version`）。トークンも同じものを使う |
| 本文（JSON） | `{"ref":"main","inputs":{"if_stale":"true"}}`（`if_stale` の値の書き方〔文字列 `"true"` か真偽値 `true` か〕は、既存ジョブに合わせる） |
| 実行時刻 | **毎週 月〜金の UTC 00:45（＝JST 09:45）**。cron式なら `45 0 * * 1-5`（UTC）。サービスが日本時間で指定する画面なら「月〜金 9:45」 |

- なぜ 09:45 か：日2年は「翌営業日午前9時30分頃」に公表される。`rates/run-daily.js --if-stale` は、日本の営業日の 9:40 より前は取りに行かずに終了する。
- 曜日に注意：`daily.yml` の 21:20〜23:20（UTC）は日本では翌日になるため曜日がずれるが、**00:45（UTC）は日本でも同じ日の 09:45 なので、月〜金のまま**（日本時間の指定でも月〜金）。
- `if_stale=true` なら、公表前、または最新で健全なときは、財務省などの取得先へ接続せずに終了する（ジョブ全体では十数秒かかる見込み。未実測。SPEC 8-2）。**最新でない間、または取得の問題が残っている間は、呼ぶたびに取得し直す。** 同じ判定で `workflow_run` の起動も動くので、この外部cronが無くても、上流の完了のたびに同じ確認が走る。

## 2. 画面での操作

1. 外部cronのサービスにログインし、`daily.yml` 用の既存ジョブを探す。**URL に `daily.yml/dispatches` が入っているジョブ**が目印（毎日 UTC 21:20・22:20・23:20 ＝ JST 06:20・07:20・08:20 に動いているもの）。
2. そのうち1つを開き、URL・ヘッダ・本文を**そのまま控える**（画面を見ながら、手順3で同じ値を入れる）。
3. そのジョブを**複製**（コピー／クローン）する。複製の機能が無いときは、新規作成して手順2で控えた値を入れる。複製した（新規の）ジョブで、**次の3か所だけ**変える。
   - 名前：例「rates.yml（JP-US 2Y）」など、`daily.yml` のジョブと区別できる名前。
   - URL：`…/workflows/daily.yml/dispatches` の `daily.yml` を `rates.yml` に。
   - 実行時刻：上の表のとおり（月〜金 UTC 00:45＝JST 09:45）。
   - ヘッダ・トークン・本文の `ref` と `if_stale` は、既存のまま。
4. 保存して、有効にする。
5. サービスに「今すぐ実行／テスト」の機能があれば1回実行する。結果の欄に、成功を示す2xxの番号（204 または 200。上の「確認できたこと」）が出ればよい。

## 3. GitHub 側での確認（登録直後と、翌朝の初回）

1. <https://github.com/MFlab-inc/FXDaily-Levels/actions/workflows/rates.yml> を開く。`workflow_run` の起動で、一覧には1日に十数本の実行が並ぶ（SPEC 8-2）。右上の絞り込み（Event）を **`workflow_dispatch`** にする。
2. 実行者が `MFlab-inc`、起動した時刻が設定した時刻（9:45 JST）の直後の実行を探す。
3. その実行の `Fetch JP-US 2Y rates` のログに、次のどれかが出ていれば正常。
   - `公表前（日本の営業日の9:40より前）のためスキップ。外部へは接続していません`（9:40 より前に呼んだとき。テスト実行の時刻による）
   - `既に最新のためスキップ。外部へは接続していません`（先に `workflow_run` の実行が取得していたときも、これが正常）
   - `取得が必要（…）` のあとに `保存完了: …/data/rates.json（status=ok、判定=…）`、または `内容に変化がないため、rates.json は書き換えません`
4. 取得した朝は、`main` に `rates: YYYY-MM-DD HH:MM` というコミットが1つ増え、`data/rates.json` の `generation.status` が `ok`、`us2y.date` と `jp2y.date` がどちらも直前の営業日になる（設計上の想定。例：10/9 の朝なら 2026-10-08）。**取得したのが外部cronの実行とは限らない**（9:40〜9:45 の間に `workflow_run` や schedule の実行が先に取得していれば、9:45 の実行は「既に最新のためスキップ」になる）。
5. フィード（`gpt-feed.txt`）の【JP-US 2Y Rates】の区画は、`rates.json` の更新の**直後ではなく、さらに次に `intraday.yml` か `daily.yml` が走ったとき**に反映される（SPEC 8-1）。実際に測れた遅れは1回だけ：10/7 19:47 の `rates.json` が、10/8 01:19 の `intraday.yml` で初めてフィードに載った（5時間31分後）。9:45 に更新されたと仮定した試算（12分〜3時間5分）は、実測ではない。どちらも `workflow_run` を足す前の値で、足したあとは未測定（SPEC 8-1）。

画面（サービス側）で失敗が出たときの目安（GitHub の一般的な応答の意味であり、このリポジトリで確認したものではない）：

| 番号 | 考えられる原因 |
|---|---|
| 404 | URL のファイル名の誤り（`rates.yml`）、トークンがこのリポジトリを見られない |
| 401／403 | トークンの期限切れ、権限不足（既存の `daily.yml` 用ジョブは動いているので、同じトークンなら通常は起きない） |
| 422 | 本文の誤り（`ref` が無い、入力名が `if_stale` ではない など） |

## 4. 動かなくなったとき・やめるとき

- 外部cronが無くても、`rates.yml` 自身の schedule と、`intraday.yml`・`daily.yml` の完了ごとの起動（`workflow_run`）が動く。どれも GitHub の配信や上流の実行に依存するので、時刻どおりとは限らない。それでも JST 10:37 と 11:37 に `rates-freshness-check.yml` が `rates.json` の古さを見張り、更新されていなければ赤になる（この見張り自体も schedule なので、遅れる・抜ける可能性は残る）。
- **手動で必ず取得したい**（`if_stale` オフで Run workflow）ときは、実行中の run が無いことを確かめてから行う。実行中の run があるところへ、さらに別の起動が来ると、待機中の手動実行が取り消されることがある（SPEC 10節）。
- やめるときは、サービスの画面でそのジョブを無効にするだけでよい（リポジトリ側の変更は不要）。

## 付録：画面を使わずに1回だけ試す（任意）

自分のパソコンのターミナルから。`<トークン>` は、`daily.yml` 用の外部cronと同じトークン。**トークンを、チャットやファイルに貼り付けない**。

```
curl -sS -i -X POST \
  -H "Authorization: Bearer <トークン>" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/MFlab-inc/FXDaily-Levels/actions/workflows/rates.yml/dispatches \
  -d '{"ref":"main","inputs":{"if_stale":"true"}}'
```

先頭の行が `HTTP/2 204`（上のヘッダでは 204）なら成功。手順3の確認へ進む。
