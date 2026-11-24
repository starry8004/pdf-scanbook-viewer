// PDF 스캔북 뷰어 — pdf.js 렌더링 + 만화리더식 UX (한쪽/두쪽/연속, RTL, 여백자르기, 진도저장)
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

// ───────────────────────── helpers ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const idb = (() => {
  let dbp;
  const open = () => dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('pdf-viewer', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)) };
})();

// ───────────────────────── DOM ─────────────────────────
const stage = $('#stage'), welcome = $('#welcome'), pageInput = $('#pageInput'), pageTotal = $('#pageTotal');
const zoomLabel = $('#zoomLabel'), titleEl = $('#title'), toastEl = $('#toast'), helpEl = $('#help');
const progressEl = $('#progress'), progressFill = $('#progressFill'), thumbPane = $('#thumbPane');
const libList = $('#libList'), recentList = $('#recentList'), libHint = $('#libHint'), libSearch = $('#libSearch');
const loadingEl = $('#loading'), loadingText = $('#loadingText'), fltPanel = $('#fltPanel');

// ───────────────────────── state ─────────────────────────
const ACTUAL = 96 / 72, PAD = 8, GAP = 12, FULL = { x: 0, y: 0, w: 1, h: 1 };
const prefs = Object.assign({ invert: false, brightness: 100, contrast: 100, sideOpen: false, sideTab: 'library' }, LS.get('pv.prefs', {}));
const savePrefs = () => LS.set('pv.prefs', prefs);
const BOOK_FIELDS = ['page', 'mode', 'cover', 'rtl', 'crop', 'fit', 'zoom', 'rot'];
const bookDefaults = () => Object.assign({ page: 0, mode: 'single', cover: true, rtl: false, crop: false, fit: 'page', zoom: 1, rot: 0 }, LS.get('pv.defaults', {}), { page: 0, zoom: 1, rot: 0 });

let doc = null, loadingTask = null, numPages = 0, book = null, bookKey = '', bookName = '';
let docGen = 0, geomGen = 0, viewToken = 0, view = null;
let estBox = { w: 595, h: 842 };
const boxCache = new Map(), boxPending = new Map(), cropCache = new Map(), canvasCache = new Map();

const keyOf = name => 'pv.book:' + name.toLowerCase();

// ───────────────────────── render queue ─────────────────────────
const queue = [], inflight = new Map();
let busy = false;
function schedule(key, prio, idx, fn) {
  const ex = inflight.get(key);
  if (ex) { ex.prio = Math.min(ex.prio, prio); return ex.promise; }
  let res, rej;
  const promise = new Promise((a, b) => { res = a; rej = b; });
  const job = { key, prio, idx, fn, res, rej, promise, gen: docGen };
  inflight.set(key, job); queue.push(job); pump();
  return promise;
}
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    queue.sort((a, b) => a.prio - b.prio);
    const job = queue.shift();
    if (job.gen !== docGen) { inflight.delete(job.key); job.rej(new Error('stale')); continue; }
    try { job.res(await job.fn()); } catch (e) { job.rej(e); }
    inflight.delete(job.key);
  }
  busy = false;
}
function dropQueued(pred) {
  for (let i = queue.length - 1; i >= 0; i--) {
    const j = queue[i];
    if (pred(j)) { queue.splice(i, 1); inflight.delete(j.key); j.rej(new Error('drop')); }
  }
}

// ───────────────────────── geometry & crop ─────────────────────────
async function pageAndRot(idx) {
  const page = await doc.getPage(idx + 1);
  return { page, rot: (page.rotate + book.rot) % 360 };
}

function getBox(idx) {
  if (boxCache.has(idx)) return Promise.resolve(boxCache.get(idx));
  if (boxPending.has(idx)) return boxPending.get(idx);
  const gg = geomGen;
  const p = (async () => {
    const { page, rot } = await pageAndRot(idx);
    const vp = page.getViewport({ scale: 1, rotation: rot });
    const crop = book.crop ? await detectCrop(idx) : FULL;
    const box = { w: vp.width * crop.w, h: vp.height * crop.h };
    if (gg === geomGen) { boxCache.set(idx, box); estBox = box; }
    return box;
  })();
  boxPending.set(idx, p);
  p.catch(() => {}).finally(() => { if (boxPending.get(idx) === p) boxPending.delete(idx); });
  return p;
}

async function detectCrop(idx) {
  const key = idx + '|' + book.rot;
  if (cropCache.has(key)) return cropCache.get(key);
  const { page, rot } = await pageAndRot(idx);
  const vp1 = page.getViewport({ scale: 1, rotation: rot });
  const vp = page.getViewport({ scale: 260 / vp1.width, rotation: rot });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const box = computeContentBox(ctx.getImageData(0, 0, c.width, c.height));
  cropCache.set(key, box);
  return box;
}

// 스캔 페이지에서 글자/그림 영역을 찾아 정규화 좌표(0~1)로 반환.
// 검은 스캔 테두리(잉크 비율 85%↑ 띠)와 흰 여백은 제외.
function computeContentBox({ width: W, height: H, data }) {
  const lum = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < lum.length; i++, j += 4) {
    const v = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000 | 0;
    lum[i] = v; hist[v]++;
  }
  let acc = 0, paper = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= lum.length * 0.3) { paper = v; break; } }
  const inkT = Math.max(paper - 55, 25);
  const ink = new Uint8Array(lum.length);
  for (let i = 0; i < lum.length; i++) ink[i] = lum[i] < inkT ? 1 : 0;

  const isContent = r => r > 0.006 && r < 0.85;
  const colRange = (y0, y1) => {
    const n = y1 - y0 + 1, ok = new Uint8Array(W);
    for (let x = 0; x < W; x++) { let s = 0; for (let y = y0; y <= y1; y++) s += ink[y * W + x]; ok[x] = isContent(s / n) ? 1 : 0; }
    return edges(ok);
  };
  const rowRange = (x0, x1) => {
    const n = x1 - x0 + 1, ok = new Uint8Array(H);
    for (let y = 0; y < H; y++) { let s = 0; const b = y * W; for (let x = x0; x <= x1; x++) s += ink[b + x]; ok[y] = isContent(s / n) ? 1 : 0; }
    return edges(ok);
  };
  // 연속 2줄 이상 내용이 있는 첫/마지막 위치 (잡티 무시)
  function edges(ok) {
    let a = -1, b = -1;
    for (let i = 0; i < ok.length - 1; i++) if (ok[i] && ok[i + 1]) { a = i; break; }
    for (let i = ok.length - 1; i > 0; i--) if (ok[i] && ok[i - 1]) { b = i; break; }
    return a < 0 ? null : [a, b];
  }
  let cx = colRange(0, H - 1); if (!cx) return FULL;
  let ry = rowRange(cx[0], cx[1]); if (!ry) return FULL;
  cx = colRange(ry[0], ry[1]) || cx;
  const padX = W * 0.02, padY = H * 0.02;
  const x0 = Math.max(0, cx[0] - padX), x1 = Math.min(W, cx[1] + 1 + padX);
  const y0 = Math.max(0, ry[0] - padY), y1 = Math.min(H, ry[1] + 1 + padY);
  const box = { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
  if (box.w * box.h < 0.2 || box.w < 0.3 || box.h < 0.3) return FULL; // 거의 빈 쪽 등은 자르지 않음
  return box;
}

