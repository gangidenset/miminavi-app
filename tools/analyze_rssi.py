#!/usr/bin/env python3
"""測定結果 CSV（ビーコンタブの「結果を書き出す」）から距離の式の値を求める。

距離の式  RSSI = A − 10·n·log10(d)  に、測定結果を最小二乗で当てはめて
  - A（1m 地点の強さ）と n（減衰係数）
  - 体の向き・Android の向き・iPhone の向き・障害物（壁など）ごとの RSSI のずれ（dB）
を同時に求め、今のアプリの値（A=−45, n=4.0）と比べた距離の誤差を出す。

使い方:
  python3 tools/analyze_rssi.py 測定結果1.csv 測定結果2.csv ...
  python3 tools/analyze_rssi.py *.csv --out report.md      # 結果を Markdown にも保存
  python3 tools/analyze_rssi.py *.csv --raw                # 4秒平均ではなく生の受信値の平均で当てはめる

  基準（ずれ 0 とする条件）は、体の向き=正面・向き=縦・障害物=無し。
  1つの CSV を何度書き出しても、同じ記録（記録No・測定日時・ビーコン）は1回だけ数える。
外部ライブラリは使わない（Python 3 のみ）。
"""
import argparse
import csv
import math
import sys
from collections import Counter, defaultdict

CUR_A, CUR_N = -45.0, 4.0
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


def read_rows(paths, use_raw):
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
                lv = {}
                for col, _, base in FACTORS:
                    v = (r.get(col) or '').strip()
                    lv[col] = v or base   # 空欄（以前の記録）は基準扱い
                rows.append({'d': d, 'rssi': rssi, 'beacon': r.get('対象ビーコン', ''), **lv})
    return rows


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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('csv', nargs='+')
    ap.add_argument('--raw', action='store_true', help='生RSSI平均値で当てはめる（既定は アプリが使う4秒平均の RSSI平均値）')
    ap.add_argument('--out', help='結果を Markdown で保存するファイル')
    a = ap.parse_args()

    rows = read_rows(a.csv, a.raw)
    if len(rows) < 3:
        sys.exit('使える行が足りません（実際の距離と RSSI が入った行が 3 行以上必要）')
    out = []
    p = out.append
    p(f'# RSSI 分析結果\n\n対象：{len(rows)} 行（{", ".join(a.csv)}）　RSSI：{"生の受信値の平均" if a.raw else "4秒平均（アプリと同じ）"}\n')

    # 1) 基準条件だけで A と n
    base_rows = [r for r in rows if all(r[col] == base for col, _, base in FACTORS)]
    p('## 1. 距離の式（基準条件：体 正面・縦・障害物なし）\n')
    if len({round(math.log10(r['d']), 3) for r in base_rows}) >= 2:
        c, _, rmse, _ = fit(base_rows, [])
        A0, n0 = c['A'], c['n']
        p(f'- {len(base_rows)} 行から：**A = {A0:.1f} dBm、n = {n0:.2f}**（当てはめの残差 RMSE {rmse:.1f} dB）')
    else:
        A0 = n0 = None
        p(f'- 基準条件の行が {len(base_rows)} 行で、距離が 2 種類以上ないため求められません')

    # 2) 全データで条件のずれを同時に
    c, ok, rmse, _ = fit(rows, FACTORS)
    p('\n## 2. 条件ごとの RSSI のずれ（全データで同時に当てはめ）\n')
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
    p('端末ごとに送信の強さが違うと、ここが ±3dB 以上になる。大きいビーコンは「1mで補正」を使う。\n')
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
    p('| 実際の距離 (m) | 行数 | RSSI 平均 | 式の予測（全データ） |')
    p('|---:|---:|---:|---:|')
    byd = defaultdict(list)
    for r in base_rows or rows:
        byd[round(r['d'], 2)].append(r['rssi'])
    for d in sorted(byd):
        v = byd[d]
        p(f'| {d:g} | {len(v)} | {sum(v) / len(v):.1f} | {c["A"] - 10 * c["n"] * math.log10(d):.1f} |')

    p('\n## アプリに反映するとき\n')
    p('- `app/src/main/assets/app.js` の `DEFAULT_A`（1m 地点の強さ）と、n の初期値（ビーコンタブの減衰係数）を上の値にする')
    p('- 体の向き・壁のずれが数 dB 以上あるなら、その分を RSSI に足してから距離にする補正を検討する')
    text = '\n'.join(out) + '\n'
    print(text)
    if a.out:
        with open(a.out, 'w', encoding='utf-8') as f:
            f.write(text)


if __name__ == '__main__':
    main()
