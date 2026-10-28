/* ミミナビ 画面ロジック
 * ネイティブ側（MainActivity.java）とは次の窓口でやりとりする：
 *   JS → ネイティブ : window.MimiNative.startScan() / speak() / listen() / save() など
 *   ネイティブ → JS : window.__native(type, data)  type = beacons | status | heading | speech
 * PC のブラウザで開いた場合は、疑似ビーコンで画面の動きを確認できる。
 */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const N = window.MimiNative || null;

// ------------------------------------------------------------ 事業所の図面
// 1マス = 0.6m。外壁の内側 14×12 マス ≒ 60m²（8.4m × 7.2m）
const CELL_M = 0.6;
const C = 20; // SVG 上の1マスの大きさ
const OFFICE = {
  name: '事業所',
  start: [1, 6], // 現在地が分からないときの出発点（入口付近）
  grid: [
    "################",
    "#..............#",
    "#..............#",
    "#..............#",
    "#..............#",
    "########.#######",
    "#........#.....#",
    "#........#.....#",
    "#..........#####",
    "########.#.....#",
    "#........#.....#",
    "#........#.....#",
    "#........#.....#",
    "################"],
  rooms: [
    { label: '事務所', x: 1, y: 1, w: 14, h: 4 },
    { label: '会議室(2)', x: 10, y: 6, w: 5, h: 2 },
    { label: '会議室(4)', x: 10, y: 9, w: 5, h: 4 },
    { label: '会議室(8)', x: 1, y: 10, w: 8, h: 3 },
  ],
  // デモで想定していたビーコン設置位置（入口＋各目的地）
  suggested: [[8, 6, '入口'], [8, 4, '事務所前'], [8, 8, '廊下'], [10, 7, '会議室(2)'], [10, 9, '会議室(4)'], [8, 10, '会議室(8)']],
  dests: [
    { id: 'r8', name: '会議室(8)', at: [8, 10], future: '会議室(8)：14時まで予約あり' },
    { id: 'r4', name: '会議室(4)', at: [10, 9], via: [[8, 6], [8, 8]], future: '会議室(4)：空き（次の予約は15時から）' },
    { id: 'r2', name: '会議室(2)', at: [10, 7], via: [[8, 6], [8, 8]], future: '会議室(2)：使用中（あと20分）' },
    { id: 'office', name: 'オフィス（事務所）', at: [8, 4] },
  ],
  samples: ['会議室(8)はどこ？', '会議室(4)に行きたい', '会議室(2)', '事務所は？'],
};
const W = OFFICE.grid[0].length, H = OFFICE.grid.length;
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // 図面の上・右・下・左
const DNAME = ['図面の上', '図面の右', '図面の下', '図面の左'];
const walkable = (x, y) => x >= 0 && y >= 0 && x < W && y < H && OFFICE.grid[y][x] !== '#';

// ------------------------------------------------------------ 状態
const st = {
  view: 'home', tab: 'guide', sound: true,
  status: null, beacons: [], others: 0, scanning: false,
  heading: null, pos: null, placing: null, nav: null,
  data: { placements: {}, n: 2.0, northOffset: null },
};

function load() {
  try {
    const raw = N ? N.load() : localStorage.getItem('miminavi');
    if (raw) Object.assign(st.data, JSON.parse(raw));
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
let guideView = 'home'; // 「案内」タブで最後に開いていた画面
$('tabbar').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (st.tab === 'guide') guideView = st.view;
  if (b.dataset.tab === 'guide') show(guideView);
  else show(b.dataset.tab);
});

