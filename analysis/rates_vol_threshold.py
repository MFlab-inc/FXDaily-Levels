#!/usr/bin/env python3
"""米国債の値動きの順位の基準（80%）をデータで確かめる（一度きりの集計。2026-11-05）。

問い：「米国債の値動き」（risk/SPEC.md 10-1 と同じ定義）の過去1年での順位が高い週は、その後1週間の為替が
本当に荒れていたか。基準を 80%・85%・90%・95% にしたとき、何が変わるか。参考に VIX の順位（基準70%）も同じ形で見る。

データ（FRED の公開 CSV。https://fred.stlouisfed.org/graph/fredgraph.csv?id=<系列>）：
  米国債の利回り DGS2・DGS5・DGS10・DGS30（米財務省の国債金利と同じ元データ。30年は 2002-02〜2006-02 に欠けがあるため、
  順位が出せるのは 2007年から）
  為替 DEXJPUS（USD/JPY）・DEXUSEU（EUR/USD）・DEXUSUK（GBP/USD）・DEXUSAL（AUD/USD）・DEXCAUS（USD/CAD）。
  ニューヨーク正午の値（FRB の H.10）。EUR/JPY＝EUR/USD×USD/JPY、EUR/GBP＝EUR/USD÷GBP/USD。XAU/USD は FRED に無いため対象外
  VIX VIXCLS
  元データは保存しない（集計の結果だけを書く）。

米国債の利回りは、FRED ではなく米財務省の年ごとの CSV（risk.json の米国債の値動きと同じ取得先）から取る。

決め方（記事と同じ順番）：週の最後の米国の営業日（金曜など）の順位を見て、次の週を見る。
  ・週の初めの値＝その次の為替の値（翌営業日のニューヨーク正午）
  ・その後5営業日の、初めの値からの最大の振れ幅（終値どうし。上下どちらでも）を、次の2つの物差しで割る
      直近の物差し：直近20営業日の1日の変化（対数）の標準偏差×√5（オプションの想定変動幅が、最近の値動きに合わせて
                    広がる・縮むのに近い）
      1年の物差し ：直近250営業日の同じもの（ふだんの1年に比べて荒れたか）
  ・記事の3案の損切りは、週初の中心から 1.0σ（❸）・1.5σ（❷）・2.0σ（❶）。そこで「直近の物差しで 1.0・1.5・2.0 倍を
    越えて振れた週の割合」を数える（向きは問わない）

使い方：python3 analysis/rates_vol_threshold.py <出力先フォルダ> [risk.json]
標準ライブラリだけで動く。
"""
import bisect
import csv
import datetime as dt
import io
import json
import math
import os
import sys
import time
import urllib.request

FRED = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={}"
TENORS = ["DGS2", "DGS5", "DGS10", "DGS30"]
FX = {"USDJPY": "DEXJPUS", "EURUSD": "DEXUSEU", "GBPUSD": "DEXUSUK", "AUDUSD": "DEXUSAL", "USDCAD": "DEXCAUS"}
PAIRS = ["USDJPY", "EURUSD", "GBPUSD", "AUDUSD", "EURJPY", "EURGBP", "USDCAD"]
LOOKBACK = 20
WINDOW = 252
BUCKETS = [(0, 70), (70, 80), (80, 85), (85, 90), (90, 95), (95, 100.01)]
THRESHOLDS = [70, 80, 85, 90, 95]
HORIZON = 5


UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}   # intraday.js と同じ（FRED は既定の UA だと応答が遅い）
TREASURY = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/"
            "{y}/all?type=daily_treasury_yield_curve&field_tdr_date_value={y}&page&_format=csv")
TREASURY_COLS = {"DGS2": "2 Yr", "DGS5": "5 Yr", "DGS10": "10 Yr", "DGS30": "30 Yr"}


def get_text(url, timeout=120):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8-sig")


