// Score loading (MusicXML / compressed .mxl), part + transposition detection,
// OSMD rendering, note-sequence extraction and cursor control.
/* global opensheetmusicdisplay, JSZip */

/** Read a File into a MusicXML string (unzips .mxl). */
export async function readScoreFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
  if (!isZip) return decodeText(buf);
  if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load; cannot open .mxl files.');
  const zip = await JSZip.loadAsync(buf);
  let path = null;
  const container = zip.file('META-INF/container.xml');
  if (container) {
    const doc = new DOMParser().parseFromString(await container.async('string'), 'application/xml');
    path = doc.querySelector('rootfile')?.getAttribute('full-path') || null;
  }
  if (!path) {
    path = Object.keys(zip.files).find((n) => !n.startsWith('META-INF') && /\.(musicxml|xml)$/i.test(n));
  }
  if (!path || !zip.file(path)) throw new Error('No MusicXML file found inside the .mxl archive.');
  return decodeText(await zip.file(path).async('uint8array'));
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Inspect the raw MusicXML for parts, their first clef and any <transpose> element.
 * @returns {{id:string, name:string, clef:string, transposeSemis:number|null, autoSemis:number, autoReason:string}[]}
 */
export function analyzeParts(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This file is not valid MusicXML.');
  const root = doc.documentElement;
  if (root.nodeName === 'score-timewise') throw new Error('Timewise MusicXML is not supported; export partwise from MuseScore.');
  const names = {};
  doc.querySelectorAll('part-list > score-part').forEach((sp) => {
    names[sp.getAttribute('id')] = (sp.querySelector('part-name')?.textContent || '').trim();
  });
  return [...doc.querySelectorAll('score-partwise > part')].map((part, i) => {
    const id = part.getAttribute('id');
    const clefEl = part.querySelector('attributes clef');
    const sign = clefEl?.querySelector('sign')?.textContent.trim() || '';
    const line = clefEl?.querySelector('line')?.textContent.trim() || '';
    const clef = sign === 'G' ? 'treble' : sign === 'F' ? 'bass' : sign === 'C' ? (line === '4' ? 'tenor' : 'C') : sign || 'unknown';
    const tr = part.querySelector('attributes transpose');
    let transposeSemis = null;
    if (tr) {
      const chrom = parseInt(tr.querySelector('chromatic')?.textContent || '0', 10);
      const oct = parseInt(tr.querySelector('octave-change')?.textContent || '0', 10);
      transposeSemis = chrom + 12 * oct;
    }
    let autoSemis, autoReason;
    if (transposeSemis !== null) {
      autoSemis = transposeSemis;
      autoReason = `file says transpose ${transposeSemis >= 0 ? '+' : ''}${transposeSemis}`;
    } else if (clef === 'treble') {
      autoSemis = -14;
      autoReason = 'treble clef → B♭ transposing';
    } else {
      autoSemis = 0;
      autoReason = `${clef} clef → concert pitch`;
    }
    return { id, name: names[id] || `Part ${i + 1}`, clef, transposeSemis, autoSemis, autoReason };
  });
}