// 端末の戻るボタン（true を返すとアプリ内で処理済み）
window.__back = () => {
  if (!$('dark').hidden) { $('dark').hidden = true; return true; }
  if (st.placing) { cancelPlacing(); return true; }
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

function onBeacons(d) {
  st.beacons = d.beacons || [];
  st.others = d.others || 0;
  st.scanning = !!d.scanning;
  estimate();
  renderChip();
  if (st.view === 'home') renderHomeKpi();
  if (st.view === 'beacons') renderBeacons();
  if (st.view === 'plan') renderPlan(false);
  if (st.view === 'nav') { updateDyn($('navMap')); navRealUpdate(); }
}

// ------------------------------------------------------------ 距離と位置の推定
function distanceOf(b) {
  const p = st.data.placements[b.key];
  const tx = p && typeof p.tx === 'number' ? p.tx : b.tx;
  const d = Math.pow(10, (tx - b.rssi) / (10 * st.data.n));
  return Math.min(30, Math.max(0.1, d));
}
const cellCenterM = (x, y) => [(x + 0.5) * CELL_M, (y + 0.5) * CELL_M];

function estimate() {
  const used = st.beacons
    .filter(b => st.data.placements[b.key] && b.ageMs < 5000)
    .map(b => ({ b, p: st.data.placements[b.key], d: distanceOf(b) }))
    .sort((a, c) => a.d - c.d)
    .slice(0, 4); // 近い順に最大4台
  if (!used.length) { st.pos = null; return; }
  let sx = 0, sy = 0, sw = 0;
  used.forEach(u => {
    const w = 1 / Math.pow(Math.max(u.d, 0.3), 2);
    const [mx, my] = cellCenterM(u.p.x, u.p.y);
    sx += w * mx; sy += w * my; sw += w;
  });
  let x = sx / sw, y = sy / sw;
  if (st.pos) { // 揺れを抑えるため前回値となめらかにつなぐ
    x = st.pos.x + 0.4 * (x - st.pos.x);
    y = st.pos.y + 0.4 * (y - st.pos.y);
  }
  st.pos = { x, y, acc: used[0].d, used, cell: snapCell(x / CELL_M - 0.5, y / CELL_M - 0.5) };
}
function snapCell(fx, fy) {
  let best = null, bd = 1e9;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!walkable(x, y)) continue;
    const d = (x - fx) ** 2 + (y - fy) ** 2;
    if (d < bd) { bd = d; best = [x, y]; }
  }
  return best;
}
function placeName(x, y) {
  const s = OFFICE.suggested.find(q => q[0] === x && q[1] === y);
  if (s) return s[2];
  const r = OFFICE.rooms.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  return r ? r.label : '通路';
}