def fetch_treasury(first_year=2005):
    """米財務省の国債金利（risk.json の米国債の値動きと同じ取得先）。返り値：{DGS2: {日付: 値}, ...}"""
    out = {k: {} for k in TREASURY_COLS}
    for y in range(first_year, dt.date.today().year + 1):
        print(f"::notice::米財務省 {y} 年を取得します")
        text = None
        for k in range(4):
            try:
                text = get_text(TREASURY.format(y=y))
                break
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(5 * (k + 1))
        if text is None:
            raise RuntimeError(f"米財務省 {y} 年を取得できません：{last}")
        rows = list(csv.reader(io.StringIO(text)))
        head = [h.strip() for h in rows[0]]
        idx = {k: head.index(c) for k, c in TREASURY_COLS.items() if c in head}
        for r in rows[1:]:
            if not r:
                continue
            m, d, yy = r[0].strip().split("/")
            date = f"{yy}-{m}-{d}"
            for k, i in idx.items():
                v = r[i].strip() if i < len(r) else ""
                if v not in ("", "N/A"):
                    out[k][date] = float(v)
        time.sleep(1)
    return out


def fetch(series_id, tries=4):
    print(f"::notice::{series_id} を取得します")
    last = None
    for k in range(tries):
        try:
            text = get_text(FRED.format(series_id) + "&cosd=2004-01-01")
            out = {}
            for row in csv.reader(io.StringIO(text)):
                if not row or not row[0][:1].isdigit():
                    continue
                v = row[1].strip() if len(row) > 1 else ""
                if v in ("", "."):
                    continue
                out[row[0]] = float(v)
            if len(out) < 100:
                raise RuntimeError(f"{series_id}: 行が少なすぎます（{len(out)}）")
            return out
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(5 * (k + 1))
    raise RuntimeError(f"{series_id} を取得できません：{last}")


def rank_at(values, i, window=WINDOW):
    if i + 1 < window:
        return None
    latest = values[i]
    c = sum(1 for k in range(i - window + 1, i + 1) if values[k] <= latest)
    return round(c * 1000 / window) / 10


def rates_vol_ranks(y):
    """risk/lib/trial.js の realizedVolSeries ＋ rankAt と同じ計算。返り値：日付→(値bp, 順位)。"""
    dates = sorted(d for d in set.intersection(*(set(y[t]) for t in TENORS)))
    bp = [{t: round(y[t][d] * 100) for t in TENORS} for d in dates]
    vals, vdates = [], []
    for i in range(LOOKBACK, len(dates)):
        s = 0.0
        for t in TENORS:
            ss = sum((bp[j][t] - bp[j - 1][t]) ** 2 for j in range(i - LOOKBACK + 1, i + 1))
            s += math.sqrt(ss / LOOKBACK)
        vals.append(s / len(TENORS))
        vdates.append(dates[i])
    out = {}
    for i, d in enumerate(vdates):
        r = rank_at(vals, i)
        if r is not None:
            out[d] = (vals[i], r)
    return out


def simple_ranks(series):
    dates = sorted(series)
    vals = [series[d] for d in dates]
    return {d: (vals[i], rank_at(vals, i)) for i, d in enumerate(dates) if rank_at(vals, i) is not None}


def stdev(xs):
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def bucket_of(r):
    for lo, hi in BUCKETS:
        if lo <= r < hi:
            return (lo, hi)
    return None


def week_signals(rank_map):
    """週ごとに、その週の最後の日付の順位（金曜が祝日なら木曜など）。返り値：[(日付, 順位)]"""
    by_week = {}
    for d in sorted(rank_map):
        y, w, _ = dt.date.fromisoformat(d).isocalendar()
        by_week[(y, w)] = d
    return [(d, rank_map[d][1]) for _, d in sorted(by_week.items())]