function resetGeometry() {
  geomGen++;
  boxCache.clear(); boxPending.clear();
}

// ───────────────────────── canvas rendering & cache ─────────────────────────
const CACHE_MAX = 18, CACHE_PX = 70e6;
const dpr = () => Math.min(window.devicePixelRatio || 1, 3);
const canvasKey = (idx, s) => `${idx}|${book.rot}|${book.crop ? 1 : 0}|${s.toFixed(4)}`;

function cachePut(key, c) {
  canvasCache.set(key, c);
  let px = 0;
  for (const v of canvasCache.values()) px += v.width * v.height;
  for (const [k, v] of canvasCache) {
    if (canvasCache.size <= CACHE_MAX && px <= CACHE_PX) break;
    if (v.isConnected) continue;
    canvasCache.delete(k); px -= v.width * v.height; v.width = v.height = 0;
  }
}
function findAnyCanvas(idx) {
  const pre = `${idx}|${book.rot}|${book.crop ? 1 : 0}|`;
  let best = null;
  for (const [k, c] of canvasCache) if (k.startsWith(pre) && c.width) best = c;
  return best;
}
function getCanvas(idx, cssScale, prio) {
  const key = canvasKey(idx, cssScale);
  const hit = canvasCache.get(key);
  if (hit && hit.width) { canvasCache.delete(key); canvasCache.set(key, hit); return Promise.resolve(hit); }
  return schedule(key, prio, idx, async () => {
    const c = await renderToCanvas(idx, cssScale);
    c.dataset.key = key;
    cachePut(key, c);
    return c;
  });
}
async function renderToCanvas(idx, cssScale) {
  const { page, rot } = await pageAndRot(idx);
  const crop = book.crop ? await detectCrop(idx) : FULL;
  let s = cssScale * dpr();
  let vp = page.getViewport({ scale: s, rotation: rot });
  let cw = vp.width * crop.w, ch = vp.height * crop.h;
  const MAXPX = 24e6;
  if (cw * ch > MAXPX) {
    s *= Math.sqrt(MAXPX / (cw * ch));
    vp = page.getViewport({ scale: s, rotation: rot });
    cw = vp.width * crop.w; ch = vp.height * crop.h;
  }
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cw)); c.height = Math.max(1, Math.round(ch));
  const ctx = c.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({
    canvasContext: ctx, viewport: vp,
    transform: [1, 0, 0, 1, -vp.width * crop.x, -vp.height * crop.y],
  }).promise;
  return c;
}

// ───────────────────────── spreads (page mode) ─────────────────────────
function spreadStart(p) {
  if (book.mode !== 'double') return p;
  if (book.cover) return p === 0 ? 0 : p - ((p - 1) % 2);
  return p - (p % 2);
}
function spreadPages(start) {
  if (book.mode !== 'double' || (book.cover && start === 0)) return [start];
  return start + 1 < numPages ? [start, start + 1] : [start];
}
const nextSpreadStart = p => { const pg = spreadPages(spreadStart(p)); return pg[pg.length - 1] + 1; };
const prevSpreadStart = p => { const s = spreadStart(p); return s === 0 ? -1 : spreadStart(s - 1); };

function fitScale(W, H) {
  const vw = Math.max(50, stage.clientWidth - PAD * 2), vh = Math.max(50, stage.clientHeight - PAD * 2);
  const base = book.fit === 'width' ? vw / W : book.fit === 'actual' ? ACTUAL : Math.min(vw / W, vh / H);
  return base * book.zoom;
}
function spreadGeom(boxes) {
  const H = boxes[0].h;
  const units = boxes.map(b => H / b.h);           // 높이를 첫 쪽에 맞춤
  const W = boxes.reduce((s, b, i) => s + b.w * units[i], 0);
  return { H, W, units, sc: fitScale(W, H) };
}

function clearStageView() {
  stage.querySelectorAll('.wrap, .scroll-list').forEach(e => e.remove());
}

async function showPage(p, opt = {}) {
  if (!doc) return;
  const start = spreadStart(clamp(p, 0, numPages - 1));
  const pages = spreadPages(start);
  book.page = start;
  const token = ++viewToken;
  updateIndicator(); saveProgressSoon(); highlightThumb();
  dropQueued(j => j.prio >= 10 && j.prio < 100);
  let boxes;
  try { boxes = await Promise.all(pages.map(getBox)); } catch { return; }
  if (token !== viewToken) return;

  const prevLeft = stage.scrollLeft;
  clearStageView();
  const wrap = el('div', 'wrap'), spread = el('div', 'spread' + (book.rtl ? ' rtl' : ''));
  const els = pages.map(idx => {
    const pg = el('div', 'pg'); pg.dataset.idx = idx;
    const ph = findAnyCanvas(idx); if (ph) pg.appendChild(ph);
    spread.appendChild(pg); return pg;
  });
  wrap.appendChild(spread); stage.appendChild(wrap);
  view = { type: 'page', pages, boxes, els, g: null };
  applyPageLayout();
  stage.scrollTop = opt.scrollTo === 'bottom' ? stage.scrollHeight : 0;
  stage.scrollLeft = opt.keepLeft ? prevLeft : (book.rtl ? stage.scrollWidth : 0);
  renderPageView(token);
  prefetchAround(token);
}

