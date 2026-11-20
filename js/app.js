import { ScoreView, readScoreFile, analyzeParts } from './score.js';
import { PitchListener } from './audio.js';
import { Follower } from './follower.js';
import { midiName, TRANSPOSITIONS } from './notes.js';

const $ = (id) => document.getElementById(id);
const ui = {
  file: $('file'), sample: $('sample'), part: $('part'), transpose: $('transpose'), mode: $('mode'),
  zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomLabel: $('zoomLabel'), fullscreen: $('fullscreen'),
  listen: $('listen'), restart: $('restart'), level: $('level'), gateMark: $('gateMark'),
  noteName: $('noteName'), cents: $('cents'), gate: $('gate'), solo: $('solo'), turnAt: $('turnAt'),
  scroller: $('scroller'), osmd: $('osmd'), empty: $('empty'), status: $('status'),
};

// ---------- settings (per-viewer convenience only) ----------
const SETTINGS_KEY = 'euph-follower-settings';
const settings = { transpose: 'auto', mode: 'page', zoom: 1, gate: 50, solo: true, turnAt: 'last' };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* storage unavailable */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };

for (const [key, t] of Object.entries(TRANSPOSITIONS)) ui.transpose.add(new Option(t.label, key));
ui.transpose.value = settings.transpose;
ui.mode.value = settings.mode;
ui.gate.value = settings.gate;
ui.solo.checked = settings.solo;
ui.turnAt.value = settings.turnAt;

// ---------- state ----------
if (typeof opensheetmusicdisplay === 'undefined') {
  ui.status.textContent = 'OpenSheetMusicDisplay failed to load. Check your internet connection and reload.';
  ui.status.className = 'show error';
  throw new Error('OSMD not loaded');
}
const view = new ScoreView(ui.osmd, ui.scroller);
const follower = new Follower();
const listener = new PitchListener(onFrame);
let parts = [];
let currentXml = null;
let displayed = -1;
let wakeLock = null;
window.euphFollower = { view, follower, listener }; // for debugging from the console

const gateFromSlider = (v) => Math.pow(10, -1.2 - 2.3 * (v / 100)); // 0.063 … 0.0003 RMS
const levelPct = (r) => Math.max(0, Math.min(100, ((20 * Math.log10(Math.max(r, 1e-6)) + 60) / 60) * 100));
function applyGate() {
  const g = gateFromSlider(+ui.gate.value);
  follower.setOptions({ gate: g });
  ui.gateMark.style.left = `${levelPct(g)}%`;
}
applyGate();

let statusTimer;
function status(msg, isError = false, ms = 3500) {
  ui.status.textContent = msg;
  ui.status.classList.toggle('error', isError);
  ui.status.classList.add('show');
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => ui.status.classList.remove('show'), ms);
}

// ---------- transposition ----------
function transposeSemis() {
  const t = TRANSPOSITIONS[ui.transpose.value];
  if (t.semis !== null) return t.semis;
  return parts[+ui.part.value || 0]?.autoSemis ?? 0;
}
function updateAutoLabel() {
  const p = parts[+ui.part.value || 0];
  const opt = ui.transpose.querySelector('option[value="auto"]');
  opt.textContent = p ? `Auto (${p.autoReason})` : TRANSPOSITIONS.auto.label;
}
function pushScoreToFollower(keepIndex) {
  const semis = transposeSemis();
  follower.setScore(view.events.map((e) => e.written + semis));
  const k = keepIndex ?? 0;
  follower.setPosition(k);
  show(k, true);
}

// ---------- loading ----------
async function loadXml(xml, label) {
  try {
    status(`Loading ${label}…`, false, 0);
    parts = analyzeParts(xml);
    if (!parts.length) throw new Error('No parts found in this file.');
    currentXml = xml;
    await view.load(xml);
    ui.part.innerHTML = '';
    parts.forEach((p, i) => ui.part.add(new Option(`${p.name} (${p.clef})`, i)));
    // Prefer a part that looks like ours.
    const guess = parts.findIndex((p) => /euph|bariton|tenor tuba/i.test(p.name));
    ui.part.value = String(guess >= 0 ? guess : 0);
    ui.part.disabled = parts.length < 2;
    updateAutoLabel();
    ui.empty.hidden = true;
    ui.osmd.hidden = false; // must be laid out (non-zero width) before OSMD renders
    renderScore(0);
    ui.listen.disabled = false;
    ui.restart.disabled = false;
    const semis = transposeSemis();
    status(`${label}: ${view.events.length} notes. Reading as ${semis === 0 ? 'concert pitch' : `written ${semis > 0 ? '+' : ''}${semis} semitones`}.`);
  } catch (err) {
    console.error(err);
    status(`Could not load ${label}: ${err.message || err}`, true, 8000);
  }
}