def fx_series(raw):
    s = {p: raw[p] for p in ["USDJPY", "EURUSD", "GBPUSD", "AUDUSD", "USDCAD"]}
    common = set(s["EURUSD"]) & set(s["USDJPY"])
    s["EURJPY"] = {d: s["EURUSD"][d] * s["USDJPY"][d] for d in common}
    common = set(s["EURUSD"]) & set(s["GBPUSD"])
    s["EURGBP"] = {d: s["EURUSD"][d] / s["GBPUSD"][d] for d in common}
    return s


def outcomes(fx, signals):
    """各（週, 銘柄）について、翌週の最大の振れ幅を2つの物差しで割った値。返り値：[(順位, 銘柄, 週の日付, 直近比, 1年比)]"""
    rows = []
    for p in PAIRS:
        dates = sorted(fx[p])
        px = [fx[p][d] for d in dates]
        lr = [math.log(px[i] / px[i - 1]) for i in range(1, len(px))]   # lr[i-1] は dates[i] の変化
        for sig_date, rank in signals:
            j = bisect.bisect_right(dates, sig_date)     # 信号の日より後の、最初の為替の日
            if j + HORIZON >= len(px) or j < 251:
                continue
            recent = lr[j - 20:j]     # dates[j-19..j] の変化（初めの値までの20個）
            year = lr[j - 250:j]
            s_recent = stdev(recent) * math.sqrt(HORIZON)
            s_year = stdev(year) * math.sqrt(HORIZON)
            m = max(abs(math.log(px[j + k] / px[j])) for k in range(1, HORIZON + 1))
            rows.append((rank, p, sig_date, m / s_recent, m / s_year))
    return rows


