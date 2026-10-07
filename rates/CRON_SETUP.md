# 外部cronの登録手順：`rates.yml` を毎営業日 JST 09:45 に呼ぶ

日米2年金利（`rates.yml`）を、時刻どおりに起動するための外部cronの登録手順。`daily.yml` で使っている外部cronと**同じサービスの画面で、既存のジョブを複製して3か所だけ変える**やり方で書く。仕様は [SPEC.md](SPEC.md) の8節。

## 0. 先に知っておくこと（確認できたこと・できていないこと）

**確認できたこと**（GitHub Actions の実行履歴とジョブのログ。2026-10-07 に確認）

- `daily.yml`（Daily FX Data）は、外部から `workflow_dispatch` で **UTC 21:20・22:20・23:20**（JST 06:20・07:20・08:20）の **:20:09〜:20:10 秒**に起動されている（実行履歴の直近 `workflow_dispatch` 10 件〔UTC 10/1 23:20 〜 10/6 23:20〕すべて。実行者は `MFlab-inc`、結果は success）。
- そのうち1件（UTC 10/6 23:20）のジョブのログに `node fetch.js --if-stale` と出ている。つまり、外部cronが渡す `if_stale=true` は、少なくともこの1件では `daily.yml` へ届いている（他の9件のログは見ていない）。
- GitHub の API の仕様（GitHub Docs「Create a workflow dispatch event」）：`POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`。`workflow_id` にはワークフローのファイル名（`rates.yml`）を指定できる。`ref`（ブランチ名）は必須、`inputs` は任意。クラシックのトークンは `repo` スコープが必要。

**確認できていないこと**

- **外部cronのサービス名**。このリポジトリのファイル・コミット履歴・PR #10 の説明文にも、GitHub の記録にも書かれていない。現時点で確認できる信頼性のある情報は存在しません。そのため下の手順は、サービス名や画面の名前（ボタンの文言）を使わず、「既存の `daily.yml` 用のジョブを複製する」形で書いている。
- 既存ジョブの URL・ヘッダ・本文・トークンの種類（クラシックか、特定のリポジトリ用か）。**画面で見て、同じにする**（手順2）。
- マージ前に登録した場合の動き。`workflow_dispatch` は、`ref`（main）にそのワークフローのファイルがあることが前提。**`rates.yml` が main に入ってから（PR #13 のマージ後）登録する**。

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
- `if_stale=true` なら、公表前・既に最新で健全なときは、外部サイトへ接続せずに終了する。何度呼んでも、財務省への負荷は増えない。

## 2. 画面での操作

1. 外部cronのサービスにログインし、`daily.yml` 用の既存ジョブを探す。**URL に `daily.yml/dispatches` が入っているジョブ**が目印（毎日 UTC 21:20・22:20・23:20 ＝ JST 06:20・07:20・08:20 に動いているもの）。
2. そのうち1つを開き、URL・ヘッダ・本文を**そのまま控える**（画面を見ながら、手順3で同じ値を入れる）。
3. そのジョブを**複製**（コピー／クローン）する。複製の機能が無いときは、新規作成して手順2で控えた値を入れる。複製した（新規の）ジョブで、**次の3か所だけ**変える。
   - 名前：例「rates.yml（JP-US 2Y）」など、`daily.yml` のジョブと区別できる名前。
   - URL：`…/workflows/daily.yml/dispatches` の `daily.yml` を `rates.yml` に。
   - 実行時刻：上の表のとおり（月〜金 UTC 00:45＝JST 09:45）。
   - ヘッダ・トークン・本文の `ref` と `if_stale` は、既存のまま。
4. 保存して、有効にする。
5. （PR #13 のマージ後）サービスに「今すぐ実行／テスト」の機能があれば1回実行する。結果の欄に、成功を示す2xxの番号（GitHub Docs の現行の記載は `200`）が出ればよい。

## 3. GitHub 側での確認（登録直後と、翌朝の初回）

1. <https://github.com/MFlab-inc/FXDaily-Levels/actions/workflows/rates.yml> を開く。
2. 一番上の実行の、起動の種類が手動（`workflow_dispatch`）で、実行者が `MFlab-inc`、起動した時刻が設定した時刻（9:45 JST）の直後ならよい。
3. その実行の `Fetch JP-US 2Y rates` のログに、次のどれかが出ていれば正常。
   - `公表前（日本の営業日の9:40より前）のためスキップ。外部へは接続していません`（9:40 より前に呼んだとき。テスト実行の時刻による）
   - `既に最新のためスキップ。外部へは接続していません`
   - `取得が必要（…）` のあとに `保存完了: …/data/rates.json（status=ok、判定=…）`、または `内容に変化がないため、rates.json は書き換えません`
4. 取得した朝は、`main` に `rates: YYYY-MM-DD HH:MM` というコミットが1つ増え、`data/rates.json` の `generation.status` が `ok`、`us2y.date` と `jp2y.date` がどちらも直前の営業日になる（設計上の想定。例：10/9 の朝なら 2026-10-08）。
5. フィード（`gpt-feed.txt`）の【JP-US 2Y Rates】の区画は、`rates.json` の更新の**直後ではなく、次に `intraday.yml` か `daily.yml` が走ったとき**に反映される（SPEC 8-1）。実測では 12 分〜3 時間 5 分の遅れだった。

画面（サービス側）で失敗が出たときの目安（GitHub の一般的な応答の意味であり、このリポジトリで確認したものではない）：

| 番号 | 考えられる原因 |
|---|---|
| 404 | URL のファイル名の誤り（`rates.yml`）、`rates.yml` がまだ main に無い、トークンがこのリポジトリを見られない |
| 401／403 | トークンの期限切れ、権限不足（既存の `daily.yml` 用ジョブは動いているので、同じトークンなら通常は起きない） |
| 422 | 本文の誤り（`ref` が無い、入力名が `if_stale` ではない など） |

## 4. 動かなくなったとき・やめるとき

- 外部cronが届かなくても、`rates.yml` 自身の schedule（JST 09:40・09:55、10:00〜13:45 は15分毎）が保険になる。ただし GitHub の schedule は遅れる・抜けるため（SPEC 8節）、時刻どおりには動かないことがある。それでも JST 10:37 と 11:37 に `rates-freshness-check.yml` が `rates.json` の古さを見張り、更新されていなければ赤になる。
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

先頭の行が `HTTP/2 2xx`（成功）なら、手順3の確認へ進む。
