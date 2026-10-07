'use strict';

/* ============================================================
   Аудио-резак: загрузка mp3 → волна → выделение → экспорт.
   Всё в браузере, без сервера.
   ============================================================ */

const $ = (s) => document.querySelector(s);

const el = {
  dropView:    $('#dropView'),
  editor:      $('#editor'),
  fileInput:   $('#fileInput'),
  pickBtn:     $('#pickBtn'),
  newFileBtn:  $('#newFileBtn'),
  fileMeta:    $('#fileMeta'),
  ruler:       $('#ruler'),
  wave:        $('#wave'),
  minimap:     $('#minimap'),
  playSelBtn:  $('#playSelBtn'),
  playIco:     $('#playIco'),
  playLabel:   $('#playLabel'),
  playAllBtn:  $('#playAllBtn'),
  stopBtn:     $('#stopBtn'),
  loopBtn:     $('#loopBtn'),
  zoomInBtn:   $('#zoomInBtn'),
  zoomOutBtn:  $('#zoomOutBtn'),
  fitBtn:      $('#fitBtn'),
  selAllBtn:   $('#selAllBtn'),
  curTime:     $('#curTime'),
  totTime:     $('#totTime'),
  startIn:     $('#startIn'),
  endIn:       $('#endIn'),
  durOut:      $('#durOut'),
  setStartBtn: $('#setStartBtn'),
  setEndBtn:   $('#setEndBtn'),
  fmtSel:      $('#fmtSel'),
  brWrap:      $('#brWrap'),
  brSel:       $('#brSel'),
  fadeChk:     $('#fadeChk'),
  dlBtn:       $('#dlBtn'),
  prog:        $('#prog'),
  progBar:     $('#progBar'),
  progTxt:     $('#progTxt'),
  overlay:     $('#overlay'),
  overlayTxt:  $('#overlayTxt'),
  toast:       $('#toast'),
};

const BUCKET = 512;              // сэмплов на одну «ступеньку» пред-расчёта пиков
const MIN_VIEW = 0.004;          // минимальная видимая длительность, сек
const MIN_SEL  = 0.002;          // минимальная длина выделения, сек
const GRIP     = 7;              // радиус захвата края выделения, px
const BAR      = 14;             // высота верхней полоски переноса, px

const st = {
  buffer: null, chans: null, duration: 0, name: 'audio',
  peakMin: null, peakMax: null,
  viewStart: 0, viewEnd: 0,
  selStart: 0, selEnd: 0,
  playhead: 0,
  loop: false,
  ctx: null, src: null,
  playing: false, playOffset: 0, playStartedAt: 0, playFrom: 0, playTo: 0,
  drag: null,
  exporting: false,
};

/* ---------------- утилиты ---------------- */

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

function fmtTime(t, ms = true) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  if (!ms) return `${m}:${String(s).padStart(2, '0')}`;
  const f = Math.round((t - Math.floor(t)) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}

function parseTime(str) {
  if (str == null) return NaN;
  const s = String(str).trim().replace(',', '.');
  if (!s) return NaN;
  const parts = s.split(':');
  if (parts.length > 3) return NaN;
  let total = 0;
  for (const p of parts) {
    const n = parseFloat(p);
    if (!isFinite(n) || n < 0) return NaN;
    total = total * 60 + n;
  }
  return total;
}

function toast(msg, ok = false) {
  el.toast.textContent = msg;
  el.toast.className = 'toast' + (ok ? ' ok' : '');
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, ok ? 3200 : 6000);
}

function busy(text) {
  if (text) { el.overlayTxt.textContent = text; el.overlay.hidden = false; }
  else el.overlay.hidden = true;
}

// Отдаём управление браузеру, чтобы интерфейс не замирал.
// rAF в фоновой вкладке не вызывается, поэтому дублируем таймером.
function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(go);
    setTimeout(go, 20);
  });
}

/* ---------------- загрузка файла ---------------- */

el.pickBtn.addEventListener('click', () => el.fileInput.click());
el.newFileBtn.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadFile(f);
  e.target.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragover',  (e) => { e.preventDefault(); });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});

