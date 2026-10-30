#!/usr/bin/env python3
"""draw.io のフロアマップ → ミミナビ用の地図データ（map.js）

使い方:
    python3 tools/drawio_to_map.py map/floor.drawio app/src/main/assets/map.js

draw.io 側のルール（各図形の「データを編集」= Ctrl+M で設定）
  kind = wall / glass / partition   … 壁（線）。通れない
  kind = door / opening             … ドア・開口（壁の隙間に置く四角）。通れる
         access = staff             … 関係者のみのドア
  kind = furniture / pillar / equipment … 家具・柱・設備。通れない
  kind = room                       … 部屋・エリア（名前の表示と、建物の内側の判定に使う）
  kind = corridor                   … 案内ルート（通路）。ルートはここを優先して通り、現在地もここに寄せる
                                      （kind がなくても、draw.io の赤い四角 = 塗り #f8cecc・線 #b85450 は通路として扱う）
  kind = destination                … 目的地。label = 画面と読み上げの名前、keywords = 呼び方（カンマ区切り）
  kind = beacon                     … ビーコン。label = B-01 など、minor = iPhone 側の Minor 番号
  「イス」レイヤーの図形            … デスクに収納する前提なので通れる扱い（表示のみ）
  length_mm（壁に設定）             … 実際の長さ。2本あれば縦横それぞれの縮尺を補正する
外部ライブラリは使わない（Python 3.8 以上の標準ライブラリのみ）。
"""
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from collections import deque

CELL = 0.2            # 通行判定のマスの大きさ（m）
WALL_HALF = 0.12      # 壁の線から何 m 以内のマスをふさぐか（マスの半分より少し大きく）
DOOR_EXPAND = 0.2     # ドアの四角を壁の厚み方向に広げる量（m）
MARGIN = 0.4          # 地図の外周の余白（m）
DEFAULT_MM_PER_UNIT = 10.0   # length_mm がないとき：draw.io の 1 = 10mm


