# data/daytrade/

デイトレプラン自動生成（仕様: `docs/daytrade-plan-spec.md`）が使う・作るファイル。

| ファイル | 誰が書くか | 内容 |
|---|---|---|
| `accounts.json` | **本人が手で更新** | 口座ごとの `equity_jpy`（資金・円）、`commission_per_lot_jpy`、`risk_pct`、`daily_loss_pct`。生成器は読むだけ。JSON にコメントは書けないので、先頭の `_comment` に説明を入れてある |
| `log.csv` | 生成器（`daytrade.yml`、`daytrade-score.js`） | 案の記録。追記のみ（仕様 5節・6-1）。`run` は design（設計）／design-b（状態更新で追加した型B）／status（取消・採点の結果）。`filled_ticket_*` は本人が週1回、MT4の取引記録と照合して手で埋める（bot は書き換えない） |
| `backtest-<日付>.md` / `.csv` | `daytrade-backtest.js`（手動） | バックテストの集計（仕様 6-2）。CSV の先頭列 `sl_floor` は SL下限方式（`a_reject`＝丸め後10pips未満は不採用〔ライブの規則〕、`b_widen`＝max(k×ATR, 10pips) で採用） |

`equity_jpy` を変えたら、次の生成から上限ロットに反映される。

関連: `data/daytrade-plan.txt`・`data/daytrade-plan.json`（生成物、公開）、`data/history/h1-<銘柄>.csv`（バックテスト用のH1履歴。1回だけ取得）。
