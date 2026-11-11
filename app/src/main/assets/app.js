/* ミミナビ 画面ロジック（地図データ版）
 * 地図は map.js（tools/drawio_to_map.py が draw.io から自動生成）の window.MIMI_MAP を使う。
 * ネイティブ側（MainActivity.java）とのやりとり：
 *   JS → ネイティブ : window.MimiNative.startScan() / speak() / listen() / save() など
 *   ネイティブ → JS : window.__native(type, data)  type = beacons | status | heading | step | speech | exported
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
// 図面のビーコン [{label, minor, place, at}]。図面タブで動かした B-xx は st.data.moved の位置を使う
let BEACONS = MAP.beacons;
function refreshBeacons() {
  const moved = st.data.moved || {};
  BEACONS = MAP.beacons.map(b => Array.isArray(moved[b.label]) ? { ...b, at: moved[b.label], place: placeName(moved[b.label]), moved: true, orig: b.at } : b);
}
const beaconPlace = b => b.place || placeName(b.at);
const ENTRY = (MAP.doors.find(d => /入口/.test(d.name)) || {}).cell || DESTS[0].cell;

// UUID を 8-4-4-4-12 の大文字に整える（形式が違えば空文字）
function normUuid(u) {
  const h = String(u || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return h.length === 32 ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : '';
}
const walkable = (x, y) => x >= 0 && y >= 0 && x < GW && y < GH && ROWS[y][x] !== '#';
// 案内ルート（draw.io の赤いライン）。ルートはここを優先して通り、現在地もここに寄せる
const LANES = G.lanes || null;
const isLane = (x, y) => !!LANES && LANES[y][x] === '1';
const OFF_LANE_COST = 10;           // 案内ルートの外を1マス進むときの追加コスト
// 案内ルートのマスのうち、マスの中心が赤い枠の内側にあるもの。ルートの線が枠からはみ出ないよう、ここを優先する
const LANE_CORE = G.laneCore || null;
const isLaneCore = (x, y) => !LANE_CORE || LANE_CORE[y][x] === '1';
const LANE_EDGE_COST = 2;           // 赤い枠のふち（中心が枠の外）のマスを進むときの追加コスト
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
// 図面の上から見た北の向き（右回り °）。事業所の図面では、北は図面の上から右へ約36°
// （利用者が図面に描いた北の矢印から求めた値。ビーコンタブで変えられる）
const MAP_NORTH_DEFAULT = 36;
const st = {
  view: 'home', tab: 'guide', sound: true,
  status: null, beacons: [], others: 0, scanning: false,
  heading: null, pos: null, nav: null, room: null, roomCand: null, roomCandN: 0, near: null, nearCand: null, nearCandN: 0, steps: 0, stepTimes: [], posAge: 0,
  data: { v: 2, n: 4.0, tx: {}, northOffset: null, assign: {}, uuids: [], moved: {}, beaconH: '', phoneH: '', posMode: 'prox', holdStill: true, pdr: true, stepLen: 0.5, headRef: 'map', mapNorth: MAP_NORTH_DEFAULT, pull: 30 },
  browse: false, raw: [],
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
      if (d.headRef === 'map' || d.headRef === 'calib') st.data.headRef = d.headRef;
      if (typeof d.pull === 'number' && d.pull >= 0 && d.pull <= 100) st.data.pull = d.pull;
      if (typeof d.mapNorth === 'number' && isFinite(d.mapNorth)) st.data.mapNorth = ((d.mapNorth % 360) + 360) % 360;
      if (d.assign && typeof d.assign === 'object') st.data.assign = d.assign;
      if (d.moved && typeof d.moved === 'object') st.data.moved = d.moved;
      if (d.beaconH != null) st.data.beaconH = String(d.beaconH);
      if (d.phoneH != null) st.data.phoneH = String(d.phoneH);
      if (d.posMode === 'prox' || d.posMode === 'dist') st.data.posMode = d.posMode;
      if (typeof d.holdStill === 'boolean') st.data.holdStill = d.holdStill;
      if (typeof d.pdr === 'boolean') st.data.pdr = d.pdr;
      if (typeof d.stepLen === 'number' && d.stepLen >= 0.2 && d.stepLen <= 1.2) st.data.stepLen = d.stepLen;
      if (Array.isArray(d.uuids)) st.data.uuids = d.uuids.map(normUuid).filter(Boolean);
      else if (typeof d.uuid === 'string' && d.uuid) st.data.uuids = [normUuid(d.uuid)];   // 旧形式（1つだけ）から移行
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
  if (v !== 'plan' && zoom.full) zoomFull(false);
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
  if (st.placing) { const r = st.placing.rec || st.placing.recBeacon; st.placing = null; if (r) show('beacons'); else renderPlan(true); return true; }
  if (zoom.full) { zoomFull(false); return true; }
  if (st.tab !== 'guide') { show(guideView); return true; }
  if (st.view !== 'home') { stopNav(); show('home'); return true; }
  return false;
};

// ------------------------------------------------------------ ネイティブからの通知
window.__native = (type, d) => {
  if (type === 'beacons') onBeacons(d);
  else if (type === 'status') { st.status = d; renderStatus(); }
  else if (type === 'heading') onHeading(d);
  else if (type === 'step') onStep(d);
  else if (type === 'speech') onSpeech(d);
  else if (type === 'exported') onExported(d);
};
// 使う UUID（複数可）。空ならすべてのビーコン。登録外のビーコンは一覧にも位置の計算にも使わない
const uuidInList = (u, list) => list.includes(normUuid(u));
const uuidOk = b => !st.data.uuids.length || (b.type === 'iBeacon' && uuidInList(b.uuid, st.data.uuids));
// Android 側の絞り込み。「追加用に全部表示」中は絞り込まない
function applyNativeFilter() {
  if (N && N.setUuidFilter) N.setUuidFilter(st.browse ? '' : st.data.uuids.join(','));
}
function setUuids(list) {
  st.data.uuids = [...new Set(list.map(normUuid).filter(Boolean))];
  if (!st.data.uuids.length) st.browse = false;
  save();
  applyNativeFilter();
  st.beacons = st.raw.filter(uuidOk);
  st.pos = null; st.room = null;
  estimate();
  renderBeacons();
}
// 歩数（加速度センサーから1歩ごとに届く）。直近 WALK_WINDOW_MS に WALK_STEPS 歩以上あれば「歩いている」
const WALK_WINDOW_MS = 2500, WALK_STEPS = 2;
const HOLD_K = 0.05;   // 止まっているとき、新しい位置に寄せる割合（0.5秒ごと。歩いているときは 0.5）
function onStep(d) {
  st.steps = typeof d.n === 'number' ? d.n : st.steps + 1;
  const now = Date.now();
  st.stepTimes.push(now);
  while (st.stepTimes.length && now - st.stepTimes[0] > WALK_WINDOW_MS) st.stepTimes.shift();
  pdrStep();
}
// ---- 歩数＋コンパスで、案内ルートに沿って進める（歩行者推測航法）
//  1歩ごとに、歩幅だけ進める。進む向きは、コンパスの向き（方角合わせで図面の上を 0°）に近い方。
//  案内中は案内ルートの上を前か後ろへ、それ以外は赤いラインの上を進む（分かれ道では向きに近い方の道）。
//  向きとルートの方向が 60° 以上違うとき（曲がっている途中・ルートの外を向いている）は進めない。
//  RSSI の位置は、ずれを直すために少しずつ寄せる（estimate の PDR_RSSI_K）。ビーコンの真横ではしっかり寄せる
const PDR_TURN_COS = 0.5;   // 向きとルートの方向の差が 60° 以内の方へだけ進む
const PDR_RSSI_K = 0.25;    // 歩数で進めているとき、RSSI の位置に寄せる割合（0.5秒ごと）
// コンパスの値がないときの説明
const compassMissing = () => !N ? 'PC ブラウザではコンパスを使えません'
  : st.status && st.status.compass === 'none' ? 'この端末にはコンパス（地磁気センサー）がありません'
  : 'コンパスの値を待っています（スマホを少し動かしてください。続くときはアプリを開き直してください）';
// 図面の上を 0° とした向き。向きの基準が「図面の北」なら、コンパスの向き（北が 0°）に図面での北の向きを足す。
// 「方角合わせ」なら、方角合わせで図面の上を向いたときのコンパスの値を引く
const usingCalib = () => st.data.headRef === 'calib' && st.data.northOffset != null;
const mapHeading = () => st.heading == null ? null
  : usingCalib() ? (st.heading - st.data.northOffset + 360) % 360
  : st.data.headRef === 'map' ? (st.heading + st.data.mapNorth + 360) % 360 : null;
const headVec = deg => { const r = deg * Math.PI / 180; return [Math.sin(r), -Math.cos(r)]; };   // 0°=図面の上、90°=右
const pdrActive = () => st.data.pdr && st.data.posMode !== 'dist' && hasStepSensor() && mapHeading() != null && !!LANES;
function pdrWhyOff() {
  if (!st.data.pdr) return 'オフ';
  if (st.data.posMode === 'dist') return '「距離から計算」では使わない';
  if (!hasStepSensor()) return '歩数を数えられない端末';
  if (st.heading == null) return compassMissing();
  if (mapHeading() == null) return '方角合わせをしていない（案内を始めるときの「方角合わせ」で合わせるか、向きの基準を「図面の北」にする）';
  if (!LANES) return '図面に案内ルートがない';
  return '';
}
function pdrStep() {
  if (!pdrActive() || !st.pos) return;
  const v = headVec(mapHeading()), len = st.data.stepLen;
  const np = st.nav && !st.nav.sim ? stepOnPath(st.nav.path, st.pos.raw, v, len) : stepOnLanes(st.pos.raw, v, len);
  st.pdrLast = np ? 'ok' : 'turn';
  if (np) { st.pos.raw = np; st.pdrSteps = (st.pdrSteps || 0) + 1; }
}
// 赤いラインの上で、今の点から歩幅くらいの所のうち、向きにいちばん進む点（ラインに沿ってたどれる所だけ）
function stepOnLanes(p, v, len) {
  const c0 = nearestLaneCell(p, null); if (!c0) return null;
  const s0 = cellCenter(c0), R = len + CELL;
  const seen = new Set([c0[1] * GW + c0[0]]), q = [c0];
  let best = null, bs = 0;
  for (let h = 0; h < q.length; h++) {
    const [x, y] = q[h];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, k = ny * GW + nx;
      if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= GW || ny >= GH || seen.has(k) || !isLane(nx, ny)) continue;
      const c = cellCenter([nx, ny]), w = [c[0] - s0[0], c[1] - s0[1]], L = Math.hypot(w[0], w[1]);
      if (L > R) continue;
      seen.add(k); q.push([nx, ny]);
      const proj = w[0] * v[0] + w[1] * v[1];
      if (proj / L >= PDR_TURN_COS && proj > bs) { bs = proj; best = c; }
    }
  }
  if (!best || bs < 0.5 * len) return null;   // その向きにルートがほとんど続いていない（行き止まり・ラインの幅の中だけ）
  // 歩幅より遠いマスなら、歩幅の所まで
  const L = dist(best, s0);
  return L > len ? [s0[0] + (best[0] - s0[0]) * len / L, s0[1] + (best[1] - s0[1]) * len / L] : best;
}
// 案内ルートの上で、向きが前（行き先の方）なら前へ、後ろなら後ろへ歩幅だけ進める
function stepOnPath(path, p, v, len) {
  if (!path || path.length < 2) return null;
  const i = nearestIdxOnPath(path, p);
  const a = cellCenter(path[Math.max(0, i - 2)]), b = cellCenter(path[Math.min(path.length - 1, i + 2)]);
  const L = dist(a, b); if (!L) return null;
  const c = ((b[0] - a[0]) * v[0] + (b[1] - a[1]) * v[1]) / L;
  if (Math.abs(c) < PDR_TURN_COS) return null;
  const dir = c > 0 ? 1 : -1;
  let cur = cellCenter(path[i]), rest = len, j = i;
  while (rest > 0) {
    const nj = j + dir; if (nj < 0 || nj >= path.length) break;
    const nxt = cellCenter(path[nj]), d = dist(cur, nxt);
    if (d >= rest) return [cur[0] + (nxt[0] - cur[0]) * rest / d, cur[1] + (nxt[1] - cur[1]) * rest / d];
    rest -= d; cur = nxt; j = nj;
  }
  return cur;
}
function isWalking() {
  const now = Date.now();
  return st.stepTimes.filter(t => now - t <= WALK_WINDOW_MS).length >= WALK_STEPS;
}
const hasStepSensor = () => !!(st.status && st.status.stepSensor);
// 止まっているときは位置をほぼ動かさない（RSSI のゆれで位置が動かないように）。歩数が取れない端末では使わない。
// 位置が出てから HOLD_AFTER 回（0.5秒ごと）までは固定しない（最初の1回の値がずれていても、そこで止まらないように）
const HOLD_AFTER = 10;
const holdingStill = () => st.data.holdStill && hasStepSensor() && !isWalking() && st.posAge >= HOLD_AFTER;
const walkLabel = () => !hasStepSensor() ? 'センサーなし' : isWalking() ? '歩いている' : '止まっている';
function onBeacons(d) {
  const raw = d.beacons || [];
  st.raw = raw;
  st.beacons = raw.filter(uuidOk);
  st.ignored = raw.length - st.beacons.length;
  st.others = d.others || 0;
  st.scanning = !!d.scanning;
  estimate();
  recTick();
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
    const ds = distanceOf(b, mb.label);   // 空間の（斜めの）距離
    if (!cur || b.rssi > cur.b.rssi) m.set(mb.label, { b, mb, ds, d: floorDist(ds, mb.label) });
  });
  return m;
}
// 高さの補正：推定距離は空間の斜めの距離。現在地は床の上（平面）で求めるので、ビーコンとスマホの高さの差を除いた
// 床の上の距離 √(d² − 高さの差²) を使う。高さはビーコンタブの設定。測定の記録中は、記録の条件
// （ビーコンごとの iPhone の高さ・Android の高さ）を優先する。どちらかの高さが空欄なら補正しない
function heightDiff(label) {
  const num = v => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(x) ? x : null; };
  let bh = num(st.data.beaconH), ph = num(st.data.phoneH);
  const c = rec.cur;
  if (c) {
    const e = recEff(c.form, label);
    if (num(e.h) != null) bh = num(e.h);
    if (num(c.form.andH) != null) ph = num(c.form.andH);
  }
  return bh != null && ph != null ? Math.abs(bh - ph) : 0;
}
function floorDist(d, label) {
  const dh = heightDiff(label);
  return dh ? Math.max(0.1, Math.sqrt(Math.max(0, d * d - dh * dh))) : d;
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
// ------------------------------------------------------------ 測位
// 「現在地の求め方」（ビーコンタブ）で切り替える
//  近接型（標準） … いちばん強い2台を案内ルートの上で結び、2台の強さの差から2台の間のどこにいるかを出す
//  距離（3点測位）… 推定距離から位置を計算する。受信台数で次のように切り替える
//  1台    … 1点測位：ビーコンを中心に半径 d の円。円の上で、前回の位置の方向にある点
//  2台    … 2点測位：2つの円の交点。交点が2つあれば、前回の位置・案内ルートに近い方。交わらなければ2台を結ぶ線の上
//  3台以上 … 近い3台で3点測位：3つの円の式を引き算した連立方程式を解く。3台が一直線に近いときは最小二乗で探す
//  d は各ビーコンまでの推定距離（d = 10^((A − RSSI) ÷ (10 × n))）
function estimate() {
  const all = [...seenByLabel().values()].sort((a, c) => a.d - c.d);
  if (!all.length) { st.pos = null; st.room = null; st.near = null; st.nearCand = null; st.posAge = 0; return; }
  st.posAge = st.pos ? st.posAge + 1 : 0;
  const prevRoom = st.room;
  decideRoom(all);   // 今いる部屋（到着判定に使う）
  let used = all.slice(0, 3), prox = null;
  const prev = st.pos ? st.pos.raw : null;
  let p, method;
  if (st.data.posMode !== 'dist') {
    prox = proximity(all); p = prox.p; used = prox.used; method = `近接型（${used.length}台）`;
    const nb = decideNear(all);   // ビーコンの真横にいるときは、そのビーコンの点に引っ張る
    if (nb) { p = laneAnchor(nb.mb.at); used = [nb]; prox.near = nb; method = `近接型（${nb.mb.label} のそば）`; }
  }
  else if (used.length === 1) { p = onePoint(used[0], prev); method = '1点測位'; }
  else if (used.length === 2) { p = twoPoint(used[0], used[1], prev); method = '2点測位'; }
  // 3台目が2台目より THIRD_DROP_DB 以上弱いときは、遠くて距離が不正確なので使わず2点測位にする
  else if (strength(used[1]) - strength(used[2]) >= THIRD_DROP_DB) { used = used.slice(0, 2); p = twoPoint(used[0], used[1], prev); method = '2点測位（3台目は弱いので使わない）'; }
  else { p = threePoint(used, prev); method = '3点測位'; }
  const pull = pullToStrongest(all, p); p = pull.p;
  // 前回となめらかにつなぐ（部屋が変わったときはそのまま移る）
  // 止まっているときは、部屋が変わっても、ビーコンの真横に引っ張るときも、少しずつしか動かさない（約10秒で追いつく）
  // 歩数で進めているときは、RSSI の位置には少しずつ寄せる（ビーコンの真横ではしっかり寄せる）
  const still = holdingStill(), pdr = pdrActive();
  if (prev && (prevRoom === st.room || still || pdr)) {
    const k = still ? HOLD_K : pdr && !(prox && prox.near) ? PDR_RSSI_K : 0.5;
    p = [prev[0] + k * (p[0] - prev[0]), prev[1] + k * (p[1] - prev[1])];
  }
  const raw = p;
  // 表示する位置は線の上に寄せる（案内中はそのルート、そうでなければ赤いライン）
  let cell = null, pathIdx = null;
  if (st.nav && !st.nav.sim) {
    pathIdx = nearestIdxOnPath(st.nav.path, raw);
    cell = st.nav.path[pathIdx];
  } else if (LANES) {
    cell = nearestLaneCell(raw, null);
  }
  if (!cell) cell = nearestFree(raw);
  const [px, py] = (st.nav && !st.nav.sim) || LANES ? cellCenter(cell) : raw;
  st.pos = { x: px, y: py, raw, acc: used[0].d, used, all, cell, room: st.room, method, prox, still, pull,
             pathIdx, path: st.nav && !st.nav.sim ? st.nav.path : null };
}
// 近接型
//  狭い所や反射の多い所では、RSSI が距離で素直に変わらず（実測で 1m→4m でも約9dB しか下がらない）、
//  推定距離から位置を計算すると大きくずれる。そこで距離は使わず、強さの順番と差だけを使う。
//  1. 1m地点の強さで補正した強さ（「1mで補正」の値を引いたもの）で、いちばん強い2台を選ぶ
//  2. 2台それぞれの「案内ルートでいちばん近い点」を、案内ルートに沿って結ぶ
//  3. 2台の強さの差 Δ から、強い方から見て f = 1 ÷ (1 + 10^(Δ ÷ PROX_SLOPE_DB)) の所にいるとする
//     （差 0dB で真ん中、差が大きいほど強い方に寄る。1台だけのときはそのビーコンの点）
const PROX_SLOPE_DB = 15;   // 強さの差がこの dB で、距離の比を10倍とみなす（実測の当てはめ n≈1.5 の 10×n）
function proximity(all) {
  const s = all.slice().sort((a, c) => strength(c) - strength(a));
  const u1 = s[0], u2 = s[1];
  const a1 = laneAnchor(u1.mb.at);
  if (!u2) return { p: a1, used: [u1], f: 0, diff: null };
  const diff = strength(u1) - strength(u2);
  const f = 1 / (1 + Math.pow(10, diff / PROX_SLOPE_DB));
  return { p: alongPts(lanePathPts(a1, laneAnchor(u2.mb.at)), f), used: [u1, u2], f, diff };
}
// ビーコンの真横（約1m以内）にいるかの判定。距離は不正確でも、1m以内ならはっきり強くなる（実測：1m −56、2m以上 −60以下）
//  なる条件：1m地点の強さ − NEAR_ENTER_DB 以上で、2番目より NEAR_LEAD_DB 以上強い状態が NEAR_COUNT 回（0.5秒ごと）続く
//  やめる条件：1m地点の強さ − NEAR_EXIT_DB を下回るか、2番目との差が NEAR_HOLD_DB を下回る（すぐに出入りしないよう、なる条件よりゆるい）
//  1m地点の強さは「1mで補正」した値。補正していなければ実測の平均 NEAR_1M_DEFAULT を使う
//  （距離の式の標準値 −45 は距離の当てはめ用の値で、実際の 1m 地点の強さとは違うため）
const NEAR_1M_DEFAULT = -55, NEAR_ENTER_DB = 3, NEAR_EXIT_DB = 5, NEAR_LEAD_DB = 3, NEAR_HOLD_DB = 1, NEAR_COUNT = 2;
const oneMeterOf = label => typeof st.data.tx[label] === 'number' ? st.data.tx[label] : NEAR_1M_DEFAULT;
function decideNear(all) {
  const s = all.slice().sort((a, c) => strength(c) - strength(a));
  const top = s[0], lead = s[1] ? strength(top) - strength(s[1]) : 99;
  const over = top.b.rssi - oneMeterOf(top.mb.label);
  if (st.near === top.mb.label && over >= -NEAR_EXIT_DB && lead >= NEAR_HOLD_DB) return top;   // そのまま続ける
  st.near = null;
  if (over >= -NEAR_ENTER_DB && lead >= NEAR_LEAD_DB) {
    st.nearCandN = st.nearCand === top.mb.label ? st.nearCandN + 1 : 1;
    st.nearCand = top.mb.label;
    if (st.nearCandN >= NEAR_COUNT) { st.near = top.mb.label; st.nearCand = null; return top; }
  } else st.nearCand = null;
  return null;
}
// いちばん強いビーコンの方へ、いつも少し引っ張る（どの求め方でも）
//  引っ張る割合 w = 最大の割合 × min(1, 2番目との差 ÷ PULL_FULL_DB)。差 0dB（同じくらいの強さ）なら引っ張らない。
//  受信が1台だけなら最大の割合。引っ張る先は、そのビーコンの案内ルート上の点（案内ルートがなければビーコンの位置）
const PULL_FULL_DB = 10;   // 2番目との差がこの dB 以上で、最大の割合で引っ張る
function pullToStrongest(all, p) {
  const max = (st.data.pull || 0) / 100;
  const s = all.slice().sort((a, c) => strength(c) - strength(a)), top = s[0];
  const lead = s[1] ? strength(top) - strength(s[1]) : PULL_FULL_DB;
  const w = max * Math.min(1, Math.max(0, lead) / PULL_FULL_DB);
  if (!top || w <= 0) return { p, w: 0, to: null };
  const a = laneAnchor(top.mb.at);
  return { p: [p[0] + w * (a[0] - p[0]), p[1] + w * (a[1] - p[1])], w, to: top };
}
// ビーコンの位置から、案内ルートでいちばん近い点（案内ルートがない図面ではビーコンの位置）
function laneAnchor(at) {
  const c = LANES ? nearestLaneCell(at, null) : null;
  return c ? cellCenter(c) : at.slice();
}
// 案内ルートのマスだけを通る a→b の最短の並び（点の配列）。つながっていなければ a・b を直線で結ぶ
const lanePathCache = new Map();
function lanePathPts(a, b) {
  if (!LANES) return [a, b];
  const ca = cellOf(a), cb = cellOf(b);
  if (!isLane(ca[0], ca[1]) || !isLane(cb[0], cb[1])) return [a, b];
  const key = ca.join() + '>' + cb.join();
  if (lanePathCache.has(key)) return lanePathCache.get(key);
  const prev = new Int32Array(GW * GH).fill(-2), start = ca[1] * GW + ca[0], goal = cb[1] * GW + cb[0];
  const q = [start]; prev[start] = -1;
  for (let h = 0; h < q.length && prev[goal] === -2; h++) {
    const i = q[h], x = i % GW, y = (i - x) / GW;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, j = ny * GW + nx;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < GW && ny < GH && prev[j] === -2 && isLane(nx, ny)) { prev[j] = i; q.push(j); }
    }
  }
  let pts = [a, b];
  if (prev[goal] !== -2) {
    pts = [];
    for (let i = goal; i !== -1; i = prev[i]) pts.push(cellCenter([i % GW, Math.floor(i / GW)]));
    pts.reverse();
  }
  lanePathCache.set(key, pts);
  return pts;
}
// 点の並びに沿って、全体の長さの f の所
function alongPts(pts, f) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  let rest = total * f;
  for (let i = 1; i < pts.length; i++) {
    const L = dist(pts[i - 1], pts[i]);
    if (rest <= L && L > 0) { const t = rest / L; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; }
    rest -= L;
  }
  return pts[pts.length - 1].slice();
}
// 1点測位
function onePoint(u, prev) {
  const b = u.mb.at;
  let dir = null;
  if (prev && dist(prev, b) > 0.05) dir = prev;                       // 前回の位置の方向
  else if (LANES) { const c = nearestLaneCell(b, null); if (c && dist(cellCenter(c), b) > 0.05) dir = cellCenter(c); }   // 初回は案内ルートの方向
  if (!dir) return b.slice();
  const L = dist(dir, b);
  return [b[0] + (dir[0] - b[0]) / L * u.d, b[1] + (dir[1] - b[1]) / L * u.d];
}
// 2点測位
// 2点測位
//  2つの円の交点は、自分が2台を結ぶ線の外側にいるとき（ビーコン・ビーコン・自分の並び）に、RSSI の少しの揺れで
//  左右へ大きくぶれたり、2台の間に出たりする。そこで、歩ける場所のマスのうち「2台までの距離が推定距離に
//  いちばん合う所」を探す。線の外側・内側・横のどこでも同じ基準で比べ、同じくらい合う所が複数あるときは
//  案内ルート（赤いライン）に近い所・前回の位置に近い所を選ぶ
const THIRD_DROP_DB = 3;   // 3台目がこれ以上弱ければ、3点測位をやめて2点測位にする
const TWO_LANE_W = 0.03;   // 案内ルートから 1m 離れるごとの重み（距離の2乗に掛ける）
const TWO_PREV_W = 0.02;   // 前回の位置から 1m 離れるごとの重み（距離の2乗に掛ける）
let laneDistMap = null;    // マスごとの案内ルートまでの距離（初回に作る）
function laneDistAt(x, y) {
  if (!LANES) return 0;
  if (!laneDistMap) {
    laneDistMap = new Float32Array(GW * GH);
    const lanes = [];
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) if (isLane(i, j)) lanes.push(cellCenter([i, j]));
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      if (!walkable(i, j)) continue;
      const c = cellCenter([i, j]);
      let m = 1e9; lanes.forEach(l => { const d = dist(l, c); if (d < m) m = d; });
      laneDistMap[j * GW + i] = lanes.length ? m : 0;
    }
  }
  return laneDistMap[y * GW + x];
}
function twoPoint(u1, u2, prev) {
  if (dist(u1.mb.at, u2.mb.at) < 0.05) return onePoint(u1, prev);
  return fitOnGrid([u1, u2], prev);
}
// 2点測位・3点測位で共通：歩ける場所のマスのうち、各ビーコンまでの距離が推定距離にいちばん合う所。
//  合い方は距離のずれの割合（(図面上の距離 − 推定距離) ÷ 推定距離）の2乗の和で比べるので、遠いビーコンのずれは効きにくい。
//  案内ルート（赤いライン）から離れるほど・前回の位置から離れるほど少し不利にする
function fitOnGrid(us, prev) {
  let best = null, bc = Infinity;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    if (!walkable(x, y)) continue;
    const c = cellCenter([x, y]);
    let cost = 0;
    us.forEach(u => { cost += Math.pow((dist(c, u.mb.at) - u.d) / Math.max(u.d, 0.5), 2); });
    const ld = laneDistAt(x, y);
    cost += TWO_LANE_W * ld * ld;
    if (prev) cost += TWO_PREV_W * Math.pow(dist(c, prev), 2);
    if (cost < bc) { bc = cost; best = c; }
  }
  return best || us[0].mb.at.slice();
}
// 3点測位
//  これまでは3つの円の式を引き算した連立方程式を解いていたが、距離を2乗して引き算するため遠いビーコン
//  （いちばん不正確）のずれが大きく効き、案内ルートも考えないので、壁の向こうや別の廊下に出やすかった。
//  そこで2点測位と同じく、歩ける場所のマスから案内ルートの近くを優先して探す
function threePoint(us, prev) {
  return fitOnGrid(us, prev);
}
function nearestIdxOnPath(path, p) {
  let bi = 0, bd = 1e9;
  path.forEach((c, i) => { const d = dist(cellCenter(c), p); if (d < bd) { bd = d; bi = i; } });
  return bi;
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
  // 向いている方向の △（図面タブ。現在地の点の外側に置き、向きに合わせて回す）
  if (!opt.path) {
    const R = 46 * K, sx = (R * Math.sin(Math.PI / 6)).toFixed(1), sy = (-R * Math.cos(Math.PI / 6)).toFixed(1);
    s += `<g class="headg" transform="translate(-9999 -9999)">`
      + `<path d="M0 0 L${-sx} ${sy} A${R} ${R} 0 0 1 ${sx} ${sy} Z" fill="var(--coral)" fill-opacity=".3" stroke="var(--coral)" stroke-width="${1.5 * K}" stroke-opacity=".6"/>`   // 向いている方向の扇（±30°）
      + `<path d="M0 ${-38 * K} L${7 * K} ${-12 * K} L${-7 * K} ${-12 * K} Z" fill="var(--coral)" stroke="#fff" stroke-width="${2 * K}" stroke-linejoin="round"/></g>`;   // 細長い △
  }
  if (opt.path) s += `<g class="me" transform="translate(-9999 -9999)"><circle r="${13 * K}" fill="var(--coral)" opacity=".18"/><path d="M0 ${-9 * K} L${7 * K} ${7 * K} L0 ${3 * K} L${-7 * K} ${7 * K} Z" fill="var(--coral)" stroke="#fff" stroke-width="${1.5 * K}" stroke-linejoin="round"/></g>`;
  const ex = (v[0] + v[2]) * U, ey = (v[1] + v[3]) * U;
  // 北の向き（左上の空いている所）
  { const cx = v[0] * U + 120, cy = v[1] * U + 130, r = 62;
    s += `<g transform="translate(${cx} ${cy}) rotate(${st.data.mapNorth})"><circle r="${r}" fill="var(--surface)" stroke="var(--line)" stroke-width="3"/>`
      + `<path d="M0 ${-r + 10} L20 10 L0 0 L-20 10 Z" fill="var(--slate)"/><text y="${-r - 12}" text-anchor="middle" font-family="var(--f-mono)" font-size="40" font-weight="700" fill="var(--ink)">N</text></g>`; }
  s += `<text x="${ex - 20}" y="${ey - 20}" text-anchor="end" font-family="var(--f-mono)" font-size="26" fill="var(--muted)">↑図面の上　━ 1m</text>`;
  s += `<line x1="${ex - 120}" y1="${ey - 50}" x2="${ex - 20}" y2="${ey - 50}" stroke="var(--muted)" stroke-width="6"/></svg>`;
  el.innerHTML = s;
  el.dataset.nav = opt.path ? '1' : '';
  el.style.setProperty('--map-ratio', (vw / vh).toFixed(3));
  updateDyn(el);
}
// 図面タブの △ を、現在地の位置・向いている方向に合わせる（方角合わせをしていないときは出さない）
function placeHeading(el) {
  const g = el && el.querySelector('.headg'); if (!g) return;
  const h = mapHeading();
  if (!st.pos || h == null) { g.setAttribute('transform', 'translate(-9999 -9999)'); return; }
  g.setAttribute('transform', `translate(${(st.pos.x * U).toFixed(1)} ${(st.pos.y * U).toFixed(1)}) rotate(${h.toFixed(0)})`);
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
    // 動かしたビーコンは、図面の元の位置を点線の丸と線で示す
    if (mb.moved && el.id === 'planMap') {
      const [ox, oy] = mb.orig;
      s += `<line x1="${ox * U}" y1="${oy * U}" x2="${x * U}" y2="${y * U}" stroke="var(--gray)" stroke-width="3" stroke-dasharray="8 6"/>`;
      s += `<circle cx="${ox * U}" cy="${oy * U}" r="${5 * K}" fill="none" stroke="var(--gray)" stroke-width="3" stroke-dasharray="6 5"/>`;
    }
    if (hit && usedSet.has(mb.label)) s += `<circle cx="${x * U}" cy="${y * U}" r="${Math.min(hit.d, 12) * U}" fill="none" stroke="var(--teal)" stroke-width="3" opacity=".35"/>`;
    s += `<circle cx="${x * U}" cy="${y * U}" r="${hit ? 6.5 * K : 5.5 * K}" fill="${hit ? 'var(--teal)' : 'var(--gray)'}"/>`;
    // 番号は壁（黒い線）と見分けやすい青にし、背景色のふちどりを付ける
    s += `<text x="${x * U}" y="${(y * U) - 9 * K}" text-anchor="middle" font-family="var(--f-mono)" font-size="24" font-weight="700" fill="var(--blabel)" stroke="var(--surface)" stroke-width="6" stroke-linejoin="round" paint-order="stroke">${esc(mb.label)}</text>`;
  });
  if (st.pos && el.dataset.nav !== '1') {
    const px = st.pos.x * U, py = st.pos.y * U;
    s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(Math.max(0.3, Math.min(st.pos.acc, 4)) * U).toFixed(1)}" fill="var(--coral)" opacity=".15"/>`;
    s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${7 * K}" fill="var(--coral)" stroke="#fff" stroke-width="${2 * K}"/>`;
  }
  placeHeading(el);
  const rp = recPosOf(rec.form);
  if (rp && el.id === 'planMap' && rp.label.startsWith('図面')) {
    const [mx, my] = [rp.at[0] * U, rp.at[1] * U], k = 8 * K;
    s += `<path d="M${mx} ${my - k}L${mx + k} ${my}L${mx} ${my + k}L${mx - k} ${my}Z" fill="var(--slate)" stroke="#fff" stroke-width="${1.5 * K}"/>`;
    s += `<text x="${mx}" y="${my + k + 22}" text-anchor="middle" font-size="22" fill="var(--ink)">ミミナビ</text>`;
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
  if (st.view === 'plan') placeHeading($('planMap'));
  if (st.view === 'nav' && st.nav && !st.nav.sim && st.pos && mapHeading() != null) placeMeAt([st.pos.x, st.pos.y], mapHeading());
  if (st.view === 'calib') {
    $('needle').style.transform = `rotate(${deg}deg)`;
    $('headingTxt').textContent = `方位 ${deg}°（${COMPASS[Math.round(deg / 45) % 8]}）`;
  }
}
$('calibBtn').onclick = () => {
  if (st.heading != null) { st.data.northOffset = st.heading; st.data.headRef = 'calib'; save(); }   // 方角合わせをしたら、その値を使う
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
// 案内ルート（赤い枠）がある図面では、赤い枠のマスだけを通る。現在地のアイコンは赤い枠の上しか動かないので、
// ルートも枠の上だけにしないと、ルートの先（目的地）までアイコンが届かず、到着にならない。
// 出発点・目的地が枠の外なら、いちばん近い枠のマスから・までのルートにする。枠の上でつながらないときだけ、枠の外も通る
function route(s, g) {
  if (LANES) {
    const ls = isLane(s[0], s[1]) ? s : nearestLaneCell(cellCenter(s), null);
    const lg = isLane(g[0], g[1]) ? g : nearestLaneCell(cellCenter(g), null);
    const p = ls && lg ? routeOn(ls, lg, true) : null;
    if (p) return p;
  }
  return routeOn(s, g, false);
}
function routeOn(s, g, laneOnly) {
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
      if (!walkable(nx, ny) || (laneOnly && !isLane(nx, ny))) continue;
      const step = laneOnly ? (isLaneCore(nx, ny) ? 0 : LANE_EDGE_COST)
        : LANES ? (isLane(nx, ny) ? 0 : OFF_LANE_COST + (STEP_COST[ROWS[ny][nx]] || 0)) : (STEP_COST[ROWS[ny][nx]] || 0);
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
  if (mapHeading() != null) {
    const mapHead = mapHeading();
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
// 案内画面の現在地の矢印。deg は図面の上を 0° とした向き
function placeMeAt(p, deg) {
  const g = $('navMap').querySelector('.me'); if (!g) return;
  g.setAttribute('transform', `translate(${(p[0] * U).toFixed(1)} ${(p[1] * U).toFixed(1)}) rotate(${Math.round(deg)})`);
}
const placeMeCell = (c, d) => placeMeAt(cellCenter(c), d * 90);
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
  // 矢印は向いている方向（方角合わせをしていなければ、ルートの進む方向）
  const h = mapHeading();
  placeMeAt(pos, h != null ? h : nav.segs[segIndexAt(Math.max(1, nav.idx))].d * 90);
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
    if (st.nav) return;   // その間に次の案内が始まっていたら切り替えない
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
  if (full || !el.querySelector('svg')) { buildMap(el, { allDests: true, small: true }); zoomApply(); }
  else updateDyn(el);
  $('planSize').textContent = `${(BX1 - BX0 - 0.8).toFixed(1)}m × ${(BY1 - BY0 - 0.8).toFixed(1)}m`;
  $('planPos').textContent = st.pos
    ? `x ${st.pos.x.toFixed(1)}m, y ${st.pos.y.toFixed(1)}m（${placeName([st.pos.x, st.pos.y])}付近・誤差 約${st.pos.acc.toFixed(1)}m）${st.room ? `／部屋：${roomName(st.room.name)}` : ''}`
    : '—（図面のビーコンを受信していません）';
  $('planHead').textContent = mapHeading() != null ? `図面の上から ${Math.round(mapHeading())}°（図面の △ の向き・基準：${usingCalib() ? '方角合わせ' : `図面の北 ${st.data.mapNorth}°`}）`
    : st.heading == null ? compassMissing() : '方角合わせをすると、図面に向き（△）が出ます（案内タブ →「この施設で案内を始める」→ 方角合わせ）。ビーコンタブで向きの基準を「図面の北」にしても出ます';
  const pl = st.pos && st.pos.pull;
  $('planPull').textContent = !st.data.pull ? 'オフ' : pl && pl.to ? `${pl.to.mb.label} の方へ ${Math.round(pl.w * 100)}%（最大 ${st.data.pull}%）` : '引っ張っていない（2台が同じくらいの強さ）';
  $('planWalk').textContent = !hasStepSensor() ? '歩数センサーなし（止まっていても位置を固定しない）'
    : `${walkLabel()}（歩数 ${st.steps}）${st.pos && st.pos.still ? '・位置をほぼ固定中' : ''}${pdrActive() ? `・歩数で進める（歩幅 ${st.data.stepLen}m・向き ${Math.round(mapHeading())}°${st.pdrLast === 'turn' ? '・ルートの方向を向いていないので止める' : ''}）` : ''}`;
  $('planUsed').textContent = !st.pos ? '—'
    : st.pos.prox && st.pos.prox.near ? `${st.pos.method}：${st.pos.prox.near.mb.label} ${Math.round(st.pos.prox.near.b.rssi)}dBm（1m地点 ${oneMeterOf(st.pos.prox.near.mb.label)}dBm${typeof st.data.tx[st.pos.prox.near.mb.label] === 'number' ? '・補正' : '・標準'}${st.pos.prox.diff != null ? `、2番目より ${st.pos.prox.diff.toFixed(1)}dB 強い` : ''}）`
    : st.pos.prox ? `${st.pos.method}：` + st.pos.used.map(u => `${u.mb.label} ${Math.round(u.b.rssi)}dBm`).join(' / ')
      + (st.pos.prox.diff != null ? `（差 ${st.pos.prox.diff.toFixed(1)}dB → ${st.pos.used[0].mb.label} から ${st.pos.used[1].mb.label} へ ${Math.round(st.pos.prox.f * 100)}% の所）` : '（そのビーコンのそば）')
    : `${st.pos.method}：` + st.pos.used.map(u => `${u.mb.label} ${u.d.toFixed(1)}m`).join(' / ') + (st.pos.used.some(u => Math.abs(u.d - u.ds) > 0.005) ? '（高さ補正後の床の上の距離）' : '');
  const seen = seenByLabel();
  $('placingBar').hidden = !st.placing;
  if (st.placing) { $('placingName').textContent = st.placing.label; $('placingText').textContent = st.placing.rec ? 'を図面上でタップ' : 'を置いた場所を図面上でタップ'; }
  const all = mapBeacons();
  const sig = all.map(b => { const h = seen.get(b.label); return b.label + (h ? Math.round(h.b.rssi) + h.b.key : 'x'); }).join('|');
  if (!full && sig === listSig) return;
  listSig = sig;
  $('placedList').innerHTML = all.map(b => {
    const h = seen.get(b.label);
    const how = b.custom ? '自分で配置' : h && h.mb.manual ? '手動で割り当て' : `Minor ${b.minor ?? '?'}`;
    const del = b.custom ? `<button class="iconbtn" data-del="${esc(b.label)}">外す</button>`
      : `<button class="iconbtn" data-move="${esc(b.label)}">動かす</button>${b.moved ? `<button class="iconbtn" data-unmove="${esc(b.label)}">元に戻す</button>` : ''}`;
    return `<div class="prow"><i class="lg ${h ? 'teal' : 'gray'}"></i><b class="${h ? '' : 'off'}">${esc(b.label)}</b><span class="grow">${esc(beaconPlace(b))}${b.moved ? '（移動済み）' : ''}・${how}</span><span class="rem">${h ? `${Math.round(h.b.rssi)}dBm 約${h.d.toFixed(1)}m` : '未受信'}</span>${del}</div>`;
  }).join('');
}

$('placedList').addEventListener('click', e => {
  const mv = e.target.closest('[data-move]');
  if (mv) {
    st.placing = { move: mv.dataset.move, label: mv.dataset.move };
    renderPlan(true);
    say(`${mv.dataset.move}を置いた場所を、図面の上でタップしてください。`);
    return;
  }
  const um = e.target.closest('[data-unmove]');
  if (um) {
    delete st.data.moved[um.dataset.unmove];
    refreshBeacons(); save(); estimate(); renderPlan(true);
    say(`${um.dataset.unmove}を図面の元の位置に戻しました。`);
    return;
  }
  const b = e.target.closest('[data-del]'); if (!b) return;
  Object.keys(st.data.assign).forEach(k => { if (st.data.assign[k].label === b.dataset.del) delete st.data.assign[k]; });
  save(); estimate(); renderPlan(true);
});
// ------------------------------------------------------------ 図面タブの拡大・縮小
// 拡大率 s（1 = 図面全体）と、表示の中心 c（図面の座標 × U）で表す。viewBox の縦横比は表示枠に合わせる
const ZMAX = 8;
const zoom = { s: 1, c: null, full: false, ptrs: new Map(), g: null, moved: false, suppress: false, lastTap: null };
const zoomBase = () => [BX0 * U, BY0 * U, (BX1 - BX0) * U, (BY1 - BY0) * U];
function zoomBox() { const r = $('planMap').getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null; }
// 今の s・c から viewBox を求める（図面の外へ出すぎないように中心を寄せる）
function zoomView(box) {
  const b = zoomBase(), ar = box.width / box.height;
  const W = b[2] / b[3] > ar ? b[2] : b[3] * ar, H = W / ar;
  const w = W / zoom.s, h = H / zoom.s;
  const c = zoom.c || [b[0] + b[2] / 2, b[1] + b[3] / 2];
  const cl = (v, lo, len, sz) => sz >= len ? lo + len / 2 : Math.min(Math.max(v, lo + sz / 2), lo + len - sz / 2);
  zoom.c = [cl(c[0], b[0], b[2], w), cl(c[1], b[1], b[3], h)];
  return [zoom.c[0] - w / 2, zoom.c[1] - h / 2, w, h];
}
function zoomApply() {
  const svg = $('planMap').querySelector('svg'), box = zoomBox();
  if (!svg || !box) return null;
  const v = zoomView(box);
  svg.setAttribute('viewBox', v.map(n => n.toFixed(1)).join(' '));
  $('planWrap').classList.toggle('zoomed', zoom.s > 1.001);
  $('zoomIn').disabled = zoom.s >= ZMAX - 0.001;
  $('zoomOut').disabled = $('zoomReset').disabled = zoom.s <= 1.001;
  return v;
}
// 画面上の点 (px, py)（表示枠の左上から）にある図面の点を、そのまま同じ所に残して拡大率を変える
function zoomAt(s, px, py, q) {
  const box = zoomBox(); if (!box) return;
  if (!q) { const v = zoomView(box), k = v[2] / box.width; q = [v[0] + px * k, v[1] + py * k]; }
  zoom.s = Math.min(Math.max(s, 1), ZMAX);
  const v = zoomView(box), k = v[2] / box.width;
  zoom.c = [q[0] - px * k + v[2] / 2, q[1] - py * k + v[3] / 2];
  zoomApply();
}
function zoomEnd() { if (st.placing) updateDyn($('planMap')); }
function zoomFull(on) {
  zoom.full = on;
  $('planWrap').classList.toggle('full', on);
  $('zoomFull').setAttribute('aria-pressed', on);
  $('zoomFull').setAttribute('aria-label', on ? '大きく表示をやめる' : '大きく表示');
  zoomApply(); zoomEnd();
}
const zoomBtn = f => () => { const box = zoomBox(); if (box) { zoomAt(f(zoom.s), box.width / 2, box.height / 2); zoomEnd(); } };
$('zoomIn').onclick = zoomBtn(s => s * 1.6);
$('zoomOut').onclick = zoomBtn(s => s / 1.6);
$('zoomReset').onclick = () => { zoom.s = 1; zoom.c = null; zoomApply(); zoomEnd(); };
$('zoomFull').onclick = () => zoomFull(!zoom.full);
if (window.ResizeObserver) new ResizeObserver(() => zoomApply()).observe($('planMap'));
// 指での操作：2本指で拡大・縮小、拡大中は1本指で移動、ダブルタップで拡大
{
  const el = $('planMap');
  const rel = p => { const r = el.getBoundingClientRect(); return [p.x - r.left, p.y - r.top]; };
  const gesture = () => {
    const box = zoomBox(), v = box && zoomView(box); if (!v) return null;
    const ps = [...zoom.ptrs.values()], k = v[2] / box.width;
    if (ps.length >= 2) {
      const [a, b] = ps, m = rel({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      return { s0: zoom.s, d0: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1), q: [v[0] + m[0] * k, v[1] + m[1] * k] };
    }
    return { pan: true, p0: { ...ps[0] }, c0: zoom.c.slice(), k };
  };
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    zoom.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (zoom.ptrs.size === 1) { zoom.moved = false; zoom.down = { x: e.clientX, y: e.clientY }; }
    zoom.g = gesture();
    try { el.setPointerCapture(e.pointerId); } catch (_) { }
  });
  el.addEventListener('pointermove', e => {
    const p = zoom.ptrs.get(e.pointerId); if (!p || !zoom.g) return;
    p.x = e.clientX; p.y = e.clientY;
    const ps = [...zoom.ptrs.values()];
    if (ps.length >= 2 && !zoom.g.pan) {
      const [a, b] = ps, m = rel({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      zoom.moved = true;
      zoomAt(zoom.g.s0 * Math.hypot(a.x - b.x, a.y - b.y) / zoom.g.d0, m[0], m[1], zoom.g.q);
    } else if (zoom.g.pan) {
      const dx = p.x - zoom.g.p0.x, dy = p.y - zoom.g.p0.y;
      if (!zoom.moved && Math.hypot(dx, dy) < 8) return;
      zoom.moved = true;
      if (zoom.s <= 1.001) return;
      zoom.c = [zoom.g.c0[0] - dx * zoom.g.k, zoom.g.c0[1] - dy * zoom.g.k];
      zoomApply();
    }
  });
  const up = e => {
    if (!zoom.ptrs.has(e.pointerId)) return;
    zoom.ptrs.delete(e.pointerId);
    if (zoom.moved) zoom.suppress = true;   // 動かしたあとの click では、ビーコンを置かない
    if (zoom.ptrs.size) { zoom.g = gesture(); return; }
    zoom.g = null;
    if (zoom.moved) { zoomEnd(); return; }
    if (e.type !== 'pointerup' || st.placing) return;
    const now = Date.now(), t = zoom.lastTap;
    if (t && now - t.time < 320 && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 30) {
      const [px, py] = rel({ x: e.clientX, y: e.clientY });
      if (zoom.s >= ZMAX - 0.001) { zoom.s = 1; zoom.c = null; zoomApply(); } else zoomAt(zoom.s * 2, px, py);
      zoom.lastTap = null; zoomEnd();
    } else zoom.lastTap = { time: now, x: e.clientX, y: e.clientY };
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('click', e => { if (zoom.suppress) { zoom.suppress = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const [px, py] = rel({ x: e.clientX, y: e.clientY });
    zoomAt(zoom.s * Math.exp(-e.deltaY / 300), px, py); zoomEnd();
  }, { passive: false });
}
$('planMap').addEventListener('click', e => {
  if (!st.placing) return;
  const svg = $('planMap').querySelector('svg'); if (!svg) return;
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const q = pt.matrixTransform(svg.getScreenCTM().inverse());
  const at = [Math.round(q.x / U * 100) / 100, Math.round(q.y / U * 100) / 100];
  if (at[0] < BX0 || at[0] > BX1 || at[1] < BY0 || at[1] > BY1) return;
  if (st.placing.move) {
    const label = st.placing.move;
    st.placing = null;
    st.data.moved[label] = at;
    refreshBeacons(); save(); estimate(); renderPlan(true);
    if (st.view === 'beacons') renderBeacons();
    say(`${label}を、${placeName(at)}に動かしました。`);
    return;
  }
  if (st.placing.recBeacon) {   // 測定の記録から、ビーコンを図面に置く
    const { label, key } = st.placing;
    st.placing = null;
    let name = label;
    const a = key && st.data.assign[key];
    if (a && a.at) a.at = at;                                            // 自分で置いたビーコン（P-xx）を置き直す
    else if (MAP.beacons.some(b => b.label === label) && !(a && !a.at && a.label !== label)) {
      st.data.moved[label] = at; refreshBeacons();                       // 図面の B-xx を動かす
    } else if (key) {                                                    // 図面にないビーコン（Minor 6 など）を新しく置く
      name = nextCustomLabel();
      Object.keys(st.data.assign).forEach(k => { if (k !== key && st.data.assign[k].label === name) delete st.data.assign[k]; });
      st.data.assign[key] = { label: name, at };
      if (rec.form.per[label]) { rec.form.per[name] = rec.form.per[label]; delete rec.form.per[label]; }
      if (rec.form.target === label) rec.form.target = name;
      recSave();
    }
    save(); estimate();
    say(`${name}を、${placeName(at)}に置きました。`);
    show('beacons'); $('recPer').dataset.sig = ''; renderRecPer(); renderRecPos(); renderRecTargets();
    return;
  }
  if (st.placing.rec) {
    st.placing = null;
    rec.form.andPos = '@map'; rec.form.andAt = at; recSave();
    say(`ミミナビの位置を、${placeName(at)}にしました。`);
    show('beacons'); renderRecPos();
    return;
  }
  const { key, label } = st.placing;
  Object.keys(st.data.assign).forEach(k => { if (k !== key && st.data.assign[k].label === label) delete st.data.assign[k]; });
  st.data.assign[key] = { label, at };
  st.placing = null;
  save(); estimate(); renderPlan(true);
  say(`${label}を、${placeName(at)}に配置しました。`);
});
$('placingCancel').onclick = () => { const r = st.placing && (st.placing.rec || st.placing.recBeacon); st.placing = null; if (r) { show('beacons'); renderRecPos(); } else renderPlan(true); };

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
  $('posMode').value = st.data.posMode;
  $('holdStill').checked = st.data.holdStill;
  $('pdrOn').checked = st.data.pdr;
  if (document.activeElement !== $('pullPct')) $('pullPct').value = st.data.pull;
  $('headRef').value = st.data.headRef;
  if (document.activeElement !== $('mapNorth')) $('mapNorth').value = st.data.mapNorth;
  $('headNote').textContent = st.heading == null ? compassMissing() + '。'
    : st.data.headRef === 'calib' && st.data.northOffset == null ? 'まだ方角合わせをしていません（案内を始めるときの「方角合わせ」で合わせる）。'
    : `今の向き：図面の上から ${Math.round(mapHeading())}°（コンパス ${Math.round(st.heading)}°）`;
  if (document.activeElement !== $('stepLen')) $('stepLen').value = st.data.stepLen;
  $('pdrState').textContent = pdrActive() ? `使用中：図面の上から ${Math.round(mapHeading())}° の向き` : `使っていない：${pdrWhyOff()}`;
  $('walkState').textContent = hasStepSensor() ? `今：${walkLabel()}（歩数 ${st.steps}）` : 'この端末では歩数を数えられないため、使いません。';
  if (document.activeElement !== $('hBeacon')) $('hBeacon').value = st.data.beaconH;
  if (document.activeElement !== $('hPhone')) $('hPhone').value = st.data.phoneH;
  renderHeightNote();
  renderUuidCard();
  renderRecTargets();
  renderRecPos();
  renderRecPer();

  const sorted = [...(st.browse ? st.raw : st.beacons)].sort((a, b) => b.rssi - a.rssi);
  if (!sorted.length) {
    rows.clear();
    list.innerHTML = st.data.uuids.length
      ? `<p class="sub">登録した UUID（${st.data.uuids.length}件）のビーコンを探しています…<br>iPhone の Beacon Simulator で、登録した UUID の iBeacon を送信してください。</p>`
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
        <div class="bbtns"><button class="iconbtn" data-act="cal">1mで補正</button><button class="iconbtn" data-act="reset" hidden>補正を戻す</button><button class="iconbtn" data-act="uuid">このUUIDを使う</button></div>`;
      rows.set(b.key, el);
    }
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
    const ok = uuidOk(b);
    const mb = ok ? beaconOf(b) : null;
    const label = mb ? mb.label : null;
    el.classList.toggle('placed', !!mb);
    el.classList.toggle('stale', b.ageMs > 3000 || !ok);
    el.querySelector('.name').textContent = !ok ? '対象外（登録していない UUID）' : mb ? `${mb.label}（${beaconPlace(mb)}）` : '図面に未配置';
    el.querySelector('.assign').hidden = !ok;
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
    el.querySelector('[data-act="uuid"]').hidden = b.type !== 'iBeacon' || uuidInList(b.uuid, st.data.uuids);
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
  const b = st.raw.find(x => x.key === btn.closest('.bcard').dataset.key); if (!b) return;
  if (btn.dataset.act === 'uuid') {
    setUuids(st.data.uuids.concat([b.uuid]));
    say(`UUIDを登録しました。登録は${st.data.uuids.length}件です。`);
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
function renderUuidCard() {
  const list = st.data.uuids;
  $('uuidList').innerHTML = list.length
    ? list.map((u, i) => `<div class="prow"><i class="lg teal"></i><span class="grow mono">${esc(u)}</span><span class="rem">${st.beacons.filter(b => normUuid(b.uuid) === u).length}台</span><button class="iconbtn" data-del-uuid="${i}">外す</button></div>`).join('')
    : '';
  $('uuidText').textContent = list.length
    ? `登録した ${list.length} 件の UUID 以外は無視しています${st.ignored && !st.browse ? `（今 ${st.ignored}台を無視）` : ''}。`
    : '未設定：受信したすべてのビーコンを使います。受信中のビーコンの「このUUIDを使う」か、下の入力欄で登録できます。';
  $('uuidClear').hidden = !list.length;
  $('uuidBrowse').hidden = !list.length;
  $('uuidBrowse').textContent = st.browse ? '追加用の表示をやめる' : '他のUUIDも表示する（追加用）';
  $('uuidBrowse').setAttribute('aria-pressed', st.browse);
}
$('uuidList').addEventListener('click', e => {
  const b = e.target.closest('[data-del-uuid]'); if (!b) return;
  const list = st.data.uuids.slice(); list.splice(Number(b.dataset.delUuid), 1);
  setUuids(list);
});
$('uuidAdd').addEventListener('submit', e => {
  e.preventDefault();
  const u = normUuid($('uuidInput').value);
  if (!u) { $('uuidInput').setCustomValidity('UUID の形式（8-4-4-4-12 桁の16進数）で入力してください'); $('uuidInput').reportValidity(); return; }
  $('uuidInput').setCustomValidity(''); $('uuidInput').value = ''; $('uuidInput').blur();
  setUuids(st.data.uuids.concat([u]));
});
$('uuidInput').addEventListener('input', () => $('uuidInput').setCustomValidity(''));
$('uuidBrowse').onclick = () => { st.browse = !st.browse; applyNativeFilter(); renderBeacons(); };
$('uuidClear').onclick = () => { setUuids([]); say('すべてのビーコンを使います。'); };
$('nRange').addEventListener('input', e => { st.data.n = Number(e.target.value); $('nVal').textContent = st.data.n.toFixed(1); save(); });
// 現在地の求め方（近接型／距離から3点測位）
$('posMode').addEventListener('change', e => { st.data.posMode = e.target.value; save(); estimate(); renderPlan(true); });
$('holdStill').addEventListener('change', e => { st.data.holdStill = e.target.checked; save(); });
$('headRef').addEventListener('change', e => { st.data.headRef = e.target.value; save(); renderBeacons(); });
$('mapNorth').addEventListener('change', e => {
  const v = parseFloat(String(e.target.value).replace(',', '.'));
  if (isFinite(v)) { st.data.mapNorth = Math.round(((v % 360) + 360) % 360); save(); if ($('planMap').querySelector('svg')) { buildMap($('planMap'), { allDests: true, small: true }); zoomApply(); } }
  e.target.value = st.data.mapNorth;
});
$('pullPct').addEventListener('change', e => {
  const v = parseFloat(String(e.target.value).replace(',', '.'));
  if (isFinite(v) && v >= 0 && v <= 100) { st.data.pull = Math.round(v); save(); estimate(); }
  e.target.value = st.data.pull;
});
$('pdrOn').addEventListener('change', e => { st.data.pdr = e.target.checked; save(); });
$('stepLen').addEventListener('change', e => {
  const v = parseFloat(String(e.target.value).replace(',', '.'));
  if (isFinite(v) && v >= 0.2 && v <= 1.2) { st.data.stepLen = Math.round(v * 100) / 100; save(); }
  e.target.value = st.data.stepLen;
});
// 高さの補正の設定
['hBeacon', 'hPhone'].forEach(id => $(id).addEventListener('change', () => {
  st.data.beaconH = $('hBeacon').value.trim(); st.data.phoneH = $('hPhone').value.trim();
  save(); estimate(); renderHeightNote();
}));
function renderHeightNote() {
  const on = st.data.beaconH !== '' && st.data.phoneH !== '';
  $('hNote').textContent = on
    ? `補正中：高さの差 ${Math.abs(parseFloat(st.data.beaconH) - parseFloat(st.data.phoneH)).toFixed(2)}m を除いた床の上の距離で現在地を計算します。`
    : '両方入れると、高さの差を除いた床の上の距離で現在地を計算します（空欄なら補正しない）。';
}

// ------------------------------------------------------------ 測定の記録（ビーコンタブ）
// 記録中は 0.5 秒ごと（ビーコンの通知ごと）に、受信中のビーコンの値と推定位置を保存する。
// 「結果を書き出す」は測定結果一覧（Excel）と同じ列の順番の CSV、「生データ」は 0.5 秒ごとの全記録。
const REC_KEY = 'records';
const REC_FIELDS = ['target', 'andPos', 'dist', 'sec', 'reps', 'iphPlace', 'andPlace', 'iphH', 'andH', 'iphDir', 'andDir', 'body', 'obst', 'note'];
const rec = { list: [], form: { sec: '30', reps: '1', iphDir: '縦', andDir: '縦', body: '正面', obst: '無し', per: {} }, cur: null, next: null, seq: 0 };
function recLoad() {
  try {
    const raw = N && N.loadItem ? N.loadItem(REC_KEY) : localStorage.getItem('miminavi-' + REC_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (Array.isArray(d.list)) rec.list = d.list;
    if (d.form && typeof d.form === 'object') Object.assign(rec.form, d.form);
    if (!rec.form.per || typeof rec.form.per !== 'object') rec.form.per = {};
    rec.seq = typeof d.seq === 'number' ? d.seq : rec.list.reduce((m, r) => Math.max(m, r.no || 0), 0);
  } catch (e) { /* 初回など */ }
}
function recSave() {
  const s = JSON.stringify({ list: rec.list, form: rec.form, seq: rec.seq });
  try { if (N && N.saveItem) N.saveItem(REC_KEY, s); else localStorage.setItem('miminavi-' + REC_KEY, s); } catch (e) { }
}
const pad2 = v => String(v).padStart(2, '0');
const fmtTime = t => { const d = new Date(t); return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const numOrNull = v => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(x) ? x : null; };
const stats = a => a.length ? { min: Math.min(...a), max: Math.max(...a), avg: a.reduce((x, y) => x + y, 0) / a.length } : null;
function recReadForm() {
  const f = $('recForm');
  REC_FIELDS.forEach(k => { if (f.elements[k] && k !== 'andPos') rec.form[k] = f.elements[k].value.trim(); });
  recReadPer();
}
// ビーコンごとの設定（空欄は共通の値を使う）
function recReadPer() {
  document.querySelectorAll('#recPer [data-k]').forEach(el => {
    const l = el.dataset.label, k = el.dataset.k, v = el.value.trim();
    const o = rec.form.per[l] || (rec.form.per[l] = {});
    if (v) o[k] = v; else delete o[k];
    if (!Object.keys(o).length) delete rec.form.per[l];
  });
}
// ビーコンごとの実際の条件。「受信中のすべて」のときはビーコンごとの設定、空欄や1台だけのときは共通の値
function recEff(form, label) {
  const p = (!form.target && form.per && form.per[label]) || {};
  const pick = (k, common) => (p[k] != null && p[k] !== '' ? p[k] : common);
  return { dist: pick('dist', form.dist), dir: pick('dir', form.iphDir), h: pick('h', form.iphH), place: pick('place', form.iphPlace) };
}
// ビーコンごとの設定欄（受信中のビーコン＋設定済みのビーコン）
function renderRecPer() {
  const box = $('recPer'); if (!box) return;
  const f = rec.form, pos = recPosOf(f), one = !!f.target;
  const ae = document.activeElement;
  if (box.contains(ae) && /^(INPUT|SELECT)$/.test(ae.tagName)) return;   // 入力中は描き直さない
  const seen = new Set();
  st.beacons.forEach(b => { if (b.ageMs <= 5000) seen.add(recLabelOf(b)); });
  const labels = one ? [f.target] : [...new Set([...seen, ...Object.keys(f.per || {})])].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
  const placeSig = labels.map(l => { const mb = mapBeacons().find(b => b.label === l); return mb ? mb.at.join() + (mb.moved ? 'm' : '') : '-'; });
  const sig = JSON.stringify([one, labels, [...seen], placeSig, !!pos, ...[f.andPos, f.andAt, f.iphH, f.andH, f.dist, f.iphDir, f.iphPlace].map(x => x || '')]);
  if (box.dataset.sig === sig) return;
  recReadPer();   // 描き直す前に、入力途中の値を取りこむ
  box.dataset.sig = sig;
  if (!labels.length) { box.innerHTML = '<p class="sub">受信中のビーコンがここに並び、ビーコンごとに実際の距離・向き・高さ・設置場所を入れられます。</p>'; return; }
  const v = (l, k) => esc(((f.per || {})[l] || {})[k] || '');
  // 図面の位置（ビーコンの配置）の行
  const placeLine = l => {
    const mb = mapBeacons().find(b => b.label === l);
    const where = mb ? `${esc(beaconPlace(mb))}${mb.moved ? '（移動済み）' : mb.custom ? '（自分で配置）' : ''}` : '図面に未配置';
    const canPlace = mb || recKeyOfLabel(l);
    return `<div class="perplace"><span>図面の位置：${where}</span>${canPlace ? `<button type="button" class="iconbtn" data-place="${esc(l)}">図面で置く</button>` : ''}${mb && mb.moved ? `<button type="button" class="iconbtn" data-unplace="${esc(l)}">元に戻す</button>` : ''}</div>`;
  };
  if (one) {
    box.innerHTML = `<p class="pertitle">ビーコンの配置</p><div class="perrow1"><b>${esc(f.target)}</b>${placeLine(f.target)}</div>`;
    return;
  }
  box.innerHTML = `<p class="pertitle">ビーコンごとの設定（iPhone ごとの条件・配置）</p><div class="perhead"><span>ビーコン</span><span>実際の距離(m)</span><span>iPhoneの向き</span><span>高さ(m)</span><span>設置場所</span></div>` + labels.map(l => {
    const auto = pos ? recTrueDist(f, pos.at, l) : null;
    const distIn = pos
      ? `<input disabled placeholder="${auto == null ? '—' : '自動 ' + auto.toFixed(1)}">`
      : `<input data-label="${esc(l)}" data-k="dist" type="number" inputmode="decimal" step="0.1" min="0" value="${v(l, 'dist')}" placeholder="${esc(f.dist || '共通')}">`;
    const dir = ((f.per || {})[l] || {}).dir || '';
    return `<div class="perrow${seen.has(l) ? '' : ' off'}"><b>${esc(l)}</b>${distIn}
      <select data-label="${esc(l)}" data-k="dir"><option value=""${dir ? '' : ' selected'}>共通（${esc(f.iphDir || '縦')}）</option><option${dir === '縦' ? ' selected' : ''}>縦</option><option${dir === '横' ? ' selected' : ''}>横</option></select>
      <input data-label="${esc(l)}" data-k="h" type="number" inputmode="decimal" step="0.1" min="0" value="${v(l, 'h')}" placeholder="${esc(f.iphH || '共通')}">
      <input data-label="${esc(l)}" data-k="place" value="${v(l, 'place')}" placeholder="${esc(f.iphPlace || '共通')}"></div>${placeLine(l)}`;
  }).join('') + `<p class="sub">空欄は上の共通の値を使います。灰色は今受信していないビーコン（前に入れた設定）です。「図面で置く」で、iPhone を実際に置いた場所を図面上で指定できます（現在地の計算・案内・実際の距離に使う）。</p>`;
}
// ラベル（B-xx・P-xx・Minor n）から、受信中のビーコンのキーを探す
function recKeyOfLabel(l) {
  const b = st.beacons.find(x => recLabelOf(x) === l);
  if (b) return b.key;
  const k = Object.keys(st.data.assign).find(k => st.data.assign[k].label === l);
  return k || null;
}
$('recPer').addEventListener('click', e => {
  const pb = e.target.closest('[data-place]');
  if (pb) {
    const l = pb.dataset.place;
    st.placing = { recBeacon: true, label: l, key: recKeyOfLabel(l) };
    show('plan');
    say(`${l}を置いた場所を、図面の上でタップしてください。`);
    return;
  }
  const ub = e.target.closest('[data-unplace]');
  if (ub) {
    delete st.data.moved[ub.dataset.unplace];
    refreshBeacons(); save(); estimate();
    $('recPer').dataset.sig = ''; renderRecPer(); renderRecPos();
    say(`${ub.dataset.unplace}を図面の元の位置に戻しました。`);
  }
});
// ミミナビの位置：B-xx（そのビーコンの図面上の位置）か、図面でタップした地点。指定すると実際の距離はビーコンごとに図面から計算する
function recPosOf(form) {
  const v = form.andPos;
  if (!v) return null;
  if (v === '@map') return Array.isArray(form.andAt) ? { label: `図面で指定（${form.andAt[0].toFixed(1)}, ${form.andAt[1].toFixed(1)}）`, at: form.andAt } : null;
  const mb = mapBeacons().find(b => b.label === v);
  return mb ? { label: v, at: mb.at } : null;
}
// ビーコンまでの実際の距離（図面上の距離。両方の高さがあれば高さの差も含める）
function recTrueDist(form, at, label) {
  const mb = mapBeacons().find(b => b.label === label);
  if (!at || !mb) return null;
  const h = dist(mb.at, at), ih = numOrNull(recEff(form, label).h), ah = numOrNull(form.andH);
  return ih != null && ah != null ? Math.hypot(h, ih - ah) : h;
}
function renderRecPos() {
  const sel = $('recPos'); if (document.activeElement === sel) return;
  const f = rec.form;
  let opts = `<option value="">指定しない（実際の距離を入力する）</option>`;
  opts += mapBeacons().map(b => `<option value="${esc(b.label)}">${esc(b.label)}：${esc(beaconPlace(b))}</option>`).join('');
  if (Array.isArray(f.andAt)) opts += `<option value="@map">図面で指定した地点（${f.andAt[0].toFixed(1)}, ${f.andAt[1].toFixed(1)}）</option>`;
  opts += `<option value="@tap">図面をタップして指定…</option>`;
  if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
  const pos = recPosOf(f);
  sel.value = pos ? f.andPos : '';
  const d = $('recForm').elements.dist;
  d.disabled = !!pos;
  d.placeholder = pos ? '自動（図面から計算）' : '例 1';
  if (pos) d.value = '';
}
$('recPos').addEventListener('change', e => {
  const v = e.target.value;
  if (v === '@tap') {
    e.target.blur();
    st.placing = { rec: true, label: 'ミミナビの位置' };
    show('plan');
    say('ミミナビを置いた場所を、図面の上でタップしてください。');
    return;
  }
  rec.form.andPos = v;
  recSave(); renderRecPos(); e.target.blur();
});
function recFillForm() {
  const f = $('recForm');
  REC_FIELDS.forEach(k => { if (f.elements[k] && k !== 'target' && k !== 'andPos' && rec.form[k] != null) f.elements[k].value = rec.form[k]; });
}
// 対象のビーコンの選択肢（受信中で図面に対応しているもの＋選択中のもの）
function renderRecTargets() {
  const sel = $('recTarget'); if (document.activeElement === sel) return;
  const labels = [...new Set([...seenByLabel().keys(), rec.form.target].filter(Boolean))].sort();
  const opts = `<option value="">受信中のすべて</option>` + labels.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
  if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
  sel.value = rec.form.target || '';
}
const recLabelOf = b => { const mb = beaconOf(b); return mb ? mb.label : `Minor ${b.minor}`; };
const REC_GAP_MS = 5000;   // 連続で記録するときの間
function recStart(rep) {
  if (rec.cur) return;
  rep = typeof rep === 'number' ? rep : 1;
  rec.next = null;
  if (rep === 1) recReadForm();
  const sec = Number(rec.form.sec) || 30, reps = Math.max(1, Number(rec.form.reps) || 1);
  const now = Date.now();
  const pos = recPosOf(rec.form);
  rec.cur = { startedAt: now, until: now + sec * 1000, sec, rep, reps, form: JSON.parse(JSON.stringify(rec.form)), pos, n: st.data.n, ticks: [], lastCount: {} };
  recSave();
  if (N) N.keepScreenOn(true);
  say(reps > 1 ? `${rep}回目の記録を始めます。${sec}秒です。` : `記録を始めます。${sec}秒です。端末を動かさないでください。`);
  renderRec();
}
function recStop(save) {
  if (!rec.cur && rec.next) {   // 連続記録の待ち時間に中止
    rec.next = null;
    if (N && !st.nav) N.keepScreenOn(false);
    say('連続の記録を中止しました。');
    renderRec(); return;
  }
  const cur = rec.cur; if (!cur) return;
  rec.cur = null;
  if (save) {
    const r = recBuild(cur);
    const more = cur.rep < cur.reps;
    if (r.beacons.length) {
      rec.list.push(r); recSave();
      const top = r.beacons[0];
      if (more) say(`${cur.rep}回目を記録しました。5秒後に${cur.rep + 1}回目を始めます。`);
      else say(`${cur.reps > 1 ? `${cur.reps}回の記録が終わりました。最後の回は、` : '記録しました。'}${top.label}、RSSIの平均は${Math.round(top.rssi.avg)}、推定距離は${top.dist.avg.toFixed(1)}メートルです。`);
    } else say(`ビーコンを受信できなかったため、記録しませんでした。${more ? '5秒後に次の回を始めます。' : ''}`);
    if (more) rec.next = { at: Date.now() + REC_GAP_MS, rep: cur.rep + 1, reps: cur.reps };
  } else {
    rec.next = null;
    say('記録を中止しました。');
  }
  if (N && !st.nav && !rec.next) N.keepScreenOn(false);
  renderRec();
}
// 0.5 秒ごとの記録
function recTick() {
  const cur = rec.cur; if (!cur) return;
  const now = Date.now();
  const tick = { walk: walkLabel(), steps: st.steps, head: mapHeading() == null ? null : Math.round(mapHeading()), t: now - cur.startedAt, pos: st.pos ? [r2(st.pos.x), r2(st.pos.y)] : null, rawPos: st.pos ? [r2(st.pos.raw[0]), r2(st.pos.raw[1])] : null, method: st.pos ? st.pos.method : '', room: st.room ? st.room.name : '', b: [] };
  st.beacons.forEach(b => {
    if (b.ageMs > 5000) return;
    const label = recLabelOf(b);
    if (cur.form.target && label !== cur.form.target) return;
    const mb = beaconOf(b);
    const A = mb ? txOf(mb.label) : DEFAULT_A;
    const d = mb ? distanceOf(b, mb.label) : Math.min(30, Math.max(0.1, Math.pow(10, (A - b.rssi) / (10 * cur.n))));
    const fresh = cur.lastCount[b.key] !== b.count;   // 前回から新しい受信があったか
    cur.lastCount[b.key] = b.count;
    tick.b.push({ label, minor: b.minor, rssi: r1(b.rssi), last: b.rssiLast, fresh, d: r2(d), A, cal: !!mb && typeof st.data.tx[mb.label] === 'number' });
  });
  cur.ticks.push(tick);
  if (now >= cur.until) recStop(true);
  else renderRecStatus();
}
// 記録をビーコンごとにまとめる
function recBuild(cur) {
  const by = new Map();
  cur.ticks.forEach(tk => tk.b.forEach(x => {
    if (!by.has(x.label)) by.set(x.label, { label: x.label, minor: x.minor, A: x.A, cal: x.cal, rssi: [], d: [], raw: [] });
    const g = by.get(x.label);
    g.rssi.push(x.rssi); g.d.push(x.d);
    if (x.fresh) g.raw.push(x.last);
  }));
  const beacons = [...by.values()].map(g => ({
    label: g.label, minor: g.minor, A: g.A, cal: g.cal, samples: g.rssi.length, received: g.raw.length,
    rssi: stats(g.rssi), dist: stats(g.d), raw: stats(g.raw),
    trueD: cur.pos ? recTrueDist(cur.form, cur.pos.at, g.label) : numOrNull(recEff(cur.form, g.label).dist),
    iphDir: recEff(cur.form, g.label).dir, iphH: numOrNull(recEff(cur.form, g.label).h), iphPlace: recEff(cur.form, g.label).place,
  })).sort((a, b) => a.label.localeCompare(b.label, 'ja', { numeric: true }));
  // 推定位置の平均とずれ（表示位置＝案内ルートに寄せた位置、計算位置＝寄せる前）
  const avgPos = key => { const a = cur.ticks.map(t => t[key]).filter(Boolean); return a.length ? [a.reduce((s, p) => s + p[0], 0) / a.length, a.reduce((s, p) => s + p[1], 0) / a.length] : null; };
  const shown = avgPos('pos'), calc = avgPos('rawPos');
  const position = cur.pos ? { label: cur.pos.label, at: cur.pos.at, shown, calc, err: shown ? dist(shown, cur.pos.at) : null, errCalc: calc ? dist(calc, cur.pos.at) : null } : null;
  const f = cur.form;
  const perKey = form => form.target ? '' : JSON.stringify(Object.keys(form.per || {}).sort().map(k => [k, form.per[k]]));
  const same = rec.list.filter(r => ['target', 'andPos', 'dist', 'iphPlace', 'andPlace', 'iphH', 'andH', 'iphDir', 'andDir', 'body', 'obst'].every(k => (r.form[k] || '') === (f[k] || '')) && perKey(r.form) === perKey(f)).length;
  rec.seq++;
  return {
    no: rec.seq, at: cur.startedAt, sec: r1((Math.min(Date.now(), cur.until) - cur.startedAt) / 1000), form: f, n: cur.n, round: same + 1,
    model: st.status && st.status.model ? st.status.model : '', ver: N && N.appVersion ? N.appVersion() : 'PC',
    beacons, ticks: cur.ticks, position,
  };
}
function renderRecStatus() {
  const el = $('recStatus');
  el.classList.toggle('on', !!(rec.cur || rec.next));
  if (rec.cur) {
    const left = Math.max(0, Math.ceil((rec.cur.until - Date.now()) / 1000));
    const labels = new Set(); rec.cur.ticks.forEach(t => t.b.forEach(x => labels.add(x.label)));
    el.textContent = `● 記録中${rec.cur.reps > 1 ? `（${rec.cur.rep}/${rec.cur.reps}回目）` : ''}　残り ${left} 秒　${rec.cur.ticks.length} 回分・ビーコン ${labels.size} 台`;
  } else if (rec.next) {
    el.textContent = `● 次の記録まで ${Math.max(0, Math.ceil((rec.next.at - Date.now()) / 1000))} 秒（${rec.next.rep}/${rec.next.reps}回目）`;
  } else el.textContent = rec.list.length ? `記録 ${rec.list.length} 件（ビーコンごとの結果 ${rec.list.reduce((a, r) => a + r.beacons.length, 0)} 行）` : 'まだ記録はありません。条件を入れて「記録を始める」を押してください。';
}
function renderRec() {
  const busy = !!(rec.cur || rec.next);
  $('recForm').classList.toggle('busy', busy);
  $('recStart').hidden = busy;
  $('recStop').hidden = !busy;
  $('nRange').disabled = busy;   // 記録中は n を変えない
  const has = rec.list.length > 0 && !busy;
  ['recExport', 'recExportRaw', 'recClear'].forEach(id => { $(id).hidden = !has; });
  renderRecStatus();
  renderRecTargets();
  renderRecPos();
  renderRecPer();
  $('recList').innerHTML = rec.list.slice().reverse().map(r => {
    const f = r.form, dist = numOrNull(f.dist), P = r.position;
    const lines = r.beacons.map(b => {
      const td = b.trueD !== undefined ? b.trueD : dist;
      const err = td == null ? '' : `　実際 ${td.toFixed(1)}m　誤差 ${(b.dist.avg - td >= 0 ? '+' : '')}${(b.dist.avg - td).toFixed(2)}m`;
      return `<span>${esc(b.label)}${b.iphDir ? `（${esc(b.iphDir)}）` : ''}：RSSI ${b.rssi.avg.toFixed(1)}（${b.rssi.min}〜${b.rssi.max}）／距離 ${b.dist.avg.toFixed(2)}m${err}</span>`;
    }).join('') + (P && P.err != null ? `<span>位置のずれ ${P.err.toFixed(2)}m（計算位置 ${P.errCalc.toFixed(2)}m）</span>` : '');
    const where = P ? `ミミナビ ${esc(P.label)}` : r.beacons.length > 1 ? `${r.beacons.length}台` : dist == null ? '距離未入力' : dist + 'm';
    return `<div class="prow"><div class="rtxt"><b>No.${r.no}</b>　${esc(fmtTime(r.at))}　${where}・Android ${esc(f.andDir || '')}${f.body ? '・体 ' + esc(f.body) : ''}・${esc(f.obst || '')}・${r.round}回目${lines}</div><button class="iconbtn" data-del-rec="${r.no}">消す</button></div>`;
  }).join('');
}
// ---- CSV
const csvCell = v => { if (v == null) return ''; const s = String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csvOf = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const REC_HEAD = ['項番', '測定日時', '測定回', 'iPhone設置場所', 'Android設置場所', '実際の距離(m)', 'iPhoneの高さ(m)', 'Androidの高さ(m)', 'iPhoneの向き', 'Androidの向き', '障害物',
  '減衰係数', '1m地点の値(dBm)', '1m値の種別', '対象ビーコン', 'RSSI最小値', 'RSSI平均値', 'RSSI最大値', '推定距離最小値', '推定距離平均値', '推定距離最大値', '測定時間(秒)', 'サンプル数',
  '距離誤差', '絶対誤差', '誤差率(%)', '備考', '生RSSI最小値', '生RSSI平均値', '生RSSI最大値', '受信回数', '受信端末', 'アプリ版', '記録No',
  'ミミナビの位置', 'ミミナビX(m)', 'ミミナビY(m)', '推定位置X(平均)', '推定位置Y(平均)', '位置のずれ(m)', '計算位置のずれ(m)', '体の向き'];
function recSummaryCsv() {
  const rows = [REC_HEAD];
  rec.list.forEach(r => r.beacons.forEach(b => {
    const f = r.form, P = r.position;
    const dist = b.trueD !== undefined ? (b.trueD == null ? null : r2(b.trueD)) : numOrNull(f.dist);
    const err = dist == null ? null : r2(b.dist.avg - dist);
    const has = k => b[k] !== undefined;   // 以前の記録にはビーコンごとの値がない
    rows.push([rows.length, fmtTime(r.at), r.round, has('iphPlace') ? b.iphPlace : f.iphPlace, f.andPlace, dist, has('iphH') ? b.iphH : numOrNull(f.iphH), numOrNull(f.andH),
      has('iphDir') ? b.iphDir : f.iphDir, f.andDir, f.obst,
      r.n, b.A, b.cal ? '補正' : '標準', b.label, b.rssi.min, r1(b.rssi.avg), b.rssi.max, b.dist.min, r2(b.dist.avg), b.dist.max, r.sec, b.samples,
      err, err == null ? null : Math.abs(err), err == null || !dist ? null : r1(Math.abs(err) / dist * 100), f.note,
      b.raw ? b.raw.min : null, b.raw ? r1(b.raw.avg) : null, b.raw ? b.raw.max : null, b.received, r.model, r.ver, r.no,
      P ? P.label : null, P ? r2(P.at[0]) : null, P ? r2(P.at[1]) : null, P && P.shown ? r2(P.shown[0]) : null, P && P.shown ? r2(P.shown[1]) : null,
      P && P.err != null ? r2(P.err) : null, P && P.errCalc != null ? r2(P.errCalc) : null, f.body]);
  }));
  return csvOf(rows);
}
function recRawCsv() {
  const rows = [['記録No', '測定日時', '経過(秒)', '対象ビーコン', 'Minor', 'RSSI(平均)', 'RSSI(最新の受信値)', '新しい受信', '推定距離(m)', '1m地点の値(dBm)', '減衰係数', '実際の距離(m)', '推定位置X(m)', '推定位置Y(m)', '測位方式', '今いる部屋', '計算位置X(m)', '計算位置Y(m)', 'ミミナビの位置', 'ミミナビX(m)', 'ミミナビY(m)', '歩行', '歩数', '向き(図面の上=0°)']];
  rec.list.forEach(r => r.ticks.forEach(tk => tk.b.forEach(x => {
    const P = r.position, td = P ? recTrueDist(r.form, P.at, x.label) : numOrNull(recEff(r.form, x.label).dist);
    rows.push([r.no, fmtTime(r.at + tk.t), r1(tk.t / 1000), x.label, x.minor, x.rssi, x.last, x.fresh ? 1 : 0, x.d, x.A, r.n, td == null ? null : r2(td),
      tk.pos ? tk.pos[0] : null, tk.pos ? tk.pos[1] : null, tk.method, tk.room, tk.rawPos ? tk.rawPos[0] : null, tk.rawPos ? tk.rawPos[1] : null,
      P ? P.label : null, P ? r2(P.at[0]) : null, P ? r2(P.at[1]) : null, tk.walk == null ? null : tk.walk, tk.steps == null ? null : tk.steps, tk.head == null ? null : tk.head]);
  })));
  return csvOf(rows);
}
function recExport(kind) {
  const d = new Date(), stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  const name = `miminavi_${kind === 'raw' ? '生データ' : '測定結果'}_${stamp}.csv`;
  const csv = kind === 'raw' ? recRawCsv() : recSummaryCsv();
  if (N && N.exportFile) { N.exportFile(name, csv); return; }
  // PC ブラウザ：ダウンロード（Excel で文字化けしないよう BOM 付き）
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function onExported(d) {
  if (d && d.ok) say('書き出しました。');
  else if (d && d.error && d.error !== 'キャンセルしました') say('書き出せませんでした。' + d.error);
}
// ビーコンの通知が止まっても、時間になったら記録を終える
setInterval(() => {
  if (rec.next && !rec.cur) { if (Date.now() >= rec.next.at) recStart(rec.next.rep); else renderRecStatus(); return; }
  if (!rec.cur) return;
  if (Date.now() >= rec.cur.until) recStop(true); else renderRecStatus();
}, 1000);
$('recForm').addEventListener('change', () => { recReadForm(); recSave(); renderRecPer(); });
$('recForm').addEventListener('submit', e => e.preventDefault());
$('recStart').onclick = () => recStart(1);
$('recStop').onclick = () => recStop(false);
$('recExport').onclick = () => recExport('summary');
$('recExportRaw').onclick = () => recExport('raw');
$('recClear').onclick = () => {
  if (!confirm(`記録 ${rec.list.length} 件をすべて消します。書き出していない記録は戻せません。よろしいですか？`)) return;
  rec.list = []; rec.seq = 0; recSave(); renderRec();
};
$('recList').addEventListener('click', e => {
  const b = e.target.closest('[data-del-rec]'); if (!b) return;
  const no = Number(b.dataset.delRec);
  if (!confirm(`No.${no} の記録を消します。よろしいですか？`)) return;
  rec.list = rec.list.filter(r => r.no !== no); recSave(); renderRec();
});

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
refreshBeacons();
recLoad();
recFillForm();
renderRec();
show('home');
if (MAP.warnings && MAP.warnings.length) console.warn('地図データの注意:', MAP.warnings);
if (N) {
  if (st.data.uuids.length) applyNativeFilter();
  N.startScan();
  setInterval(() => { if (!st.scanning) N.refreshStatus(); }, 3000);
} else {
  startMock();
}
// テスト用
window.__mimi = { pullToStrongest, proximity, decideNear, onStep, isWalking, pdrActive, stepOnLanes, stepOnPath, lanePathPts, laneAnchor, BEACONS, route, segments, matchDest, DESTS, ENTRY, st, startNav, doorsOnPath, atDest, roomAt, estimate, rec };
})();
