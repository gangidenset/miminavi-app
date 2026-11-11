#!/usr/bin/env python3
"""測定結果 CSV（ビーコンタブの「結果を書き出す」）から距離の式の値を求める。

距離の式  RSSI = A − 10·n·log10(d)  に、測定結果を最小二乗で当てはめて
  - A（1m 地点の強さ）と n（減衰係数）
  - 体の向き・Android の向き・iPhone の向き・障害物（壁など）ごとの RSSI のずれ（dB）
を同時に求め、今のアプリの値（A=−45, n=4.0）と比べた距離の誤差を出す。

使い方:
  python3 tools/analyze_rssi.py 測定結果1.csv 測定結果2.csv ...
  python3 tools/analyze_rssi.py *.csv --out report.md      # 結果を Markdown にも保存
  python3 tools/analyze_rssi.py *.csv --raw                # アプリの平均（直近2秒。2026/11/11 より前の記録は4秒）ではなく生の受信値の平均で当てはめる
  python3 tools/analyze_rssi.py *.csv --slant              # 手入力の「実際の距離」が斜めの距離のとき
  python3 tools/analyze_rssi.py 測定データ                  # フォルダを渡すと、中（サブフォルダも）の測定結果 CSV をすべて使う
  python3 tools/analyze_rssi.py                             # 何も渡さないと、近くの「測定データ」フォルダを探して使う

  python3 tools/analyze_rssi.py 測定データ --out-dir 分析結果  # 「RSSI分析結果_日付-時刻.md」をそのフォルダに作る（なければ作る）
  python3 tools/analyze_rssi.py 測定データ --summary         # 画面には結論（アプリに使う A と n）だけを出す

  Windows では tools/RSSI分析.bat をダブルクリックするか、CSV・フォルダをその上にドラッグ＆ドロップしても動く。

  結論の A・n：アプリの式 d = 10^((A − RSSI) ÷ (10 × n)) で出した推定距離と実際の距離の差（誤差率）が、
  全データでいちばん小さくなる A・n を総当たりで探す（n はアプリのスライダーと同じ 2.0〜5.0）。
  今の値より誤差が目に見えて減るときだけ、変えることをすすめる（データが少ない・距離の幅が狭いときはすすめない）。

  高さの補正：手入力の「実際の距離」は床の上の（水平の）距離として、iPhone と Android の高さが両方入っていれば
  斜めの距離 √(水平の距離² + 高さの差²) にしてから当てはめる（例 デスク 0.7m・手持ち 1.4m なら差 0.7m）。
  「ミミナビの位置」を指定した記録は、アプリが高さの差を含めて計算済みなのでそのまま使う。

  基準（ずれ 0 とする条件）は、体の向き=正面・向き=縦・障害物=無し。
  1つの CSV を何度書き出しても、同じ記録（記録No・測定日時・ビーコン）は1回だけ数える。
外部ライブラリは使わない（Python 3 のみ）。
"""
import argparse
import csv
import datetime
import math
import sys
from pathlib import Path
from collections import Counter, defaultdict

CUR_A, CUR_N = -45.0, 4.0
GRID_A = [x / 2 for x in range(-140, -59)]     # A の候補：−70.0〜−30.0 dBm（0.5 刻み）
GRID_N = [x / 10 for x in range(20, 51)]       # n の候補：2.0〜5.0（アプリのスライダーと同じ範囲・0.1 刻み）
BETTER_PT = 3.0                                # 誤差率がこの % 以上減るときだけ、値を変えることをすすめる
MIN_ROWS = 30                                  # これより行数が少ないときは、値を変えることをすすめない
FACTORS = [  # (CSV の列, 表示名, 基準の値)
    ('体の向き', '体の向き', '正面'),
    ('Androidの向き', 'Androidの向き', '縦'),
    ('iPhoneの向き', 'iPhoneの向き', '縦'),
    ('障害物', '障害物', '無し'),
]