def summarize(rows, label):
    lines = [f"### {label}", "",
             "| 順位の帯 | 週数 | 銘柄×週 | 直近の物差しで1.0倍超 | 1.5倍超 | 2.0倍超 | 1年の物差しでの振れ幅（平均） | 2.0倍超（1年） |",
             "|---|---:|---:|---:|---:|---:|---:|---:|"]
    data = {}
    for lo, hi in BUCKETS:
        rs = [r for r in rows if lo <= r[0] < hi]
        weeks = len({r[2] for r in rs})
        if not rs:
            lines.append(f"| {lo}〜{min(hi,100):g}% | 0 | 0 | — | — | — | — | — |")
            continue
        f = lambda k, col=3: sum(1 for r in rs if r[col] > k) / len(rs)
        se = lambda p: math.sqrt(p * (1 - p) / max(weeks, 1))
        a, b, c = f(1.0), f(1.5), f(2.0)
        yr_mean = sum(r[4] for r in rs) / len(rs)
        yr2 = f(2.0, 4)
        data[(lo, hi)] = {"weeks": weeks, "n": len(rs), "gt1": a, "gt15": b, "gt2": c, "year_mean": yr_mean, "year_gt2": yr2}
        lines.append(f"| {lo}〜{min(hi,100):g}% | {weeks} | {len(rs)} | {a:.1%}（±{se(a):.1%}） | {b:.1%}（±{se(b):.1%}） | "
                     f"{c:.1%}（±{se(c):.1%}） | {yr_mean:.2f} | {yr2:.1%} |")
    # 基準ごとの「以上」と「未満」の比較
    lines += ["", "| 基準 | 以上の週 | 未満の週 | 1.5倍超（以上） | 1.5倍超（未満） | 2.0倍超（以上） | 2.0倍超（未満） | 1年比の平均（以上） | 1年比の平均（未満） |",
              "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for th in THRESHOLDS:
        hi_ = [r for r in rows if r[0] >= th]
        lo_ = [r for r in rows if r[0] < th]
        if not hi_ or not lo_:
            continue
        g = lambda rs, k, col=3: sum(1 for r in rs if r[col] > k) / len(rs)
        lines.append(f"| {th}% | {len({r[2] for r in hi_})} | {len({r[2] for r in lo_})} | {g(hi_,1.5):.1%} | {g(lo_,1.5):.1%} | "
                     f"{g(hi_,2.0):.1%} | {g(lo_,2.0):.1%} | {sum(r[4] for r in hi_)/len(hi_):.2f} | {sum(r[4] for r in lo_)/len(lo_):.2f} |")
    return lines, data


def run_lengths(rank_map, th):
    """基準以上が続いた期間（営業日数）の一覧と、基準以上の日の割合。"""
    dates = sorted(rank_map)
    runs, cur = [], 0
    for d in dates:
        if rank_map[d][1] >= th:
            cur += 1
        elif cur:
            runs.append(cur)
            cur = 0
    if cur:
        runs.append(cur)
    share = sum(1 for d in dates if rank_map[d][1] >= th) / len(dates)
    return runs, share


def main():
    out_dir = sys.argv[1]
    risk_path = sys.argv[2] if len(sys.argv) > 2 else None
    os.makedirs(out_dir, exist_ok=True)
    y = fetch_treasury()
    raw = {p: fetch(s) for p, s in FX.items()}
    vix = fetch("VIXCLS")
    rv = rates_vol_ranks(y)
    vr = simple_ranks(vix)
    fx = fx_series(raw)
    md = ["# 米国債の値動きの基準（80%）の検証", "",
          f"作成：{dt.datetime.utcnow():%Y-%m-%d %H:%M} UTC。データ：米国債の利回りは米財務省（2・5・10・30年）、為替と VIX は FRED（{', '.join(list(FX.values()) + ['VIXCLS'])}）。",
          f"米国債の値動きの順位がある期間：{min(rv)}〜{max(rv)}（{len(rv)}営業日）。VIX：{min(vr)}〜{max(vr)}。", ""]

    # 1. 再現の確認：risk.json の最近の値と比べる
    if risk_path and os.path.exists(risk_path):
        doc = json.load(open(risk_path, encoding="utf-8"))
        hist = ((doc.get("trial") or {}).get("rates_vol") or {}).get("history") or []
        diffs = [(h["date"], h["rank_pct"], rv[h["date"]][1], h.get("value"), round(rv[h["date"]][0], 2))
                 for h in hist if h["date"] in rv]
        md += ["## 1. 計算の再現（この集計で計算した順位と、risk.json の順位。どちらも米財務省の金利）", ""]
        if diffs:
            same80 = sum(1 for _, a, b, *_ in diffs if (a >= 80) == (b >= 80))
            maxd = max(abs(a - b) for _, a, b, *_ in diffs)
            md += [f"比べた日数 {len(diffs)}、順位の差の最大 {maxd:.1f}、80%以上かの判定の一致 {same80}/{len(diffs)}。", "",
                   "| 日付 | risk.json | この集計 | 値（risk.json） | 値（この集計） |", "|---|---:|---:|---:|---:|"]
            md += [f"| {d} | {a} | {b} | {v} | {w} |" for d, a, b, v, w in diffs[-10:]]
        md.append("")

    # 2. 基準を超える日の割合と続く長さ
    md += ["## 2. 基準を超える日の割合と、超えた状態が続く長さ（2007年〜）", "",
           "| 指標 | 基準 | 基準以上の日の割合 | 続いた回数 | 続いた長さの中央値（営業日） | 最長（営業日） | 20営業日以上続いた回数 |",
           "|---|---:|---:|---:|---:|---:|---:|"]
    for name, m, ths in (("米国債の値動き", rv, [80, 85, 90, 95]), ("VIX", vr, [70, 80, 90])):
        for th in ths:
            runs, share = run_lengths(m, th)
            med = sorted(runs)[len(runs) // 2] if runs else 0
            md.append(f"| {name} | {th}% | {share:.1%} | {len(runs)} | {med} | {max(runs) if runs else 0} | {sum(1 for r in runs if r >= 20)} |")
    md.append("")

    # 3. 週ごとの比較
    rows_rv = outcomes(fx, week_signals(rv))
    rows_vx = outcomes(fx, week_signals(vr))
    md += ["## 3. 順位の帯ごとの、翌週の為替の振れ幅（7銘柄。XAU/USD は対象外）", "",
           "「直近の物差しで1.5倍超」＝週の初めの値から、直近20営業日の値動きから見込む1週間の幅（σ）の1.5倍を越えて振れた週の割合。"
           "記事の❷通常の損切り（中心から1.5σ）・❶保守的の損切り（2.0σ）の深さに当たる。向きは問わない。"
           "括弧の±は、週の数から見た目安の誤差（銘柄どうしは同じ週に動きやすいため、銘柄×週ではなく週の数で計算）。", ""]
    l1, d1 = summarize(rows_rv, "米国債の値動きの順位（金曜など週の最後の日）")
    l2, d2 = summarize(rows_vx, "VIX の順位（参考）")
    md += l1 + [""] + l2 + [""]

    # 4. 期間を分けて（安定しているか）
    md += ["## 4. 期間を分けた比較（米国債の値動き、基準80%・90%）", "",
           "| 期間 | 基準 | 以上の週 | 2.0倍超（以上） | 2.0倍超（未満） | 1年比の平均（以上） | 1年比の平均（未満） |",
           "|---|---:|---:|---:|---:|---:|---:|"]
    for a, b in (("2007-01-01", "2012-12-31"), ("2013-01-01", "2019-12-31"), ("2020-01-01", "2026-12-31")):
        sub = [r for r in rows_rv if a <= r[2] <= b]
        for th in (80, 90):
            hi_ = [r for r in sub if r[0] >= th]
            lo_ = [r for r in sub if r[0] < th]
            if not hi_ or not lo_:
                continue
            g = lambda rs, k, col=3: sum(1 for r in rs if r[col] > k) / len(rs)
            md.append(f"| {a[:4]}〜{b[:4]} | {th}% | {len({r[2] for r in hi_})} | {g(hi_, 2.0):.1%} | {g(lo_, 2.0):.1%} | "
                      f"{sum(r[4] for r in hi_)/len(hi_):.2f} | {sum(r[4] for r in lo_)/len(lo_):.2f} |")
    md.append("")

    # 5. 銘柄ごと（基準80%）
    md += ["## 5. 銘柄ごと（米国債の値動き、基準80%）", "",
           "| 銘柄 | 2.0倍超（80%以上） | 2.0倍超（80%未満） | 1年比の平均（以上） | 1年比の平均（未満） |", "|---|---:|---:|---:|---:|"]
    for p in PAIRS:
        hi_ = [r for r in rows_rv if r[1] == p and r[0] >= 80]
        lo_ = [r for r in rows_rv if r[1] == p and r[0] < 80]
        if hi_ and lo_:
            g = lambda rs: sum(1 for r in rs if r[3] > 2.0) / len(rs)
            md.append(f"| {p} | {g(hi_):.1%} | {g(lo_):.1%} | {sum(r[4] for r in hi_)/len(hi_):.2f} | {sum(r[4] for r in lo_)/len(lo_):.2f} |")
    md.append("")

    open(os.path.join(out_dir, "rates_vol_threshold.md"), "w", encoding="utf-8").write("\n".join(md) + "\n")
    with open(os.path.join(out_dir, "rates_vol_threshold_buckets.json"), "w", encoding="utf-8") as f:
        json.dump({"rates_vol": {f"{lo}-{hi}": v for (lo, hi), v in d1.items()},
                   "vix": {f"{lo}-{hi}": v for (lo, hi), v in d2.items()}}, f, ensure_ascii=False, indent=1)
    print("\n".join(md))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        import traceback
        tb = traceback.format_exc().strip().splitlines()
        # Actions のログ本文は外から読めないため、注釈（annotation）に誤りの要点を出す
        print(f"::error::{type(e).__name__}: {e} | {' / '.join(x.strip() for x in tb[-6:])}"[:3000])
        sys.exit(1)