function applyPageLayout() {
  if (view?.type !== 'page') return;
  const g = view.g = spreadGeom(view.boxes);
  view.els.forEach((pg, i) => {
    pg.style.width = view.boxes[i].w * g.sc * g.units[i] + 'px';
    pg.style.height = g.H * g.sc + 'px';
  });
  updateZoomLabel(g.sc);
}

function renderPageView(token) {
  const v = view;
  if (v?.type !== 'page') return;
  v.pages.forEach((idx, i) => {
    const sc = v.g.sc * v.g.units[i];
    getCanvas(idx, sc, i).then(c => {
      if (token !== viewToken || view !== v) return;
      if (c.dataset.key !== canvasKey(idx, v.g.sc * v.g.units[i])) return; // 더 최신 배율로 바뀜
      if (v.els[i].firstChild !== c) v.els[i].replaceChildren(c);
    }).catch(() => {});
  });
}

async function prefetchAround(token) {
  const targets = [];
  let p = book.page;
  for (let k = 0; k < 2; k++) { const n = nextSpreadStart(p); if (n >= numPages) break; targets.push(n); p = n; }
  const pv = prevSpreadStart(book.page); if (pv >= 0) targets.push(pv);
  let prio = 10;
  for (const s of targets) {
    const pages = spreadPages(s);
    try {
      const boxes = await Promise.all(pages.map(getBox));
      if (token !== viewToken) return;
      const g = spreadGeom(boxes);
      pages.forEach((idx, i) => getCanvas(idx, g.sc * g.units[i], prio++).catch(() => {}));
    } catch { return; }
  }
}

// ───────────────────────── continuous scroll mode (virtualized) ─────────────────────────
function singleFit(b) {
  const vw = Math.max(50, stage.clientWidth - PAD * 2), vh = Math.max(50, stage.clientHeight - PAD * 2);
  const base = book.fit === 'width' ? vw / b.w : book.fit === 'actual' ? ACTUAL : Math.min(vw / b.w, vh / b.h);
  return base * book.zoom;
}

async function buildScroll(anchor) {
  const token = ++viewToken;
  dropQueued(j => j.prio < 100);
  try { await getBox(anchor); } catch { return; }
  if (token !== viewToken) return;
  clearStageView();
  const list = el('div', 'scroll-list');
  stage.appendChild(list);
  view = { type: 'scroll', list, slots: new Map(), tops: [], hs: [], ws: [], scs: [], cw: 0, cur: anchor };
  scrollLayout();
  stage.scrollTop = Math.max(0, view.tops[anchor] - PAD);
  stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
  updateVisible();
  updateIndicator();
}

function scrollLayout() {
  const v = view;
  let y = PAD, maxW = 0;
  for (let i = 0; i < numPages; i++) {
    const b = boxCache.get(i) || estBox, sc = singleFit(b);
    v.tops[i] = y; v.ws[i] = b.w * sc; v.hs[i] = b.h * sc; v.scs[i] = sc;
    y += v.hs[i] + GAP;
    if (v.ws[i] > maxW) maxW = v.ws[i];
  }
  v.cw = Math.max(maxW + PAD * 2, stage.clientWidth);
  v.list.style.width = v.cw + 'px';
  v.list.style.height = y - GAP + PAD + 'px';
  for (const [i, s] of v.slots) posSlot(i, s);
  updateZoomLabel(v.scs[v.cur] || v.scs[0]);
}
function posSlot(i, s) {
  const v = view;
  s.style.top = v.tops[i] + 'px';
  s.style.left = (v.cw - v.ws[i]) / 2 + 'px';
  s.style.width = v.ws[i] + 'px';
  s.style.height = v.hs[i] + 'px';
}
function lastLE(arr, val) { // arr 오름차순, arr[i] <= val 인 최대 i
  let lo = 0, hi = arr.length - 1, ans = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= val) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function relayoutScrollAnchored() {
  const v = view; if (v?.type !== 'scroll') return;
  const i = v.cur, off = (stage.scrollTop - v.tops[i]) / (v.hs[i] || 1);
  scrollLayout();
  stage.scrollTop = v.tops[i] + off * v.hs[i];
}
let boxRelayoutPending = false;
function scheduleBoxRelayout() {
  if (boxRelayoutPending) return;
  boxRelayoutPending = true;
  requestAnimationFrame(() => { boxRelayoutPending = false; relayoutScrollAnchored(); updateVisible(); });
}

function updateVisible(force = false) {
  const v = view; if (v?.type !== 'scroll') return;
  const top = stage.scrollTop, bot = top + stage.clientHeight;
  const first = lastLE(v.tops, top), last = lastLE(v.tops, bot);
  const cur = lastLE(v.tops, top + stage.clientHeight * 0.4);
  if (cur !== v.cur || book.page !== cur) { v.cur = cur; book.page = cur; updateIndicator(); saveProgressSoon(); highlightThumb(); }
  const lo = Math.max(0, first - 2), hi = Math.min(numPages - 1, last + 2);
  for (const [i, s] of v.slots) if (i < first - 4 || i > last + 4) { s.remove(); v.slots.delete(i); }
  dropQueued(j => j.prio < 100 && j.idx != null && (j.idx < first - 4 || j.idx > last + 4));
  for (let i = lo; i <= hi; i++) {
    let s = v.slots.get(i);
    if (!s) {
      s = el('div', 'pg'); s.dataset.idx = i;
      const ph = findAnyCanvas(i); if (ph) s.appendChild(ph);
      v.list.appendChild(s); v.slots.set(i, s); posSlot(i, s);
    }
    if (!boxCache.has(i)) { getBox(i).then(scheduleBoxRelayout).catch(() => {}); continue; }
    const key = canvasKey(i, v.scs[i]);
    if (!force && s.firstChild?.dataset?.key === key) continue;
    const prio = i >= first && i <= last ? Math.abs(i - cur) : 10 + Math.abs(i - cur);
    getCanvas(i, v.scs[i], prio).then(c => {
      if (view !== v) return;
      const slot = v.slots.get(i);
      if (slot && c.dataset.key === canvasKey(i, v.scs[i]) && slot.firstChild !== c) slot.replaceChildren(c);
    }).catch(() => {});
  }
}

