# ============================================================
# FX MARKET REPORT — チャート静止画レンダラー（本番・確定仕様）
# 実装: mplfinance（最軽量） ／ 配色: 深い緑#0B7A3B・赤#C8102E（金融機関風・本文と統一）
# 足種: 1時間足 ／ 表示: 直近14暦日（2週間） ／ サイズ: 820×640（スマホ最適化・文字大型）
#
# 実行例:  python render_chart.py USDJPY EURUSD USOIL
#   data/daily-levels.json … 既存フィード（prev_close_ny / r1 / s1 を自動取得）
#   data/h1-bars.json      … 全13銘柄のH1確定足（pairs.{SYMBOL} = [{time_jst,o,h,l,c,v?}...]）
#   charts/{SYMBOL}.png    … 出力（固定URLでレポートHTMLから参照）
# 銘柄無指定時は「USDJPY・EURUSD＋前日変動率が最大の候補銘柄」を自動選定
# 依存: pip install mplfinance   （GitHub Actions では fonts-noto-cjk も apt で導入）
# ============================================================
import sys, json, glob, datetime as dt
from pathlib import Path
import pandas as pd
import matplotlib
matplotlib.use('Agg')
from matplotlib import font_manager
import mplfinance as mpf

# ---------- 設定 ----------
REQUIRED_DAILY = ('USDJPY','EURUSD','GBPUSD','EURJPY','AUDUSD','EURGBP','USDCAD','USDCHF',
                  'NZDUSD','AUDNZD','XAUUSD','USOIL','US500','US30','US100')  # 15銘柄
# 指数3種は現物系列（^DJI / ^GSPC / ^NDX）。キー名は US30 / US500 / US100 で固定。
REQUIRED_H1 = ('USDJPY','EURUSD','GBPUSD','EURJPY','AUDUSD','EURGBP','USDCAD','USDCHF',
               'NZDUSD','AUDNZD','XAUUSD','USOIL')                              # 12銘柄
MIN_BARS = 480          # h1の最低本数（仕様は500本ローリング、下限480）
DAYS_SHOWN = 14          # 表示期間（暦日）＝ 直近2週間（スマホでの足の見やすさ優先）
W_IN, H_IN, DPI = 8.2, 6.4, 100
TV_UP, TV_DN = '#0B7A3B', '#C8102E'          # 深い緑・赤（確定仕様：金融機関風、本文と統一）
NAVY, SUB = '#0E2A47', '#5B6B80'
LINE_CLOSE, LINE_R1, LINE_S1 = '#64748B', '#0B7A3B', '#C8102E'
STALE_LIMIT_DAYS = 4     # 最終足がこれより古ければ失敗（金曜→月曜＋米祝日1日を許容する下限）

PROFILES = {
    'USDJPY': ('USD/JPY ・ 1時間足', 3),
    'EURUSD': ('EUR/USD ・ 1時間足', 5),
    'GBPUSD': ('GBP/USD ・ 1時間足', 5),
    'AUDUSD': ('AUD/USD ・ 1時間足', 5),
    'EURJPY': ('EUR/JPY ・ 1時間足', 3),
    'XAUUSD': ('XAU/USD（ゴールド）・ 1時間足', 2),
    'USOIL':  ('WTI原油（USOIL）・ 1時間足', 2),
    'EURGBP': ('EUR/GBP ・ 1時間足', 5),
    'USDCAD': ('USD/CAD ・ 1時間足', 5),
    'USDCHF': ('USD/CHF ・ 1時間足', 5),
    'NZDUSD': ('NZD/USD ・ 1時間足', 5),
    'AUDNZD': ('AUD/NZD ・ 1時間足', 5),
}

# ---------- フォント（Noto CJK を環境から探索） ----------
def find_font(patterns):
    for pat in patterns:
        hits = glob.glob(pat, recursive=True)
        if hits:
            return hits[0]
    raise FileNotFoundError('Noto CJK フォントが見つかりません（fonts-noto-cjk を導入してください）')

JP  = font_manager.FontProperties(fname=find_font(
    ['/usr/share/fonts/**/NotoSansCJK*Regular*.ttc', '/usr/share/fonts/**/NotoSansCJK*.ttc']))
