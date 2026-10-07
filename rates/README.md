# 日米2年金利フィード

USD/JPY の「日米の政策比較」の材料として、米2年（米財務省）と日2年（財務省）の利回り、金利差、5営業日差、判定（円高方向／円安方向／はっきりしない／判定できません）を `data/rates.json` と GPT フィードに出す。**仕様は [SPEC.md](SPEC.md)**。

## ファイル

| ファイル | 役割 |
|---|---|
| `config.js` | しきい値（10bp）・取得先・時刻・出典の文言 |
| `lib/parse.js` | 財務省CSV・XML、国債金利情報（Shift_JIS・和暦）、内閣府の祝日CSVの読み取り |
| `lib/calendar.js` | 日本・米国の営業日、期待する最新日、履歴の穴 |
| `lib/calc.js` | 整数（ミリ%）での金利差・5営業日差・判定 |
| `lib/snapshot.js` | 取得した系列から値・判定・鮮度を作る（ネットワークなしの純関数） |
| `lib/view.js` | 保存済みの rates.json を「いま」の鮮度で見直す。フィードの区画 |
| `lib/http.js` | タイムアウト・再試行つきGET |
| `run-daily.js` | 更新（`--if-stale`、`--check-fresh`） |
| `CRON_SETUP.md` | 外部cron（`rates.yml` を JST 09:45 に呼ぶ）の登録手順 |
| `jp-holidays.csv` | 同梱の祝日表（内閣府CSV。2022〜2027年。年1回更新） |
| `test/` | 試験と、実データから切り出した試験用ファイル（`fixtures/`） |

## 実行

```
node rates/run-daily.js               # 取得して data/rates.json を更新（常に取得）
node rates/run-daily.js --if-stale    # 公表前・最新で健全なら、取得せずに終了
node rates/run-daily.js --check-fresh # 外部へ接続せず、いま最新か確かめる（古ければ終了コード1）
node --test rates/test/*.test.js      # 試験
```

`.github/workflows/rates.yml` が毎営業日の朝に実行する（`rates-tests.yml` が PR と main への push で試験を実行する）。外部cronから `workflow_dispatch`（`if_stale=true`）で呼ぶ運用の登録が別途必要（手順は [CRON_SETUP.md](CRON_SETUP.md)、SPEC 8節）。`rates.yml` が書くのは `data/rates.json` だけで、フィード（`gpt-feed.*`）への反映は次の `intraday.yml`・`daily.yml` の実行で行う（SPEC 8-1）。