async function loadFile(file) {
  stopPlayback();
  busy('Читаю файл…');
  try {
    const bytes = await file.arrayBuffer();
    if (!st.ctx) st.ctx = new (window.AudioContext || window.webkitAudioContext)();
    busy('Декодирую аудио…');
    await nextFrame();
    const buf = await decode(bytes);

    st.buffer = buf;
    st.chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) st.chans.push(buf.getChannelData(c));
    st.duration = buf.duration;
    st.name = file.name.replace(/\.[^.]+$/, '') || 'audio';

    busy('Строю волну…');
    await nextFrame();
    buildPeaks();

    st.viewStart = 0; st.viewEnd = st.duration;
    st.selStart = 0;  st.selEnd = st.duration;
    st.playhead = 0;

    el.dropView.hidden = true;
    el.editor.hidden = false;
    el.newFileBtn.hidden = false;
    el.fileMeta.hidden = false;
    el.fileMeta.innerHTML =
      `<span><b>${escapeHtml(file.name)}</b></span>` +
      `<span>${fmtTime(st.duration)}</span>` +
      `<span>${buf.sampleRate} Гц</span>` +
      `<span>${buf.numberOfChannels === 1 ? 'моно' : buf.numberOfChannels === 2 ? 'стерео' : buf.numberOfChannels + ' канала'}</span>` +
      `<span>${(file.size / 1048576).toFixed(1)} МБ</span>`;

    busy(null);
    resizeAll();
    minimapCache = null;
    draw();
    warmUpMp3();
  } catch (err) {
    busy(null);
    console.error(err);
    toast('Не получилось прочитать файл: ' + (err && err.message ? err.message : 'формат не поддерживается браузером'));
  }
}

