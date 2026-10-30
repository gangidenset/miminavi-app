/* ミミナビ 画面ロジック（地図データ版）
 * 地図は map.js（tools/drawio_to_map.py が draw.io から自動生成）の window.MIMI_MAP を使う。
 * ネイティブ側（MainActivity.java）とのやりとり：
 *   JS → ネイティブ : window.MimiNative.startScan() / speak() / listen() / save() など
 *   ネイティブ → JS : window.__native(type, data)  type = beacons | status | heading | speech
 * PC のブラウザで開いた場合は、疑似ビーコンで画面の動きを確認できる。
 */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const N = window.MimiNative || null;
const MAP = window.MIMI_MAP;

// ------------------------------------------------------------ 地図データ
const G = MAP.grid;
const CELL = G.cell;                // 1マス（m）
const [GX, GY] = G.origin;
const GW = G.w, GH = G.h, ROWS = G.rows;
const STEP_COST = { '.': 0, '2': 1.5, '1': 4, 'D': 0, 'S': 0.5 };   // 壁ぎわほど通りにくく
const TURN_COST = 3;                // 曲がる回数を減らす
const U = 100;                      // 描画単位：1m = 100
const K = 3;                        // 目印の大きさの倍率
const [BX0, BY0, BX1, BY1] = MAP.bounds;
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const DNAME = ['図面の上', '図面の右', '図面の下', '図面の左'];
const DESTS = MAP.dests;
const BEACONS = MAP.beacons;        // [{label, minor, place, at}]
const beaconPlace = b => b.place || placeName(b.at);
const ENTRY = (MAP.doors.find(d => /入口/.test(d.name)) || {}).cell || DESTS[0].cell;

const walkable = (x, y) => x >= 0 && y >= 0 && x < GW && y < GH && ROWS[y][x] !== '#';
// 案内ルート（draw.io の赤いライン）。ルートはここを優先して通り、現在地もここに寄せる
const LANES = G.lanes || null;
const isLane = (x, y) => !!LANES && LANES[y][x] === '1';
const OFF_LANE_COST = 10;           // 案内ルートの外を1マス進むときの追加コスト
const cellCenter = c => [GX + (c[0] + 0.5) * CELL, GY + (c[1] + 0.5) * CELL];
const cellOf = p => [Math.floor((p[0] - GX) / CELL), Math.floor((p[1] - GY) / CELL)];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function nearestFree(p) {
  const [cx, cy] = cellOf(p);
  for (let r = 0; r <= 20; r++) {
    let best = null, bd = 1e9;
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r || !walkable(x, y)) continue;
      const d = dist(cellCenter([x, y]), p);
      if (d < bd) { bd = d; best = [x, y]; }
    }
    if (best) return best;
  }
  return ENTRY;
}
function inPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const roomName = n => n.replace(/[（(][^）)]*[)）]$/, '');
// 部屋：重なっている場合はいちばん小さい部屋を採用
const polyArea = pts => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const ROOMS = MAP.rooms.map(r => ({ ...r, area: polyArea(r.poly) }));
function roomAt(p) {
  let best = null;
  ROOMS.forEach(r => { if (inPoly(p, r.poly) && (!best || r.area < best.area)) best = r; });
  return best;
}
const roomCellCache = new Map();
function nearestCellInRoom(room, p) {
  let cells = roomCellCache.get(room.name);
  if (!cells) {
    cells = [];
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (walkable(x, y) && roomAt(cellCenter([x, y])) === room) cells.push([x, y]);
    roomCellCache.set(room.name, cells);
  }
  let best = null, bd = 1e9;
  cells.forEach(c => { const d = dist(cellCenter(c), p); if (d < bd) { bd = d; best = c; } });
  return best;
}
function placeName(p) {
  const d = DESTS.find(d => dist(d.at, p) < 1.2);
  if (d) return d.name;
  const r = roomAt(p);
  return r ? roomName(r.name) : '通路';
}
const spoken = name => name.replace(/[（(]\s*([^）)]*?)\s*[)）]/g, '$1');

// ------------------------------------------------------------ 状態
const st = {
  view: 'home', tab: 'guide', sound: true,
  status: null, beacons: [], others: 0, scanning: false,
  heading: null, pos: null, nav: null, room: null, roomCand: null, roomCandN: 0,
  data: { v: 2, n: 4.0, tx: {}, northOffset: null, assign: {}, uuid: '' },
  placing: null,
};
function load() {
  try {
    const raw = N ? N.load() : localStorage.getItem('miminavi');
    if (raw) {
      const d = JSON.parse(raw);
      // v2 から距離の式の初期値を実測データに合わせて変更。古い n（2.0）は引き継がない
      if (d.v === 2 && typeof d.n === 'number') st.data.n = d.n;
      if (d.tx && typeof d.tx === 'object') st.data.tx = d.tx;
      if (typeof d.northOffset === 'number') st.data.northOffset = d.northOffset;
      if (d.assign && typeof d.assign === 'object') st.data.assign = d.assign;
      if (typeof d.uuid === 'string') st.data.uuid = d.uuid;
    }
  } catch (e) { /* 初回など */ }
}
function save() {
  const s = JSON.stringify(st.data);
  try { if (N) N.save(s); else localStorage.setItem('miminavi', s); } catch (e) { }
}

// ------------------------------------------------------------ 音声
let jaVoice = null;
if (!N && 'speechSynthesis' in window) {
  const pick = () => { jaVoice = speechSynthesis.getVoices().find(v => /ja/i.test(v.lang)) || null; };
  pick(); speechSynthesis.onvoiceschanged = pick;
}
function say(text) {
  $('darkSay').textContent = text;
  if (!st.sound) return;
  if (N) { N.speak(text); return; }
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = 'ja-JP'; if (jaVoice) u.voice = jaVoice; u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch (e) { }
}
function hush() { try { if (N) N.stopSpeak(); else speechSynthesis.cancel(); } catch (e) { } }

// ------------------------------------------------------------ 画面切り替え
const VIEWS = ['home', 'calib', 'listen', 'nav', 'done', 'plan', 'beacons'];
function show(v) {
  st.view = v;
  VIEWS.forEach(k => { $('v-' + k).hidden = k !== v; });
  const tab = v === 'plan' ? 'plan' : v === 'beacons' ? 'beacons' : 'guide';
  st.tab = tab;
  document.querySelectorAll('#tabbar button').forEach(b => b.setAttribute('aria-pressed', b.dataset.tab === tab));
  if (v === 'plan') renderPlan(true);
  if (v === 'beacons') renderBeacons();
  if (v === 'home') renderHome();
}
let guideView = 'home';
$('tabbar').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (st.tab === 'guide') guideView = st.view;
  if (b.dataset.tab === 'guide') show(guideView);
  else show(b.dataset.tab);
});
window.__back = () => {
  if (!$('dark').hidden) { $('dark').hidden = true; return true; }
  if (st.placing) { st.placing = null; renderPlan(true); return true; }
  if (st.tab !== 'guide') { show(guideView); return true; }
  if (st.view !== 'home') { stopNav(); show('home'); return true; }
  return false;
};

// ------------------------------------------------------------ ネイティブからの通知
window.__native = (type, d) => {
  if (type === 'beacons') onBeacons(d);
  else if (type === 'status') { st.status = d; renderStatus(); }
  else if (type === 'heading') onHeading(d);
  else if (type === 'speech') onSpeech(d);
};
// 使う UUID（Beacon Simulator で全台に同じ値を設定）。空ならすべてのビーコン
const normUuid = u => String(u || '').toUpperCase();
const uuidOk = b => !st.data.uuid || (b.type === 'iBeacon' && normUuid(b.uuid) === normUuid(st.data.uuid));
function setUuid(u) {
  st.data.uuid = u ? normUuid(u) : '';
  save();
  if (N && N.setUuidFilter) N.setUuidFilter(st.data.uuid);
  st.beacons = st.beacons.filter(uuidOk);
  st.pos = null; st.room = null;
  estimate();
  renderBeacons();
}
function onBeacons(d) {
  const raw = d.beacons || [];
  st.beacons = raw.filter(uuidOk);
  st.ignored = raw.length - st.beacons.length;
  st.others = d.others || 0;
  st.scanning = !!d.scanning;
  estimate();
  renderChip();
  if (st.view === 'home') renderHomeKpi();
  if (st.view === 'beacons') renderBeacons();
  if (st.view === 'plan') renderPlan(false);
  if (st.view === 'nav') { updateDyn($('navMap')); navRealUpdate(); }
}

