# data/daytrade/

デイトレプラン自動生成（仕様: `docs/daytrade-plan-spec.md`）が使う・作るファイル。

| ファイル | 誰が書くか | 内容 |
|---|---|---|
| `accounts.json` | **本人が手で更新** | 口座のラベルと役割（`A`＝デイトレ専用、`B`＝スイング＋デイトレ）、`commission_per_lot_jpy`、`risk_pct`（0 超 5 以下）、`daily_loss_pct`。**口座番号と資金（`equity_jpy`）は書かない**（このリポジトリは公開されるため。資金は下の Variables から読む）。生成器は読むだけ。JSON にコメントは書けないので、先頭の `_comment` に説明を入れてある |
| `log.csv` | 生成器（`daytrade.yml`、`daytrade-score.js`） | 案の記録。追記のみ（仕様 5節・6-1）。`run` は design（設計）／design-b（状態更新で追加した型B）／status（取消・採点の結果）。口座の列は `lot_cap_a_A`・`lot_cap_b_A`・`lot_cap_a_B`・`lot_cap_b_B`（上限ロット）と `filled_ticket_A`・`filled_ticket_B`。`filled_ticket_*` は本人が週1回、MT4の取引記録と照合して手で埋める（bot は書き換えない）。<br>**取消と採点**：消えた版は `status` の行（`reached`）で取消を記録する。取消の時刻までに H1 足で到達していれば `取消(到達後)`（`reached_at`＝到達した足）、していなければ `取消(再設計)`。`取消(到達後)` の版は、有効期限（翌3:00）の後の採点（`daytrade-score.js`）で SL/TP1 の先着まで追った行を足す（`reached` は `取消(到達後)` のまま、`first_hit_a/b` が入る）。`取消(再設計)` の版も採点のたびに H1 で判定し直す（取消の時に H1 足が届かなかった分と、過去分の移行）。<br>**損益の列**（末尾の6列）：採点の行（`reached`＝`到達`／先着まで追った `取消(到達後)`）にだけ、案ごとの `exit_a`・`exit_b`（決済の価格）、`pips_a`・`pips_b`（最悪Entry 基準・コスト0）、`r_a`・`r_b`（pips÷SL幅）。未決は有効期限の直前の足の終値。円の金額は書かない。古い行は空のまま |
| `shadow-log.csv` | 生成器（`daytrade.yml`、`daytrade-score.js`） | **参考の並行記録（発注の対象外）**。ライブの規則（SL下限 (a)）では不採用だが、SL下限 (b)（SL＝max(k×ATR, 10pips)）なら通る案を、設計①②③・型Bの追加のたびに記録する。列は `log.csv` と同じで、先頭に `variant` を足してある。`variant` は **`sl_floor_b`**（SL下限 (b) の参考の案）と **`xau_paper`**（XAUUSD の案。下の「XAUUSD は発注の対象外」）。**版・取消・採点・同じ水準の判定は variant ごとに独立**（同じ版が両方に入っていても影響しない）。版の作り方・取消（`取消(到達後)` を含む）・採点・同じ水準の抑え（ライブの `log.csv` の履歴とは独立）は `log.csv` と同じ規則。`sl_floor_b` は `daytrade-plan.txt` の3項目目の末尾に件数だけ（候補の欄・Issue には出さない）。`xau_paper` は2項目目（候補）の末尾に1行だけ（価格・ロットなし。Issue には出さない） |
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
  2. 案の取消・再設計（到達してから取消された版には「到達済み。保有中なら元の SL・TP1 のまま」を添える）
  3. 価格が Entry 帯から 0.1×H1 ATR 以内に近づいた（「帯の近く」）／帯に入った（「帯に到達」）— **別々の出来事として、版ごとにそれぞれ1回**（近く → 到達の順。最初から帯の中なら到達だけで、到達のあとは近くを出さない）。Intraday Snapshot の完了ごとに判定する
  4. 採点の結果（到達／SL先・TP1先／未到達〔帯まであと◯pips〕／取消／取消(到達後)の先着）— 採点は従来どおり翌営業日の設計①の前なので、金曜の案は月曜に、閉じた Issue へ追記される
  5. 異常 — Daytrade Plan の失敗（1時間に1回まで）／設計の窓が終わっても設計が無い／入力（intraday.json・h1-bars.json・daytrade-context.json）の更新が60分以上止まっている