function decode(bytes) {
  // Safari ещё требует колбэк-форму
  return new Promise((resolve, reject) => {
    const p = st.ctx.decodeAudioData(bytes, resolve, (e) => reject(e || new Error('decodeAudioData')));
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------- пред-расчёт пиков ---------------- */

function buildPeaks() {
  const len = st.buffer.length, nch = st.chans.length;
  const n = Math.ceil(len / BUCKET);
  const mn = new Float32Array(n), mx = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s0 = i * BUCKET, s1 = Math.min(len, s0 + BUCKET);
    let lo = 1, hi = -1;
    for (let s = s0; s < s1; s++) {
      let v = 0;
      for (let c = 0; c < nch; c++) v += st.chans[c][s];
      v /= nch;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    mn[i] = lo; mx[i] = hi;
  }
  st.peakMin = mn; st.peakMax = mx;
}

function rangeMinMax(s0, s1) {
  const len = st.buffer.length;
  s0 = clamp(Math.floor(s0), 0, len - 1);
  s1 = clamp(Math.ceil(s1), s0 + 1, len);
  if (s1 - s0 >= BUCKET * 2) {
    const i0 = Math.floor(s0 / BUCKET);
    const i1 = Math.min(st.peakMin.length, Math.ceil(s1 / BUCKET));
    let lo = 1, hi = -1;
    for (let i = i0; i < i1; i++) {
      if (st.peakMin[i] < lo) lo = st.peakMin[i];
      if (st.peakMax[i] > hi) hi = st.peakMax[i];
    }
    return [lo, hi];
  }
  const nch = st.chans.length;
  let lo = 1, hi = -1;
  for (let s = s0; s < s1; s++) {
    let v = 0;
    for (let c = 0; c < nch; c++) v += st.chans[c][s];
    v /= nch;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/* ---------------- геометрия / отрисовка ---------------- */

const view = { w: 0, h: 0, rw: 0, rh: 0, mw: 0, mh: 0, dpr: 1 };

function fit(canvas, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth));
  const h = Math.max(1, Math.round(cssH));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

function resizeAll() {
  if (!st.buffer) return;
  view.dpr = window.devicePixelRatio || 1;
  view.w = Math.max(1, Math.round(el.wave.clientWidth));
  view.h = Math.max(1, Math.round(el.wave.clientHeight));
  view.rw = view.w;
  view.rh = Math.max(1, Math.round(el.ruler.clientHeight));
  view.mw = Math.max(1, Math.round(el.minimap.clientWidth));
  view.mh = Math.max(1, Math.round(el.minimap.clientHeight));
  minimapCache = null;
}

const t2x  = (t) => (t - st.viewStart) / (st.viewEnd - st.viewStart) * view.w;
const x2t  = (x) => st.viewStart + (x / view.w) * (st.viewEnd - st.viewStart);
const mt2x = (t) => t / st.duration * view.mw;
const mx2t = (x) => clamp(x / view.mw * st.duration, 0, st.duration);

// В фоновой вкладке rAF не вызывается: подстраховываемся таймером,
// иначе после возврата на вкладку отрисовка не возобновится.
function onFrame(fn) {
  let done = false;
  const go = () => { if (!done) { done = true; fn(); } };
  requestAnimationFrame(go);
  setTimeout(go, 50);
}

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  onFrame(() => { drawQueued = false; render(); });
}

function render() {
  if (!st.buffer) return;
  drawRuler();
  drawWave();
  drawMinimap();
  updateReadouts();
}

function drawWave() {
  const { g, w, h } = fit(el.wave, el.wave.clientHeight);
  const sr = st.buffer.sampleRate;
  const mid = h / 2;
  const amp = h / 2 - 4;

  g.clearRect(0, 0, w, h);

  // выделение — подложка
  const sx0 = clamp(t2x(st.selStart), 0, w);
  const sx1 = clamp(t2x(st.selEnd), 0, w);
  if (sx1 > sx0) {
    g.fillStyle = 'rgba(76,194,255,.10)';
    g.fillRect(sx0, 0, sx1 - sx0, h);
  }

  // центральная линия
  g.fillStyle = 'rgba(255,255,255,.07)';
  g.fillRect(0, Math.round(mid), w, 1);

  // колонки волны
  const tStep = (st.viewEnd - st.viewStart) / w;
  for (let x = 0; x < w; x++) {
    const ta = st.viewStart + x * tStep;
    const tb = ta + tStep;
    if (tb <= 0 || ta >= st.duration) continue;
    const [lo, hi] = rangeMinMax(Math.max(0, ta) * sr, Math.min(st.duration, tb) * sr);
    const yTop = mid - hi * amp;
    const yBot = mid - lo * amp;
    const inSel = (ta + tStep / 2) >= st.selStart && (ta + tStep / 2) < st.selEnd;
    g.fillStyle = inSel ? '#4cc2ff' : '#49566a';
    g.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
  }

  // полоска-ручка сверху: за неё выделение двигается целиком
  if (sx1 - sx0 > GRIP * 3) {
    g.fillStyle = 'rgba(76,194,255,.55)';
    g.fillRect(sx0, 0, sx1 - sx0, BAR);
    g.fillStyle = '#0e1116';
    const cx = (sx0 + sx1) / 2;
    for (let i = -1; i <= 1; i++) g.fillRect(Math.round(cx + i * 5) - 1, BAR / 2 - 3, 2, 6);
  }

  // границы выделения
  g.fillStyle = '#4cc2ff';
  for (const x of [t2x(st.selStart), t2x(st.selEnd)]) {
    if (x < -2 || x > w + 2) continue;
    const px = clamp(Math.round(x), 0, w - 2);
    g.fillRect(px, 0, 2, h);
    g.fillRect(px - 3, 0, 8, BAR);
    g.fillRect(px - 3, h - 14, 8, 14);
  }

  // курсор
  const px = t2x(st.playhead);
  if (px >= -1 && px <= w + 1) {
    g.fillStyle = '#ffffff';
    g.fillRect(Math.round(px), 0, 1, h);
  }
}

function drawRuler() {
  const { g, w, h } = fit(el.ruler, el.ruler.clientHeight);
  g.clearRect(0, 0, w, h);
  const span = st.viewEnd - st.viewStart;
  const steps = [0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let step = steps[steps.length - 1];
  for (const s of steps) if (span / s <= 12) { step = s; break; }

  g.font = '10px ui-monospace,SFMono-Regular,Menlo,monospace';
  g.textBaseline = 'bottom';
  g.fillStyle = '#8d9aab';
  g.strokeStyle = 'rgba(255,255,255,.14)';
  g.beginPath();
  const first = Math.ceil(st.viewStart / step) * step;
  for (let t = first; t <= st.viewEnd + 1e-9; t += step) {
    const x = Math.round(t2x(t)) + 0.5;
    g.moveTo(x, h - 6); g.lineTo(x, h);
    const label = step >= 1 ? fmtTime(t, false) : fmtTime(t).replace(/0$/, '');
    const tw = g.measureText(label).width;
    if (x - tw / 2 > 1 && x + tw / 2 < w - 1) g.fillText(label, x - tw / 2, h - 7);
  }
  g.stroke();
}

let minimapCache = null;
function drawMinimap() {
  const { g, w, h } = fit(el.minimap, el.minimap.clientHeight);
  if (!minimapCache || minimapCache.w !== w || minimapCache.h !== h) {
    const c = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const cg = c.getContext('2d');
    cg.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mid = h / 2, amp = h / 2 - 2, sr = st.buffer.sampleRate;
    cg.fillStyle = '#3a4455';
    for (let x = 0; x < w; x++) {
      const ta = x / w * st.duration, tb = (x + 1) / w * st.duration;
      const [lo, hi] = rangeMinMax(ta * sr, tb * sr);
      const yTop = mid - hi * amp, yBot = mid - lo * amp;
      cg.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }
    minimapCache = { canvas: c, w, h };
  }

  g.clearRect(0, 0, w, h);
  g.drawImage(minimapCache.canvas, 0, 0, w, h);

  // выделение
  const sx0 = mt2x(st.selStart), sx1 = mt2x(st.selEnd);
  g.fillStyle = 'rgba(76,194,255,.22)';
  g.fillRect(sx0, 0, Math.max(1, sx1 - sx0), h);

  // видимая область
  const vx0 = mt2x(st.viewStart), vx1 = mt2x(st.viewEnd);
  if (vx1 - vx0 < w - 1) {
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.fillRect(0, 0, vx0, h);
    g.fillRect(vx1, 0, w - vx1, h);
    g.strokeStyle = 'rgba(255,255,255,.45)';
    g.lineWidth = 1;
    g.strokeRect(Math.round(vx0) + .5, .5, Math.max(1, vx1 - vx0 - 1), h - 1);
  }

  // курсор
  g.fillStyle = '#fff';
  g.fillRect(Math.round(mt2x(st.playhead)), 0, 1, h);
}

function updateReadouts() {
  el.curTime.textContent = fmtTime(st.playhead);
  el.totTime.textContent = fmtTime(st.duration);
  el.durOut.textContent = fmtTime(st.selEnd - st.selStart);
  if (document.activeElement !== el.startIn) el.startIn.value = fmtTime(st.selStart);
  if (document.activeElement !== el.endIn)   el.endIn.value   = fmtTime(st.selEnd);
  el.loopBtn.classList.toggle('on', st.loop);
  el.playIco.textContent = st.playing ? '❙❙' : '▶';
  el.playLabel.textContent = st.playing ? 'Пауза' : 'Выделение';
}

/* ---------------- масштаб и прокрутка ---------------- */

function setView(a, b) {
  let span = clamp(b - a, MIN_VIEW, st.duration);
  if (span >= st.duration) { st.viewStart = 0; st.viewEnd = st.duration; draw(); return; }
  let s = clamp(a, 0, st.duration - span);
  st.viewStart = s; st.viewEnd = s + span;
  draw();
}

function zoomAt(factor, anchorT) {
  const span = st.viewEnd - st.viewStart;
  const nspan = clamp(span * factor, MIN_VIEW, st.duration);
  const k = clamp((anchorT - st.viewStart) / span, 0, 1);
  setView(anchorT - k * nspan, anchorT - k * nspan + nspan);
}

function pan(dt) { setView(st.viewStart + dt, st.viewEnd + dt); }

function fitAll() { setView(0, st.duration); }

function ensureVisible(t, margin = 0.12) {
  const span = st.viewEnd - st.viewStart;
  if (span >= st.duration) return;
  if (t < st.viewStart || t > st.viewEnd) { setView(t - span / 2, t + span / 2); return; }
  if (t > st.viewEnd - span * margin) pan(span * (1 - margin * 2));
  else if (t < st.viewStart + span * margin) pan(-span * (1 - margin * 2));
}

el.zoomInBtn.addEventListener('click', () => zoomAt(0.5, centerOrPlayhead()));
el.zoomOutBtn.addEventListener('click', () => zoomAt(2, centerOrPlayhead()));
el.fitBtn.addEventListener('click', fitAll);
el.selAllBtn.addEventListener('click', () => { setSel(0, st.duration); });

function centerOrPlayhead() {
  const p = st.playhead;
  return (p >= st.viewStart && p <= st.viewEnd) ? p : (st.viewStart + st.viewEnd) / 2;
}

el.wave.addEventListener('wheel', (e) => {
  if (!st.buffer) return;
  e.preventDefault();
  const r = el.wave.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) {
    const anchor = x2t(e.clientX - r.left);
    zoomAt(e.deltaY > 0 ? 1.18 : 1 / 1.18, anchor);
  } else {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    pan(d / view.w * (st.viewEnd - st.viewStart) * 1.1);
  }
}, { passive: false });

/* ---------------- выделение мышью ---------------- */

function setSel(a, b) {
  let s = Math.min(a, b), e = Math.max(a, b);
  s = clamp(s, 0, st.duration);
  e = clamp(e, 0, st.duration);
  if (e - s < MIN_SEL) e = Math.min(st.duration, s + MIN_SEL);
  if (e - s < MIN_SEL) s = Math.max(0, e - MIN_SEL);
  st.selStart = s; st.selEnd = e;
  draw();
}

el.wave.addEventListener('pointerdown', (e) => {
  if (!st.buffer || e.button !== 0) return;
  el.wave.setPointerCapture(e.pointerId);
  const r = el.wave.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  const t = x2t(x);
  const xs = t2x(st.selStart), xe = t2x(st.selEnd);

  let mode;
  if (Math.abs(x - xs) <= GRIP) mode = 'start';
  else if (Math.abs(x - xe) <= GRIP) mode = 'end';
  else if (y <= BAR && x > xs && x < xe) mode = 'move';   // верхняя полоска — перенос
  else mode = 'new';                                      // всё остальное — новое выделение

  st.drag = { mode, x0: x, t0: t, s0: st.selStart, e0: st.selEnd, moved: false };
  if (mode === 'new') setSel(t, t + MIN_SEL);
  updateCursor(mode);
});

el.wave.addEventListener('pointermove', (e) => {
  if (!st.buffer) return;
  const r = el.wave.getBoundingClientRect();
  const x = e.clientX - r.left;

  if (!st.drag) {
    const y = e.clientY - r.top;
    const xs = t2x(st.selStart), xe = t2x(st.selEnd);
    const near = Math.abs(x - xs) <= GRIP || Math.abs(x - xe) <= GRIP;
    el.wave.style.cursor = near ? 'col-resize' : (y <= BAR && x > xs && x < xe ? 'grab' : 'text');
    return;
  }

  const d = st.drag;
  if (Math.abs(x - d.x0) > 2) d.moved = true;
  const t = x2t(x);

  if (d.mode === 'new')        setSel(d.t0, t);
  else if (d.mode === 'start') setSel(t, d.e0);
  else if (d.mode === 'end')   setSel(d.s0, t);
  else if (d.mode === 'move') {
    const len = d.e0 - d.s0;
    let s = clamp(d.s0 + (t - d.t0), 0, st.duration - len);
    setSel(s, s + len);
  }

  // авто-прокрутка у краёв
  if (x < 24) pan(-(st.viewEnd - st.viewStart) * 0.02);
  else if (x > view.w - 24) pan((st.viewEnd - st.viewStart) * 0.02);
});

el.wave.addEventListener('pointerup', (e) => {
  if (!st.drag) return;
  const d = st.drag;
  st.drag = null;
  el.wave.style.cursor = 'text';
  if (!d.moved) {
    // просто клик — переставить курсор, выделение не трогаем
    setSel(d.s0, d.e0);
    seek(d.t0);
  } else if (d.mode === 'new') {
    seek(st.selStart);
  }
  draw();
});

el.wave.addEventListener('pointercancel', () => { st.drag = null; });

function updateCursor(mode) {
  el.wave.style.cursor = mode === 'move' ? 'grabbing' : mode === 'new' ? 'text' : 'col-resize';
}

/* миникарта: клик/протяжка — перемещение видимой области */
let mmDrag = false;
el.minimap.addEventListener('pointerdown', (e) => {
  if (!st.buffer) return;
  el.minimap.setPointerCapture(e.pointerId);
  mmDrag = true;
  mmGo(e);
});
el.minimap.addEventListener('pointermove', (e) => { if (mmDrag) mmGo(e); });
el.minimap.addEventListener('pointerup', () => { mmDrag = false; });
function mmGo(e) {
  const r = el.minimap.getBoundingClientRect();
  const t = mx2t(e.clientX - r.left);
  const span = st.viewEnd - st.viewStart;
  if (span >= st.duration) { seek(t); draw(); return; }
  setView(t - span / 2, t + span / 2);
}

/* ---------------- поля времени ---------------- */

function commitField(input, which) {
  const v = parseTime(input.value);
  if (!isFinite(v)) { updateReadouts(); toast('Не понял время. Примеры: 1:23.456 или 83.4'); return; }
  if (which === 'start') setSel(clamp(v, 0, st.duration), st.selEnd);
  else setSel(st.selStart, clamp(v, 0, st.duration));
  updateReadouts();
}
el.startIn.addEventListener('change', () => commitField(el.startIn, 'start'));
el.endIn.addEventListener('change', () => commitField(el.endIn, 'end'));
for (const i of [el.startIn, el.endIn]) {
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { i.blur(); } });
}
el.setStartBtn.addEventListener('click', () => setSel(st.playhead, Math.max(st.playhead + MIN_SEL, st.selEnd)));
el.setEndBtn.addEventListener('click',   () => setSel(Math.min(st.selStart, st.playhead - MIN_SEL), st.playhead));

/* ---------------- воспроизведение ---------------- */

function seek(t) {
  st.playhead = clamp(t, 0, st.duration);
  if (st.playing) { const to = st.playTo; stopPlayback(); startPlayback(st.playhead, to); }
  draw();
}

function startPlayback(from, to) {
  if (!st.buffer) return;
  if (st.ctx.state === 'suspended') st.ctx.resume();
  stopPlayback(true);
  from = clamp(from, 0, st.duration);
  to = clamp(to, from + 0.01, st.duration);

  const src = st.ctx.createBufferSource();
  src.buffer = st.buffer;
  src.connect(st.ctx.destination);
  if (st.loop) {
    src.loop = true;
    src.loopStart = from;
    src.loopEnd = to;
    src.start(0, from);
  } else {
    src.start(0, from, to - from);
    src.onended = () => {
      if (st.src === src) { st.playing = false; st.src = null; st.playhead = to; draw(); }
    };
  }
  st.src = src;
  st.playing = true;
  st.playFrom = from;
  st.playTo = to;
  st.playStartedAt = st.ctx.currentTime;
  tick();
  draw();
}

function stopPlayback(keepHead) {
  if (st.src) {
    try { st.src.onended = null; st.src.stop(); } catch (e) {}
    try { st.src.disconnect(); } catch (e) {}
    st.src = null;
  }
  st.playing = false;
  if (!keepHead) draw();
}

function tick() {
  if (!st.playing) return;
  const span = st.playTo - st.playFrom;
  let el_ = st.ctx.currentTime - st.playStartedAt;
  let t = st.loop ? st.playFrom + (el_ % span) : st.playFrom + el_;
  st.playhead = clamp(t, 0, st.duration);
  ensureVisible(st.playhead);
  draw();
  onFrame(tick);
}

function togglePlaySelection() {
  if (st.playing) { stopPlayback(); return; }
  const from = (st.playhead >= st.selStart && st.playhead < st.selEnd - 0.01) ? st.playhead : st.selStart;
  startPlayback(from, st.selEnd);
}

el.playSelBtn.addEventListener('click', togglePlaySelection);
el.playAllBtn.addEventListener('click', () => {
  if (st.playing) stopPlayback();
  startPlayback(st.playhead < st.duration - 0.05 ? st.playhead : 0, st.duration);
});
el.stopBtn.addEventListener('click', () => { stopPlayback(); st.playhead = st.selStart; draw(); });
el.loopBtn.addEventListener('click', () => {
  st.loop = !st.loop;
  if (st.playing) { const f = st.playhead, t = st.playTo; stopPlayback(); startPlayback(f, t); }
  draw();
});

/* ---------------- горячие клавиши ---------------- */

window.addEventListener('keydown', (e) => {
  if (!st.buffer) return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  const span = st.viewEnd - st.viewStart;
  switch (e.key) {
    case ' ':      e.preventDefault(); togglePlaySelection(); break;
    case 'ArrowLeft':  e.preventDefault(); seek(st.playhead - span * (e.shiftKey ? 0.1 : 0.02)); break;
    case 'ArrowRight': e.preventDefault(); seek(st.playhead + span * (e.shiftKey ? 0.1 : 0.02)); break;
    case 'Home':   e.preventDefault(); seek(st.selStart); break;
    case 'End':    e.preventDefault(); seek(st.selEnd); break;
    case '[':      setSel(st.playhead, Math.max(st.playhead + MIN_SEL, st.selEnd)); break;
    case ']':      setSel(Math.min(st.selStart, st.playhead - MIN_SEL), st.playhead); break;
    case '+': case '=': zoomAt(0.5, centerOrPlayhead()); break;
    case '-': case '_': zoomAt(2, centerOrPlayhead()); break;
    case '0':      fitAll(); break;
    case 'l': case 'L': case 'д': case 'Д': el.loopBtn.click(); break;
    case 'a': case 'A': case 'ф': case 'Ф':
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); setSel(0, st.duration); }
      break;
  }
});