// ------------------------------------------------------------ 図面の描画
function buildMap(el, opt = {}) {
  let s = `<svg viewBox="0 0 ${W * C} ${H * C}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="事業所の図面">`;
  s += `<rect width="${W * C}" height="${H * C}" fill="var(--floor)"/>`;
  OFFICE.grid.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch !== '#') return;
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
    s += `<rect x="${x * C}" y="${y * C}" width="${C}" height="${C}" fill="${edge ? 'var(--slate)' : 'var(--shelf)'}" ${edge ? 'opacity=".85"' : ''}/>`;
  }));
  OFFICE.rooms.forEach(r => {
    s += `<text x="${(r.x + r.w / 2) * C}" y="${(r.y + r.h / 2) * C + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--muted)" opacity=".75" font-family="var(--f-display)">${r.label}</text>`;
  });
  OFFICE.suggested.forEach(([x, y]) => {
    s += `<circle cx="${(x + .5) * C}" cy="${(y + .5) * C}" r="7" fill="none" stroke="var(--teal)" stroke-width="1.2" stroke-dasharray="2.5 2.5" opacity=".7"/>`;
  });
  if (opt.path) {
    const pts = opt.path.map(p => `${(p[0] + .5) * C},${(p[1] + .5) * C}`).join(' ');
    s += `<polyline points="${pts}" fill="none" stroke="var(--teal)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity=".35"/>`;
    s += `<polyline class="walked" points="" fill="none" stroke="var(--teal)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (opt.dest) {
    const [dx, dy] = opt.dest.at;
    s += `<g transform="translate(${(dx + .5) * C} ${(dy + .5) * C})"><path d="M0 4 C-6 -4 -8 -7 -8 -11 a8 8 0 0 1 16 0 c0 4 -2 7 -8 15z" fill="var(--coral)"/><circle cy="-11" r="3" fill="#fff"/></g>`;
  }
  s += `<g class="dyn"></g>`;
  if (opt.path) s += `<g class="me" transform="translate(-100 -100)"><circle r="13" fill="var(--coral)" opacity=".18"/><path d="M0 -9 L7 7 L0 3 L-7 7 Z" fill="var(--coral)" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></g>`;
  s += `<text x="${W * C - 6}" y="${H * C - 6}" text-anchor="end" font-family="var(--f-mono)" font-size="9" fill="#fff">1マス=${CELL_M}m</text></svg>`;
  el.innerHTML = s;
  el.dataset.nav = opt.path ? '1' : '';
  updateDyn(el);
}

function updateDyn(el) {
  const g = el.querySelector('.dyn'); if (!g) return;
  const seen = new Map(st.beacons.filter(b => b.ageMs < 5000).map(b => [b.key, b]));
  const usedKeys = new Set(st.pos ? st.pos.used.map(u => u.b.key) : []);
  let s = '';
  Object.entries(st.data.placements).forEach(([key, p]) => {
    const b = seen.get(key);
    const cx = (p.x + .5) * C, cy = (p.y + .5) * C;
    if (b) {
      const d = distanceOf(b);
      const rr = Math.min(d / CELL_M * C, W * C); // 推定距離の円
      if (usedKeys.has(key)) s += `<circle cx="${cx}" cy="${cy}" r="${rr.toFixed(1)}" fill="none" stroke="var(--teal)" stroke-width="1" opacity=".35"/>`;
      s += `<circle cx="${cx}" cy="${cy}" r="6.5" fill="var(--teal)"/>`;
    } else {
      s += `<circle cx="${cx}" cy="${cy}" r="5.5" fill="var(--gray)"/>`;
    }
    s += `<text x="${cx}" y="${cy - 10}" text-anchor="middle" font-family="var(--f-mono)" font-size="8.5" fill="var(--ink)">${esc(p.label)}</text>`;
  });
  // 案内中（デモ歩行以外）は矢印マーカーで現在地を示すので、図面タブだけ点で描く
  if (st.pos && !(el.dataset.nav === '1')) {
    const px = st.pos.x / CELL_M * C, py = st.pos.y / CELL_M * C;
    const ar = Math.max(6, Math.min(st.pos.acc, 4) / CELL_M * C);
    s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${ar.toFixed(1)}" fill="var(--coral)" opacity=".15"/>`;
    s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="7" fill="var(--coral)" stroke="#fff" stroke-width="2"/>`;
  }
  if (st.placing && el.id === 'planMap') {
    s += `<rect x="1" y="1" width="${W * C - 2}" height="${H * C - 2}" fill="none" stroke="var(--coral)" stroke-width="3" stroke-dasharray="8 5" rx="4"/>`;
  }
  g.innerHTML = s;
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ------------------------------------------------------------ ホーム
function renderHome() {
  $('dlname').textContent = `簡易マップ：事業所（${(14 * CELL_M).toFixed(1)}m × ${(12 * CELL_M).toFixed(1)}m・約60m²）`;
  renderStatus(); renderHomeKpi();
}
function renderHomeKpi() {
  const placed = Object.keys(st.data.placements);
  const seen = st.beacons.filter(b => b.ageMs < 5000 && st.data.placements[b.key]).length;
  $('kPlaced').textContent = placed.length;
  $('kSeen').textContent = seen;
  $('kPos').textContent = st.pos
    ? `現在地：${placeName(st.pos.cell[0], st.pos.cell[1])} 付近（誤差 約${st.pos.acc.toFixed(1)}m）`
    : placed.length ? '現在地：配置したビーコンを受信していません' : '現在地：まず「ビーコン」タブで iPhone を図面に配置してください';
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
  const n = st.beacons.filter(b => b.ageMs < 5000).length;
  if (scanning) { c.textContent = `BLE 受信中・ビーコン${n}台`; c.className = 'chip'; }
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

// ------------------------------------------------------------ 行き先の入力
function toListen() {
  show('listen');
  $('transcript').innerHTML = '行き先を話してください<small>マイクを押して話すか、下の例を押してください</small>';
  $('samples').innerHTML = OFFICE.samples.map(s => `<button type="button">${s}</button>`).join('');
}
$('samples').addEventListener('click', e => { if (e.target.tagName === 'BUTTON') hear([e.target.textContent]); });
$('mic').onclick = () => {
  if (N) {
    hush();
    $('mic').classList.add('on');
    $('transcript').innerHTML = '聞き取り中…<small>&nbsp;</small>';
    N.listen();
  } else {
    hear([OFFICE.samples[Math.floor(Math.random() * OFFICE.samples.length)]]);
  }
};
function onSpeech(list) {
  $('mic').classList.remove('on');
  if (list === null) { $('transcript').innerHTML = '音声認識を使えません<small>この端末に音声入力アプリがありません。文字で入力してください</small>'; return; }
  if (!list.length) { $('transcript').innerHTML = '聞き取れませんでした<small>もう一度マイクを押してください</small>'; return; }
  hear(list);
}
$('typed').addEventListener('submit', e => { e.preventDefault(); const q = $('q').value.trim(); if (q) hear([q]); $('q').value = ''; $('q').blur(); });
$('backHome').onclick = () => { stopNav(); show('home'); };

function normalize(t) {
  return t.normalize('NFKC').toLowerCase().replace(/\s/g, '')
    .replace(/八|はち/g, '8').replace(/四|よん/g, '4').replace(/二/g, '2');
}
function matchDest(text) {
  const t = normalize(text);
  let m = t.match(/会議室\(?([248])/) || t.match(/([248])番?(の)?会議室/) || t.match(/かいぎしつ\(?([248])/)
    || (/会議|かいぎ/.test(t) && t.match(/([248])/)); // 「かいぎ室8番」など認識結果の揺れ
  if (m) return OFFICE.dests.find(d => d.id === 'r' + m[1]);
  if (/事務所|オフィス|じむしょ/.test(t)) return OFFICE.dests.find(d => d.id === 'office');
  return null;
}
function hear(candidates) {
  $('mic').classList.remove('on');
  let dest = null, heard = candidates[0];
  for (const c of candidates) { const d = matchDest(c); if (d) { dest = d; heard = c; break; } }
  if (!dest) {
    $('transcript').innerHTML = `「${esc(heard)}」<small>見つかりませんでした。例：会議室(8)、事務所</small>`;
    say('すみません、見つかりませんでした。もう一度お話しください。');
    return;
  }
  $('transcript').innerHTML = `${esc(dest.name)}<small>「${esc(heard)}」→ 目的地を特定しました</small>`;
  say(`${dest.name}ですね。ルートを計算します。`);
  setTimeout(() => startNav(dest), 1100);
}

// ------------------------------------------------------------ ルート探索（曲がる回数が少ない最短ルート）
function route(s, g) {
  const INF = 1e9, dist = new Map(), prev = new Map();
  const key = (x, y, d) => x + ',' + y + ',' + d; const pq = [];
  for (let d = 0; d < 4; d++) { dist.set(key(s[0], s[1], d), 0); pq.push([0, s[0], s[1], d]); }
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]); const [c, x, y, d] = pq.shift();
    if (c > (dist.get(key(x, y, d)) ?? INF)) continue;
    if (x === g[0] && y === g[1]) {
      const path = [[x, y]]; let k = key(x, y, d);
      while (prev.has(k)) { const p = prev.get(k); path.unshift([p[0], p[1]]); k = key(...p); }
      return path.filter((q, i) => i === 0 || q[0] !== path[i - 1][0] || q[1] !== path[i - 1][1]);
    }
    for (let nd = 0; nd < 4; nd++) {
      const nx = x + DIRS[nd][0], ny = y + DIRS[nd][1];
      if (!walkable(nx, ny)) continue;
      const nc = c + 1 + (nd !== d ? 0.6 : 0); const k = key(nx, ny, nd);
      if (nc < (dist.get(k) ?? INF)) { dist.set(k, nc); prev.set(k, [x, y, d]); pq.push([nc, nx, ny, nd]); }
    }
  }
  return null;
}
const dirOf = (a, b) => DIRS.findIndex(d => d[0] === b[0] - a[0] && d[1] === b[1] - a[1]);
function segments(path) {
  const segs = [];
  for (let i = 1; i < path.length; i++) {
    const d = dirOf(path[i - 1], path[i]);
    if (segs.length && segs[segs.length - 1].d === d) segs[segs.length - 1].n++;
    else segs.push({ d, n: 1, startIdx: i - 1 });
  }
  return segs;
}
function turnWord(d1, d2) { const diff = (d2 - d1 + 4) % 4; return diff === 1 ? '右' : diff === 3 ? '左' : diff === 2 ? '後ろ' : '直進'; }
const meters = cells => Math.max(1, Math.round(cells * CELL_M));      // 読み上げ用
const metersTxt = cells => (cells * CELL_M).toFixed(1) + 'm';          // 画面表示用

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
  const from = st.pos ? st.pos.cell : OFFICE.start;
  const pts = st.pos ? [from, dest.at] : [OFFICE.start, ...(dest.via || []), dest.at];
  let path = [];
  for (let j = 1; j < pts.length; j++) {
    const part = route(pts[j - 1], pts[j]);
    if (!part) { say('ルートが見つかりませんでした。'); return; }
    path = path.length ? path.concat(part.slice(1)) : part;
  }
  show('nav');
  if (N) N.keepScreenOn(true);
  if (path.length < 2) { arrive(dest); return; }
  const segs = segments(path);
  const nav = st.nav = { dest, path, segs, idx: 0, spoken: new Set(), off: 0, paused: false, sim: !st.pos, timer: null };
  buildMap($('navMap'), { path, dest });
  placeMe(path[0], segs[0].d);
  $('pauseBtn').textContent = '一時停止';
  $('simBtn').setAttribute('aria-pressed', nav.sim);
  updateSrcChip();
  const total = path.length - 1;
  $('remain').textContent = `残り ${metersTxt(total)}`;

  // 最初の一言：方角合わせ済みなら「右を向いて」など体の向き基準で伝える
  const first = segs[0];
  let lead = `${DNAME[first.d]}方向に`;
  if (st.heading != null && st.data.northOffset != null) {
    const mapHead = (st.heading - st.data.northOffset + 360) % 360;
    const diff = ((first.d * 90 - mapHead + 540) % 360) - 180;
    const w = Math.abs(diff) < 45 ? '正面' : diff > 0 && diff < 135 ? '右' : diff < 0 && diff > -135 ? '左' : '後ろ';
    lead = w === '正面' ? '正面に' : `${w}を向いて、`;
  }
  setInstr('直進', `約${metersTxt(first.n)} まっすぐ`, '直進');
  say(`${opts.reroute ? 'ルートを再計算しました。' : ''}${dest.name}まで、約${meters(total)}メートル。${lead}まっすぐ約${meters(first.n)}メートル進みます。`);
  if (nav.sim) nav.timer = setTimeout(simTick, 4200);
}

function updateSrcChip() {
  const c = $('srcChip'); if (!st.nav) return;
  if (st.nav.sim) { c.textContent = 'デモ歩行'; c.className = 'chip warn'; }
  else if (st.pos) { c.textContent = `BLE 屋内測位（${st.pos.used.length}台）`; c.className = 'chip'; }
  else { c.textContent = 'BLE 受信待ち'; c.className = 'chip off'; }
}

function placeMe(cell, d) {
  const g = $('navMap').querySelector('.me'); if (!g) return;
  g.setAttribute('transform', `translate(${(cell[0] + .5) * C} ${(cell[1] + .5) * C}) rotate(${d * 90})`);
}
function placeMeAt(xm, ym, d) {
  const g = $('navMap').querySelector('.me'); if (!g) return;
  g.setAttribute('transform', `translate(${(xm / CELL_M * C).toFixed(1)} ${(ym / CELL_M * C).toFixed(1)}) rotate(${d * 90})`);
}

// path[i] に着いたときの案内
function eventAt(i) {
  const nav = st.nav, segs = nav.segs, last = nav.path.length - 1;
  if (i >= last) return { arrive: true };
  const si = segs.findIndex(sg => i > sg.startIdx && i <= sg.startIdx + sg.n);
  const sg = segs[si], next = segs[si + 1], toEnd = sg.startIdx + sg.n - i;
  if (next && toEnd === 0) {
    const w = turnWord(sg.d, next.d);
    return { si, key: 'turn' + si, word: w, sub: `${w}へ曲がって、約${metersTxt(next.n)}`, icon: w, speech: `${w}に曲がります。その先、約${meters(next.n)}メートル直進です。` };
  }
  if (next && toEnd <= 3 && sg.n >= 5) {
    const w = turnWord(sg.d, next.d);
    return { si, key: 'pre' + si, word: w, sub: `${metersTxt(toEnd)}先で${w}へ`, icon: w, speech: `まもなく、${w}です。` };
  }
  if (!next && toEnd <= 3) return { si, key: 'near', word: '直進', sub: `${metersTxt(toEnd)}先が目的地`, icon: '直進', speech: 'まもなく目的地です。' };
  return { si, word: '直進', sub: `約${metersTxt(toEnd)} まっすぐ`, icon: '直進' };
}

// 進み具合を j まで進める。読み上げたら true
function advance(j) {
  const nav = st.nav; if (!nav || j <= nav.idx) return false;
  let shown = null, spoken = null;
  for (let i = nav.idx + 1; i <= j; i++) {
    const ev = eventAt(i);
    if (ev.arrive) { nav.idx = i; arrive(nav.dest); return true; }
    shown = ev;
    if (ev.speech && !nav.spoken.has(ev.key)) { nav.spoken.add(ev.key); spoken = ev; }
  }
  nav.idx = j;
  const p = nav.path[j];
  const sg = nav.segs[Math.max(0, (spoken || shown).si)];
  if (nav.sim) placeMe(p, sg.d);
  const walked = $('navMap').querySelector('.walked');
  if (walked) walked.setAttribute('points', nav.path.slice(0, j + 1).map(q => `${(q[0] + .5) * C},${(q[1] + .5) * C}`).join(' '));
  $('remain').textContent = `残り ${metersTxt(nav.path.length - 1 - j)}`;
  const ev = spoken || shown;
  setInstr(ev.word, ev.sub, ev.icon);
  if (spoken) say(spoken.speech);
  return !!spoken;
}

function simTick() {
  const nav = st.nav; if (!nav || !nav.sim) return;
  if (nav.paused) { nav.timer = setTimeout(simTick, 300); return; }
  const spoke = advance(nav.idx + 1);
  if (st.nav === nav) nav.timer = setTimeout(simTick, spoke ? 2100 : 700);
}

// ビーコンで推定した現在地から進み具合を更新する
function navRealUpdate() {
  const nav = st.nav; if (!nav || nav.sim || nav.paused) return;
  updateSrcChip();
  if (!st.pos) return;
  const seg = nav.segs[Math.min(nav.segs.length - 1, Math.max(0, nav.segs.findIndex(sg => nav.idx >= sg.startIdx && nav.idx < sg.startIdx + sg.n)))];
  placeMeAt(st.pos.x, st.pos.y, seg ? seg.d : 0);

  // 目的地に置いたビーコンのすぐそば（約1m以内）なら到着
  const [gx, gy] = nav.dest.at;
  for (const b of st.beacons) {
    const p = st.data.placements[b.key];
    if (p && Math.abs(p.x - gx) <= 1 && Math.abs(p.y - gy) <= 1 && b.ageMs < 3000 && b.samples >= 2 && distanceOf(b) < 1.0) {
      advance(nav.path.length - 1); return;
    }
  }
  // ルート上でいちばん近い地点を探す（少しの後戻りは許容）
  const [cx, cy] = st.pos.cell;
  let bj = nav.idx, bd = 1e9;
  for (let j = Math.max(0, nav.idx - 2); j < nav.path.length; j++) {
    const d = Math.hypot(nav.path[j][0] - cx, nav.path[j][1] - cy);
    if (d < bd - 1e-6) { bd = d; bj = j; }
  }
  if (bd <= 2.5) {
    nav.off = 0;
    if (bj > nav.idx) advance(bj);
  } else if (++nav.off >= 6) { // 約3秒続けて外れていたら引き直す
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
  say(`目的地、${dest.name}に到着しました。`);
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
  if (nav.sim) { placeMe(nav.path[nav.idx], 0); nav.timer = setTimeout(simTick, 500); }
};
$('eyesBtn').onclick = () => { $('dark').hidden = false; };
$('darkOff').onclick = () => { $('dark').hidden = true; };
$('stopBtn').onclick = () => { stopNav(); $('dark').hidden = true; say('案内を終了しました。'); toListen(); };
$('again').onclick = toListen;
$('doneHome').onclick = () => show('home');

// ------------------------------------------------------------ 図面タブ
let placedSig = '';
function renderPlan(full) {
  const el = $('planMap');
  if (full || !el.querySelector('svg')) buildMap(el, {});
  else updateDyn(el);
  $('planSize').textContent = `${(14 * CELL_M).toFixed(1)}m × ${(12 * CELL_M).toFixed(1)}m`;
  $('planPos').textContent = st.pos
    ? `x ${st.pos.x.toFixed(1)}m, y ${st.pos.y.toFixed(1)}m（${placeName(st.pos.cell[0], st.pos.cell[1])}付近・誤差 約${st.pos.acc.toFixed(1)}m）`
    : '—（配置済みビーコンを受信していません）';
  $('planUsed').textContent = st.pos ? st.pos.used.map(u => `${u.p.label} ${u.d.toFixed(1)}m`).join(' / ') : '—';
  $('placingBar').hidden = !st.placing;
  if (st.placing) $('placingName').textContent = st.placing.label;

  const seen = new Set(st.beacons.filter(b => b.ageMs < 5000).map(b => b.key));
  const entries = Object.entries(st.data.placements).sort((a, b) => a[1].label.localeCompare(b[1].label));
  const sig = entries.map(([k, p]) => k + p.x + p.y + seen.has(k)).join('|');
  if (!full && sig === placedSig) return;
  placedSig = sig;
  $('placedList').innerHTML = entries.length ? entries.map(([k, p]) =>
    `<div class="prow"><i class="lg ${seen.has(k) ? 'teal' : 'gray'}"></i><b>${esc(p.label)}</b><span class="grow">${esc(placeName(p.x, p.y))}（${p.x},${p.y}）・${esc(shortId(k))}</span><button class="iconbtn" data-del="${esc(k)}">外す</button></div>`).join('')
    : '<p class="sub">まだありません。「ビーコン」タブで受信中の iPhone を選び、「図面に配置」を押してください。</p>';
}
$('placedList').addEventListener('click', e => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  delete st.data.placements[b.dataset.del]; save(); estimate(); renderPlan(true);
});
$('planMap').addEventListener('click', e => {
  if (!st.placing) return;
  const svg = $('planMap').querySelector('svg'); if (!svg) return;
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  let cell = [Math.floor(p.x / C), Math.floor(p.y / C)];
  if (!walkable(cell[0], cell[1])) cell = snapCell(p.x / C - .5, p.y / C - .5);
  const old = st.data.placements[st.placing.key] || {};
  st.data.placements[st.placing.key] = { ...old, x: cell[0], y: cell[1], label: st.placing.label };
  save();
  const label = st.placing.label;
  st.placing = null;
  estimate();
  renderPlan(true);
  say(`${label}を、${placeName(cell[0], cell[1])}に配置しました。`);
});
function cancelPlacing() { st.placing = null; renderPlan(true); }
$('placingCancel').onclick = cancelPlacing;

function nextLabel() {
  const used = new Set(Object.values(st.data.placements).map(p => p.label));
  for (let i = 1; ; i++) { const l = 'B-' + String(i).padStart(2, '0'); if (!used.has(l)) return l; }
}

// ------------------------------------------------------------ ビーコンタブ
function shortId(key) {
  const parts = key.split(':');
  if (parts[0] === 'Eddystone') return `NS …${parts[1].slice(-4)} / ${parts[2].slice(-4)}`;
  return `UUID …${parts[1].slice(-4)} / ${parts[2]}-${parts[3]}`;
}
function displayName(b) {
  const p = st.data.placements[b.key];
  if (p) return p.label;
  if (b.type === 'Eddystone') return 'Eddystone ' + (b.instance || '').slice(-4);
  return `Major ${b.major} / Minor ${b.minor}`;
}
const rows = new Map();
function renderBeacons() {
  const list = $('beaconList');
  $('otherChip').textContent = `他のBLE機器 ${st.others}台`;
  const s = st.status;
  const warn = $('beaconWarn');
  let w = '';
  if (s && !s.permission) w = 'Bluetooth・位置情報の権限が許可されていません。ホームの「権限を許可する」を押してください。';
  else if (s && !s.bluetooth) w = 'Bluetooth がオフです。';
  else if (s && !s.location) w = '端末の位置情報がオフです。オンにしないとビーコンを受信できない機種があります。';
  else if (!st.scanning && N) w = 'スキャンが止まっています。ホームの「スキャン開始」を押してください。';
  warn.hidden = !w; warn.textContent = w;
  $('nRange').value = st.data.n; $('nVal').textContent = Number(st.data.n).toFixed(1);

  const sorted = [...st.beacons].sort((a, b) => b.rssi - a.rssi);
  if (!sorted.length) {
    rows.clear();
    list.innerHTML = `<p class="sub">ビーコンを探しています…（他のBLE機器は ${st.others}台受信）<br>iPhone の Beacon Simulator で iBeacon の送信を開始してください。</p>`;
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
        <div class="bbtns"><button class="iconbtn" data-act="place">図面に配置</button><button class="iconbtn" data-act="cal">1mで補正</button></div>`;
      rows.set(b.key, el);
    }
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
    const p = st.data.placements[b.key];
    el.classList.toggle('placed', !!p);
    el.classList.toggle('stale', b.ageMs > 3000);
    el.querySelector('.name').textContent = displayName(b) + (p ? `（${placeName(p.x, p.y)}）` : '');
    el.querySelector('.btype').textContent = b.type;
    el.querySelector('.bmeta').textContent = b.type === 'Eddystone'
      ? `NS ${b.uuid} / ${b.instance}`
      : `${b.uuid}  Major ${b.major} / Minor ${b.minor}  1m: ${p && typeof p.tx === 'number' ? p.tx + '（補正）' : b.tx} dBm`;
    el.querySelector('.r').textContent = Math.round(b.rssi);
    el.querySelector('.d').textContent = distanceOf(b).toFixed(1);
    el.querySelector('.rssi i').style.width = Math.max(4, Math.min(100, (b.rssi + 100) * 1.6)) + '%';
    el.querySelector('[data-act="place"]').textContent = p ? '配置を変更' : '図面に配置';
  });
}
$('beaconList').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const key = btn.closest('.bcard').dataset.key;
  const b = st.beacons.find(x => x.key === key); if (!b) return;
  if (btn.dataset.act === 'place') {
    const p = st.data.placements[key];
    st.placing = { key, label: p ? p.label : nextLabel() };
    show('plan');
  } else if (btn.dataset.act === 'cal') {
    const p = st.data.placements[key];
    if (!p) { say('先に図面に配置してください。'); return; }
    p.tx = Math.round(b.rssi); save();
    say(`${p.label}の1メートル地点の強さを、${p.tx}デシベルにしました。`);
    renderBeacons();
  }
});
$('nRange').addEventListener('input', e => { st.data.n = Number(e.target.value); $('nVal').textContent = st.data.n.toFixed(1); save(); });