JPB = font_manager.FontProperties(fname=find_font(
    ['/usr/share/fonts/**/NotoSansCJK*Bold*.ttc', '/usr/share/fonts/**/NotoSansCJK*.ttc']))

# ---------- 描画 ----------
def render(symbol: str, levels: dict, h1_pairs: dict, session_date: str) -> None:
    title, prec = PROFILES[symbol]
    lv = levels['pairs'][symbol]
    close, r1, s1 = lv['prev_close_ny'], lv['r1'], lv['s1']
    fmt = lambda v: f'{v:.{prec}f}'

    df = pd.DataFrame(h1_pairs[symbol])
    df['t'] = pd.to_datetime(df['time_jst'])          # JST表記（フィード仕様）
    df = df.set_index('t').sort_index()

    last = df.index[-1]
    now_jst = pd.Timestamp.now(tz='Asia/Tokyo').tz_localize(None)
    if (now_jst - last).days > STALE_LIMIT_DAYS:
        raise RuntimeError(f'{symbol}: H1データが古すぎます（最終足 {last}）')
    df = df[df.index >= last - dt.timedelta(days=DAYS_SHOWN)]
    df = df.rename(columns={'o': 'Open', 'h': 'High', 'l': 'Low', 'c': 'Close', 'v': 'Volume'})
    has_vol = 'Volume' in df.columns and df['Volume'].notna().any()
    if has_vol:
        df['Volume'] = df['Volume'].fillna(0)   # 一部バーの欠損は0埋め（パネルは維持）

    mc = mpf.make_marketcolors(up=TV_UP, down=TV_DN, edge='inherit', wick='inherit')
    style = mpf.make_mpf_style(
        marketcolors=mc, facecolor='#FFFFFF', figcolor='#FFFFFF',
        edgecolor='#DCE3EC', gridcolor='#EEF2F7', gridstyle='-', y_on_right=True,
        rc={'font.size': 16, 'axes.labelcolor': '#3A4557',
            'xtick.color': SUB, 'ytick.color': SUB, 'axes.linewidth': 0.8})

    kwargs = dict(type='candle', style=style, figsize=(W_IN, H_IN),
                  datetime_format='%-m/%-d', xrotation=0, ylabel='', returnfig=True,
                  tight_layout=False,
                  scale_padding={'left': 0.15, 'right': 1.15, 'top': 0.6, 'bottom': 0.4},
                  update_width_config=dict(candle_linewidth=0.6, candle_width=0.85))
    if has_vol:
        vol_colors = [TV_UP if c >= o else TV_DN for o, c in zip(df['Open'], df['Close'])]
        kwargs.update(volume=False, panel_ratios=(4, 1),
                      addplot=mpf.make_addplot(df['Volume'], type='bar', panel=1,
                                               color=vol_colors, width=0.8, alpha=0.85))
    fig, axes = mpf.plot(df, **kwargs)
    ax = axes[0]

    # 横軸は暦日の境界に目盛りを置く。
    # mplfinance既定は「N本ごと」に打つため、1日あたりの本数が異なる銘柄
    # （FX 24本/日・USOIL 23本/日＝毎日06時台が取引休止）で同じ横位置が
    # 別の日付を指してしまい、3枚を並べたレポートで比較できなくなる。
    norm_idx = df.index.normalize()
    day_starts = [i for i in range(len(df)) if i == 0 or norm_idx[i] != norm_idx[i - 1]]
    step = max(1, round(len(day_starts) / 6))
    ticks = day_starts[::step]
    ax.set_xticks(ticks)
    ax.set_xticklabels([df.index[i].strftime('%-m/%-d') for i in ticks], rotation=0)
    for price, color in ((close, LINE_CLOSE), (r1, LINE_R1), (s1, LINE_S1)):
        ax.axhline(price, color=color, linestyle='--', linewidth=1.7, zorder=2)
    fig.subplots_adjust(top=0.862, bottom=0.09, left=0.018, right=0.86)

    # 水準バッジ：figure座標で右端に右寄せ描画（見切れ防止）＋近接時は縦に自動オフセット
    y0, y1 = ax.get_ylim()
    min_gap = (y1 - y0) * 0.062
    items = sorted([(r1, LINE_R1, f'R1 {fmt(r1)}'),
                    (close, LINE_CLOSE, f'前日終値 {fmt(close)}'),
                    (s1, LINE_S1, f'S1 {fmt(s1)}')], key=lambda x: -x[0])
    placed, prev_y = [], None
    for price, color, label in items:
        y = price if prev_y is None else min(price, prev_y - min_gap)
        prev_y = y
        placed.append((y, color, label))
    fig.canvas.draw()
    to_fig = fig.transFigure.inverted().transform
    for y, color, label in placed:
        fy = to_fig(ax.transData.transform((0, y)))[1]
        fig.text(0.995, fy, label, ha='right', va='center', fontsize=14, color='#FFFFFF',
                 fontproperties=JP, zorder=10,
                 bbox=dict(boxstyle='round,pad=0.32', fc=color, ec='none'))

    fig.text(0.02, 0.948, title, fontsize=23, color=NAVY, fontproperties=JPB)
    fig.text(0.02, 0.905,
             f'前日NY終値 {fmt(close)} ｜ R1 {fmt(r1)} ／ S1 {fmt(s1)} ｜ 対象日 {session_date}',
             fontsize=13.5, color=SUB, fontproperties=JP)

    Path('charts').mkdir(exist_ok=True)
    out = f'charts/{symbol}.png'
    fig.savefig(out, dpi=DPI, facecolor='#FFFFFF')
    print(f'OK: {out} ({len(df)} bars, session {session_date})')