window.addEventListener('resize', () => { resizeAll(); draw(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && st.buffer) { drawQueued = false; draw(); }
});

/* ---------------- вырезание фрагмента ---------------- */

function extract(fade) {
  const sr = st.buffer.sampleRate;
  const s0 = Math.floor(st.selStart * sr);
  const s1 = Math.min(st.buffer.length, Math.ceil(st.selEnd * sr));
  const len = Math.max(1, s1 - s0);
  const nch = st.chans.length;
  const out = [];
  for (let c = 0; c < nch; c++) out.push(st.chans[c].slice(s0, s0 + len));

  if (fade) {
    const f = Math.min(Math.floor(sr * 0.02), Math.floor(len / 2));
    for (let c = 0; c < nch; c++) {
      const d = out[c];
      for (let i = 0; i < f; i++) {
        const k = i / f;
        d[i] *= k;
        d[len - 1 - i] *= k;
      }
    }
  }
  return { sampleRate: sr, channels: out, length: len };
}

/* --- WAV (16 бит PCM) --- */
function encodeWav(a) {
  const nch = a.channels.length, len = a.length, sr = a.sampleRate;
  const bytes = 44 + len * nch * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * nch * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      let s = clamp(a.channels[c][i], -1, 1);
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/* --- MP3 через lamejs --- */
const LAME_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

async function resampleTo(a, targetRate) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const frames = Math.ceil(a.length * targetRate / a.sampleRate);
  const oac = new OAC(a.channels.length, frames, targetRate);
  const src = oac.createBuffer(a.channels.length, a.length, a.sampleRate);
  for (let c = 0; c < a.channels.length; c++) src.copyToChannel(a.channels[c], c);
  const node = oac.createBufferSource();
  node.buffer = src;
  node.connect(oac.destination);
  node.start();
  const rendered = await oac.startRendering();
  const chans = [];
  for (let c = 0; c < rendered.numberOfChannels; c++) chans.push(rendered.getChannelData(c).slice());
  return { sampleRate: targetRate, channels: chans, length: rendered.length };
}