def num(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def style_dict(s):
    out = {}
    for part in (s or '').split(';'):
        if '=' in part:
            k, v = part.split('=', 1)
            out[k.strip()] = v.strip()
        elif part.strip():
            out[part.strip()] = '1'
    return out


def clean_label(s):
    s = re.sub(r'<br\s*/?>', ' ', s or '')
    s = re.sub(r'<[^>]+>', '', s)
    s = s.replace('&nbsp;', ' ').replace('&amp;', '&')
    return re.sub(r'\s+', ' ', s).strip()


# ------------------------------------------------------------------ 読み込み
def load_cells(path):
    root = ET.parse(path).getroot()
    diagram = root.find('diagram')
    model = diagram.find('mxGraphModel')
    if model is None:
        sys.exit('圧縮形式の .drawio には未対応です。draw.io の「ファイル → プロパティ → 圧縮」をオフにして保存してください。')
    cells = {}
    order = []
    for el in model.find('root'):
        if el.tag in ('object', 'UserObject'):
            c = el.find('mxCell')
            attrs = dict(el.attrib)
            attrs.setdefault('label', '')
        else:
            c = el
            attrs = {'id': el.get('id'), 'label': el.get('value', '')}
        if c is None:
            continue
        cid = attrs['id']
        cells[cid] = {'attrs': attrs, 'cell': c, 'style': style_dict(c.get('style')), 'parent': c.get('parent')}
        order.append(cid)
    return cells, order


def layer_of(cells, cid):
    """図形が属するレイヤー（親をたどって parent=0 の直下）"""
    seen = set()
    while cid in cells and cid not in seen:
        seen.add(cid)
        p = cells[cid]['parent']
        if p == '0':
            return cid
        cid = p
    return None


def abs_offset(cells, cid):
    """グループの中の図形は親の座標を足す"""
    ox = oy = 0.0
    p = cells[cid]['parent']
    while p in cells and cells[p]['parent'] not in (None, '0'):
        g = cells[p]['cell'].find('mxGeometry')
        if g is not None and cells[p]['cell'].get('vertex') == '1':
            ox += num(g.get('x'))
            oy += num(g.get('y'))
        p = cells[p]['parent']
    return ox, oy


def vertex_rect(cells, cid):
    g = cells[cid]['cell'].find('mxGeometry')
    if g is None:
        return None
    ox, oy = abs_offset(cells, cid)
    return (num(g.get('x')) + ox, num(g.get('y')) + oy, num(g.get('width')), num(g.get('height')))


def vertex_poly(cells, cid):
    x, y, w, h = vertex_rect(cells, cid)
    rot = num(cells[cid]['style'].get('rotation'), 0.0)
    pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    if rot:
        cx, cy = x + w / 2, y + h / 2
        a = math.radians(rot)
        ca, sa = math.cos(a), math.sin(a)
        pts = [(cx + (px - cx) * ca - (py - cy) * sa, cy + (px - cx) * sa + (py - cy) * ca) for px, py in pts]
    return pts


def edge_points(cells, cid):
    """線の点列。図形に接続している端は draw.io と同じ規則で位置を決める"""
    c = cells[cid]['cell']
    st = cells[cid]['style']
    g = c.find('mxGeometry')
    if g is None:
        return []
    ox, oy = abs_offset(cells, cid)
    sp = g.find("mxPoint[@as='sourcePoint']")
    tp = g.find("mxPoint[@as='targetPoint']")
    arr = g.find('Array')
    mids = [(num(p.get('x')) + ox, num(p.get('y')) + oy) for p in arr] if arr is not None else []
    s = (num(sp.get('x')) + ox, num(sp.get('y')) + oy) if sp is not None else None
    t = (num(tp.get('x')) + ox, num(tp.get('y')) + oy) if tp is not None else None

    def terminal(term_id, prefix, stored, toward):
        if not term_id or term_id not in cells or cells[term_id]['cell'].get('vertex') != '1':
            return stored
        x, y, w, h = vertex_rect(cells, term_id)
        if prefix + 'X' in st and prefix + 'Y' in st:   # 固定の接続点
            return (x + num(st[prefix + 'X']) * w + num(st.get(prefix + 'Dx')),
                    y + num(st[prefix + 'Y']) * h + num(st.get(prefix + 'Dy')))
        # 浮いた接続：図形の中心から隣の点へ向かう線と外周の交点
        cx, cy = x + w / 2, y + h / 2
        if toward is None:
            return (cx, cy)
        dx, dy = toward[0] - cx, toward[1] - cy
        if dx == 0 and dy == 0:
            return (cx, cy)
        tx = (w / 2) / abs(dx) if dx else float('inf')
        ty = (h / 2) / abs(dy) if dy else float('inf')
        k = min(tx, ty)
        return (cx + dx * k, cy + dy * k)

    s_toward = mids[0] if mids else t
    t_toward = mids[-1] if mids else s
    s = terminal(c.get('source'), 'exit', s, s_toward)
    t = terminal(c.get('target'), 'entry', t, t_toward)
    pts = ([s] if s else []) + mids + ([t] if t else [])
    return pts


# ------------------------------------------------------------------ 幾何
def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    if L == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def in_poly(px, py, poly):
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > py) != (y2 > py):
            xi = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
            if px < xi:
                inside = not inside
    return inside


def poly_edge_dist(px, py, poly):
    return min(seg_dist(px, py, *poly[i], *poly[(i + 1) % len(poly)]) for i in range(len(poly)))


