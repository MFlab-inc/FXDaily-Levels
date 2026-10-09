# data/daytrade/

デイトレプラン自動生成（仕様: `docs/daytrade-plan-spec.md`）が使う・作るファイル。

| ファイル | 誰が書くか | 内容 |
|---|---|---|
| `accounts.json` | **本人が手で更新** | 口座のラベルと役割（`A`＝デイトレ専用、`B`＝スイング＋デイトレ）、`commission_per_lot_jpy`、`risk_pct`（0 超 5 以下）、`daily_loss_pct`。**口座番号と資金（`equity_jpy`）は書かない**（このリポジトリは公開されるため。資金は下の Variables から読む）。生成器は読むだけ。JSON にコメントは書けないので、先頭の `_comment` に説明を入れてある |
| `log.csv` | 生成器（`daytrade.yml`、`daytrade-score.js`） | 案の記録。追記のみ（仕様 5節・6-1）。`run` は design（設計）／design-b（状態更新で追加した型B）／status（取消・採点の結果）。口座の列は `lot_cap_a_A`・`lot_cap_b_A`・`lot_cap_a_B`・`lot_cap_b_B`（上限ロット）と `filled_ticket_A`・`filled_ticket_B`。`filled_ticket_*` は本人が週1回、MT4の取引記録と照合して手で埋める（bot は書き換えない） |
| `backtest-<日付>.md` / `.csv` | `daytrade-backtest.js`（手動） | バックテストの集計（仕様 6-2）。CSV の先頭2列は比較軸: `sl_floor`＝SL下限方式（`a_reject`＝丸め後10pips未満は不採用〔ライブの規則〕、`b_widen`＝max(k×ATR, 10pips) で採用）、`obstacle`＝障害の定義（`a_both`＝TP1の障害に日次レベル7本＋H1高値群・安値群の両方〔ライブの規則〕、`b_forward`＝日次レベル7本＋進行方向側の群だけ）。2×2の4通りを別々に集計 |

## 口座の資金（Secrets／Variables）の設定方法と、資金を更新する手順

口座番号と資金は、公開されるファイル（`accounts.json`・`data/daytrade-plan.txt`・`data/daytrade-plan.json`・`log.csv`）には書かない。資金（円の整数）は GitHub Actions の **Secrets**（運用はこちら）または **Variables** に置く。同じ名前が両方にあれば **Secrets が優先**される。

| 名前 | 口座 | 値の例 |
|---|---|---|
| `DAYTRADE_EQUITY_A` | A（デイトレ専用） | `500000`（円。カンマ・小数・単位は付けない） |
| `DAYTRADE_EQUITY_B` | B（スイング＋デイトレ） | `3000000` |

**なぜ Secrets か**: Variables の値は、Actions の実行ログ（`Generate plan` の `env:` 欄）に平文で出る。このリポジトリは公開なので、ログも見える。Secrets ならログで `***` に伏せられる（値は後から画面で見られない。更新は上書き）。Variables でも動く（ログに値が出る点だけ違う）。

**設定する（Secrets）**
1. GitHub でこのリポジトリを開き、`Settings` → `Secrets and variables` → `Actions` → `Secrets` タブ → `New repository secret`。
2. `Name` に `DAYTRADE_EQUITY_A`、`Secret` に資金（円の整数）を入れて `Add secret`。`DAYTRADE_EQUITY_B` も同様。
3. 次の `Daytrade Plan` の実行（Intraday Snapshot の完了ごと）から反映される。すぐ確かめたいときは `Actions` → `Daytrade Plan` → `Run workflow`（`run=status`）。

**設定する（Variables にする場合）**: 同じ画面の `Variables` タブ → `New repository variable` に、同じ名前と値で登録する（同名の Secrets があるときは Secrets が使われる）。

**資金を更新する**
1. `Secrets` タブで該当の名前の鉛筆アイコン（`Update`）を押し、新しい資金（円の整数）を入れて `Update secret`（Variables の場合は `Variables` タブで同様に `Update variable`）。コミットは要らない（リポジトリのファイルは変わらない）。
2. 次の生成（状態更新を含む）から、1項目目の『本日の損失上限』が変わる。各案の上限ロットは案を設計した時点の値のままで、次の設計（または状態更新で追加する型B）から新しい資金で計算される。

**未設定・おかしい値のとき**: 未設定（空）なら、その口座の上限ロットを **「未設定」** と表示し、出力の先頭に理由を出して **発注不可** にする。値が正の整数でない（`500,000`・`6.1e5`・`0`・負・文字）ときも、上限ロットを出さず発注不可にする（値そのものは出力に出さない）。`accounts.json` に `equity_jpy` が残っていても読まない（入力の問題として知らせる）。

**注意**: 出力に出る『本日の損失上限』は資金×`daily_loss_pct`、上限ロットも資金から計算した値なので、公開される出力から資金は逆算できる（回答どおり出している。Q68）。

関連: `data/daytrade-plan.txt`・`data/daytrade-plan.json`（生成物、公開）、`data/history/h1-<銘柄>.csv`（バックテスト用のH1履歴。1回だけ取得）。