function toInt16(f32, len) {
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const s = clamp(f32[i], -1, 1);
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/* Основной путь — кодирование в Worker. Если воркер недоступен
   (например, страницу открыли как file://), кодируем в главном потоке. */
const NO_WORKER = Symbol('no-worker');
let mp3Worker = null, workerBroken = false;

function getWorker() {
  if (workerBroken) return null;
  if (mp3Worker) return mp3Worker;
  try {
    mp3Worker = new Worker('worker.js');
    mp3Worker.addEventListener('error', () => { workerBroken = true; mp3Worker = null; });
  } catch (e) {
    workerBroken = true; mp3Worker = null;
  }
  return mp3Worker;
}

function encodeMp3InWorker(a, kbps, onProgress) {
  const w = getWorker();
  if (!w) return Promise.reject(NO_WORKER);
  return new Promise((resolve, reject) => {
    const len = a.length;
    const channels = Math.min(2, a.channels.length);
    const left = toInt16(a.channels[0], len);
    const right = channels === 2 ? toInt16(a.channels[1], len) : new Int16Array(0);

    const cleanup = () => { w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); };
    const onMsg = (e) => {
      const d = e.data;
      if (d.progress != null) { onProgress(d.progress); return; }
      cleanup();
      if (d.error) reject(new Error(d.error));
      else { onProgress(1); resolve(d.blob); }
    };
    const onErr = () => { cleanup(); workerBroken = true; mp3Worker = null; reject(NO_WORKER); };

    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({ channels, sampleRate: a.sampleRate, kbps, left, right }, [left.buffer, right.buffer]);
  });
}