// ───────────────────────── view control ─────────────────────────
function renderView(p = book?.page ?? 0) {
  if (!doc) return;
  if (book.mode === 'scroll') buildScroll(clamp(p, 0, numPages - 1));
  else showPage(p);
  syncUI();
}
function go(p, opt) {
  if (!doc) return;
  p = clamp(p, 0, numPages - 1);
  if (view?.type === 'scroll') stage.scrollTop = Math.max(0, view.tops[p] - PAD);
  else showPage(p, opt);
}
function next(opt = {}) {
  if (!doc) return;
  if (view?.type === 'scroll') return go(book.page + 1);
  const n = nextSpreadStart(book.page);
  if (n < numPages) showPage(n, opt); else toast('마지막 쪽입니다');
}
function prev(opt = {}) {
  if (!doc) return;
  if (view?.type === 'scroll') return go(book.page - 1);
  const p = prevSpreadStart(book.page);
  if (p >= 0) showPage(p, opt); else toast('첫 쪽입니다');
}
const visualRight = () => book?.rtl ? prev() : next();
const visualLeft = () => book?.rtl ? next() : prev();

const canScrollV = () => stage.scrollHeight > stage.clientHeight + 1;
const atBottom = () => stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
const atTop = () => stage.scrollTop <= 1;
function smartDown() {
  if (view?.type === 'scroll' || (canScrollV() && !atBottom())) stage.scrollBy({ top: stage.clientHeight * 0.9 });
  else next({ scrollTo: 'top' });
}
function smartUp() {
  if (view?.type === 'scroll' || (canScrollV() && !atTop())) stage.scrollBy({ top: -stage.clientHeight * 0.9 });
  else prev({ scrollTo: 'bottom' });
}
function scrollStep(dir) {
  if (view?.type === 'scroll' || canScrollV()) stage.scrollBy({ top: dir * stage.clientHeight * 0.15 });
  else dir > 0 ? next() : prev();
}

function currentScale() {
  if (view?.type === 'page') return view.g?.sc || 1;
  if (view?.type === 'scroll') return view.scs[view.cur] || 1;
  return 1;
}
function relayout() {
  if (view?.type === 'page') applyPageLayout();
  else if (view?.type === 'scroll') { scrollLayout(); updateVisible(); }
}
function withAnchor(pt, fn) {
  const mx = pt ? pt.x : stage.clientWidth / 2, my = pt ? pt.y : stage.clientHeight / 2;
  const rx = (stage.scrollLeft + mx) / Math.max(1, stage.scrollWidth);
  const ry = (stage.scrollTop + my) / Math.max(1, stage.scrollHeight);
  fn();
  stage.scrollLeft = rx * stage.scrollWidth - mx;
  stage.scrollTop = ry * stage.scrollHeight - my;
}
let rerenderT;
function rerenderSoon() {
  clearTimeout(rerenderT);
  rerenderT = setTimeout(() => {
    if (view?.type === 'page') { renderPageView(viewToken); prefetchAround(viewToken); }
    else if (view?.type === 'scroll') updateVisible(true);
  }, 200);
}
function zoomAt(f, pt) {
  if (!doc) return;
  const sc0 = currentScale();
  const target = clamp(sc0 * f, 0.1, 10);
  book.zoom *= target / sc0;
  withAnchor(pt, relayout);   // 즉시 CSS 확대
  rerenderSoon();             // 멈추면 고해상도 재렌더
  saveProgressSoon(); syncUI();
}
function setFit(fit) {
  if (!doc) return;
  book.fit = fit; book.zoom = 1;
  withAnchor(null, relayout);
  rerenderSoon(); saveProgressSoon(); rememberDefaults(); syncUI();
  toast({ width: '폭 맞춤', page: '쪽 맞춤', actual: '원본 100%' }[fit]);
}
function setMode(m) {
  if (!doc || book.mode === m) return;
  const p = book.page;
  book.mode = m;
  renderView(p); saveProgressSoon(); rememberDefaults();
  toast({ single: '한 쪽 보기', double: '두 쪽 펼침' + (book.cover ? ' (표지 단독)' : ''), scroll: '연속 스크롤' }[m]);
}
function toggleBook(prop, msgOn, msgOff, geom = false) {
  if (!doc) return;
  book[prop] = !book[prop];
  if (geom) resetGeometry();
  renderView(book.page); saveProgressSoon(); rememberDefaults();
  toast(book[prop] ? msgOn : msgOff);
}
function rotate() {
  if (!doc) return;
  book.rot = (book.rot + 90) % 360;
  resetGeometry(); buildThumbs(); renderView(book.page); saveProgressSoon();
  toast(`회전 ${book.rot}°`);
}

// ───────────────────────── filters ─────────────────────────
function applyFilters() {
  const f = `${prefs.invert ? 'invert(1) hue-rotate(180deg) ' : ''}brightness(${prefs.brightness}%) contrast(${prefs.contrast}%)`;
  document.documentElement.style.setProperty('--flt', f);
  document.body.classList.toggle('inverted', prefs.invert);
  $('#fltInvert').checked = prefs.invert;
  $('#fltBright').value = prefs.brightness; $('#fltBrightV').textContent = prefs.brightness + '%';
  $('#fltContrast').value = prefs.contrast; $('#fltContrastV').textContent = prefs.contrast + '%';
  $('#btnFilter').classList.toggle('on', prefs.invert || prefs.brightness !== 100 || prefs.contrast !== 100);
  savePrefs();
}
function adjFilter(prop, d, min, max) {
  prefs[prop] = clamp(prefs[prop] + d, min, max); applyFilters();
  toast(`${prop === 'brightness' ? '밝기' : '대비'} ${prefs[prop]}%`);
}

