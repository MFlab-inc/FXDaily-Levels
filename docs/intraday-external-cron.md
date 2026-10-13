# intraday.yml（Intraday Snapshot）を外部cronから15分ごとに起動する

`intraday.yml` は GitHub の schedule（毎時 2・17・32・47 分）で動く設計だが、schedule はほとんど届かない。`daily.yml` は外部の定期実行サービスから `workflow_dispatch` を呼んで確実に動かしているので、**同じ方式で `intraday.yml` を毎時 5・20・35・50 分に起動する**。外部の定期実行サービスはこのリポジトリの外にあり、設定の変更はそちらの画面で行う（このリポジトリでは変更できない）。

**この文書の位置づけ**：調べた事実（§1）と、外部サービスでの登録の内容・手順（§2〜§4）。`intraday.yml` 自体は変更しない（すでに `workflow_dispatch` がある。§1-3）。

## 1. 調べたこと（2026-10-09 に確認。GitHub Actions の実行履歴）

### 1-1. schedule は実際にどれだけ届いているか

`intraday.yml` の schedule が定義どおりに届けば、平日（UTC 月〜金）は毎時4回、1日96回。実際に届いた実行（`event=schedule`）は、UTC の日付ごとに次のとおり。

| UTC の日付 | schedule の実行 | 定義どおりなら | 参考：`workflow_run`（`Daily FX Data` の完了で起動）の実行 |
|---|---|---|---|
| 10/5（月） | 3 | 96 | 3 |
| 10/6（火） | 5 | 96 | 5 |
| 10/7（水） | 4 | 96 | 5 |
| 10/8（木） | 4 | 96 | 5 |
| 10/9（金。06:30 UTC まで） | 2 | 約26 | 2 |

5日間（10/5〜10/9 の途中）で schedule は18回、定義どおりなら約410回。**届いた割合は約4%**。この間の `intraday.yml` の実行は `workflow_run`（`daily.yml` が外部cronで動いたあとの完了）を足しても38回しかない。

10/8（JST 10/8 16:22 の次が 23:45）の例：

| UTC | JST | 起動 |
|---|---|---|
| 10/8 07:22 | 16:22 | schedule |
| （欠落） | 16:22〜23:45 | なし |
| 10/8 14:45 | 23:45 | schedule |

この欠落のため、`daytrade.yml`（`Intraday Snapshot` の完了で起動）は、設計③（21:00〜22:59 JST）と型Bの追加（16:00〜21:59 JST）の窓に起動できなかった。

### 1-2. `daily.yml` を外部から起動している仕組み

- **何が**：リポジトリの外にある定期実行サービス。サービス名は、このリポジトリのファイル・コミット履歴・PR の説明文のどこにも書かれていない（`rates/CRON_SETUP.md` の「確認できていないこと」にも同じ記述がある）。**別リポジトリの workflow や Cloudflare Workers の cron かどうかも、このリポジトリからは判別できない**。
- **どう呼んでいるか**：GitHub の API `POST https://api.github.com/repos/MFlab-inc/FXDaily-Levels/actions/workflows/daily.yml/dispatches`（GitHub Docs「Create a workflow dispatch event」）。実行履歴で確認できる事実：
  - `daily.yml` の `event=workflow_dispatch` の実行は、**毎営業日 UTC 21:20・22:20・23:20（JST 06:20・07:20・08:20）の :20:09〜:20:10 秒**に並んでいる（10/1 夜〜10/8 夜の 6 営業日 × 3 回 = 18 件。それより前や、その合間の不規則な時刻の実行は手動）。
  - 実行者（`actor`・`triggering_actor`）は `MFlab-inc`。つまり、**`MFlab-inc` アカウントのトークンで API が呼ばれている**。
  - 入力 `if_stale=true` が渡されている（`daily.yml` のジョブのログに `node fetch.js --if-stale`。`rates/CRON_SETUP.md` §0）。
- **どこで**：上記のとおり、サービスの場所は特定できない。外部サービスの画面（既存の `daily.yml` 用ジョブ）で、URL・ヘッダ・本文・トークンを確認する必要がある。
- `rates.yml` にも、10/8 の UTC 02:20:09 に `workflow_dispatch`（実行者 `MFlab-inc`）の実行が 1 件ある（`daily.yml` と同じ秒の特徴。外部cronに足されたものと見られる）。