// ------------------------------------------------------------ ビーコン → 図面の B-xx（Minor 番号で対応）
// 手動の割り当て（st.data.assign[キー] = {label} または {label, at}）を優先し、なければ Minor 番号で自動対応
function beaconOf(b) {
  const a = st.data.assign[b.key];
  if (a) {
    if (a.at) return { label: a.label, at: a.at, custom: true, manual: true };
    const mb = BEACONS.find(x => x.label === a.label);
    if (mb) return { ...mb, manual: true };
  }
  if (b.type === 'Eddystone') return null;
  const mb = BEACONS.find(x => x.minor === b.minor);
  if (!mb) return null;
  // 同じ B-xx を別のビーコンに手動で割り当て済みなら自動対応しない
  if (Object.entries(st.data.assign).some(([k, v]) => k !== b.key && v.label === mb.label)) return null;
  return mb;
}
// 図面上のビーコン一覧（B-xx ＋ 自分で置いたもの）
function mapBeacons() {
  const custom = Object.values(st.data.assign).filter(a => a.at).map(a => ({ label: a.label, at: a.at, minor: null, custom: true }));
  return BEACONS.concat(custom);
}
function nextCustomLabel() {
  const used = new Set(Object.values(st.data.assign).map(a => a.label));
  for (let i = 1; ; i++) { const l = 'P-' + String(i).padStart(2, '0'); if (!used.has(l)) return l; }
}
// 距離の式：d = 10^((A − RSSI) ÷ (10 × n))
//   A = 1m 地点の強さ。「1mで補正」した値、なければ実測データから求めた −45dBm
//   （iPhone が送ってくる値 −59 は実測と合わなかったため使わない）
//   n = 減衰係数。実測データへの当てはめで 4.0（ビーコンタブで調整可）
const DEFAULT_A = -45;
const txOf = label => typeof st.data.tx[label] === 'number' ? st.data.tx[label] : DEFAULT_A;
function distanceOf(b, label) {
  return Math.min(30, Math.max(0.1, Math.pow(10, (txOf(label) - b.rssi) / (10 * st.data.n))));
}
// 受信中で図面に対応するもの（同じ Minor が複数あれば強い方）
function seenByLabel() {
  const m = new Map();
  st.beacons.forEach(b => {
    if (b.ageMs > 5000) return;
    const mb = beaconOf(b); if (!mb) return;
    const cur = m.get(mb.label);
    if (!cur || b.rssi > cur.b.rssi) m.set(mb.label, { b, mb, d: distanceOf(b, mb.label) });
  });
  return m;
}
// 1m地点の強さで補正した電波の強さ（大きいほど近い）
const strength = u => u.b.rssi - txOf(u.mb.label);
const ROOM_SWITCH_DB = 3;     // 別の部屋に切り替える差（dB）
const ROOM_SWITCH_COUNT = 2;  // 何回続いたら切り替えるか（0.5秒ごと）
function decideRoom(all) {
  // 部屋ごとに、その部屋にあるビーコンのいちばん強い値
  const score = new Map();
  all.forEach(u => {
    const r = roomAt(u.mb.at); if (!r) return;
    const v = strength(u);
    if (!score.has(r.name) || v > score.get(r.name).v) score.set(r.name, { r, v });
  });
  const top = [...score.values()].sort((a, b) => b.v - a.v)[0];
  if (!top) return;
  const cur = st.room && score.get(st.room.name);
  if (!st.room || !cur) { st.room = top.r; st.roomCand = null; return; }
  if (top.r.name !== st.room.name && top.v - cur.v >= ROOM_SWITCH_DB) {
    if (st.roomCand === top.r.name) { if (++st.roomCandN >= ROOM_SWITCH_COUNT) { st.room = top.r; st.roomCand = null; } }
    else { st.roomCand = top.r.name; st.roomCandN = 1; }
  } else st.roomCand = null;
}
const PULL_DB = 6;   // 一番強いビーコンより 6dB 弱いと重みは 1/10（12dB で 1/100）
function estimate() {
  const all = [...seenByLabel().values()].sort((a, c) => strength(c) - strength(a));
  if (!all.length) { st.pos = null; st.room = null; return; }
  const prevRoom = st.room;
  decideRoom(all);   // 部屋の判定は全部のビーコンで（壁越しも含めて比べる）
  // 位置の計算は今いる部屋のビーコンだけ（壁越しのビーコンに引っ張られない）。部屋にビーコンがなければ全部
  const inRoom = st.room ? all.filter(u => roomAt(u.mb.at) === st.room) : [];
  const used = (inRoom.length ? inRoom : all).slice(0, 4);
  // 一番強いビーコンに強く引っ張られる重み：w = 10^((強さ − 一番強い強さ) ÷ 6)
  const top = strength(used[0]);
  let sx = 0, sy = 0, sw = 0;
  used.forEach(u => {
    const w = Math.pow(10, (strength(u) - top) / PULL_DB);
    u.w = w;
    sx += w * u.mb.at[0]; sy += w * u.mb.at[1]; sw += w;
  });
  used.forEach(u => { u.w /= sw; });
  let x = sx / sw, y = sy / sw;
  // 今いる部屋の外に出たら、部屋の中のいちばん近い場所に寄せる（壁の向こうに推定しない）
  if (st.room && !inPoly([x, y], st.room.poly)) {
    const c = nearestCellInRoom(st.room, [x, y]);
    if (c) [x, y] = cellCenter(c);
  }
  // 前回となめらかにつなぐ（部屋が変わったときはそのまま移る）
  if (st.pos && prevRoom === st.room) { x = st.pos.raw[0] + 0.4 * (x - st.pos.raw[0]); y = st.pos.raw[1] + 0.4 * (y - st.pos.raw[1]); }
  const raw = [x, y];
  // 線の上での位置合わせ（案内中はそのルート、そうでなければ赤いライン）
  // 線の上の各地点から各ビーコンまでの直線距離（電波は壁を通ってまっすぐ届く）が、推定距離 d にいちばん合う地点を選ぶ。
  // ビーコン2台の外側にいても求められる
  let cell = null, pathIdx = null;
  const prevPos = st.pos ? [st.pos.x, st.pos.y] : null;
  if (st.nav && !st.nav.sim) {
    const path = st.nav.path;
    pathIdx = fitOnPath(path, all.slice(0, 4), prevPos);
    if (st.pos && st.pos.pathIdx != null && st.pos.path === path) pathIdx = Math.round(st.pos.pathIdx + 0.5 * (pathIdx - st.pos.pathIdx));
    cell = path[pathIdx];
  } else if (LANES) {
    cell = fitOnLanes(all.slice(0, 4), prevPos) || nearestLaneCell(raw, st.room);
  }
  if (!cell) cell = nearestFree(raw);
  const [px, py] = (st.nav && !st.nav.sim) || LANES ? cellCenter(cell) : raw;
  st.pos = { x: px, y: py, raw, acc: used[0].d, used, all, cell, room: st.room, roomOnly: inRoom.length > 0,
             pathIdx, path: st.nav && !st.nav.sim ? st.nav.path : null };
}
// 当てはまりの悪さ：Σ 重み ×（線に沿った距離 − 推定距離）²。近いビーコンほど信頼できるので重みは 1/d²
function fitCost(dists, us, here, prevPos) {
  let c = 0;
  us.forEach((u, k) => { const w = 1 / Math.pow(Math.max(u.d, 0.5), 2); c += w * Math.pow(dists[k] - u.d, 2); });
  if (prevPos) c += 0.05 * Math.pow(dist(here, prevPos), 2);   // 前回から急に飛ばない
  return c;
}
function fitOnPath(path, us, prevPos) {
  const costs = path.map(c => { const here = cellCenter(c); return fitCost(us.map(u => dist(here, u.mb.at)), us, here, prevPos); });
  let best = 0;
  costs.forEach((c, j) => { if (c < costs[best]) best = j; });
  // ビーコンのそばを通り過ぎると手前と奥で同じくらい当てはまる。ほぼ同点なら進行方向の先（3m 以内）を選ぶ
  const tol = costs[best] * 0.25 + 0.05;
  for (let j = Math.min(path.length - 1, best + 15); j > best; j--) if (costs[j] <= costs[best] + tol) return j;
  return best;
}
// 赤いラインの上で探す
function fitOnLanes(us, prevPos) {
  if (!us.length) return null;
  const cells = allLaneCells();
  let best = null, bc = Infinity;
  for (const cell of cells) {
    const here = cellCenter(cell);
    const c = fitCost(us.map(u => dist(here, u.mb.at)), us, here, prevPos);
    if (c < bc) { bc = c; best = cell; }
  }
  return best;
}
let laneCellsAll = null;
function allLaneCells() {
  if (!laneCellsAll) { laneCellsAll = []; for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (isLane(x, y)) laneCellsAll.push([x, y]); }
  return laneCellsAll;
}
function nearestOnPath(path, p) {
  let best = null, bd = 1e9;
  path.forEach(c => { const d = dist(cellCenter(c), p); if (d < bd) { bd = d; best = c; } });
  return best;
}
const laneCellCache = new Map();
function nearestLaneCell(p, room) {
  const key = room ? room.name : '*';
  let cells = laneCellCache.get(key);
  if (!cells) {
    cells = [];
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (isLane(x, y) && (!room || roomAt(cellCenter([x, y])) === room)) cells.push([x, y]);
    laneCellCache.set(key, cells);
  }
  if (!cells.length) return room ? nearestLaneCell(p, null) : null;
  let best = null, bd = 1e9;
  cells.forEach(c => { const d = dist(cellCenter(c), p); if (d < bd) { bd = d; best = c; } });
  return best;
}
// 目的地に着いたか：同じ部屋にいて、目的地に近い（または目的地そばのビーコンがいちばん強い）
function atDest(dest) {
  if (!st.pos) return false;
  const destRoom = roomAt(dest.at);
  // 目的地の部屋に「今受信している」ビーコンがあるときだけ部屋の一致を条件にする（置いていないビーコンは考えない）
  const roomHasBeacon = destRoom && st.pos.all.some(u => roomAt(u.mb.at) === destRoom);
  if (roomHasBeacon && st.room !== destRoom) return false;
  if (dist([st.pos.x, st.pos.y], dest.at) <= 1.2) return true;
  const top = st.pos.all[0];
  if (!top || top.b.samples < 2) return false;
  // 目的地の部屋にビーコンがない場合は、部屋の外（入口付近など）のビーコンでも判定してよい
  const nearDest = dist(top.mb.at, dest.at) < 2.5 && (!destRoom || !roomHasBeacon || roomAt(top.mb.at) === destRoom);
  const lead = st.pos.all[1] ? strength(top) - strength(st.pos.all[1]) : 99;
  return nearDest && top.d < 1.2 && lead >= 2;
}