// ───────────────────────── UI sync ─────────────────────────
function updateIndicator() {
  if (!doc) { pageInput.value = ''; pageTotal.textContent = '/ 0'; progressFill.style.width = '0'; return; }
  const pages = view?.type === 'scroll' || book.mode !== 'double' ? [book.page] : spreadPages(book.page);
  const a = pages[0] + 1, b = pages[pages.length - 1] + 1;
  if (document.activeElement !== pageInput) pageInput.value = a === b ? String(a) : `${a}-${b}`;
  pageTotal.textContent = '/ ' + numPages;
  progressFill.style.width = (b / numPages * 100) + '%';
}
function updateZoomLabel(sc) { zoomLabel.textContent = Math.round(sc / ACTUAL * 100) + '%'; }
function syncUI() {
  $$('[data-mode]').forEach(b => b.classList.toggle('on', !!book && book.mode === b.dataset.mode));
  $$('[data-fit]').forEach(b => b.classList.toggle('on', !!book && book.fit === b.dataset.fit && Math.abs(book.zoom - 1) < 1e-6));
  $('#btnCover').classList.toggle('on', !!book?.cover);
  $('#btnRtl').classList.toggle('on', !!book?.rtl);
  $('#btnCrop').classList.toggle('on', !!book?.crop);
  $('#btnRotate').classList.toggle('on', !!book?.rot);
  document.body.classList.toggle('side-closed', !prefs.sideOpen);
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === prefs.sideTab));
  $('#libPane').hidden = prefs.sideTab !== 'library';
  thumbPane.hidden = prefs.sideTab !== 'thumbs';
}
function openSide(tab) {
  if (prefs.sideOpen && prefs.sideTab === tab) prefs.sideOpen = false;
  else { prefs.sideOpen = true; prefs.sideTab = tab; }
  savePrefs(); syncUI();
  if (tab === 'thumbs') highlightThumb(true);
}
let toastT;
function toast(msg, ms = 1300) {
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms);
}
function toggleHelp(show = helpEl.hidden) { helpEl.hidden = !show; }
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
function toggleUI() { document.body.classList.toggle('ui-hidden'); }

// ───────────────────────── progress / settings persistence ─────────────────────────
let saveT;
function saveProgressSoon() { clearTimeout(saveT); saveT = setTimeout(saveProgress, 400); }
function saveProgress() {
  if (!book || !bookKey) return;
  const o = { total: numPages, t: Date.now() };
  for (const f of BOOK_FIELDS) o[f] = book[f];
  LS.set(bookKey, o);
}
function rememberDefaults() {
  if (!book) return;
  LS.set('pv.defaults', { mode: book.mode, cover: book.cover, rtl: book.rtl, crop: book.crop, fit: book.fit });
}
window.addEventListener('beforeunload', saveProgress);

// ───────────────────────── thumbnails ─────────────────────────
let thumbObserver = null;
function buildThumbs() {
  thumbObserver?.disconnect();
  thumbPane.replaceChildren();
  if (!doc) return;
  thumbObserver = new IntersectionObserver(ents => {
    for (const en of ents) if (en.isIntersecting) renderThumb(+en.target.dataset.idx, en.target);
  }, { root: thumbPane, rootMargin: '400px' });
  const frag = document.createDocumentFragment();
  for (let i = 0; i < numPages; i++) {
    const it = el('div', 'th'); it.dataset.idx = i;
    const box = el('div', 'th-img'); box.style.aspectRatio = `${estBox.w} / ${estBox.h}`;
    it.append(box, el('div', 'th-n', String(i + 1)));
    it.addEventListener('click', () => go(i));
    frag.appendChild(it); thumbObserver.observe(it);
  }
  thumbPane.appendChild(frag);
  highlightThumb();
}
function renderThumb(idx, it) {
  if (it.dataset.done) return;
  it.dataset.done = '1';
  const rotNow = book.rot;
  schedule(`t|${idx}|${rotNow}`, 100 + Math.abs(idx - book.page), null, async () => {
    const { page, rot } = await pageAndRot(idx);
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const vp = page.getViewport({ scale: 150 * Math.min(dpr(), 2) / vp1.width, rotation: rot });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  }).then(c => {
    if (!it.isConnected) return;
    const b = it.querySelector('.th-img');
    b.style.aspectRatio = `${c.width} / ${c.height}`;
    b.replaceChildren(c);
  }).catch(() => { delete it.dataset.done; });
}
let lastThumb = null;
function highlightThumb(scroll = false) {
  if (!doc) return;
  const it = thumbPane.children[book.page];
  if (lastThumb && lastThumb !== it) lastThumb.classList.remove('cur');
  if (it) {
    it.classList.add('cur'); lastThumb = it;
    if (!thumbPane.hidden && prefs.sideOpen) it.scrollIntoView({ block: scroll ? 'center' : 'nearest' });
  }
}

// ───────────────────────── opening files ─────────────────────────
function showLoading(text) { loadingText.textContent = text; loadingEl.hidden = false; }
function hideLoading() { loadingEl.hidden = true; }