def num(v):
    try:
        x = float(str(v).replace(',', '.'))
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def read_rows(paths, use_raw, slant=False):
    rows, seen = [], set()
    for p in paths:
        with open(p, encoding='utf-8-sig', newline='') as f:
            for r in csv.DictReader(f):
                key = (r.get('受信端末'), r.get('記録No'), r.get('測定日時'), r.get('対象ビーコン'))
                if key in seen:
                    continue
                seen.add(key)
                d = num(r.get('実際の距離(m)'))
                rssi = num(r.get('生RSSI平均値' if use_raw else 'RSSI平均値'))
                if d is None or d <= 0 or rssi is None:
                    continue
                ih, ah = num(r.get('iPhoneの高さ(m)')), num(r.get('Androidの高さ(m)'))
                if not slant and not (r.get('ミミナビの位置') or '').strip() and ih is not None and ah is not None:
                    d = math.hypot(d, ih - ah)
                lv = {}
                for col, _, base in FACTORS:
                    v = (r.get(col) or '').strip()
                    lv[col] = v or base   # 空欄（以前の記録）は基準扱い
                rows.append({'d': d, 'rssi': rssi, 'beacon': r.get('対象ビーコン', ''), **lv})
    return rows


DATA_DIR = '測定データ'
CSV_PATTERN = '*測定結果*.csv'   # 「結果を書き出す」の CSV（miminavi_測定結果_日付-時刻.csv）。生データは使わない


def expand_paths(paths):
    """ファイルはそのまま、フォルダは中（サブフォルダも）の測定結果 CSV に展開する。
    何も渡されなければ、今のフォルダ・このファイルのフォルダ・その上のフォルダにある「測定データ」を探す。"""
    if not paths:
        here = Path(__file__).resolve().parent
        cands = [Path.cwd() / DATA_DIR, here / DATA_DIR, here.parent / DATA_DIR]
        found = next((c for c in cands if c.is_dir()), None)
        if not found:
            sys.exit('「測定データ」フォルダが見つかりません。CSV かフォルダを指定してください（探した場所：'
                     + '、'.join(str(c) for c in cands) + '）')
        paths = [str(found)]
    files = []
    for p in map(Path, paths):
        if p.is_dir():
            files += sorted(p.rglob(CSV_PATTERN))
        elif p.is_file():
            files.append(p)
        else:
            sys.exit(f'見つかりません：{p}')
    if not files:
        sys.exit(f'測定結果の CSV（{CSV_PATTERN}）が見つかりません：' + '、'.join(paths))
    return [str(f) for f in files]


def solve(X, y):
    """正規方程式をガウスの消去法で解く。解けない列（ばらつきがない条件）は 0 にする。"""
    k = len(X[0])
    M = [[sum(r[i] * r[j] for r in X) for j in range(k)] + [sum(r[i] * t for r, t in zip(X, y))] for i in range(k)]
    piv = [None] * k
    row = 0
    for c in range(k):
        p = max(range(row, k), key=lambda i: abs(M[i][c]), default=None)
        if p is None or abs(M[p][c]) < 1e-9:
            continue
        M[row], M[p] = M[p], M[row]
        for i in range(k):
            if i != row and M[i][c]:
                f = M[i][c] / M[row][c]
                M[i] = [a - f * b for a, b in zip(M[i], M[row])]
        piv[c] = row
        row += 1
    return [M[piv[c]][k] / M[piv[c]][c] if piv[c] is not None else 0.0 for c in range(k)], [p is not None for p in piv]


def fit(rows, factors):
    """RSSI = A − 10n·log10(d) + Σ ずれ。factors は (列, 基準) のうち、基準以外の値を説明変数にする。"""
    cols = ['A', 'n']
    for col, _, base in factors:
        for v in sorted({r[col] for r in rows} - {base}):
            cols.append((col, v))
    X, y = [], []
    for r in rows:
        x = [1.0, -10 * math.log10(r['d'])]
        for c in cols[2:]:
            x.append(1.0 if r[c[0]] == c[1] else 0.0)
        X.append(x)
        y.append(r['rssi'])
    b, ok = solve(X, y)
    res = [t - sum(a * c for a, c in zip(x, b)) for x, t in zip(X, y)]
    rmse = math.sqrt(sum(e * e for e in res) / len(res))
    return dict(zip(cols, b)), dict(zip(cols, ok)), rmse, X


