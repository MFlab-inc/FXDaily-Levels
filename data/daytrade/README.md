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

## 通知（GitHub Issue）

毎日ファイルを開かなくても、必要なときだけ GitHub の通知が届くようにしてある（`daytrade.yml` の各実行の最後に `scripts/daytrade-notify.js` が動く。コミットはしない）。

- **Issue は計画日ごとに1つ**（題名 `デイトレ 2026-10-13（火）`、ラベル `daytrade`）。発注できる状態の最初の設計で作り、候補が0件でも作る。本文は候補の件数と各案の要点。
- **コメントで知らせること**（どれも先頭で `@MFlab-inc` を呼ぶ。同じ出来事は1回だけ）:
  1. 新しい案（設計②③・型Bの追加）— 銘柄・向き・型・Entry帯・A/B案のSL・TP1・RR・口座ごとの上限ロット・有効期限・確認条件・停止時間
  2. 案の取消・再設計
  3. 価格が Entry 帯に入った／帯から 0.1×H1 ATR 以内に近づいた（Intraday Snapshot の完了ごとに判定。版ごとに1回）
  4. 採点の結果（到達／SL先・TP1先／未到達〔帯まであと◯pips〕／取消）— 採点は従来どおり翌営業日の設計①の前なので、金曜の案は月曜に、閉じた Issue へ追記される
  5. 異常 — Daytrade Plan の失敗（1時間に1回まで）／設計の窓が終わっても設計が無い／入力（intraday.json・h1-bars.json・daytrade-context.json）の更新が60分以上止まっている
- 計画日が終わる（有効期限 翌日 03:00）と、まとめをコメントして Issue を閉じる（金曜分は土曜 03:00 以降）。土日は Issue を作らない。
- **Issue は公開される**。口座の資金・損失上限・手数料は書かない（上限ロットは `data/daytrade-plan.txt` と同じく載せる）。重複を防ぐ隠しマーカーは、`github-actions[bot]` が書いた本文・コメントだけを読む（他の人のコメントに同じ形の文字があっても無視する）。経済カレンダー由来の文字は、`@` の呼び出しやマーカーを作れないよう無害化して載せる。
- 権限は `daytrade.yml` の `issues: write` と組み込みの `GITHUB_TOKEN` だけ（新しい Secrets は使わない）。通知が失敗しても計画の生成・コミットは止まらず、出なかった通知は次の実行で出る。
- 止めるとき: `daytrade.yml` の `Notify` の2つの手順を消す（`scripts/daytrade/test/workflow.test.js` の通知の試験も合わせて消す。試験が手順の存在を確かめているため）。Issue 側は、リポジトリの設定で Issue のコメントを制限する、または Issue を Lock しても、通知は止まらない（bot のコメントは書ける）。
- 何が通知されるかを、Issue を作らずに確かめる: `node scripts/daytrade-notify.js --dry-run [--now=<ISO>] [--data-dir=<dir>]`（書く予定の本文を出すだけ）。
- できないこと: `Intraday Snapshot` 自体が止まると `daytrade.yml` も起動しないので、その停止は通知できない（外部の起動の確認は `docs/intraday-external-cron.md`）。