async function openFile(file, { handle = null, path = '' } = {}) {
  showLoading(`불러오는 중… ${file.name}\n(Google Drive 파일은 처음 열 때 다운로드 시간이 걸릴 수 있어요)`);
  try {
    saveProgress();
    docGen++; resetGeometry();
    dropQueued(() => true);
    cropCache.clear();
    for (const c of canvasCache.values()) { if (!c.isConnected) c.width = c.height = 0; }
    canvasCache.clear();
    if (loadingTask) { const t = loadingTask; loadingTask = null; t.destroy().catch(() => {}); }
    doc = null; view = null; clearStageView();

    const data = new Uint8Array(await file.arrayBuffer());
    loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false });
    loadingTask.onProgress = ({ loaded, total }) => { if (total) loadingText.textContent = `해석 중… ${Math.round(loaded / total * 100)}%`; };
    doc = await loadingTask.promise;
    numPages = doc.numPages;
    bookName = file.name;
    bookKey = keyOf(file.name);
    book = Object.assign(bookDefaults(), LS.get(bookKey, {}));
    book.page = clamp(book.page | 0, 0, numPages - 1);
    titleEl.textContent = file.name.replace(/\.pdf$/i, '');
    titleEl.title = path || file.name;
    document.title = titleEl.textContent + ' — PDF 스캔북 뷰어';
    welcome.hidden = true;
    try { estBox = await getBox(book.page); } catch {}
    addRecent(file.name, path, handle);
    buildThumbs();
    renderView(book.page);
    hideLoading();
    stage.focus();
    if (book.page > 0) toast(`${book.page + 1}쪽부터 이어 읽기`, 1800);
    renderLib();
  } catch (e) {
    hideLoading();
    console.error(e);
    toast('열기 실패: ' + (e?.message || e), 4000);
    if (!doc) welcome.hidden = false;
  }
}
async function openHandle(h, path = '') {
  try {
    if ((await h.queryPermission({ mode: 'read' })) !== 'granted' &&
        (await h.requestPermission({ mode: 'read' })) !== 'granted') { toast('파일 접근 권한이 필요합니다'); return; }
    await openFile(await h.getFile(), { handle: h, path });
  } catch (e) { toast('열기 실패: ' + (e?.message || e), 4000); }
}
async function openFileDialog() {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ id: 'pv-file', types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      if (h) openHandle(h);
    } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
  } else $('#fileInput').click();
}
$('#fileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; });

// drag & drop
document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drop-hover'); });
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('drop-hover'); });
document.addEventListener('drop', e => {
  e.preventDefault(); document.body.classList.remove('drop-hover');
  const item = [...e.dataTransfer.items].find(i => i.kind === 'file');
  const file = [...e.dataTransfer.files].find(f => /\.pdf$/i.test(f.name));
  if (!file) { toast('PDF 파일만 열 수 있어요'); return; }
  const hp = item?.getAsFileSystemHandle?.();
  if (hp) hp.then(h => openFile(file, { handle: h?.kind === 'file' ? h : null })).catch(() => openFile(file));
  else openFile(file);
});

// ───────────────────────── recent & library ─────────────────────────
function addRecent(name, path, handle) {
  const list = LS.get('pv.recent', []).filter(r => r.name.toLowerCase() !== name.toLowerCase());
  list.unshift({ name, path, t: Date.now() });
  LS.set('pv.recent', list.slice(0, 30));
  if (handle) idb.set('h:' + name.toLowerCase(), handle).catch(() => {});
}
function progressOf(name) {
  const s = LS.get(keyOf(name), null);
  if (!s || !s.total) return null;
  return { page: s.page + 1, total: s.total, pct: Math.round((s.page + 1) / s.total * 100) };
}
function libItemEl(name, sub, onClick, dim = false) {
  const it = el('div', 'lib-item' + (dim ? ' dim' : '') + (name === bookName ? ' active' : ''));
  it.appendChild(el('div', 'nm', name.replace(/\.pdf$/i, '')));
  const pr = progressOf(name);
  const meta = el('div', 'meta');
  meta.append(el('span', '', sub || ''), el('span', '', pr ? `${pr.page}/${pr.total} · ${pr.pct}%` : ''));
  it.appendChild(meta);
  if (pr) { const bm = el('div', 'bar-mini'), i = el('i'); i.style.width = pr.pct + '%'; bm.appendChild(i); it.appendChild(bm); }
  it.title = sub ? `${sub}/${name}` : name;
  it.addEventListener('click', onClick);
  return it;
}
async function openRecent(r) {
  const inLib = libFiles.find(f => f.name.toLowerCase() === r.name.toLowerCase());
  if (inLib) return openHandle(inLib.handle, inLib.path);
  const h = await idb.get('h:' + r.name.toLowerCase()).catch(() => null);
  if (h) return openHandle(h, r.path);
  toast('이 책은 [열기]로 다시 골라주세요', 2500);
}
function renderRecent() {
  const list = LS.get('pv.recent', []).slice(0, 8);
  for (const target of [recentList, $('#welcomeRecent')]) {
    target.replaceChildren();
    if (!list.length) { if (target === recentList) target.appendChild(el('div', 'empty', '아직 없음')); continue; }
    for (const r of list) {
      const folder = r.path ? r.path.split('/').slice(0, -1).join('/') : '';
      target.appendChild(libItemEl(r.name, folder, () => openRecent(r)));
    }
  }
}

let libRoot = null, libFiles = [], scanning = false;
async function connectLibrary() {
  if (!window.showDirectoryPicker) { toast('이 브라우저는 폴더 연결을 지원하지 않아요 (Chrome/Edge 사용)', 3000); return; }
  try {
    const h = await window.showDirectoryPicker({ id: 'pv-lib', mode: 'read' });
    libRoot = h; await idb.set('lib', h);
    prefs.sideOpen = true; prefs.sideTab = 'library'; savePrefs(); syncUI();
    scanLibrary();
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
}
async function restoreLibrary() {
  const h = await idb.get('lib').catch(() => null);
  if (!h) return;
  libRoot = h;
  if ((await h.queryPermission({ mode: 'read' })) === 'granted') return scanLibrary();
  libHint.replaceChildren(el('div', '', `“${h.name}” 폴더 연결됨 — 권한 재확인이 필요합니다.`));
  const b = el('button', '', '🔓 다시 연결');
  b.addEventListener('click', async () => {
    if ((await h.requestPermission({ mode: 'read' })) === 'granted') scanLibrary();
  });
  libHint.appendChild(b);
}
async function scanLibrary() {
  if (!libRoot || scanning) return;
  scanning = true; libFiles = [];
  libHint.textContent = `“${libRoot.name}” 읽는 중…`;
  let n = 0;
  async function walk(dir, path, depth) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.') || name.startsWith('~$')) continue;
      const p = path ? `${path}/${name}` : name;
      if (h.kind === 'file') {
        if (/\.pdf$/i.test(name)) { libFiles.push({ name, path: p, folder: path, handle: h }); if (++n % 50 === 0) { libHint.textContent = `읽는 중… ${n}권`; renderLib(); } }
      } else if (depth < 8) await walk(h, p, depth + 1);
    }
  }
  try { await walk(libRoot, '', 0); } catch (e) { toast('폴더 읽기 실패: ' + e.message, 3000); }
  libFiles.sort((a, b) => a.path.localeCompare(b.path, 'ko', { numeric: true }));
  scanning = false;
  libHint.textContent = `📁 ${libRoot.name} · PDF ${libFiles.length}권`;
  renderLib();
}
function renderLib() {
  renderRecent();
  libList.replaceChildren();
  if (!libFiles.length) { libList.appendChild(el('div', 'empty', libRoot ? (scanning ? '읽는 중…' : 'PDF가 없습니다') : '연결된 폴더 없음')); return; }
  const q = libSearch.value.trim().toLowerCase();
  const items = q ? libFiles.filter(f => f.path.toLowerCase().includes(q)) : libFiles;
  const frag = document.createDocumentFragment();
  let lastFolder = null, count = 0;
  for (const f of items) {
    if (++count > 1000) { frag.appendChild(el('div', 'empty', `… ${items.length - 1000}권 더 있음 (검색하세요)`)); break; }
    if (f.folder !== lastFolder) { lastFolder = f.folder; frag.appendChild(el('div', 'lib-folder', f.folder || libRoot.name)); }
    frag.appendChild(libItemEl(f.name, '', () => openHandle(f.handle, f.path)));
  }
  libList.appendChild(frag);
}
libSearch.addEventListener('input', renderLib);