### 1-3. `intraday.yml` の `workflow_dispatch`

すでにある。**2026-10-13 以降は任意の入力 `force`（既定オフ）を1つ持つ**（それまでは入力なしの `{}`）。外部cronの本文は `{"ref":"main"}` のままでよく、`force` は付けない（手動で必ず再取得したいときだけ使う。§5）。これまでの `workflow_dispatch` の実行（2026-07-15〜10-02 の 116 回）は、不規則な時刻の手動実行。

## 2. 外部サービスに登録する内容

`daily.yml` 用のジョブを複製して、次の 4 か所だけ変える。トークンとヘッダは既存のまま（同じリポジトリ・同じ API なので、同じトークンで足りる見込み）。

| 項目 | `daily.yml` 用（既存） | `intraday.yml` 用（新規） |
|---|---|---|
| 名前 | （既存の名前） | 例「intraday.yml（Intraday Snapshot）」 |
| URL | `…/actions/workflows/daily.yml/dispatches` | `https://api.github.com/repos/MFlab-inc/FXDaily-Levels/actions/workflows/intraday.yml/dispatches` |
| 本文（JSON） | `{"ref":"main","inputs":{"if_stale":…}}` | **`{"ref":"main"}`**（`inputs` を付けない） |
| 実行時刻 | UTC 21:20・22:20・23:20 | 下の表 |

**本文に `inputs` を付けない**：`intraday.yml` の `workflow_dispatch` が持つ入力は `force`（任意）だけで、外部cronには要らない。宣言されていない入力（例：`if_stale`）を付けると、GitHub は 422（`Unexpected inputs provided`）で拒否する。既存ジョブ（`daily.yml` 用）を複製すると `inputs` ごと複製されるので、**必ず消す**。

### 実行時刻（`schedule` と同じ範囲を、3分ずらした分で）

| 方式 | 内容 |
|---|---|
| cron 式（UTC） | `5,20,35,50 * * * 1-5` と `5,20,35,50 21-23 * * 0` の 2 本 |
| 日本時間で指定する画面なら | 月曜 06:05 〜 土曜 08:50（毎時 5・20・35・50 分） |

`intraday.yml` の `schedule`（毎時 2・17・32・47 分）は、そのまま残す（届いたときの予備。外部cronの 3 分前に動く）。

## 3. 登録のあとに確認すること

1. サービスの「今すぐ実行／テスト」があれば 1 回実行する。応答が **204**（本文なし）または 200（`X-GitHub-Api-Version: 2026-03-10` のとき）なら通っている。**422 なら本文に `inputs` が残っている**。
2. <https://github.com/MFlab-inc/FXDaily-Levels/actions/workflows/intraday.yml> を開き、Event を `workflow_dispatch` に絞る。実行者が `MFlab-inc`、起動時刻が :05・:20・:35・:50 分の :09〜:10 秒ごろであること。
3. 翌営業日に、1 日の `intraday.yml` の実行（schedule＋workflow_dispatch＋workflow_run）が **96 回以上**（外部cronの 96 回に、届いた schedule と `workflow_run` の分が加わる）になっていること。確認のコマンド（GitHub の API）：

```
gh api "repos/MFlab-inc/FXDaily-Levels/actions/workflows/intraday.yml/runs?per_page=100&created=2026-10-12" --jq '.workflow_runs | length'
```

4. `daytrade.yml`（Daytrade Plan）の実行が、設計③の窓（21:00〜22:59 JST）と型Bの追加の窓（16:00〜21:59 JST）に出ること。

## 4. 注意（登録の前に知っておくこと）