def dist_err(rows, A, n, offsets=None):
    """推定距離の誤差（実際の距離との差）。offsets を渡すと条件ごとのずれを補正してから距離にする。"""
    errs, rel = [], []
    for r in rows:
        rssi = r['rssi'] - sum(offsets.get((col, r[col]), 0.0) for col, _, _ in FACTORS) if offsets else r['rssi']
        est = min(30, max(0.1, 10 ** ((A - rssi) / (10 * n))))
        errs.append(abs(est - r['d']))
        rel.append(abs(est - r['d']) / r['d'] * 100)
    errs.sort()
    return sum(errs) / len(errs), errs[len(errs) // 2], sum(rel) / len(rel)


def best_by_distance(rows):
    """推定距離の誤差率がいちばん小さくなる A・n（総当たり）"""
    best = None
    for n in GRID_N:
        for A in GRID_A:
            m, med, rel = dist_err(rows, A, n)
            if best is None or rel < best[4] - 1e-9:
                best = (A, n, m, med, rel)
    return best


def conclusion(rows):
    """結論（アプリに使う A と n）の Markdown の行"""
    cm, cmed, crel = dist_err(rows, CUR_A, CUR_N)
    A, n, m, med, rel = best_by_distance(rows)
    out = ['## 結論：アプリに使う A（1m 地点の値）と n（減衰係数）\n',
           '> アプリに入れるべき A と n です。ふだんはここだけ見れば十分です（下の 1.〜5. は根拠と詳しい分析）。\n']
    ds = [r['d'] for r in rows]
    if len(rows) < MIN_ROWS or max(ds) / min(ds) < 3:
        out.append(f'**今の値（A = {CUR_A:.0f} dBm、n = {CUR_N:.1f}）のままにしてください。**'
                   f'データが {len(rows)} 行・距離 {min(ds):.1f}〜{max(ds):.1f}m で、A・n を決めるには足りません'
                   f'（{MIN_ROWS} 行以上・いちばん遠い距離がいちばん近い距離の 3 倍以上が必要。例 1m〜5m）。'
                   f'参考：誤差がいちばん小さい値は A = {A:.1f}、n = {n:.1f}（誤差率 {crel:.0f}% → {rel:.0f}%）です。\n')
    elif rel <= crel - BETTER_PT:
        out.append(f'**A = {A:.1f} dBm、n = {n:.1f} に変えるのがおすすめです。**'
                   f'推定距離の誤差が、平均 {cm:.2f}m → {m:.2f}m（誤差率 {crel:.0f}% → {rel:.0f}%）に減ります。\n')
    else:
        out.append(f'**今の値（A = {CUR_A:.0f} dBm、n = {CUR_N:.1f}）のままでよいです。**'
                   f'いちばん誤差が小さくなる値（A = {A:.1f}、n = {n:.1f}）にしても、誤差率は {crel:.0f}% → {rel:.0f}% で、'
                   f'ほとんど変わりません。\n')
    out += ['| | A（1m 地点の値） | n（減衰係数） | 推定距離の誤差（平均） | 中央値 | 誤差率（平均） |',
            '|---|---:|---:|---:|---:|---:|',
            f'| 今のアプリ | {CUR_A:.1f} dBm | {CUR_N:.1f} | {cm:.2f}m | {cmed:.2f}m | {crel:.0f}% |',
            f'| 誤差がいちばん小さい値 | {A:.1f} dBm | {n:.1f} | {m:.2f}m | {med:.2f}m | {rel:.0f}% |', '']
    edge = []
    if A in (GRID_A[0], GRID_A[-1]):
        edge.append(f'A が探した範囲（{GRID_A[0]:.0f}〜{GRID_A[-1]:.0f} dBm）の端です')
    if n in (GRID_N[0], GRID_N[-1]):
        edge.append(f'n がアプリで設定できる範囲（{GRID_N[0]:.1f}〜{GRID_N[-1]:.1f}）の端です')
    if edge:
        out.append('- ※ ' + '。'.join(edge) + '。データが偏っている可能性があります')
    out += [f'- 全 {len(rows)} 行で、アプリと同じ式 d = 10^((A − RSSI) ÷ (10 × n)) の推定距離と実際の距離を比べた結果です',
            '- n はビーコンタブ「距離の推定」の「減衰係数 n」で変えられます。A を全部のビーコンで変えるにはアプリの改修'
            '（`app.js` の `DEFAULT_A`）が必要です。ビーコンごとなら、そのビーコンから1m の所で「1mで補正」を押します',
            '- 現在地の求め方が「近接型」（標準）のときは、現在地の計算に A・n を使いません（画面の推定距離と「距離から計算」に使います）',
            '- 下の「1.」「2.」の A・n は RSSI の式への当てはめで、距離の誤差を小さくする値とは別です。アプリに入れるのは上の値です\n']
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('csv', nargs='*', help='測定結果 CSV またはフォルダ（省略すると「測定データ」フォルダを探す）')
    ap.add_argument('--raw', action='store_true', help='生RSSI平均値で当てはめる（既定は アプリが使う平均（直近2秒。以前の記録は4秒）の RSSI平均値）')
    ap.add_argument('--slant', action='store_true', help='手入力の「実際の距離」を斜めの距離としてそのまま使う（高さで補正しない）')
    ap.add_argument('--out', help='結果を Markdown で保存するファイル')
    ap.add_argument('--out-dir', help='このフォルダに「RSSI分析結果_日付-時刻.md」を作る（フォルダがなければ作る）')
    ap.add_argument('--summary', action='store_true', help='画面には結論（アプリに使う A と n）だけを出す')
    a = ap.parse_args()

    a.csv = expand_paths(a.csv)
    rows = read_rows(a.csv, a.raw, a.slant)
    if len(rows) < 3:
        sys.exit('使える行が足りません（実際の距離と RSSI が入った行が 3 行以上必要）')
    out = []
    p = out.append
    now = datetime.datetime.now()
    p(f'# RSSI 分析結果（{now:%Y/%m/%d %H:%M}）\n\n対象：{len(rows)} 行（CSV {len(a.csv)} 個：{", ".join(Path(f).name for f in a.csv)}。同じ記録は1回だけ数える）　RSSI：{"生の受信値の平均" if a.raw else "アプリが使う平均（直近2秒。2026/11/11 より前の記録は4秒）"}\n')

    summary = conclusion(rows)
    out += summary

    # 1) 基準条件だけで A と n
    base_rows = [r for r in rows if all(r[col] == base for col, _, base in FACTORS)]
    p('## 1. 距離の式（基準条件：体 正面・縦・障害物なし）\n')
    p('> 条件のそろった測定だけで、「RSSI が距離に対してどう下がるか」の式に当てはめた A と n です。'
      '推定距離の誤差を最小にした値ではないので、アプリには入れません（入れるのは「結論」の値）。\n')
    if len({round(math.log10(r['d']), 3) for r in base_rows}) >= 2:
        c, _, rmse, _ = fit(base_rows, [])
        A0, n0 = c['A'], c['n']
        p(f'- {len(base_rows)} 行から：**A = {A0:.1f} dBm、n = {n0:.2f}**（当てはめの残差 RMSE {rmse:.1f} dB）')
        ds = [r['d'] for r in base_rows]
        if len(base_rows) < 10 or max(ds) / min(ds) < 3:
            p(f'- ※ 行数（{len(base_rows)} 行）か距離の幅（{min(ds):.1f}〜{max(ds):.1f}m）が足りないため、参考にしかならない値です。'
              '体 正面・縦・障害物なしで、1m〜5m 以上の距離を測ると求まります')
    else:
        A0 = n0 = None
        p(f'- 基準条件の行が {len(base_rows)} 行で、距離が 2 種類以上ないため求められません')

    # 2) 全データで条件のずれを同時に
    c, ok, rmse, _ = fit(rows, FACTORS)
    p('\n## 2. 条件ごとの RSSI のずれ（全データで同時に当てはめ）\n')
    p('> 体の向き・端末の向き・障害物によって、電波が基準条件より何 dB 弱く（＋は強く）なるかです。'
      'アプリはこのずれを補正しないので、「距離への影響」の倍率だけ推定距離がずれます。どの条件の影響が大きいかが分かります。\n')
    p(f'- 全 {len(rows)} 行：A = {c["A"]:.1f} dBm、n = {c["n"]:.2f}（RMSE {rmse:.1f} dB）\n')
    p('| 条件 | 値 | 行数 | ずれ (dB) | 距離への影響 |')
    p('|---|---|---:|---:|---|')
    cnt = {col: Counter(r[col] for r in rows) for col, _, _ in FACTORS}
    for col, name, base in FACTORS:
        p(f'| {name} | {base}（基準） | {cnt[col][base]} | 0.0 | — |')
        for v in sorted(set(cnt[col]) - {base}):
            k = (col, v)
            if not ok.get(k):
                p(f'| {name} | {v} | {cnt[col][v]} | 求められない | 他の条件と同時にしか変えていない |')
                continue
            dB = c[k]
            factor = 10 ** (-dB / (10 * c['n']))
            p(f'| {name} | {v} | {cnt[col][v]} | {dB:+.1f} | 補正しないと距離を ×{factor:.2f} に見積もる |')

    # 3) ビーコン（iPhone）ごとのずれ
    p('\n## 3. ビーコン（iPhone）ごとの残差の平均\n')
    p('> iPhone ごとの電波の強さのくせです。同じ距離・同じ条件でも、iPhone によって電波が強め（＋）・弱め（−）になります。'
      '±3dB 以上の iPhone は距離が狂いやすいので、そのビーコンの「1mで補正」を使います。\n')
    p('| ビーコン | 行数 | 残差の平均 (dB) |')
    p('|---|---:|---:|')
    per = defaultdict(list)
    for r in rows:
        pred = c['A'] - 10 * c['n'] * math.log10(r['d']) + sum(c.get((col, r[col]), 0.0) for col, _, _ in FACTORS)
        per[r['beacon']].append(r['rssi'] - pred)
    for b in sorted(per):
        p(f'| {b} | {len(per[b])} | {sum(per[b]) / len(per[b]):+.1f} |')

    # 4) 距離の誤差の比較
    p('\n## 4. 推定距離の誤差（全データ）\n')
    p('> A・n の候補ごとに、アプリが出す推定距離が実際の距離とどれだけずれるかを比べた表です。'
      '誤差が小さいほど、その A・n で距離が合います。「結論」の判断のもとになる比較です。\n')
    p('| 式の値 | 平均絶対誤差 (m) | 中央値 (m) | 平均誤差率 (%) |')
    p('|---|---:|---:|---:|')
    cand = [(f'今のアプリ（A={CUR_A:.0f}, n={CUR_N:.1f}）', CUR_A, CUR_N, None)]
    if A0 is not None:
        cand.append((f'基準条件の当てはめ（A={A0:.1f}, n={n0:.2f}）', A0, n0, None))
    cand.append((f'全データの当てはめ（A={c["A"]:.1f}, n={c["n"]:.2f}）', c['A'], c['n'], None))
    cand.append(('全データ＋条件のずれを補正', c['A'], c['n'], c))
    for name, A, n, off in cand:
        m, med, rel = dist_err(rows, A, n, off)
        p(f'| {name} | {m:.2f} | {med:.2f} | {rel:.0f} |')

    # 5) 距離ごとの平均 RSSI（グラフ用）
    p('\n## 5. 実際の距離ごとの RSSI（基準条件）\n')
    p('> 実際の距離ごとに、測った RSSI の平均と、式から予測した RSSI を並べた表です。'
      '距離が離れるほど RSSI がちゃんと下がっているかを確かめられます（グラフにするときの元データにもなります）。\n')
    p('| 実際の距離・斜め (m) | 行数 | RSSI 平均 | 式の予測（全データ） |')
    p('|---:|---:|---:|---:|')
    byd = defaultdict(list)
    for r in base_rows or rows:
        byd[round(r['d'], 2)].append(r['rssi'])
    for d in sorted(byd):
        v = byd[d]
        p(f'| {d:g} | {len(v)} | {sum(v) / len(v):.1f} | {c["A"] - 10 * c["n"] * math.log10(d):.1f} |')

    p('\n## アプリに反映するとき\n')
    p('- A・n は、いちばん上の「結論」の値を使う')
    p('- 体の向き・壁のずれ（「2.」）が数 dB 以上あるなら、その分を RSSI に足してから距離にする補正を検討する')
    text = '\n'.join(out) + '\n'
    outs = [a.out] if a.out else []
    if a.out_dir:
        d = Path(a.out_dir).resolve()
        d.mkdir(parents=True, exist_ok=True)   # なければ作る
        outs.append(str(d / f'RSSI分析結果_{now:%Y%m%d-%H%M}.md'))
    for o in outs:
        with open(o, 'w', encoding='utf-8') as f:
            f.write(text)
    if a.summary:
        print('\n'.join(l[2:] if l.startswith('> ') else l for l in summary if not l.startswith('|---')).replace('**', ''))
        for o in outs:
            print(f'\n結果をすべて保存しました：{o}')
    else:
        print(text)


if __name__ == '__main__':
    main()