// ------------------------------------------------------------ 図面の描画
const P = p => `${(p[0] * U).toFixed(1)},${(p[1] * U).toFixed(1)}`;
const poly = pts => pts.map(P).join(' ');
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function buildMap(el, opt = {}) {
  const vw = (BX1 - BX0) * U, vh = (BY1 - BY0) * U;
  // 案内中はルートの周りだけを拡大して表示する
  let v = [BX0, BY0, BX1 - BX0, BY1 - BY0];
  if (opt.path) {
    const pts = opt.path.map(cellCenter).concat([opt.dest.at]);
    const pad = 1.8;
    let x0 = Math.min(...pts.map(p => p[0])) - pad, x1 = Math.max(...pts.map(p => p[0])) + pad;
    let y0 = Math.min(...pts.map(p => p[1])) - pad, y1 = Math.max(...pts.map(p => p[1])) + pad;
    const box = el.getBoundingClientRect(), ar = box.width && box.height ? box.width / box.height : 0.8;
    if ((x1 - x0) / (y1 - y0) < ar) { const w = (y1 - y0) * ar, c = (x0 + x1) / 2; x0 = c - w / 2; x1 = c + w / 2; }
    else { const h = (x1 - x0) / ar, c = (y0 + y1) / 2; y0 = c - h / 2; y1 = c + h / 2; }
    v = [x0, y0, x1 - x0, y1 - y0];
  }
  let s = `<svg viewBox="${v[0] * U} ${v[1] * U} ${v[2] * U} ${v[3] * U}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(MAP.name)}の図面">`;
  s += `<rect x="${(v[0] - 5) * U}" y="${(v[1] - 5) * U}" width="${(v[2] + 10) * U}" height="${(v[3] + 10) * U}" fill="var(--surface)"/>`;
  MAP.rooms.forEach(r => { s += `<polygon points="${poly(r.poly)}" fill="var(--floor)" stroke="none"/>`; });
  (MAP.corridors || []).forEach(c => { s += `<polygon points="${poly(c.poly)}" fill="var(--coral-soft)" stroke="var(--coral)" stroke-width="2" stroke-dasharray="10 8" opacity=".9"/>`; });
  MAP.chairs.forEach(c => { s += `<polygon points="${poly(c.poly)}" fill="none" stroke="var(--line)" stroke-width="3" stroke-dasharray="6 5"/>`; });
  MAP.obstacles.forEach(o => {
    const dark = o.kind === 'pillar' || o.kind === 'equipment';
    s += `<polygon points="${poly(o.poly)}" fill="${dark ? 'var(--slate)' : 'var(--shelf)'}" ${dark ? 'opacity=".85"' : ''}/>`;
  });
  MAP.rooms.forEach(r => {
    const xs = r.poly.map(p => p[0]), ys = r.poly.map(p => p[1]);
    s += `<text x="${(Math.min(...xs) + 0.12) * U}" y="${(Math.min(...ys) + 0.38) * U}" font-size="${opt.small ? 26 : 30}" font-weight="700" fill="var(--muted)" opacity=".8" font-family="var(--f-display)">${esc(roomName(r.name))}</text>`;
  });
  MAP.walls.forEach(w => {
    const st_ = w.kind === 'glass' ? 'stroke="#5B9BD5" stroke-width="7"' : w.kind === 'partition' ? 'stroke="var(--muted)" stroke-width="5"' : 'stroke="var(--slate)" stroke-width="9"';
    s += `<polyline points="${poly(w.pts)}" fill="none" ${st_} stroke-linecap="square" stroke-linejoin="miter"/>`;
  });
  MAP.doors.forEach(d => {
    if (d.kind === 'opening') s += `<polygon points="${poly(d.poly)}" fill="none" stroke="var(--teal)" stroke-width="3" stroke-dasharray="8 6"/>`;
    else s += `<polygon points="${poly(d.poly)}" fill="${d.access === 'staff' ? 'var(--coral)' : 'var(--teal)'}"/>`;
  });
  if (opt.allDests) DESTS.forEach(d => {
    s += `<g transform="translate(${P(d.at)})"><path d="${pinPath(0.8)}" fill="var(--coral)" opacity=".9"/></g>`;
    s += `<text x="${(d.at[0] + 0.18) * U}" y="${(d.at[1] - 0.05) * U}" font-size="24" font-weight="700" fill="var(--coral)" font-family="var(--f-display)">${esc(d.name)}</text>`;
  });
  if (opt.path) {
    s += `<polyline points="${poly(opt.path.map(cellCenter))}" fill="none" stroke="var(--teal)" stroke-width="${5 * K}" stroke-linecap="round" stroke-linejoin="round" opacity=".35"/>`;
    s += `<polyline class="walked" points="" fill="none" stroke="var(--teal)" stroke-width="${5 * K}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (opt.dest) s += `<g transform="translate(${P(opt.dest.at)})"><path d="${pinPath(1.4)}" fill="var(--coral)"/><circle cy="${-15 * 1.4 * K}" r="${3.5 * 1.4 * K}" fill="#fff"/></g>`;
  s += `<g class="dyn"></g>`;
  if (opt.path) s += `<g class="me" transform="translate(-9999 -9999)"><circle r="${13 * K}" fill="var(--coral)" opacity=".18"/><path d="M0 ${-9 * K} L${7 * K} ${7 * K} L0 ${3 * K} L${-7 * K} ${7 * K} Z" fill="var(--coral)" stroke="#fff" stroke-width="${1.5 * K}" stroke-linejoin="round"/></g>`;
  const ex = (v[0] + v[2]) * U, ey = (v[1] + v[3]) * U;
  s += `<text x="${ex - 20}" y="${ey - 20}" text-anchor="end" font-family="var(--f-mono)" font-size="26" fill="var(--muted)">↑図面の上　━ 1m</text>`;
  s += `<line x1="${ex - 120}" y1="${ey - 50}" x2="${ex - 20}" y2="${ey - 50}" stroke="var(--muted)" stroke-width="6"/></svg>`;
  el.innerHTML = s;
  el.dataset.nav = opt.path ? '1' : '';
  el.style.setProperty('--map-ratio', (vw / vh).toFixed(3));
  updateDyn(el);
}
// 地図ピン（先端が原点）
function pinPath(scale) {
  const k = K * scale;
  return `M0 0 C${-6 * k} ${-8 * k} ${-8 * k} ${-11 * k} ${-8 * k} ${-15 * k} a${8 * k} ${8 * k} 0 0 1 ${16 * k} 0 c0 ${4 * k} ${-2 * k} ${7 * k} ${-8 * k} ${15 * k}z`;
}
function updateDyn(el) {
  const g = el.querySelector('.dyn'); if (!g) return;
  const seen = seenByLabel();
  const usedSet = new Set(st.pos ? st.pos.used.map(u => u.mb.label) : []);
  let s = '';
  mapBeacons().forEach(mb => {
    const hit = seen.get(mb.label);
    const [x, y] = mb.at;
    if (hit && usedSet.has(mb.label)) s += `<circle cx="${x * U}" cy="${y * U}" r="${Math.min(hit.d, 12) * U}" fill="none" stroke="var(--teal)" stroke-width="3" opacity=".35"/>`;
    s += `<circle cx="${x * U}" cy="${y * U}" r="${hit ? 6.5 * K : 5.5 * K}" fill="${hit ? 'var(--teal)' : 'var(--gray)'}"/>`;
    s += `<text x="${x * U}" y="${(y * U) - 9 * K}" text-anchor="middle" font-family="var(--f-mono)" font-size="24" fill="var(--ink)">${esc(mb.label)}</text>`;
  });
  if (st.pos && el.dataset.nav !== '1') {
    const px = st.pos.x * U, py = st.pos.y * U;
    s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(Math.max(0.3, Math.min(st.pos.acc, 4)) * U).toFixed(1)}" fill="var(--coral)" opacity=".15"/>`;
    s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${7 * K}" fill="var(--coral)" stroke="#fff" stroke-width="${2 * K}"/>`;
  }
  if (st.placing && el.id === 'planMap') {
    const svg = el.querySelector('svg'), vb = svg ? svg.viewBox.baseVal : null;
    if (vb) s += `<rect x="${vb.x + 8}" y="${vb.y + 8}" width="${vb.width - 16}" height="${vb.height - 16}" fill="none" stroke="var(--coral)" stroke-width="10" stroke-dasharray="30 18" rx="12"/>`;
  }
  g.innerHTML = s;
}