function renderScore(keepIndex) {
  if (!view.loaded) return;
  const t0 = performance.now();
  view.render(+ui.part.value || 0, settings.solo && parts.length > 1, settings.zoom);
  ui.zoomLabel.textContent = `${Math.round(settings.zoom * 100)}%`;
  if (!view.events.length) status('This part has no notes the follower can use.', true, 6000);
  displayed = -1;
  pushScoreToFollower(Math.min(keepIndex ?? 0, Math.max(0, view.events.length - 1)));
  document.body.dataset.notes = view.events.length;
  document.body.dataset.firstNotes = view.events.slice(0, 8).map((e) => e.written).join(',');
  console.debug(`render + index: ${(performance.now() - t0).toFixed(0)} ms, ${view.events.length} notes, ${view.systems.length} lines`);
}

ui.file.addEventListener('change', async () => {
  const f = ui.file.files[0];
  ui.file.value = '';
  if (!f) return;
  try { await loadXml(await readScoreFile(f), f.name); } catch (err) { status(err.message, true, 8000); }
});
async function loadUrl(url, label) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    await loadXml(await readScoreFile(blob), label);
  } catch (err) {
    status(`Could not load ${label}: ${err.message}`, true, 8000);
  }
}
ui.sample.addEventListener('click', () => loadUrl('samples/practice-piece.musicxml', 'Sample'));

// ?score=<url of a .musicxml/.mxl> or ?sample opens a piece directly (handy as a bookmark).
const params = new URLSearchParams(location.search);
if (params.has('score')) loadUrl(params.get('score'), params.get('score').split('/').pop());
else if (params.has('sample')) loadUrl('samples/practice-piece.musicxml', 'Sample');

// drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  try { await loadXml(await readScoreFile(f), f.name); } catch (err) { status(err.message, true, 8000); }
});

// ---------- display + page turning ----------
function show(k, force = false) {
  if (!view.events.length) return;
  if (k === displayed && !force) return;
  displayed = k;
  view.goTo(k);
  turnPageFor(k, force);
}

function turnPageFor(k, force) {
  const ev = view.events[k];
  if (!ev) return;
  const sc = ui.scroller;
  const top = sc.scrollTop, h = sc.clientHeight;
  const margin = Math.max(12, Math.min(80, view.lineGap * 0.45)); // room for ledger lines above/below the staff
  const sys = view.systems[ev.system];
  const next = view.systems[ev.system + 1];
  const sysTop = sys.y - margin, sysBottom = sys.y + sys.h + margin;

  if (settings.mode === 'scroll') {
    const target = ev.system === 0 ? 0 : sys.y - h * 0.2;
    if (force || Math.abs(target - top) > 4) sc.scrollTo({ top: Math.max(0, target), behavior: force ? 'auto' : 'smooth' });
    return;
  }
  // Page mode: jump in whole "screens", keeping the line being played visible.
  const offscreen = sysTop < top || sysBottom > top + h;
  const lastVisibleLine = settings.turnAt === 'last' && next && next.y + next.h + margin > top + h;
  if (offscreen || lastVisibleLine || force) {
    const target = ev.system === 0 ? 0 : Math.max(0, sysTop);
    if (force || Math.abs(target - top) > 2) sc.scrollTo({ top: target, behavior: 'auto' });
  }
}

function manualTurn(dir) {
  const sc = ui.scroller;
  sc.scrollBy({ top: dir * (sc.clientHeight - 40), behavior: settings.mode === 'scroll' ? 'smooth' : 'auto' });
}

// click a note to jump there
ui.scroller.addEventListener('click', (e) => {
  if (!view.events.length || e.target.closest('#empty')) return;
  const r = ui.scroller.getBoundingClientRect();
  const k = view.eventAt(e.clientX - r.left + ui.scroller.scrollLeft, e.clientY - r.top + ui.scroller.scrollTop);
  if (k < 0) return;
  follower.setPosition(k);
  displayed = -1;
  view.goTo(k);
  displayed = k;
  status(`Waiting for note ${k + 1} (bar ${view.events[k].measure + 1})`, false, 1500);
});