// ───────────────────────── input: keyboard ─────────────────────────
let numBuf = '', numT = 0, lastG = 0;
function clearNum() { numBuf = ''; clearTimeout(numT); }
document.addEventListener('keydown', e => {
  if (e.target.matches?.('input[type=text], input:not([type]), textarea')) {
    if (e.key === 'Escape') { e.target.blur(); stage.focus(); }
    return;
  }
  const k = e.key;
  if (!helpEl.hidden) { if (k === 'Escape' || k === '?') { toggleHelp(false); e.preventDefault(); } return; }

  if (e.ctrlKey || e.metaKey) {
    const map = {
      o: openFileDialog, O: openFileDialog,
      '=': () => zoomAt(1.2), '+': () => zoomAt(1.2), '-': () => zoomAt(1 / 1.2), '0': () => setFit('page'),
      g: () => { pageInput.focus(); pageInput.select(); }, G: () => { pageInput.focus(); pageInput.select(); },
    };
    if (map[k]) { e.preventDefault(); map[k](); }
    return;
  }
  if (e.altKey) return;

  // 숫자 + Enter / G → 쪽 이동
  if (/^[0-9]$/.test(k) && (numBuf || k !== '0')) {
    numBuf += k; clearTimeout(numT); numT = setTimeout(clearNum, 2500);
    toast(`이동: ${numBuf}쪽 (Enter)`, 2500); e.preventDefault(); return;
  }
  if (numBuf && (k === 'Enter' || k === 'G')) { e.preventDefault(); go(parseInt(numBuf, 10) - 1); toast(`${numBuf}쪽`); clearNum(); return; }
  if (k === 'Escape') { clearNum(); fltPanel.hidden = true; if (document.body.classList.contains('ui-hidden')) toggleUI(); return; }

  const actions = {
    ArrowRight: visualRight, l: visualRight,
    ArrowLeft: visualLeft, h: visualLeft,
    PageDown: smartDown, PageUp: smartUp,
    ' ': () => (e.shiftKey ? smartUp() : smartDown()),
    J: () => next(), n: () => next(), K: () => prev(), N: () => prev(),
    ArrowDown: () => scrollStep(1), j: () => scrollStep(1),
    ArrowUp: () => scrollStep(-1), k: () => scrollStep(-1),
    Home: () => go(0), End: () => go(numPages - 1), G: () => go(numPages - 1),
    g: () => { const now = Date.now(); if (now - lastG < 600) { go(0); lastG = 0; } else lastG = now; },
    w: () => setFit('width'), s: () => setFit('width'),
    p: () => setFit('page'), a: () => setFit('page'),
    '0': () => setFit('actual'),
    '+': () => zoomAt(1.2), '=': () => zoomAt(1.2), '-': () => zoomAt(1 / 1.2), _: () => zoomAt(1 / 1.2),
    d: () => setMode(book?.mode === 'double' ? 'single' : 'double'),
    D: () => toggleBook('cover', '표지 단독 켬', '표지 단독 끔'),
    v: () => setMode(book?.mode === 'scroll' ? 'single' : 'scroll'),
    r: () => toggleBook('rtl', '오른쪽→왼쪽 (RTL)', '왼쪽→오른쪽'),
    R: rotate,
    c: () => toggleBook('crop', '여백 자르기 켬', '여백 자르기 끔', true),
    i: () => { prefs.invert = !prefs.invert; applyFilters(); toast(prefs.invert ? '반전 켬' : '반전 끔'); },
    '[': () => adjFilter('brightness', -10, 40, 160), ']': () => adjFilter('brightness', 10, 40, 160),
    '{': () => adjFilter('contrast', -10, 50, 250), '}': () => adjFilter('contrast', 10, 50, 250),
    t: () => openSide('thumbs'), b: () => openSide('library'),
    u: toggleUI, f: toggleFullscreen, Enter: toggleFullscreen,
    o: openFileDialog, '?': () => toggleHelp(true),
  };
  const act = actions[k];
  if (act) { e.preventDefault(); act(); }
});

// ───────────────────────── input: mouse ─────────────────────────
let drag = null;
stage.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !doc || e.target.closest('#welcome')) return;
  const r = stage.getBoundingClientRect();
  if (e.clientX - r.left > stage.clientWidth || e.clientY - r.top > stage.clientHeight) return; // 스크롤바 클릭
  drag = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop, moved: false };
});
window.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 6) { drag.moved = true; stage.classList.add('dragging'); }
  if (drag.moved) { stage.scrollLeft = drag.sl - dx; stage.scrollTop = drag.st - dy; }
});
window.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag; drag = null; stage.classList.remove('dragging');
  if (d.moved || e.target.closest?.('#bar, #side')) return;
  const r = stage.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
  if (x < 0.28) visualLeft(); else if (x > 0.72) visualRight(); else toggleUI();
});