async function encodeMp3(a, kbps, onProgress) {
  if (!LAME_RATES.includes(a.sampleRate)) a = await resampleTo(a, 44100);
  try {
    return await encodeMp3InWorker(a, kbps, onProgress);
  } catch (e) {
    if (e !== NO_WORKER) throw e;
  }
  return encodeMp3InPage(a, kbps, onProgress);
}

async function encodeMp3InPage(a, kbps, onProgress) {
  if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) throw new Error('mp3-энкодер не загрузился');

  const nch = Math.min(2, a.channels.length);
  const len = a.length;
  const left = toInt16(a.channels[0], len);
  const right = nch === 2 ? toInt16(a.channels[1], len) : null;

  const enc = new lamejs.Mp3Encoder(nch, a.sampleRate, kbps);
  const BLOCK = 1152 * 40;
  const parts = [];
  let last = performance.now();
  for (let i = 0; i < len; i += BLOCK) {
    const n = Math.min(BLOCK, len - i);
    const chunk = nch === 2
      ? enc.encodeBuffer(left.subarray(i, i + n), right.subarray(i, i + n))
      : enc.encodeBuffer(left.subarray(i, i + n));
    if (chunk.length) parts.push(new Int8Array(chunk));
    const now = performance.now();
    if (now - last > 60) {
      last = now;
      onProgress(i / len);
      await nextFrame();
    }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Int8Array(tail));
  onProgress(1);
  return new Blob(parts, { type: 'audio/mpeg' });
}