// ------------------------------------------------------------ ホーム
function renderHome() {
  $('venueName').textContent = MAP.name;
  $('venueDesc').textContent = `${DESTS.slice(0, 3).map(d => spoken(d.name)).join('・')}など${DESTS.length}か所へ案内`;
  $('dlname').textContent = `簡易マップ：${MAP.name}（${(BX1 - BX0 - 0.8).toFixed(1)}m × ${(BY1 - BY0 - 0.8).toFixed(1)}m）`;
  renderStatus(); renderHomeKpi();
}
function renderHomeKpi() {
  $('kPlaced').textContent = mapBeacons().length;
  $('kSeen').textContent = seenByLabel().size;
  $('kPos').textContent = st.pos
    ? `現在地：${placeName([st.pos.x, st.pos.y])} 付近（誤差 約${st.pos.acc.toFixed(1)}m）${st.room ? `／いる部屋：${roomName(st.room.name)}` : ''}`
    : '現在地：図面のビーコンを受信していません（iPhone の Minor を B-xx の番号に合わせてください）';
}
function renderStatus() {
  const s = st.status;
  const ul = $('checks'), btns = $('statusBtns');
  if (!s) { ul.innerHTML = '<li><i>…</i>確認中</li>'; btns.innerHTML = ''; renderChip(); return; }
  const item = (ok, label, hint) => `<li class="${ok ? '' : 'ng'}"><i>${ok ? '✓' : '!'}</i>${label}${ok || !hint ? '' : `<span>${hint}</span>`}</li>`;
  ul.innerHTML =
    item(s.permission, 'Bluetooth・位置情報の権限', '許可が必要です') +
    item(s.bluetooth, 'Bluetooth', 'オフになっています') +
    item(s.location, '位置情報（端末の設定）', 'オフだとビーコンが見えません') +
    item(s.scanning || st.scanning, 'ビーコンのスキャン', '停止中') +
    (s.error ? `<li class="ng"><i>!</i>${esc(s.error)}</li>` : '') +
    (s.tts === false && N ? `<li class="ng"><i>!</i>日本語の読み上げ<span>端末の音声データが必要です</span></li>` : '');
  let b = '';
  if (!s.permission) b += `<button class="btn small" data-act="scan">権限を許可する</button><button class="btn small ghost" data-act="appset">アプリの設定</button>`;
  else if (!s.bluetooth) b += `<button class="btn small" data-act="scan">Bluetooth をオンにする</button>`;
  if (s.permission && !s.location) b += `<button class="btn small ghost" data-act="locset">位置情報の設定を開く</button>`;
  if (s.permission && s.bluetooth && !(s.scanning || st.scanning)) b += `<button class="btn small" data-act="scan">スキャン開始</button>`;
  btns.innerHTML = b;
  $('modelName').textContent = s.model || '';
  renderChip();
}
$('statusBtns').addEventListener('click', e => {
  const a = e.target.closest('button'); if (!a) return;
  if (a.dataset.act === 'scan' && N) N.startScan();
  if (a.dataset.act === 'appset' && N) N.openAppSettings();
  if (a.dataset.act === 'locset' && N) N.openLocationSettings();
});
function renderChip() {
  const c = $('scanChip');
  const scanning = st.scanning || (st.status && st.status.scanning);
  if (scanning) { c.textContent = `BLE 受信中・図面のビーコン${seenByLabel().size}台`; c.className = 'chip'; }
  else { c.textContent = 'BLE 停止中'; c.className = 'chip warn'; }
}
$('start').onclick = () => { show('calib'); say('ミミナビを起動しました。図面の上の方向を向いて、ボタンを押してください。'); };

