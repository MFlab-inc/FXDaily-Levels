# MTF判定フィード

スイング記事の「月足・週足・日足の向き」を、9銘柄（USDJPY・EURUSD・GBPUSD・AUDUSD・EURJPY・EURGBP・USDCAD・XAUUSD・USDCHF）について毎日自動で計算し、`data/mtf-feed.txt` と `data/mtf-feed.json` として公開する。仕様は「MTF判定フィード仕様 v1.0」。既存の `fetch.js`・`build-feed.js`・`gpt-feed.txt` には触れない。

## ファイル

| ファイル | 役割 |
|---|---|
| `mtf/config.js` | 銘柄（Twelve Data の表記・価格の桁数・1日の標準本数）、取得の開始日、計算定義の版 |
| `mtf/lib/ny-time.js` | ニューヨーク時間の換算（`America/New_York`、夏時間・冬時間は時刻帯データベース）と日付の道具 |
| `mtf/lib/daily-bars.js` | 1時間足（UTC）→ NY17時区切りの日足（仕様 1-1） |
| `mtf/lib/calc.js` | 日足・週足（一目均衡表）・月足の判定、組み合わせ、履歴・欠測・本数の少ない日（仕様 第2・3節） |
| `mtf/lib/feed.js` | `mtf-feed.json` / `mtf-feed.txt` の生成（仕様 第4節） |
| `mtf/lib/store.js` | 日足の履歴CSV（`data/mtf/ny-daily-<銘柄>.csv`）の読み書き・追記・まとめ書き込み |
| `mtf/lib/twelvedata.js` | Twelve Data の取得（間隔・レート制限・再試行・ページ送り・キーを出さない） |
| `mtf/lib/guard.js`, `mtf/lib/history.js` | 過去分の取得で、daily / intraday と呼び出しを重ねないための確認／過去分の日足化 |
| `mtf/run-daily.js` | 毎日の更新。`daily.yml` の `Build MTF feed` 手順から実行する |
| `mtf/backfill.js` | 過去分（2024-07-01〜）の一括取得。`MTF Backfill` ワークフローから、main で1回だけ実行する |
| `mtf/test/` | 模擬データでの試験（`node --test mtf/test/*.test.js`） |

## 運用

- 履歴CSVの列: `date_ny,open,high,low,close,bars,last_bar_ny`。`last_bar_ny` は仕様の列に足した1列で、その日の最後の1時間足の開始時刻（NY現地 HH:MM）。仕様 3-7「金曜の最後の1時間足がNY16時台より前」の印を、あとから付けるために持つ。
- **過去分の取得（1回だけ）**: マージ後、Actions → `MTF Backfill` → Run workflow（main）。`data/mtf/` にCSVが1つでもあれば、取得も書き込みもせず失敗して止まる。途中で1銘柄でも失敗したら何も書かないので、やり直せる。
- **毎日の更新**: `daily.yml` が起動するたびに `node mtf/run-daily.js` が走る（`continue-on-error`）。履歴CSVが無い間、およびその日（基準日）の分を作成済みの間は何もしない。各銘柄の直近1000本（約40日分、1リクエスト）の1時間足から日足を作り、確定日までを追記し、既存の直近3日は取り直して上書きする。未完了（失敗・基準日の足が未公開の銘柄あり）のときの再試行は、同じ基準日につき最大3回。
- 週足・月足の確定は、データが実際にそこまで届いているか（最新の日足の日付）で判定する。基準日の足が届いていない銘柄では、途中までの日で作った週足・月足を「確定」として出さず、その銘柄は `status: stale` になる。
- 履歴CSVが無い銘柄は、毎日の更新では作らない（過去分の取得が「データあり」で止まらないようにするため）。
- ファイルは全部できてから `data/` に置く（一時フォルダは `data/` の隣。`git add data/` に混ざらない）。

## 試験

```
node --test mtf/test/*.test.js
```