/* Первый вызов энкодера тратит ~3 с на прогрев JIT.
   Делаем это заранее на тишине, чтобы экспорт начинался сразу. */
let mp3Warm = false;
function warmUpMp3() {
  if (mp3Warm) return;
  mp3Warm = true;
  const w = getWorker();
  if (w) { w.postMessage({ warmup: true }); return; }
  const run = () => {
    try {
      const enc = new lamejs.Mp3Encoder(2, 44100, 128);
      const z = new Int16Array(1152);
      for (let i = 0; i < 20; i++) enc.encodeBuffer(z, z);
      enc.flush();
    } catch (e) { /* не критично */ }
  };
  if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}

/* ---------------- скачивание ---------------- */

el.fmtSel.addEventListener('change', () => {
  el.brWrap.style.display = el.fmtSel.value === 'mp3' ? '' : 'none';
});

el.dlBtn.addEventListener('click', async () => {
  if (!st.buffer || st.exporting) return;
  const dur = st.selEnd - st.selStart;
  if (dur < 0.01) { toast('Фрагмент слишком короткий — выделите побольше'); return; }

  st.exporting = true;
  el.dlBtn.disabled = true;
  el.prog.hidden = false;
  setProgress(0, 'готовлю…');

  try {
    await nextFrame();
    const a = extract(el.fadeChk.checked);
    const fmt = el.fmtSel.value;
    let blob, ext;

    if (fmt === 'wav') {
      setProgress(0.4, 'собираю wav…');
      await nextFrame();
      blob = encodeWav(a);
      ext = 'wav';
    } else {
      blob = await encodeMp3(a, parseInt(el.brSel.value, 10), (p) => setProgress(p * 0.98, 'кодирую mp3…'));
      ext = 'mp3';
    }

    setProgress(1, 'готово');
    const stamp = (t) => {
      const m = Math.floor(t / 60), sec = (t - m * 60).toFixed(1).padStart(4, '0');
      return `${m}м${sec}с`;
    };
    const fname = `${st.name}_${stamp(st.selStart)}-${stamp(st.selEnd)}.${ext}`;

    const url = URL.createObjectURL(blob);
    const a2 = document.createElement('a');
    a2.href = url;
    a2.download = fname;
    document.body.appendChild(a2);
    a2.click();
    a2.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);

    toast(`Скачано: ${fname} · ${(blob.size / 1048576).toFixed(2)} МБ`, true);
  } catch (err) {
    console.error(err);
    toast('Экспорт не удался: ' + (err && err.message ? err.message : err));
  } finally {
    st.exporting = false;
    el.dlBtn.disabled = false;
    setTimeout(() => { el.prog.hidden = true; }, 1200);
  }
});

function setProgress(p, label) {
  el.progBar.style.setProperty('--p', (p * 100).toFixed(1) + '%');
  const pct = Math.round(p * 100) + '%';
  el.progTxt.textContent = p >= 1 ? 'готово' : (label ? label + ' ' + pct : pct);
}