// ------------------------------------------------------------ 方角合わせ
const COMPASS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
function onHeading(deg) {
  st.heading = deg;
  if (st.view === 'calib') {
    $('needle').style.transform = `rotate(${deg}deg)`;
    $('headingTxt').textContent = `方位 ${deg}°（${COMPASS[Math.round(deg / 45) % 8]}）`;
  }
}
$('calibBtn').onclick = () => {
  if (st.heading != null) { st.data.northOffset = st.heading; save(); }
  say('向きを合わせました。行き先を話してください。');
  toListen();
};
$('calibSkip').onclick = () => { say('行き先を話してください。'); toListen(); };

// ------------------------------------------------------------ 行き先の入力と特定
function toListen(cands) {
  show('listen');
  $('transcript').innerHTML = '行き先を話してください<small>マイクを押して話すか、下の行き先を押してください</small>';
  renderSamples(cands);
}
function renderSamples(cands) {
  const list = cands || DESTS;
  $('samples').innerHTML = list.map(d => `<button type="button" data-id="${esc(d.id)}" class="${cands ? 'cand' : ''}">${esc(d.name)}</button>`).join('');
}
$('samples').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const d = DESTS.find(x => x.id === b.dataset.id);
  if (d) choose(d, d.name);
});
$('mic').onclick = () => {
  if (N) {
    hush();
    $('mic').classList.add('on');
    $('transcript').innerHTML = '聞き取り中…<small>&nbsp;</small>';
    N.listen();
  } else {
    const d = DESTS[Math.floor(Math.random() * DESTS.length)];
    hear([spoken(d.name) + 'に行きたい']);
  }
};
function onSpeech(list) {
  $('mic').classList.remove('on');
  if (list === null) { $('transcript').innerHTML = '音声認識を使えません<small>この端末に音声入力アプリがありません。行き先のボタンか文字で入力してください</small>'; return; }
  if (!list.length) { $('transcript').innerHTML = '聞き取れませんでした<small>もう一度マイクを押してください</small>'; return; }
  hear(list);
}
$('typed').addEventListener('submit', e => { e.preventDefault(); const q = $('q').value.trim(); if (q) hear([q]); $('q').value = ''; $('q').blur(); });
$('backHome').onclick = () => { stopNav(); show('home'); };

