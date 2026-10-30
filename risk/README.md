# 取引可否の指標（自前の定義）

swing-flow の記事の「全体の取引可否」に使う5項目のうち、**VIX 順位**（Cboe 公式の終値から、過去252営業日での位置）と**イベント警戒**（日米欧英豪加の中央銀行・米雇用統計・米CPI が、日本時間のその日の9:00から7日以内に2件以上で High）を `data/risk.json` に出す。**仕様は [SPEC.md](SPEC.md)**。

## ファイル

| ファイル | 役割 |
|---|---|
| `config.js` | 取得先・252日・基準（70%）・予定の種類・7日・2件・時刻・出典の文言 |
| `events.csv` | 最重要の予定表（2026〜2027年、144件。各公式サイトで確認。URL はファイル先頭） |
| `lib/parse.js` | Cboe の `VIX_History.csv` の読み取り |
| `lib/calc.js` | 順位の計算（当日を含む252個のうち、当日以下の割合） |
| `lib/calendar.js` | NYSE の営業日、VIX の「最新のはずの日」 |
| `lib/events.js` | 予定表の読み取り、日本時間への変換、イベント警戒の判定 |
| `lib/view.js` | 保存済みの risk.json が「いま」最新か |
| `lib/http.js` | タイムアウト・再試行つきGET |
| `run-daily.js` | 更新（`--if-stale`、`--check-fresh`、`--data-dir`） |
| `test/` | 試験（VIX の値は試験用に作ったもの。外部へは接続しない） |

## 実行

```
node risk/run-daily.js               # VIX を取得し、イベント警戒を数え直して data/risk.json を更新（常に取得）
node risk/run-daily.js --if-stale    # VIX が最新なら取得しない（イベント警戒だけ数え直す）。両方とも今日の分なら何もしない
node risk/run-daily.js --check-fresh # 外部へ接続せず、いま最新か確かめる（古ければ終了コード1）
node --test risk/test/*.test.js      # 試験
```

`.github/workflows/risk.yml` が日本時間の月〜土の朝と、`intraday.yml`・`daily.yml` の完了のたびに `--if-stale` で起動する。フィード（`gpt-feed.*`）には、GPT の値との照合が済むまで載せない（SPEC 9節）。

## 予定表の更新（年1回＋変更があったとき）

`events.csv` は、種類ごとの最後の予定のうち最も早い日（いまは 2027-12-03）までしか数えられない。終わりの60日前から実行のたびに警告が出る。各公式サイトで翌年の日程が出たら行を足す。米国の統計が延期されたときなども、この表を直す。