# ------------------------------------------------------------------ 本体
def convert(src):
    cells, order = load_cells(src)
    layer_names = {cid: clean_label(cells[cid]['attrs'].get('label')) for cid in order if cells[cid]['parent'] == '0'}
    warnings = []

    def kind_of(cid):
        a = cells[cid]['attrs']
        k = (a.get('kind') or '').strip()
        st_ = cells[cid]['style']
        if cells[cid]['cell'].get('vertex') == '1' and \
                st_.get('fillColor', '').lower() == '#f8cecc' and st_.get('strokeColor', '').lower() == '#b85450':
            return 'corridor'
        if k:
            return k
        lname = layer_names.get(layer_of(cells, cid), '')
        lab = clean_label(a.get('label'))
        if 'イス' in lname or lab == 'イス':
            return 'chair'
        if cells[cid]['cell'].get('edge') == '1' and '壁' in lname:
            return 'wall'
        if '家具' in lname and cells[cid]['cell'].get('vertex') == '1':
            return 'furniture'
        return ''

    # 縮尺：length_mm の付いた壁から縦横の mm/単位 を求める
    refs = []
    for cid in order:
        a = cells[cid]['attrs']
        if a.get('length_mm') and cells[cid]['cell'].get('edge') == '1':
            pts = edge_points(cells, cid)
            if len(pts) >= 2:
                dx = abs(pts[-1][0] - pts[0][0])
                dy = abs(pts[-1][1] - pts[0][1])
                refs.append((dx, dy, num(a['length_mm']), clean_label(a.get('name') or a.get('label'))))
    sx = sy = DEFAULT_MM_PER_UNIT
    if len(refs) >= 2:
        # (dx*sx)^2 + (dy*sy)^2 = L^2 を2本で連立
        (a1, b1, L1, _), (a2, b2, L2, _) = refs[0], refs[1]
        A = [[a1 * a1, b1 * b1], [a2 * a2, b2 * b2]]
        B = [L1 * L1, L2 * L2]
        det = A[0][0] * A[1][1] - A[0][1] * A[1][0]
        if abs(det) > 1e-6:
            u = (B[0] * A[1][1] - A[0][1] * B[1]) / det
            v = (A[0][0] * B[1] - B[0] * A[1][0]) / det
            if u > 0 and v > 0:
                sx, sy = math.sqrt(u), math.sqrt(v)
    elif len(refs) == 1:
        dx, dy, L, _ = refs[0]
        sx = sy = L / math.hypot(dx, dy)
    scale_note = {'mm_per_unit_x': round(sx, 4), 'mm_per_unit_y': round(sy, 4),
                  'references': [{'name': r[3], 'length_mm': r[2]} for r in refs]}

    def M(p):  # draw.io 座標 → m
        return (p[0] * sx / 1000.0, p[1] * sy / 1000.0)

    walls, doors, obstacles, chairs, rooms, dests, beacons, corridors = [], [], [], [], [], [], [], []
    for cid in order:
        info = cells[cid]
        a = info['attrs']
        k = kind_of(cid)
        is_edge = info['cell'].get('edge') == '1'
        is_vertex = info['cell'].get('vertex') == '1'
        name = clean_label(a.get('name') or a.get('label'))
        label = clean_label(a.get('label')) or name
        if not k or k in ('reference', 'note'):
            continue
        if is_edge and k in ('wall', 'glass', 'partition'):
            pts = [M(p) for p in edge_points(cells, cid)]
            if len(pts) >= 2:
                walls.append({'kind': k, 'name': name, 'pts': pts})
        elif is_vertex:
            poly = [M(p) for p in vertex_poly(cells, cid)]
            xs = [p[0] for p in poly]
            ys = [p[1] for p in poly]
            cx, cy = sum(xs) / 4, sum(ys) / 4
            if k in ('door', 'opening'):
                doors.append({'kind': k, 'name': name, 'access': a.get('access', 'all'), 'poly': poly})
            elif k in ('furniture', 'pillar', 'equipment'):
                shape = 'ellipse' if 'ellipse' in info['style'] else 'rect'
                obstacles.append({'kind': k, 'name': name, 'poly': poly, 'shape': shape})
            elif k == 'chair':
                chairs.append({'poly': poly, 'shape': 'ellipse' if 'ellipse' in info['style'] else 'rect'})
            elif k == 'room':
                rooms.append({'name': label, 'poly': poly})
            elif k == 'corridor':
                corridors.append({'name': name, 'poly': poly})
            elif k == 'destination':
                kws = [s.strip() for s in re.split(r'[,、，]', a.get('keywords', '')) if s.strip()]
                dests.append({'id': cid, 'name': label, 'keywords': kws, 'at': (cx, cy),
                              'future': a.get('future', '')})
            elif k == 'beacon':
                minor = a.get('minor') or re.sub(r'\D', '', label) or ''
                beacons.append({'label': label, 'minor': int(minor) if minor.isdigit() else None,
                                'place': a.get('place', ''), 'at': (cx, cy)})

    # ------------------------------------------------ 通行グリッド
    allpts = [p for w in walls for p in w['pts']] + [p for o in obstacles for p in o['poly']] + \
             [p for r in rooms for p in r['poly']]
    minx = min(p[0] for p in allpts) - MARGIN
    miny = min(p[1] for p in allpts) - MARGIN
    maxx = max(p[0] for p in allpts) + MARGIN
    maxy = max(p[1] for p in allpts) + MARGIN
    W = int(math.ceil((maxx - minx) / CELL))
    H = int(math.ceil((maxy - miny) / CELL))

    def center(ix, iy):
        return (minx + (ix + 0.5) * CELL, miny + (iy + 0.5) * CELL)

    wall = [[False] * W for _ in range(H)]
    furn = [[False] * W for _ in range(H)]
    door = [[None] * W for _ in range(H)]
    room = [[False] * W for _ in range(H)]

    def bbox_cells(pts, pad):
        x0 = max(0, int((min(p[0] for p in pts) - pad - minx) / CELL))
        x1 = min(W - 1, int((max(p[0] for p in pts) + pad - minx) / CELL))
        y0 = max(0, int((min(p[1] for p in pts) - pad - miny) / CELL))
        y1 = min(H - 1, int((max(p[1] for p in pts) + pad - miny) / CELL))
        return x0, x1, y0, y1

    for w in walls:
        pts = w['pts']
        for i in range(len(pts) - 1):
            a_, b_ = pts[i], pts[i + 1]
            x0, x1, y0, y1 = bbox_cells([a_, b_], WALL_HALF)
            for iy in range(y0, y1 + 1):
                for ix in range(x0, x1 + 1):
                    px, py = center(ix, iy)
                    if seg_dist(px, py, *a_, *b_) <= WALL_HALF:
                        wall[iy][ix] = True
    for o in obstacles:
        x0, x1, y0, y1 = bbox_cells(o['poly'], 0.1)
        for iy in range(y0, y1 + 1):
            for ix in range(x0, x1 + 1):
                px, py = center(ix, iy)
                if in_poly(px, py, o['poly']) or poly_edge_dist(px, py, o['poly']) <= 0.06:
                    furn[iy][ix] = True
    for di, d in enumerate(doors):
        poly = d['poly']
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        wdt, hgt = max(xs) - min(xs), max(ys) - min(ys)
        ex = DOOR_EXPAND if wdt < hgt else 0.0
        ey = DOOR_EXPAND if hgt <= wdt else 0.0
        bx0, bx1, by0, by1 = min(xs) - ex, max(xs) + ex, min(ys) - ey, max(ys) + ey
        d['width_m'] = round(max(wdt, hgt), 2)
        for iy in range(H):
            for ix in range(W):
                px, py = center(ix, iy)
                if bx0 <= px <= bx1 and by0 <= py <= by1:
                    door[iy][ix] = di
    for r in rooms:
        x0, x1, y0, y1 = bbox_cells(r['poly'], 0)
        for iy in range(y0, y1 + 1):
            for ix in range(x0, x1 + 1):
                if in_poly(*center(ix, iy), r['poly']):
                    room[iy][ix] = True

    # 建物の外：外周からドアを閉じた状態で塗りつぶし、部屋の外側を除外
    outside = [[False] * W for _ in range(H)]
    q = deque()
    for ix in range(W):
        for iy in (0, H - 1):
            q.append((ix, iy))
    for iy in range(H):
        for ix in (0, W - 1):
            q.append((ix, iy))
    while q:
        ix, iy = q.popleft()
        if not (0 <= ix < W and 0 <= iy < H) or outside[iy][ix]:
            continue
        if wall[iy][ix] or door[iy][ix] is not None:
            continue
        outside[iy][ix] = True
        q.extend(((ix + 1, iy), (ix - 1, iy), (ix, iy + 1), (ix, iy - 1)))

    free = [[False] * W for _ in range(H)]
    for iy in range(H):
        for ix in range(W):
            blocked = furn[iy][ix] or (wall[iy][ix] and door[iy][ix] is None)
            free[iy][ix] = (not blocked) and ((not outside[iy][ix]) or room[iy][ix])

    # いちばん大きなつながり以外（壁の向こうの切れ端など）は除外
    comp = [[-1] * W for _ in range(H)]
    sizes = []
    for iy in range(H):
        for ix in range(W):
            if free[iy][ix] and comp[iy][ix] < 0:
                cid_ = len(sizes)
                n = 0
                q = deque([(ix, iy)])
                comp[iy][ix] = cid_
                while q:
                    x, y = q.popleft()
                    n += 1
                    for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                        if 0 <= nx < W and 0 <= ny < H and free[ny][nx] and comp[ny][nx] < 0:
                            comp[ny][nx] = cid_
                            q.append((nx, ny))
                sizes.append(n)
    main = max(range(len(sizes)), key=lambda i: sizes[i]) if sizes else -1
    for iy in range(H):
        for ix in range(W):
            if free[iy][ix] and comp[iy][ix] != main:
                free[iy][ix] = False

    # 壁ぎわは少し避ける（通路の真ん中を通るように）
    dist = [[0 if not free[iy][ix] else 99 for ix in range(W)] for iy in range(H)]
    q = deque((ix, iy) for iy in range(H) for ix in range(W) if not free[iy][ix])
    while q:
        x, y = q.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < W and 0 <= ny < H and dist[ny][nx] > dist[y][x] + 1:
                dist[ny][nx] = dist[y][x] + 1
                q.append((nx, ny))

    # 案内ルート（通路）のマス
    lane = [[False] * W for _ in range(H)]
    for c in corridors:
        x0, x1, y0, y1 = bbox_cells(c['poly'], 0.1)
        for iy in range(y0, y1 + 1):
            for ix in range(x0, x1 + 1):
                if free[iy][ix] and (in_poly(*center(ix, iy), c['poly']) or poly_edge_dist(*center(ix, iy), c['poly']) <= 0.1):
                    lane[iy][ix] = True
    lane_rows = [''.join('1' if lane[iy][ix] else '0' for ix in range(W)) for iy in range(H)]
    if corridors:
        # つながっているか確認
        start = next(((ix, iy) for iy in range(H) for ix in range(W) if lane[iy][ix]), None)
        seen_ = set()
        q = deque([start] if start else [])
        while q:
            x, y = q.popleft()
            if (x, y) in seen_:
                continue
            seen_.add((x, y))
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < W and 0 <= ny < H and lane[ny][nx] and (nx, ny) not in seen_:
                    q.append((nx, ny))
        total = sum(r.count('1') for r in lane_rows)
        if len(seen_) != total:
            warnings.append(f'案内ルートが途中で途切れています（{total - len(seen_)} マスがつながっていません。壁や家具と重なっていないか確認してください）')

    rows = []
    for iy in range(H):
        row = []
        for ix in range(W):
            if not free[iy][ix]:
                row.append('#')
            elif door[iy][ix] is not None and doors[door[iy][ix]]['access'] == 'staff':
                row.append('S')
            elif door[iy][ix] is not None and doors[door[iy][ix]]['kind'] == 'door':
                row.append('D')
            else:
                row.append(str(min(dist[iy][ix], 3)) if dist[iy][ix] <= 2 else '.')
        rows.append(''.join(row))

    def cell_of(p):
        return (int((p[0] - minx) / CELL), int((p[1] - miny) / CELL))

    def nearest_free(p):
        ix, iy = cell_of(p)
        best, bd = None, 1e9
        for r_ in range(0, 15):
            for y in range(iy - r_, iy + r_ + 1):
                for x in range(ix - r_, ix + r_ + 1):
                    if 0 <= x < W and 0 <= y < H and free[y][x]:
                        dd = (x - ix) ** 2 + (y - iy) ** 2
                        if dd < bd:
                            bd, best = dd, (x, y)
            if best:
                return best
        return None

    for d in dests:
        c = nearest_free(d['at'])
        if c is None:
            warnings.append(f"目的地「{d['name']}」の近くに通れる場所がありません")
        d['cell'] = c
    for b in beacons:
        if b['minor'] is None:
            warnings.append(f"ビーコン「{b['label']}」の Minor 番号が分かりません")
    minors = [b['minor'] for b in beacons if b['minor'] is not None]
    if len(minors) != len(set(minors)):
        warnings.append('ビーコンの Minor 番号が重複しています')
    for d in doors:
        c = nearest_free([(sum(p[0] for p in d['poly']) / 4), (sum(p[1] for p in d['poly']) / 4)])
        d['cell'] = c

    def R(v):
        return round(v, 3)

    def RP(p):
        return [R(p[0]), R(p[1])]

    out = {
        'version': 1,
        'name': clean_label(cells[order[0]]['attrs'].get('label')) if False else '事業所',
        'source': src.split('/')[-1],
        'scale': scale_note,
        'bounds': [R(minx), R(miny), R(maxx), R(maxy)],
        'grid': {'cell': CELL, 'origin': [R(minx), R(miny)], 'w': W, 'h': H, 'rows': rows,
                 'lanes': lane_rows if corridors else None},
        'corridors': [{'name': c['name'], 'poly': [RP(p) for p in c['poly']]} for c in corridors],
        'rooms': [{'name': r['name'], 'poly': [RP(p) for p in r['poly']]} for r in rooms],
        'walls': [{'kind': w['kind'], 'pts': [RP(p) for p in w['pts']]} for w in walls],
        'doors': [{'kind': d['kind'], 'name': d['name'], 'access': d['access'], 'width': d['width_m'],
                   'poly': [RP(p) for p in d['poly']], 'cell': d['cell']} for d in doors],
        'obstacles': [{'kind': o['kind'], 'name': o['name'], 'shape': o['shape'], 'poly': [RP(p) for p in o['poly']]}
                      for o in obstacles],
        'chairs': [{'shape': c['shape'], 'poly': [RP(p) for p in c['poly']]} for c in chairs],
        'dests': [{'id': d['id'], 'name': d['name'], 'keywords': d['keywords'], 'at': RP(d['at']),
                   'cell': d['cell'], 'future': d['future']} for d in dests],
        'beacons': [{'label': b['label'], 'minor': b['minor'], 'place': b['place'], 'at': RP(b['at'])}
                    for b in sorted(beacons, key=lambda b: (b['minor'] is None, b['minor'] or 0))],
        'warnings': warnings,
    }
    return out


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    data = convert(sys.argv[1])
    js = '/* 自動生成：tools/drawio_to_map.py（' + data['source'] + '）。直接編集しないでください */\n'
    js += 'window.MIMI_MAP = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        f.write(js)
    g = data['grid']
    print(f"地図を書き出しました: {sys.argv[2]}")
    print(f"  縮尺 x={data['scale']['mm_per_unit_x']}mm, y={data['scale']['mm_per_unit_y']}mm（draw.io の 1 あたり）")
    print(f"  範囲 {data['bounds'][2]-data['bounds'][0]:.2f}m × {data['bounds'][3]-data['bounds'][1]:.2f}m、"
          f"マス {g['w']}×{g['h']}（{g['cell']}m）")
    print(f"  壁 {len(data['walls'])}、ドア・開口 {len(data['doors'])}、家具など {len(data['obstacles'])}、"
          f"イス {len(data['chairs'])}、部屋 {len(data['rooms'])}、目的地 {len(data['dests'])}、ビーコン {len(data['beacons'])}、"
          f"案内ルート {len(data['corridors'])}")
    for w in data['warnings']:
        print('  注意: ' + w)


if __name__ == '__main__':
    main()