const KANJI = '一二三四五六七八九';
function norm(t) {
  return String(t).normalize('NFKC').toLowerCase()
    .replace(/ミーティング/g, 'mtg')
    .replace(/[一二三四五六七八九]/g, c => String(KANJI.indexOf(c) + 1))
    .replace(/かいぎしつ/g, '会議室').replace(/じむしょ/g, '事務所').replace(/といれ/g, 'トイレ')
    .replace(/きゅうとうしつ/g, '給湯室').replace(/うけつけ/g, '受付').replace(/しょこ/g, '書庫')
    .replace(/はち/g, '8').replace(/よん/g, '4')
    .replace(/[\s()「」『』、。,.!?・"'“”]/g, '');
}
const DEST_KEYS = DESTS.map(d => ({ d, keys: [...new Set([d.name, spoken(d.name), ...d.keywords].map(norm).filter(Boolean))] }));
// いちばん長く一致した呼び方の目的地。同点が複数なら候補として返す
function matchDest(text) {
  const t = norm(text);
  let best = 0, hits = [];
  DEST_KEYS.forEach(({ d, keys }) => {
    const sc = Math.max(0, ...keys.filter(k => t.includes(k)).map(k => k.length));
    if (sc > best) { best = sc; hits = [d]; } else if (sc === best && sc > 0) hits.push(d);
  });
  return hits;
}
function hear(candidates) {
  $('mic').classList.remove('on');
  let hits = [], heard = candidates[0];
  for (const c of candidates) { const h = matchDest(c); if (h.length) { hits = h; heard = c; break; } }
  if (!hits.length) {
    $('transcript').innerHTML = `「${esc(heard)}」<small>見つかりませんでした。下の行き先から選ぶか、もう一度お話しください</small>`;
    say('すみません、見つかりませんでした。もう一度お話しください。');
    return;
  }
  if (hits.length > 1) {
    $('transcript').innerHTML = `「${esc(heard)}」<small>行き先が${hits.length}つあります。どちらですか？</small>`;
    renderSamples(hits);
    say(`${hits.map(d => spoken(d.name)).join('と、')}、どちらですか？`);
    return;
  }
  choose(hits[0], heard);
}
function choose(dest, heard) {
  $('transcript').innerHTML = `${esc(dest.name)}<small>「${esc(heard)}」→ 目的地を特定しました</small>`;
  say(`${spoken(dest.name)}ですね。ルートを計算します。`);
  setTimeout(() => startNav(dest), 1100);
}

// ------------------------------------------------------------ ルート探索（ダイクストラ法：壁ぎわと曲がり角を避けた最短ルート）
function route(s, g) {
  if (!walkable(s[0], s[1])) s = nearestFree(cellCenter(s));
  const n = GW * GH * 4, cost = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const heap = [];   // [cost, state]
  const push = (c, k) => { heap.push([c, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const key = (x, y, d) => (y * GW + x) * 4 + d;
  for (let d = 0; d < 4; d++) { const k = key(s[0], s[1], d); cost[k] = 0; push(0, k); }
  while (heap.length) {
    const [c, k] = pop();
    if (c > cost[k]) continue;
    const d = k % 4, xy = (k - d) / 4, x = xy % GW, y = (xy - x) / GW;
    if (x === g[0] && y === g[1]) {
      const path = [];
      for (let q = k; q >= 0; q = prev[q]) { const qd = q % 4, qxy = (q - qd) / 4; const p = [qxy % GW, (qxy - qxy % GW) / GW]; if (!path.length || path[0][0] !== p[0] || path[0][1] !== p[1]) path.unshift(p); }
      return path;
    }
    for (let nd = 0; nd < 4; nd++) {
      const nx = x + DIRS[nd][0], ny = y + DIRS[nd][1];
      if (!walkable(nx, ny)) continue;
      const step = LANES ? (isLane(nx, ny) ? 0 : OFF_LANE_COST + (STEP_COST[ROWS[ny][nx]] || 0)) : (STEP_COST[ROWS[ny][nx]] || 0);
      const nc = c + 1 + step + (nd !== d ? TURN_COST : 0);
      const nk = key(nx, ny, nd);
      if (nc < cost[nk]) { cost[nk] = nc; prev[nk] = k; push(nc, nk); }
    }
  }
  return null;
}
const dirOf = (a, b) => DIRS.findIndex(d => d[0] === b[0] - a[0] && d[1] === b[1] - a[1]);
// 直線ごとに区切り、0.6m 未満の小さな寄り道は案内しない
function segments(path) {
  let segs = [];
  for (let i = 1; i < path.length; i++) {
    const d = dirOf(path[i - 1], path[i]);
    if (segs.length && segs[segs.length - 1].d === d) segs[segs.length - 1].n++;
    else segs.push({ d, n: 1 });
  }
  const minN = Math.round(0.6 / CELL);
  let changed = true;
  while (changed && segs.length > 2) {
    changed = false;
    for (let i = 1; i < segs.length - 1; i++) {
      if (segs[i].n < minN) {
        const prev = segs[i - 1], next = segs[i + 1];
        prev.n += segs[i].n;
        segs.splice(i, 1);
        if (prev.d === next.d) { prev.n += next.n; segs.splice(i, 1); }
        changed = true; break;
      }
    }
  }
  if (segs.length > 1 && segs[0].n < 2) { segs[1].n += segs[0].n; segs.shift(); }
  if (segs.length > 1 && segs[segs.length - 1].n < 2) { segs[segs.length - 2].n += segs[segs.length - 1].n; segs.pop(); }
  let idx = 0;
  segs.forEach(sg => { sg.startIdx = idx; idx += sg.n; });
  return segs;
}
function turnWord(d1, d2) { const diff = (d2 - d1 + 4) % 4; return diff === 1 ? '右' : diff === 3 ? '左' : diff === 2 ? '後ろ' : '直進'; }
const meters = cells => Math.max(1, Math.round(cells * CELL));
const metersTxt = cells => (cells * CELL).toFixed(1) + 'm';
// ルート上のドア（はじめて通るマスの番号）
function doorsOnPath(path) {
  const out = [];
  let inDoor = false;
  path.forEach((c, i) => {
    const ch = ROWS[c[1]][c[0]];
    const isDoor = ch === 'D' || ch === 'S';
    if (isDoor && !inDoor) {
      let best = null, bd = 1e9;
      MAP.doors.forEach(d => { if (d.kind !== 'door' || !d.cell) return; const dd = Math.hypot(d.cell[0] - c[0], d.cell[1] - c[1]); if (dd < bd) { bd = dd; best = d; } });
      if (best && bd < 8) out.push({ idx: i, door: best });
    }
    inDoor = isDoor;
  });
  return out;
}
function doorSpeech(d) {
  const n = d.name.replace(/（[^）]*）|\([^)]*\)/g, '').replace(/\s*(ドア|両開き)$/, '').trim();
  if (d.access === 'staff') return `この先、${n}です。関係者用のドアです。`;
  return `この先、${n}${/扉$/.test(n) ? '' : 'のドア'}を通ります。`;
}

// ------------------------------------------------------------ 案内
function setInstr(word, sub, icon) {
  $('instrMain').textContent = word; $('instrSub').textContent = sub;
  const rot = { '直進': 0, '右': 90, '左': -90, '後ろ': 180 }[icon] ?? 0;
  $('arrowIcon').style.transform = `rotate(${rot}deg)`;
}
function stopNav() {
  if (st.nav) clearTimeout(st.nav.timer);
  st.nav = null; hush();
  if (N) N.keepScreenOn(false);
}
function startNav(dest, opts = {}) {
  if (st.nav) clearTimeout(st.nav.timer);
  const from = st.pos ? st.pos.cell : ENTRY;
  const path = route(from, dest.cell);
  if (!path) { say('ルートが見つかりませんでした。'); return; }
  show('nav');
  if (N) N.keepScreenOn(true);
  if (path.length < 3) { arrive(dest); return; }
  const segs = segments(path);
  const nav = st.nav = { dest, path, segs, doors: doorsOnPath(path), idx: 0, spoken: new Set(), off: 0, paused: false, sim: !st.pos, timer: null };
  buildMap($('navMap'), { path, dest });
  placeMeCell(path[0], segs[0].d);
  $('pauseBtn').textContent = '一時停止';
  $('simBtn').setAttribute('aria-pressed', nav.sim);
  updateSrcChip();
  const total = path.length - 1;
  $('remain').textContent = `残り ${metersTxt(total)}`;
  const first = segs[0];
  let lead = `${DNAME[first.d]}方向に`;
  if (st.heading != null && st.data.northOffset != null) {
    const mapHead = (st.heading - st.data.northOffset + 360) % 360;
    const diff = ((first.d * 90 - mapHead + 540) % 360) - 180;
    const w = Math.abs(diff) < 45 ? '正面' : diff > 0 && diff < 135 ? '右' : diff < 0 && diff > -135 ? '左' : '後ろ';
    lead = w === '正面' ? '正面に' : `${w}を向いて、`;
  }
  setInstr('直進', `約${metersTxt(first.n)} まっすぐ`, '直進');
  say(`${opts.reroute ? 'ルートを再計算しました。' : ''}${spoken(dest.name)}まで、約${meters(total)}メートル。${lead}まっすぐ約${meters(first.n)}メートル進みます。`);
  if (nav.sim) nav.timer = setTimeout(simTick, 4200);
}
function updateSrcChip() {
  const c = $('srcChip'); if (!st.nav) return;
  if (st.nav.sim) { c.textContent = 'デモ歩行'; c.className = 'chip warn'; }
  else if (st.pos) { c.textContent = `BLE 屋内測位（${st.pos.used.length}台）`; c.className = 'chip'; }
  else { c.textContent = 'BLE 受信待ち'; c.className = 'chip off'; }
}
function placeMeAt(p, d) {
  const g = $('navMap').querySelector('.me'); if (!g) return;
  g.setAttribute('transform', `translate(${(p[0] * U).toFixed(1)} ${(p[1] * U).toFixed(1)}) rotate(${d * 90})`);
}
const placeMeCell = (c, d) => placeMeAt(cellCenter(c), d);
const segIndexAt = i => { const segs = st.nav.segs; for (let k = 0; k < segs.length; k++) if (i > segs[k].startIdx && i <= segs[k].startIdx + segs[k].n) return k; return segs.length - 1; };

// path[i] に着いたときの案内
function eventAt(i) {
  const nav = st.nav, segs = nav.segs, last = nav.path.length - 1;
  if (i >= last) return { arrive: true };
  const si = segIndexAt(i), sg = segs[si], next = segs[si + 1];
  const toEnd = sg.startIdx + sg.n - i, toEndM = toEnd * CELL;
  if (next && toEnd === 0) {
    const w = turnWord(sg.d, next.d);
    return { si, key: 'turn' + si, word: w, sub: `${w}へ曲がって、約${metersTxt(next.n)}`, icon: w, speech: `${w}に曲がります。その先、約${meters(next.n)}メートル直進です。` };
  }
  if (next && toEndM <= 2.0 && sg.n * CELL >= 3.0) {
    const w = turnWord(sg.d, next.d);
    return { si, key: 'pre' + si, word: w, sub: `${metersTxt(toEnd)}先で${w}へ`, icon: w, speech: `まもなく、${w}です。` };
  }
  if (!next && toEndM <= 1.5) return { si, key: 'near', word: '直進', sub: `${metersTxt(toEnd)}先が目的地`, icon: '直進', speech: 'まもなく目的地です。' };
  const dr = nav.doors.find(x => x.idx > i && (x.idx - i) * CELL <= 2.0);
  if (dr) return { si, key: 'door' + dr.idx, word: '直進', sub: `この先 ${dr.door.name}`, icon: '直進', speech: doorSpeech(dr.door) };
  return { si, word: '直進', sub: `約${metersTxt(toEnd)} まっすぐ`, icon: '直進' };
}
// 進み具合を j まで進める。読み上げたら true
function advance(j) {
  const nav = st.nav; if (!nav || j <= nav.idx) return false;
  j = Math.min(j, nav.path.length - 1);
  let shown = null, spokenEv = null;
  for (let i = nav.idx + 1; i <= j; i++) {
    const ev = eventAt(i);
    if (ev.arrive) { nav.idx = i; arrive(nav.dest); return true; }
    shown = ev;
    if (ev.speech && !nav.spoken.has(ev.key)) { nav.spoken.add(ev.key); spokenEv = ev; }
  }
  nav.idx = j;
  const sg = nav.segs[(spokenEv || shown).si];
  if (nav.sim) placeMeCell(nav.path[j], sg.d);
  const walked = $('navMap').querySelector('.walked');
  if (walked) walked.setAttribute('points', poly(nav.path.slice(0, j + 1).map(cellCenter)));
  $('remain').textContent = `残り ${metersTxt(nav.path.length - 1 - j)}`;
  const ev = spokenEv || shown;
  setInstr(ev.word, ev.sub, ev.icon);
  if (spokenEv) say(spokenEv.speech);
  return !!spokenEv;
}
function simTick() {
  const nav = st.nav; if (!nav || !nav.sim) return;
  if (nav.paused) { nav.timer = setTimeout(simTick, 300); return; }
  const spoke = advance(nav.idx + 3);   // 0.6m ずつ
  if (st.nav === nav) nav.timer = setTimeout(simTick, spoke ? 2300 : 480);
}
// ビーコンで推定した現在地から進み具合を更新する
function navRealUpdate() {
  const nav = st.nav; if (!nav || nav.sim || nav.paused) return;
  updateSrcChip();
  if (!st.pos) return;
  const pos = [st.pos.x, st.pos.y];
  placeMeAt(pos, nav.segs[segIndexAt(Math.max(1, nav.idx))].d);
  // 到着：条件を満たす状態が約1.5秒（3回）続いたら
  nav.arriveN = atDest(nav.dest) ? (nav.arriveN || 0) + 1 : 0;
  if (nav.arriveN >= 3) { advance(nav.path.length - 1); return; }
  // ルート上の位置：線の上での位置合わせの結果（pathIdx）を使う
  if (st.pos.pathIdx != null && st.pos.path === nav.path) {
    nav.off = 0;
    if (st.pos.pathIdx > nav.idx) advance(st.pos.pathIdx);
    return;
  }
  const raw = st.pos.raw || pos;
  let bj = nav.idx, bd = 1e9;
  const hi = Math.min(nav.path.length - 1, nav.idx + 40);
  for (let j = Math.max(0, nav.idx - 10); j <= hi; j++) {
    const d = dist(cellCenter(nav.path[j]), raw);
    if (d < bd - 1e-6) { bd = d; bj = j; }
  }
  if (bd <= 2.0) {
    nav.off = 0;
    if (bj > nav.idx) advance(bj);
  } else if (++nav.off >= 6) {   // 約3秒続けて外れていたら引き直す
    say('ルートから外れました。');
    startNav(nav.dest, { reroute: true });
  }
}
function arrive(dest) {
  const nav = st.nav;
  if (nav) clearTimeout(nav.timer);
  st.nav = null;
  if (N) N.keepScreenOn(false);
  setInstr('到着', dest.name, '直進');
  say(`目的地、${spoken(dest.name)}に到着しました。`);
  setTimeout(() => {
    $('dark').hidden = true;
    show('done');
    $('doneTitle').textContent = dest.name;
    $('future').hidden = !dest.future;
    $('futureText').textContent = dest.future || '';
  }, 1400);
}
$('pauseBtn').onclick = () => {
  const nav = st.nav; if (!nav) return;
  nav.paused = !nav.paused;
  $('pauseBtn').textContent = nav.paused ? '再開' : '一時停止';
  if (nav.paused) hush();
};
$('simBtn').onclick = () => {
  const nav = st.nav; if (!nav) return;
  nav.sim = !nav.sim;
  $('simBtn').setAttribute('aria-pressed', nav.sim);
  updateSrcChip();
  clearTimeout(nav.timer);
  if (nav.sim) { placeMeCell(nav.path[nav.idx], nav.segs[segIndexAt(Math.max(1, nav.idx))].d); nav.timer = setTimeout(simTick, 500); }
};
$('eyesBtn').onclick = () => { $('dark').hidden = false; };
$('darkOff').onclick = () => { $('dark').hidden = true; };
$('stopBtn').onclick = () => { stopNav(); $('dark').hidden = true; say('案内を終了しました。'); toListen(); };
$('again').onclick = () => toListen();
$('doneHome').onclick = () => show('home');

// ------------------------------------------------------------ 図面タブ
let listSig = '';
function renderPlan(full) {
  const el = $('planMap');
  if (full || !el.querySelector('svg')) buildMap(el, { allDests: true, small: true });
  else updateDyn(el);
  $('planSize').textContent = `${(BX1 - BX0 - 0.8).toFixed(1)}m × ${(BY1 - BY0 - 0.8).toFixed(1)}m`;
  $('planPos').textContent = st.pos
    ? `x ${st.pos.x.toFixed(1)}m, y ${st.pos.y.toFixed(1)}m（${placeName([st.pos.x, st.pos.y])}付近・誤差 約${st.pos.acc.toFixed(1)}m）${st.room ? `／部屋：${roomName(st.room.name)}` : ''}`
    : '—（図面のビーコンを受信していません）';
  $('planUsed').textContent = st.pos ? st.pos.used.map(u => `${u.mb.label} ${u.d.toFixed(1)}m（重み${Math.round(u.w * 100)}%）`).join(' / ') + (st.pos.roomOnly ? '' : '（部屋にビーコンがないため全体で計算）') : '—';
  const seen = seenByLabel();
  $('placingBar').hidden = !st.placing;
  if (st.placing) $('placingName').textContent = st.placing.label;
  const all = mapBeacons();
  const sig = all.map(b => { const h = seen.get(b.label); return b.label + (h ? Math.round(h.b.rssi) + h.b.key : 'x'); }).join('|');
  if (!full && sig === listSig) return;
  listSig = sig;
  $('placedList').innerHTML = all.map(b => {
    const h = seen.get(b.label);
    const how = b.custom ? '自分で配置' : h && h.mb.manual ? '手動で割り当て' : `Minor ${b.minor ?? '?'}`;
    const del = b.custom ? `<button class="iconbtn" data-del="${esc(b.label)}">外す</button>` : '';
    return `<div class="prow"><i class="lg ${h ? 'teal' : 'gray'}"></i><b class="${h ? '' : 'off'}">${esc(b.label)}</b><span class="grow">${esc(beaconPlace(b))}・${how}</span><span class="rem">${h ? `${Math.round(h.b.rssi)}dBm 約${h.d.toFixed(1)}m` : '未受信'}</span>${del}</div>`;
  }).join('');
}

$('placedList').addEventListener('click', e => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  Object.keys(st.data.assign).forEach(k => { if (st.data.assign[k].label === b.dataset.del) delete st.data.assign[k]; });
  save(); estimate(); renderPlan(true);
});
$('planMap').addEventListener('click', e => {
  if (!st.placing) return;
  const svg = $('planMap').querySelector('svg'); if (!svg) return;
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const q = pt.matrixTransform(svg.getScreenCTM().inverse());
  const at = [Math.round(q.x / U * 100) / 100, Math.round(q.y / U * 100) / 100];
  if (at[0] < BX0 || at[0] > BX1 || at[1] < BY0 || at[1] > BY1) return;
  const { key, label } = st.placing;
  Object.keys(st.data.assign).forEach(k => { if (k !== key && st.data.assign[k].label === label) delete st.data.assign[k]; });
  st.data.assign[key] = { label, at };
  st.placing = null;
  save(); estimate(); renderPlan(true);
  say(`${label}を、${placeName(at)}に配置しました。`);
});
$('placingCancel').onclick = () => { st.placing = null; renderPlan(true); };

// ------------------------------------------------------------ ビーコンタブ
const rows = new Map();
function renderBeacons() {
  const list = $('beaconList');
  $('otherChip').textContent = `他のBLE機器 ${st.others}台`;
  const s = st.status, warn = $('beaconWarn');
  let w = '';
  if (s && !s.permission) w = 'Bluetooth・位置情報の権限が許可されていません。ホームの「権限を許可する」を押してください。';
  else if (s && !s.bluetooth) w = 'Bluetooth がオフです。';
  else if (s && !s.location) w = '端末の位置情報がオフです。オンにしないとビーコンを受信できない機種があります。';
  else if (!st.scanning && N) w = 'スキャンが止まっています。ホームの「スキャン開始」を押してください。';
  warn.hidden = !w; warn.textContent = w;
  $('nRange').value = st.data.n; $('nVal').textContent = Number(st.data.n).toFixed(1);
  $('uuidText').innerHTML = st.data.uuid
    ? `<b>${esc(st.data.uuid)}</b><br>このUUID以外のビーコンは無視しています${st.ignored ? `（今 ${st.ignored}台を無視）` : ''}。`
    : '未設定：受信したすべてのビーコンを使います。受信中のビーコンの「このUUIDだけ使う」で設定できます。';
  $('uuidClear').hidden = !st.data.uuid;

  const sorted = [...st.beacons].sort((a, b) => b.rssi - a.rssi);
  if (!sorted.length) {
    rows.clear();
    list.innerHTML = st.data.uuid
      ? `<p class="sub">UUID ${esc(st.data.uuid)} のビーコンを探しています…<br>iPhone の Beacon Simulator で、この UUID の iBeacon を送信してください。</p>`
      : `<p class="sub">ビーコンを探しています…（他のBLE機器は ${st.others}台受信）<br>iPhone の Beacon Simulator で iBeacon の送信を開始してください。</p>`;
    return;
  }
  if (list.querySelector('p.sub')) list.innerHTML = '';
  const keys = new Set(sorted.map(b => b.key));
  for (const [k, el] of rows) if (!keys.has(k)) { el.remove(); rows.delete(k); }
  sorted.forEach((b, i) => {
    let el = rows.get(b.key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'bcard';
      el.dataset.key = b.key;
      el.innerHTML = `<div class="btop"><span class="name"></span><span class="btype"></span></div>
        <div class="bmeta"></div>
        <div class="bnums"><span><b class="r"></b> dBm</span><span class="rssi"><i></i></span><span>約<b class="d"></b>m</span></div>
        <label class="assign">図面の位置<select data-act="assign"></select></label>
        <div class="bbtns"><button class="iconbtn" data-act="cal">1mで補正</button><button class="iconbtn" data-act="reset" hidden>補正を戻す</button><button class="iconbtn" data-act="uuid">このUUIDだけ使う</button></div>`;
      rows.set(b.key, el);
    }
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
    const mb = beaconOf(b);
    const label = mb ? mb.label : null;
    el.classList.toggle('placed', !!mb);
    el.classList.toggle('stale', b.ageMs > 3000);
    el.querySelector('.name').textContent = mb ? `${mb.label}（${beaconPlace(mb)}）` : '図面に未配置';
    const sel = el.querySelector('select');
    if (document.activeElement !== sel) {
      const a = st.data.assign[b.key];
      const taken = new Map(Object.entries(st.data.assign).filter(([k]) => k !== b.key).map(([k, v]) => [v.label, k]));
      const auto = !a && mb ? `自動（Minor ${b.minor} → ${mb.label}）` : '自動（Minor 番号で対応）';
      let opts = `<option value="">${esc(auto)}</option>`;
      opts += BEACONS.map(x => `<option value="${esc(x.label)}">${esc(x.label)}：${esc(beaconPlace(x))}${taken.has(x.label) ? '（使用中）' : ''}</option>`).join('');
      if (a && a.at) opts += `<option value="@keep">${esc(a.label)}：自分で配置した場所</option>`;
      opts += `<option value="@tap">図面をタップして場所を指定…</option>`;
      if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
      sel.value = a ? (a.at ? '@keep' : a.label) : '';
    }
    el.querySelector('.btype').textContent = b.type;
    const cal = label && typeof st.data.tx[label] === 'number';
    el.querySelector('.bmeta').textContent = b.type === 'Eddystone'
      ? `NS ${b.uuid} / ${b.instance}`
      : `${b.uuid}  Major ${b.major} / Minor ${b.minor}  1m: ${cal ? st.data.tx[label] + '（補正）' : DEFAULT_A + '（標準）'} dBm`;
    el.querySelector('.r').textContent = Math.round(b.rssi);
    el.querySelector('.d').textContent = (label ? distanceOf(b, label) : Math.pow(10, (DEFAULT_A - b.rssi) / (10 * st.data.n))).toFixed(1);
    el.querySelector('.rssi i').style.width = Math.max(4, Math.min(100, (b.rssi + 100) * 1.6)) + '%';
    el.querySelector('[data-act="cal"]').hidden = !label;
    el.querySelector('[data-act="reset"]').hidden = !cal;
    el.querySelector('[data-act="uuid"]').hidden = b.type !== 'iBeacon' || normUuid(b.uuid) === normUuid(st.data.uuid);
  });
}
$('beaconList').addEventListener('change', e => {
  const sel = e.target.closest('select[data-act="assign"]'); if (!sel) return;
  const key = sel.closest('.bcard').dataset.key, v = sel.value;
  if (v === '@keep') return;
  if (v === '@tap') {
    const a = st.data.assign[key];
    st.placing = { key, label: a && a.at ? a.label : nextCustomLabel() };
    sel.blur();
    show('plan');
    return;
  }
  if (!v) delete st.data.assign[key];
  else {
    Object.keys(st.data.assign).forEach(k => { if (k !== key && st.data.assign[k].label === v) delete st.data.assign[k]; });
    st.data.assign[key] = { label: v };
    const mb = BEACONS.find(x => x.label === v);
    say(`${v}、${beaconPlace(mb)}に割り当てました。`);
  }
  save(); estimate(); sel.blur(); renderBeacons();
});
$('beaconList').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const b = st.beacons.find(x => x.key === btn.closest('.bcard').dataset.key); if (!b) return;
  if (btn.dataset.act === 'uuid') {
    setUuid(b.uuid);
    say('このUUIDのビーコンだけを使います。');
    return;
  }
  const mb = beaconOf(b); if (!mb) return;
  if (btn.dataset.act === 'cal') {
    st.data.tx[mb.label] = Math.round(b.rssi); save();
    say(`${mb.label}の1メートル地点の強さを、${st.data.tx[mb.label]}デシベルにしました。`);
  } else if (btn.dataset.act === 'reset') {
    delete st.data.tx[mb.label]; save();
  }
  renderBeacons();
});
$('uuidClear').onclick = () => { setUuid(''); say('すべてのビーコンを使います。'); };
$('nRange').addEventListener('input', e => { st.data.n = Number(e.target.value); $('nVal').textContent = st.data.n.toFixed(1); save(); });

// ------------------------------------------------------------ PC ブラウザ用の疑似データ（受付付近に立っている想定）
function startMock() {
  st.status = { permission: true, bluetooth: true, location: true, scanning: true, tts: true, error: '', model: 'PC ブラウザ（疑似データ）' };
  const me = (DESTS.find(d => d.name === '受付') || DESTS[0]).at;
  let t = 0;
  setInterval(() => {
    t++;
    const beacons = BEACONS.filter(b => b.minor != null).map(b => {
      const d = Math.max(0.5, dist(b.at, me));
      const rssi = -45 - 40 * Math.log10(d) + Math.sin(t / 4 + b.minor) * 2;
      return { key: `iBeacon:E2C56DB5-DFFB-48D2-B060-D0F5A71096E0:1:${b.minor}`, type: 'iBeacon', uuid: 'E2C56DB5-DFFB-48D2-B060-D0F5A71096E0', major: 1, minor: b.minor, tx: -59, rssi, rssiLast: rssi, samples: 6, ageMs: 200, count: t };
    }).filter(b => b.rssi > -95);
    window.__native('beacons', { scanning: true, others: 17, beacons });
  }, 500);
  window.__native('status', st.status);
}

// ------------------------------------------------------------ 起動
load();
show('home');
if (MAP.warnings && MAP.warnings.length) console.warn('地図データの注意:', MAP.warnings);
if (N) {
  if (st.data.uuid && N.setUuidFilter) N.setUuidFilter(st.data.uuid);
  N.startScan();
  setInterval(() => { if (!st.scanning) N.refreshStatus(); }, 3000);
} else {
  startMock();
}
// テスト用
window.__mimi = { route, segments, matchDest, DESTS, ENTRY, st, startNav, doorsOnPath, atDest, roomAt, estimate };
})();