// ---------- listening ----------
let lastUi = 0;
function onFrame(f) {
  const res = follower.process(f);
  if (res.moved) show(follower.displayIndex);
  if (res.relocated) status(`Found you in bar ${view.events[follower.cur].measure + 1}`, false, 1500);

  const now = performance.now();
  if (now - lastUi < 50) return; // tuner display at ~20 fps
  lastUi = now;
  ui.level.style.width = `${levelPct(f.rms)}%`;
  if (f.midi != null && f.rms >= follower.o.gate) {
    const semis = transposeSemis();
    const near = Math.round(f.midi);
    const cents = Math.round((f.midi - near) * 100);
    ui.noteName.textContent = semis ? midiName(near - semis) : midiName(near);
    ui.cents.textContent = `${cents >= 0 ? '+' : ''}${cents}¢${semis ? ` · concert ${midiName(near)}` : ''}`;
  } else {
    ui.noteName.textContent = '–';
    ui.cents.textContent = '';
  }
}

async function toggleListen() {
  if (ui.listen.disabled) return;
  if (listener.running) {
    await listener.stop();
    ui.listen.classList.remove('on');
    ui.listen.querySelector('.label').textContent = 'Listen';
    ui.level.style.width = '0';
    ui.noteName.textContent = '–';
    ui.cents.textContent = '';
    releaseWakeLock();
    return;
  }
  try {
    await listener.start();
    follower.reset();
    follower.setPosition(Math.max(0, displayed));
    ui.listen.classList.add('on');
    ui.listen.querySelector('.label').textContent = 'Stop';
    requestWakeLock();
    status('Listening. Start playing from the highlighted note.');
  } catch (err) {
    console.error(err);
    const msg = err.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the address bar and try again.' : err.message;
    status(msg, true, 8000);
  }
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}
function releaseWakeLock() { try { wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && listener.running) requestWakeLock();
});

// ---------- controls ----------
ui.listen.addEventListener('click', toggleListen);
ui.restart.addEventListener('click', () => { follower.setPosition(0); show(0, true); });
ui.part.addEventListener('change', () => { updateAutoLabel(); renderScore(0); });
ui.transpose.addEventListener('change', () => {
  settings.transpose = ui.transpose.value; saveSettings();
  pushScoreToFollower(Math.max(0, displayed));
});
ui.mode.addEventListener('change', () => { settings.mode = ui.mode.value; saveSettings(); show(Math.max(0, displayed), true); });
ui.turnAt.addEventListener('change', () => { settings.turnAt = ui.turnAt.value; saveSettings(); });
ui.gate.addEventListener('input', () => { settings.gate = +ui.gate.value; saveSettings(); applyGate(); });
ui.solo.addEventListener('change', () => { settings.solo = ui.solo.checked; saveSettings(); renderScore(Math.max(0, displayed)); });
function setZoom(z) {
  settings.zoom = Math.max(0.4, Math.min(2.5, Math.round(z * 10) / 10));
  saveSettings();
  renderScore(Math.max(0, displayed));
}
ui.zoomIn.addEventListener('click', () => setZoom(settings.zoom + 0.1));
ui.zoomOut.addEventListener('click', () => setZoom(settings.zoom - 0.1));
ui.fullscreen.addEventListener('click', toggleFullscreen);
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

window.addEventListener('keydown', (e) => {
  if (e.target.closest('select, input')) return;
  const has = view.events.length > 0;
  switch (e.key) {
    case ' ': e.preventDefault(); toggleListen(); break;
    case 'ArrowRight': if (has) { e.preventDefault(); const k = Math.min(view.events.length - 1, Math.max(0, displayed) + 1); follower.setPosition(k); show(k); } break;
    case 'ArrowLeft': if (has) { e.preventDefault(); const k = Math.max(0, displayed - 1); follower.setPosition(k); show(k); } break;
    case 'Home': if (has) { e.preventDefault(); follower.setPosition(0); show(0, true); } break;
    case 'PageDown': e.preventDefault(); manualTurn(1); break;
    case 'PageUp': e.preventDefault(); manualTurn(-1); break;
    case 'f': case 'F': toggleFullscreen(); break;
    default: break;
  }
});

// Re-layout when the width changes (rotate tablet, resize window).
let lastWidth = ui.scroller.clientWidth, resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = ui.scroller.clientWidth;
    if (Math.abs(w - lastWidth) < 20 || !currentXml) return;
    lastWidth = w;
    renderScore(Math.max(0, displayed));
  }, 250);
}).observe(ui.scroller);