- **Twelve Data のクレジット**：1 回の `intraday.yml` で、`intraday.js` が 7 クレジット（`/quote` のバッチ 1 回）、`daytrade.js` が 12 銘柄 × 2 系列 = 24 リクエスト（`time_series`）。合計でおよそ 31 クレジット／回（見積もり。実測ではない）。外部cronで 15 分ごとに確実に動くと、1 日 96 回で約 3,000 クレジット。schedule も届いた日は、その分が上乗せされる。契約しているプランの 1 日・1 分あたりの上限に収まるかを、先に確認する。
- **毎時 :20 は、`daily.yml` の外部cron（UTC 21:20・22:20・23:20）と同じ分**。この 3 時間は、`daily.yml` と `intraday.yml` が同じ秒に起動して、Twelve Data を同時に呼ぶ。さらに `daily.yml` の完了で `intraday.yml` が `workflow_run` でもう 1 回動く。1 分あたりの上限が心配なら、その 3 時間だけ :20 を :23 などにずらす。
- **同時実行の抑止**：2026-10-13 から `intraday.yml` に `concurrency`（グループ `intraday-snapshot`、`cancel-in-progress: false`）がある。同じ分に重なっても、後から来た方は前の完了を待つ（§5）。それ以前は無く、2026-10-13 05:50 JST に外部cronと schedule が8秒差で重なって、1分に57クレジットを使い、schedule 側が「Commit and push data」で失敗した。
- **下流の実行が増える**：`Intraday Snapshot` の完了で、`daytrade.yml`（状態更新は 1 時間に 1 回まで）と `rates.yml`（`--if-stale`。取得済みなら外部へ接続しない）が起動する。実行の数は増えるが、コミットは増えにくい設計。
- **取得済みなら API を呼ばずに終わる処理**：2026-10-13 から `intraday.js`・`daytrade.js` に入っている（`daily.yml` の `--if-stale` と同じ考え方。§5）。
- **やめるとき**：サービスの画面でそのジョブを無効にするだけでよい（リポジトリ側の変更は不要）。

## 5. 同時実行の抑止と、取得のスキップ（2026-10-13 追記）

**起きたこと**：2026-10-13 05:50 JST に、外部cron（05:50:23 起動）と GitHub の schedule（05:50:31 起動。定義は毎時 `:47` なので、約3分半遅れて届いたと見られる）が8秒差で重なり、Twelve Data を1分に57クレジット使った（上限は55）。データの更新自体は外部cron側の run が成功した。schedule 側は取得・ビルドの手順が成功し、**「Commit and push data」で失敗**した（同じ `data/` への push の衝突によるものと見られる。実行ログは取得できなかったので推定）。過去1週間（2026-10-06 02:20Z〜10-13 02:20Z）の Intraday Snapshot は 165 回（外部cron 119・schedule 22・workflow_run 24）で、同じ分に2本以上起動したのはこの1回だけだった。

**対策**（`intraday.yml`・`intraday.js`・`daytrade.js`。`lib/recent-fetch.js`）：

1. `concurrency`（グループ `intraday-snapshot`、走っている run は止めない）：同時に1本だけ動き、後から来た run は前の完了を待つ。待機できる run は1つで、待機中にさらに新しい run が来ると古い待機は取り消される（どれも同じ仕事で、次に動く run が下の判定をする）。止まった run が後続を塞がないよう、job に `timeout-minutes: 10` を付けた（通常は30秒前後）。
2. 取得のスキップ：`intraday.js`（`data/intraday.json`）と `daytrade.js`（`data/h1-bars.json` と `data/daytrade-context.json` の古い方）は、**前回の取得（`as_of`）から5分未満**なら、Twelve Data（・Yahoo・カレンダー）を呼ばずに**終了コード 0 で終わる**。後続の手順と Daytrade Plan（workflow_run）は今までどおり動く。次の場合は**スキップしない**（これまでどおり取得する）：前回の取得が不完全（銘柄の欠け・`errors`。`intraday.js` は quote のバッチ失敗）／**日次レベル（`daily-levels.json`）の `as_of` が前回の取得より新しい**（Daily FX Data の完了直後の再取得で、新しい日次との突き合わせを更新するため）／ファイルが無い・壊れている・時刻が読めない。手動で必ず取得したいときは `--force`、または手動実行（workflow_dispatch）の `force` をオンにする。
3. スキップしても `Build GPT feed` とコミットの手順は動く（`rates.yml` の更新をフィードへ反映するのも、この手順のため）。`build-feed.js` は `feed_generated_at`（現在時刻）をフィードに書くので、スキップした run でも、そのファイルだけが更新されてコミットされることがある。

外部cron（:05・:23・:35・:50）と schedule（:02・:17・:32・:47）は3分ずれているので、schedule が定刻に届いた回は、外部cronの run が（5分未満で）スキップされる。外部cronの設定は変えなくてよい。