# 第3銘柄の候補（前日変動率が最大のものを1つ採用）
THIRD_CANDIDATES = ('GBPUSD', 'AUDUSD', 'XAUUSD', 'USOIL', 'EURJPY')
# ※US500は除外（現物指数は取引時間が1日6.5時間で1時間足チャートに適さないため）


def pick_third(levels: dict) -> str:
    """前々日NY終値→前日NY終値の変動率が最大の候補銘柄を返す。"""
    best, best_pct = None, -1.0
    for sym in THIRD_CANDIDATES:
        lv = levels['pairs'].get(sym) or {}
        a, b = lv.get('prev2_close_ny'), lv.get('prev_close_ny')
        if not a or not b:
            continue
        pct = abs((b - a) / a * 100)
        if pct > best_pct:
            best, best_pct = sym, pct
    if best is None:
        sys.exit('第3銘柄を判定できません（prev2_close_ny が不足）')
    print(f'第3銘柄: {best}（前日変動率 {best_pct:.2f}%）')
    return best


def main():
    levels = json.loads(Path('data/daily-levels.json').read_text())
    h1 = json.loads(Path('data/h1-bars.json').read_text())

    # ゲート1: フィード側assert（errors空 かつ 全銘柄status=match を必須）
    results = h1.get('consistency_check', {}).get('results', {})
    if not results:
        sys.exit('[GATE1] consistency_check.results が存在しないため中止')

    # 現物指数（US500/US30/US100）は「公式終値＝クロージング・オークションの約定値」であり、
    # 1時間足の最終バーの終値からは原理的に再現できない（例：2026-08-12 の US500 は
    # 高値・安値が完全一致で終値のみ 7727.41 対 7728.2＝0.010% ずれ）。
    # これを一律 mismatch として扱うと、チャート化していない銘柄が毎朝パイプライン全体を
    # 止めることになる。恒久対策はフィード側で現物指数を検算対象から外すこと。
    # それまでの措置として、チャート非対象銘柄に限り小さな乖離を許容する。
    # ※チャートを描く12銘柄（REQUIRED_H1）は24時間取引で終値が一意に決まるため、
    #   従来どおり乖離ゼロを要求する（緩めない）。
    NON_CHART_TOL_PCT = 0.05

    def _tolerable(sym):
        """チャート非対象銘柄の不一致が、終値の丸め相当の乖離に収まっているか。"""
        if sym in REQUIRED_H1:
            return False, 'チャート対象銘柄'
        v = results.get(sym, {})
        # 許容するのは「検算した結果わずかにずれた」場合だけ。
        # skipped 等の「そもそも検算していない」状態は、乖離が算出できてしまう場合でも必ず止める。
        if v.get('status') != 'mismatch':
            return False, f"status={v.get('status')}（検算されていない）"
        d, ref = v.get('h1_derived'), v.get('daily_ref')
        if not isinstance(d, dict) or not isinstance(ref, dict):
            return False, '乖離を数値で確認できない'
        worst, worst_k = 0.0, ''
        for k in ('high', 'low', 'close'):
            a, b = d.get(k), ref.get(k)
            if not isinstance(a, (int, float)) or not isinstance(b, (int, float)) or not b:
                return False, f'{k} が数値でない'
            r = abs(a - b) / abs(b) * 100
            if r > worst: worst, worst_k = r, k
        if worst > NON_CHART_TOL_PCT:
            return False, f'{worst_k} の乖離 {worst:.4f}% が許容 {NON_CHART_TOL_PCT}% 超'
        return True, f'最大乖離 {worst:.4f}%（{worst_k}）'

    warned = []
    not_match = {}
    for k, v in results.items():
        if v.get('status') == 'match':
            continue
        okay, why = _tolerable(k)
        if okay:
            warned.append(f'{k}: {why}')
        else:
            not_match[k] = f"{v.get('status')} — {why}"
    if not_match:
        sys.exit(f'[GATE1] status!=match の銘柄があるため中止（skipped等も不可）: {not_match}')

    # 上記で許容した銘柄しか errors に載っていないなら継続する（載っていれば止める）。
    # 判定できない形式の行は必ず止める（fail closed）。
    errs = [str(e) for e in (h1.get('errors') or [])]
    tolerated = {w.split(':')[0] for w in warned}
    blocking = [e for e in errs
                if not (tolerated and any(s in e for s in tolerated)
                        and not any(s in e for s in REQUIRED_H1))]
    if blocking:
        sys.exit(f'[GATE1] h1-bars.json の errors が空でないため中止: {blocking}')
    for w in warned:
        print(f'[GATE1] 警告（継続）: チャート非対象銘柄の検算不一致 — {w}。'
              f'現物指数は公式終値をH1から再現できないための既知事象。'
              f'フィード側で検算対象から外すのが恒久対策')

    missing = [s for s in h1.get('pairs', {}) if s not in results]
    if missing:
        sys.exit(f'[GATE1] 検算されていない銘柄があるため中止: {missing}')

    # ゲート2: 世代一致（h1が照合したdailyと、いま読んでいるdailyが同一世代であること）
    checked = h1.get('consistency_check', {}).get('checked_against', {}).get('daily_as_of')
    daily_as_of = levels.get('as_of')
    if not checked or checked != daily_as_of:
        sys.exit(f'[GATE2] スナップショット世代不一致のため中止: '
                 f'h1照合時daily={checked} / 現daily={daily_as_of}。'
                 f'フィード更新の途中の可能性。両ファイル再取得後に再実行してください')

    # ゲート3: session_date が「実行日(JST)の前日」であること（機械判定・祝日はここで検知）
    session_date_raw = str(levels.get('session_date', ''))
    today_jst = dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date()
    expected = (today_jst - dt.timedelta(days=1)).isoformat()
    if session_date_raw != expected:
        sys.exit(f'[GATE3] session_date不一致のため中止: フィード={session_date_raw} / '
                 f'期待値={expected}（実行日の前日）。米市場休場・フィード未更新・'
                 f'実行曜日誤りのいずれかの可能性。人間の確認後に対応してください')

    # ゲート4: データ構造の妥当性（銘柄・本数・型・時刻順・重複・OHLC整合）
    dp = levels.get('pairs', {})
    miss_d = [s for s in REQUIRED_DAILY if s not in dp]
    if miss_d:
        sys.exit(f'[GATE4] daily-levels.json に必須銘柄が不足: {miss_d}')
    miss_h = [s for s in REQUIRED_H1 if s not in h1.get('pairs', {})]
    if miss_h:
        sys.exit(f'[GATE4] h1-bars.json に必須銘柄が不足: {miss_h}')

    for sym, v in levels['pairs'].items():
        for k in ('prev_high', 'prev_low', 'prev_close_ny', 'prev2_close_ny', 'r1', 's1'):
            if not isinstance(v.get(k), (int, float)):
                sys.exit(f'[GATE4] daily {sym}.{k} が数値でない: {v.get(k)!r}')
        if not (v['prev_low'] <= v['prev_close_ny'] <= v['prev_high']):
            sys.exit(f'[GATE4] daily {sym}: 終値が高安レンジ外 '
                     f"(L={v['prev_low']} C={v['prev_close_ny']} H={v['prev_high']})")

    for sym, bars in h1['pairs'].items():
        if len(bars) < MIN_BARS:
            sys.exit(f'[GATE4] h1 {sym}: 本数不足 {len(bars)}本（下限{MIN_BARS}）')
        times = [b.get('time_jst') for b in bars]
        if any(not isinstance(t, str) for t in times):
            sys.exit(f'[GATE4] h1 {sym}: time_jst が文字列でない要素あり')
        if times != sorted(times):
            sys.exit(f'[GATE4] h1 {sym}: 時刻が昇順でない')
        if len(set(times)) != len(times):
            dup = [t for t in set(times) if times.count(t) > 1][:3]
            sys.exit(f'[GATE4] h1 {sym}: 時刻の重複あり {dup}')
        for b in bars:
            for k in ('o', 'h', 'l', 'c'):
                if not isinstance(b.get(k), (int, float)):
                    sys.exit(f'[GATE4] h1 {sym} {b.get("time_jst")}: {k} が数値でない')
            if not (b['l'] <= min(b['o'], b['c']) and max(b['o'], b['c']) <= b['h']):
                sys.exit(f'[GATE4] h1 {sym} {b["time_jst"]}: OHLC不整合 '
                         f"(O{b['o']} H{b['h']} L{b['l']} C{b['c']})")

    # ゲート5: 取引時間の妥当性（休場帯バー混入の回帰検知）
    for sym, bars in h1.get('pairs', {}).items():
        weekend = [b for b in bars
                   if (dt.date.fromisoformat(b['time_jst'][:10]).weekday() == 5
                       and b['time_jst'][11:13] >= '07')
                   or (dt.date.fromisoformat(b['time_jst'][:10]).weekday() == 6
                       and b['time_jst'][11:13] < '21')]
        if len(weekend) > len(bars) * 0.02:      # 2%超は明らかな混入
            sys.exit(f'[GATE5] {sym}: 休場帯バーの混入を検知（{len(weekend)}/{len(bars)}本）。'
                     f'フィード側の取引時間フィルタが機能していない可能性')

    explicit = bool(sys.argv[1:])   # 銘柄を明示指定した実行か
    symbols = sys.argv[1:] or ['USDJPY', 'EURUSD', pick_third(levels)]
    session_date = session_date_raw.replace('-', '/')
    for s in symbols:
        if s not in PROFILES:
            sys.exit(f'未定義の銘柄: {s}（PROFILES に追加してください）')
        render(s, levels, h1['pairs'], session_date)

    # 選定結果を書き出し（レポート生成側はこのファイルを正とし、自前で再判定しない）
    # 明示指定の実行（例: render_chart.py XAUUSD）では書き換えない。
    # 上書きすると symbols が1銘柄・third_symbol が null になり、
    # 翌朝のレポートが誤った銘柄で生成される。
    if explicit:
        print('注: 銘柄を明示指定したため charts/selection.json は更新しません（既存の選定を維持）')
        return
    Path('charts').mkdir(exist_ok=True)
    Path('charts/selection.json').write_text(json.dumps({
        'session_date': session_date_raw,
        'daily_as_of': daily_as_of,
        'symbols': symbols,
        'third_symbol': symbols[2] if len(symbols) >= 3 else None,
    }, ensure_ascii=False, indent=2))
    print('OK: charts/selection.json（レポート側はこの選定を使用）')


if __name__ == '__main__':
    main()