// ------------------------------------------------------------ PC ブラウザ用の疑似データ
function startMock() {
  const fake = [
    { minor: 1, base: -58 }, { minor: 2, base: -66 }, { minor: 3, base: -72 }, { minor: 4, base: -80 },
  ];
  st.status = { permission: true, bluetooth: true, location: true, scanning: true, tts: true, error: '', model: 'PC ブラウザ（疑似データ）' };
  let t = 0;
  setInterval(() => {
    t++;
    const beacons = fake.map(f => ({
      key: `iBeacon:E2C56DB5-DFFB-48D2-B060-D0F5A71096E0:1:${f.minor}`, type: 'iBeacon',
      uuid: 'E2C56DB5-DFFB-48D2-B060-D0F5A71096E0', major: 1, minor: f.minor, tx: -59,
      rssi: f.base + Math.sin(t / 5 + f.minor) * 3, rssiLast: f.base, samples: 6, ageMs: 200, count: t,
    }));
    window.__native('beacons', { scanning: true, others: 17, beacons });
  }, 500);
  window.__native('status', st.status);
}

// ------------------------------------------------------------ 起動
load();
show('home');
if (N) {
  N.startScan(); // 初回は権限の確認ダイアログが出る
  setInterval(() => { if (!st.scanning) N.refreshStatus(); }, 3000);
} else {
  startMock();
}
})();