let wheelLock = 0, edgeHits = 0, edgeT = 0;
stage.addEventListener('wheel', e => {
  if (!doc) return;
  if (e.ctrlKey) {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, { x: e.clientX - r.left, y: e.clientY - r.top });
    return;
  }
  if (view?.type !== 'page' || e.deltaY === 0) return;
  if (canScrollV()) {
    if ((e.deltaY > 0 && !atBottom()) || (e.deltaY < 0 && !atTop())) { edgeHits = 0; return; } // 일반 스크롤
    // 끝에 닿은 뒤 휠을 한 번 더 굴려야 넘어감
    const now = Date.now();
    if (now - edgeT > 700) edgeHits = 0;
    edgeT = now;
    if (++edgeHits < 3) { e.preventDefault(); return; }
  }
  e.preventDefault();
  const now = Date.now();
  if (now - wheelLock < 230) return;
  wheelLock = now; edgeHits = 0;
  e.deltaY > 0 ? next({ scrollTo: 'top', keepLeft: true }) : prev({ scrollTo: 'bottom', keepLeft: true });
}, { passive: false });

let scrollRaf = 0;
stage.addEventListener('scroll', () => {
  if (view?.type !== 'scroll' || scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateVisible(); });
});

new ResizeObserver(() => {
  if (!view) return;
  if (view.type === 'page') applyPageLayout();
  else { relayoutScrollAnchored(); updateVisible(); }
  rerenderSoon();
}).observe(stage);

// fullscreen: 상단 바 자동 숨김
document.addEventListener('fullscreenchange', () => document.body.classList.toggle('fs', !!document.fullscreenElement));
document.addEventListener('mousemove', e => {
  if (!document.body.classList.contains('fs')) return;
  const bar = $('#bar');
  if (e.clientY < 30) bar.classList.add('peek');
  else if (!bar.matches(':hover') && e.clientY > 90) bar.classList.remove('peek');
});

// progress bar seek
progressEl.addEventListener('click', e => {
  if (!doc) return;
  const r = progressEl.getBoundingClientRect();
  go(Math.floor((e.clientX - r.left) / r.width * numPages));
});
progressEl.addEventListener('mousemove', e => {
  if (!doc) return;
  const r = progressEl.getBoundingClientRect();
  progressEl.title = `${clamp(Math.floor((e.clientX - r.left) / r.width * numPages) + 1, 1, numPages)}쪽`;
});

// ───────────────────────── toolbar wiring ─────────────────────────
document.addEventListener('click', e => { const b = e.target.closest('button'); if (b) b.blur(); });
$('#btnSide').onclick = () => openSide(prefs.sideTab);
$$('.tabs [data-tab]').forEach(b => b.onclick = () => { prefs.sideTab = b.dataset.tab; savePrefs(); syncUI(); if (b.dataset.tab === 'thumbs') highlightThumb(true); });
$('#btnPrev').onclick = visualLeft;
$('#btnNext').onclick = visualRight;
pageInput.addEventListener('change', () => { const n = parseInt(pageInput.value, 10); if (n) go(n - 1); pageInput.blur(); stage.focus(); });
pageInput.addEventListener('keydown', e => { if (e.key === 'Enter') pageInput.dispatchEvent(new Event('change')); });
pageInput.addEventListener('blur', updateIndicator);
$$('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
$$('[data-fit]').forEach(b => b.onclick = () => setFit(b.dataset.fit));
$('#btnZoomIn').onclick = () => zoomAt(1.2);
$('#btnZoomOut').onclick = () => zoomAt(1 / 1.2);
$('#btnCover').onclick = () => toggleBook('cover', '표지 단독 켬', '표지 단독 끔');
$('#btnRtl').onclick = () => toggleBook('rtl', '오른쪽→왼쪽 (RTL)', '왼쪽→오른쪽');
$('#btnCrop').onclick = () => toggleBook('crop', '여백 자르기 켬', '여백 자르기 끔', true);
$('#btnRotate').onclick = rotate;
$('#btnFilter').onclick = () => { fltPanel.hidden = !fltPanel.hidden; };
$('#fltInvert').onchange = e => { prefs.invert = e.target.checked; applyFilters(); };
$('#fltBright').oninput = e => { prefs.brightness = +e.target.value; applyFilters(); };
$('#fltContrast').oninput = e => { prefs.contrast = +e.target.value; applyFilters(); };
$('#fltReset').onclick = () => { prefs.invert = false; prefs.brightness = 100; prefs.contrast = 100; applyFilters(); };
$('#btnOpen').onclick = openFileDialog;
$('#btnFull').onclick = toggleFullscreen;
$('#btnHelp').onclick = () => toggleHelp(true);
helpEl.addEventListener('click', e => { if (e.target === helpEl) toggleHelp(false); });
$('#btnConnect').onclick = connectLibrary;
$('#wConnect').onclick = connectLibrary;
$('#wOpen').onclick = openFileDialog;
$('#btnRescan').onclick = scanLibrary;

// ───────────────────────── boot ─────────────────────────
if (!window.showDirectoryPicker) { // iPad Safari 등: 폴더 연결 불가 → 파일 열기만
  for (const id of ['#wConnect', '#btnConnect', '#btnRescan', '#wHintFolder']) $(id).hidden = true;
  $('#wHintFile').hidden = false;
  libHint.textContent = '이 브라우저는 폴더 연결을 지원하지 않아요. [열기]로 책을 고르세요.';
}
applyFilters();
syncUI();
updateIndicator();
renderLib();
restoreLibrary();
stage.focus();

// ?open=<같은 출처 PDF 경로>&keys=d,c  — 디버그/테스트용 (열고 나서 키 입력 재생)
(async () => {
  const qs = new URLSearchParams(location.search), src = qs.get('open');
  if (!src) return;
  const blob = await (await fetch(src)).blob();
  await openFile(new File([blob], decodeURIComponent(src.split('/').pop()), { type: 'application/pdf' }));
  for (const k of (qs.get('keys') || '').split(',').filter(Boolean)) {
    await new Promise(r => setTimeout(r, 400));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: k.length === 1 && k !== k.toLowerCase(), bubbles: true }));
  }
})();