export class ScoreView {
  /** @param {HTMLElement} container OSMD host, @param {HTMLElement} scroller scrolling ancestor */
  constructor(container, scroller) {
    this.container = container;
    this.scroller = scroller;
    this.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
      backend: 'svg',
      autoResize: false,
      drawTitle: true,
      drawingParameters: 'default',
      followCursor: false,
      cursorsOptions: [{ type: 0, color: '#2f9e44', alpha: 0.45, follow: false }],
    });
    this.events = [];      // [{step, written, measure, x, y, h}]
    this.partIndex = 0;
    this.cursorStep = 0;
    this.highlighted = [];
    this.highlightColor = '#e8590c';
    this.loaded = false;
  }

  async load(xml) {
    this.loaded = false;
    await this.osmd.load(xml);
    this.loaded = true;
  }

  get partCount() { return this.osmd.Sheet ? this.osmd.Sheet.Instruments.length : 0; }

  /** Render, showing only the chosen part when soloPart is set. */
  render(partIndex, soloPart, zoom) {
    this.partIndex = partIndex;
    const ins = this.osmd.Sheet.Instruments;
    ins.forEach((inst, i) => { inst.Visible = !soloPart || i === partIndex; });
    this.osmd.zoom = zoom;
    this.highlighted = [];
    this.osmd.render();
    this.buildEvents();
  }

  get instrument() { return this.osmd.Sheet.Instruments[this.partIndex]; }

  /** Walk the cursor through the piece and record every played note of the chosen part. */
  buildEvents() {
    const c = this.osmd.cursor;
    const inst = this.instrument;
    c.show();
    c.reset();
    const base = this.scroller.getBoundingClientRect();
    const sx = this.scroller.scrollLeft, sy = this.scroller.scrollTop;
    const events = [];
    let step = 0;
    while (!c.Iterator.EndReached && step < 200000) {
      const it = c.Iterator;
      const notes = [];
      for (const ve of it.CurrentVoiceEntries) {
        if (ve.IsGrace) continue;
        if (ve.ParentSourceStaffEntry?.ParentStaff?.ParentInstrument !== inst) continue;
        for (const n of ve.Notes) if (!n.isRest() && n.Pitch) notes.push(n);
      }
      if (notes.length) {
        // Highest note if there are several (divisi / double stops).
        const top = notes.reduce((a, b) => (b.halfTone > a.halfTone ? b : a));
        const tie = top.NoteTie;
        const tieContinuation = tie && tie.StartNote && tie.StartNote !== top;
        if (!(tieContinuation && events.length)) {
          const r = c.cursorElement.getBoundingClientRect();
          events.push({
            step,
            written: top.halfTone + 12, // OSMD halfTone: A4 = 57 → MIDI 69
            measure: it.CurrentMeasureIndex,
            x: r.left - base.left + sx + r.width / 2,
            y: r.top - base.top + sy,
            h: r.height,
          });
        }
      }
      c.next();
      step++;
    }
    this.events = events;
    c.reset();
    this.cursorStep = 0;
    // Group into systems (lines) by vertical position, for page turning.
    const systems = [];
    for (const e of events) {
      const last = systems[systems.length - 1];
      if (!last || Math.abs(e.y - last.y) > 4) systems.push({ y: e.y, h: e.h });
      else last.h = Math.max(last.h, e.h);
      e.system = systems.length - 1;
    }
    this.systems = systems;
    // Free space between lines (ledger lines, dynamics live there) — used as turn padding.
    const gaps = systems.slice(1).map((s, i) => s.y - (systems[i].y + systems[i].h)).sort((a, b) => a - b);
    this.lineGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 60;
    return events;
  }

  /** Move the OSMD cursor to score event k and colour its notehead. */
  goTo(k) {
    if (!this.events.length) return;
    k = Math.max(0, Math.min(this.events.length - 1, k));
    const target = this.events[k].step;
    const c = this.osmd.cursor;
    const far = Math.abs(target - this.cursorStep) > 1;
    if (far) c.hide();
    if (target < this.cursorStep) { c.reset(); this.cursorStep = 0; }
    while (this.cursorStep < target && !c.Iterator.EndReached) { c.next(); this.cursorStep++; }
    if (far || c.Hidden) c.show();
    this.paintCurrent();
  }

  paintCurrent() {
    for (const el of this.highlighted) { el.style.fill = ''; el.style.stroke = ''; }
    this.highlighted = [];
    let gnotes = [];
    try { gnotes = this.osmd.cursor.GNotesUnderCursor(this.instrument) || []; } catch { gnotes = []; }
    for (const g of gnotes) {
      let heads = [];
      try { heads = g.getNoteheadSVGs?.() || []; } catch { heads = []; }
      for (const h of heads) {
        if (!h) continue;
        const els = [h, ...h.querySelectorAll('path')];
        for (const el of els) { el.style.fill = this.highlightColor; el.style.stroke = this.highlightColor; }
        this.highlighted.push(...els);
      }
    }
  }

  /** Score event nearest to a click at content coordinates (x, y). */
  eventAt(x, y) {
    let best = -1, bestD = Infinity;
    this.events.forEach((e, i) => {
      const inLine = y >= e.y - 10 && y <= e.y + e.h + 10;
      const d = (inLine ? 0 : 100000 + Math.abs(y - (e.y + e.h / 2)) * 10) + Math.abs(x - e.x);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }
}