- 計画日が終わる（有効期限 翌日 03:00）と、まとめをコメントして Issue を閉じる（金曜分は土曜 03:00 以降）。土日は Issue を作らない。
- **Issue は公開される**。口座の資金・損失上限・手数料は書かない（上限ロットは `data/daytrade-plan.txt` と同じく載せる）。重複を防ぐ隠しマーカーは、`github-actions[bot]` が書いた本文・コメントだけを読む（他の人のコメントに同じ形の文字があっても無視する）。経済カレンダー由来の文字は、`@` の呼び出しやマーカーを作れないよう無害化して載せる。
- 権限は `daytrade.yml` の `issues: write` と組み込みの `GITHUB_TOKEN` だけ（新しい Secrets は使わない）。通知が失敗しても計画の生成・コミットは止まらず、出なかった通知は次の実行で出る。
- 止めるとき: `daytrade.yml` の `Notify` の2つの手順を消す（`scripts/daytrade/test/workflow.test.js` の通知の試験も合わせて消す。試験が手順の存在を確かめているため）。Issue 側は、リポジトリの設定で Issue のコメントを制限する、または Issue を Lock しても、通知は止まらない（bot のコメントは書ける）。
- 何が通知されるかを、Issue を作らずに確かめる: `node scripts/daytrade-notify.js --dry-run [--now=<ISO>] [--data-dir=<dir>]`（書く予定の本文を出すだけ）。
- できないこと: `Intraday Snapshot` 自体が止まると `daytrade.yml` も起動しないので、その停止は通知できない（外部の起動の確認は `docs/intraday-external-cron.md`）。

## 設計①の入力待ち

設計①の窓（NY 夏時間 06:00〜08:59、冬時間 07:00〜09:59）の中で、発注不可の理由が「日次レベルの日付が古い」「MTF の日付が古い」だけのとき、生成器は**計画もログも書かず**（コミットなし）、次の実行を待つ（実行ログに `入力待ち:` と出る）。日次レベルと MTF は `daily.yml`（Daily FX Data）が1回で更新し、その完了 → Intraday Snapshot → Daytrade Plan の連鎖で数分後に動くので、入力がそろった最初の実行が設計①になる。採点（`daytrade-score.js`）は入力待ちでも動く。窓の終わりまでそろわなければ、窓の後の状態更新が「設計なし」の計画を書き、Issue に「設計①がありません」が通知される。手動の実行（`run` を指定）と `--force` は待たない。

## XAUUSD は発注の対象外（並行記録のみ）

2026-11-09 の論点 c（本人決定）で、XAUUSD の案は発注の対象外になりました（`scripts/daytrade/pairs.js` の XAUUSD の `live: false`。戻すときはこの1か所を消す）。

- 案はこれまでどおり同じ規則（SL下限 (a)・障害 (a)）で作り、`shadow-log.csv` の **`variant=xau_paper`** に記録・採点します（版・取消〔`取消(再設計)`／`取消(到達後)`〕・採点・損益の列は `log.csv` と同じ規則）。
- ライブの候補には出ません（`daytrade-plan.json` の `candidates`・`daytrade-plan.txt` の「2. 候補」・Issue の通知・`log.csv`）。上限ロットも計算しません。`daytrade-plan.json` の **`paper`** に案の一覧（価格あり・ロットなし）、`paper_status` に状態が入ります。`daytrade-plan.txt` には候補の後に『参考：XAUUSD は発注の対象外（並行記録のみ。今回 n 件記録）』の1行だけが出ます。
- `log.csv` の切替前の XAUUSD の行はそのまま残ります（書き換えません）。採点待ちの行は今までどおり `log.csv` で採点されます。切替前から有効だった版（その計画日のもの）は、`plan.json` から外れる最初の実行（状態更新か設計）で、通常の取消の行が `log.csv` に追記されます（到達済みなら `取消(到達後)`。Issue に通知済みなら『案を取消しました』が出ます）。最後の設計③のあとに切り替えた場合などは、その計画日の版は有効期限後に `log.csv` で通常どおり採点されます。
- **切替の日時**：マージ後に最初に動いた設計の時刻。`git log --reverse --format='%h %aI %s' --grep='^daytrade: design' <マージのコミット>..origin/main | head -1` で分かる。**実際の切替の日時：2026-11-09 22:05（設計③。PR #49 のマージ〔17:16 JST、コミット `572f6e74`〕後に最初に動いた設計。コミット `f091bcb4`、`daytrade-plan.json` の `generated_at` は 22:05:54 JST）**。この設計では `paper` は 0 件（XAUUSD の型Aは「届かない」で不採用）で、`xau_paper` の記録はまだ無い。マージ後の最初の実行は状態更新のことが多く、`daytrade-plan.json` の `paper_status` はそこで先に付く（実際は 18:05 JST、コミット `834db186`）。`xau_paper` の型Aの記録は最初の設計から始まる。
- 集計：XAUUSD は `shadow-log.csv` の `variant=xau_paper` から、ライブ（`log.csv`）とは分けて見る。バックテスト（`backtest-*.md`）は XAUUSD を含めたまま。
- 戻すかどうかは、ルール見直し（12/19 以降）で、並行記録の到達件数・勝率・実現R を見て相談する。
