// Node tests for the pure parts: YIN accuracy and score following on synthetic
// euphonium-like tones. Run: node tests/run-tests.mjs
import { yin, rms } from '../js/yin.js';
import { Follower } from '../js/follower.js';
import { freqToMidi, midiToFreq, midiName } from '../js/notes.js';

const SR = 24000, FRAME = 1024, HOP = 256;
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// Brass-like spectrum: strong low harmonics, optional weak fundamental (low register).
function tone(midi, sec, { amp = 0.3, fundamental = 1, vibrato = 0.15, noise = 0.003, attack = 0.03, release = 0.04 } = {}) {
  const n = Math.round(sec * SR), out = new Float32Array(n), f0 = midiToFreq(midi);
  const harm = [fundamental, 0.9, 0.7, 0.55, 0.4, 0.3, 0.2, 0.12];
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 * Math.pow(2, (vibrato * Math.sin(2 * Math.PI * 5.5 * t)) / 12 / 10);
    phase += (2 * Math.PI * f) / SR;
    let s = 0;
    for (let h = 0; h < harm.length; h++) if ((h + 1) * f < SR / 2) s += harm[h] * Math.sin((h + 1) * phase);
    const env = Math.min(1, t / attack) * Math.min(1, (sec - t) / release);
    out[i] = amp * env * s / 3 + noise * (Math.random() * 2 - 1);
  }
  return out;
}
const silence = (sec, noise = 0.002) => Float32Array.from({ length: Math.round(sec * SR) }, () => noise * (Math.random() * 2 - 1));
function concat(chunks) {
  const out = new Float32Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
function* frames(sig) {
  for (let s = 0; s + FRAME <= sig.length; s += HOP) {
    const f = sig.subarray(s, s + FRAME);
    const r = rms(f);
    const p = r > 0.002 ? yin(f, SR) : null;
    yield { t: (s + FRAME) / SR, midi: p ? freqToMidi(p.freq) : null, rms: r };
  }
}
// Play a list of MIDI notes (tongued: short gap between notes).
const perform = (midis, beat = 0.42, opts = {}) =>
  concat([silence(0.3), ...midis.flatMap((m) => [tone(m, beat, opts), silence(0.03)]), silence(0.4)]);

function follow(score, sig, start = 0) {
  const fl = new Follower({ gate: 0.006 });
  fl.setScore(score);
  fl.setPosition(start);
  const visited = [];
  for (const fr of frames(sig)) {
    const r = fl.process(fr);
    if (r.moved) visited.push(fl.cur);
  }
  return { fl, visited };
}

// ---------- 1. YIN accuracy across the euphonium range ----------
{
  let worst = 0, worstNote = '';
  for (let m = 34; m <= 82; m++) {
    const fund = m < 46 ? 0.25 : 1; // pedal/low notes: weak fundamental
    const sig = tone(m, 0.5, { vibrato: 0, fundamental: fund });
    const f = sig.subarray(4000, 4000 + FRAME);
    const p = yin(f, SR);
    const err = p ? Math.abs(freqToMidi(p.freq) - m) * 100 : Infinity;
    if (err > worst) { worst = err; worstNote = midiName(m); }
  }
  check(worst < 10, `YIN B♭1–B♭5 within 10 cents (worst ${worst.toFixed(1)}¢ at ${worstNote})`);
  check(yin(silence(0.1, 0.01).subarray(0, FRAME), SR) === null || true, 'YIN on noise does not throw');
}

// ---------- the sample piece, concert pitch ----------
const B2 = 46, C3 = 48, D3 = 50, Eb3 = 51, F3 = 53, G3 = 55, A3 = 57, Bb3 = 58, C4 = 60, D4 = 62;
const piece = [B2, C3, D3, Eb3, F3, G3, A3, Bb3, Bb3, A3, G3, F3, Eb3, D3, C3, B2, F3, D3, F3, Bb3, D4, C4, Bb3, A3, F3, G3, A3, Bb3];

// ---------- 2. follows a clean performance, including the repeated B♭3 ----------
{
  const { fl, visited } = follow(piece, perform(piece));
  const inOrder = visited.every((v, i) => v === i);
  check(fl.cur === piece.length - 1 && inOrder, `clean performance: reached ${fl.cur + 1}/${piece.length}, strictly in order: ${inOrder}`);
}

// ---------- 3. skipped note + one wrong note ----------
{
  const played = piece.slice();
  played.splice(5, 1);          // skip G3
  played[12] = played[12] + 2;  // wrong note (E♭3 → F3)... follower should carry on
  const { fl } = follow(piece, perform(played));
  check(fl.cur === piece.length - 1, `skip + wrong note: reached ${fl.cur + 1}/${piece.length}`);
}

// ---------- 4. starts in bar 5 without telling the app ----------
{
  const from = 16;
  const { fl } = follow(piece, perform(piece.slice(from)));
  check(fl.cur === piece.length - 1, `start mid-piece: relocated and reached ${fl.cur + 1}/${piece.length}`);
}

// ---------- 5. low register with weak fundamentals (octave-error prone) ----------
{
  const low = [34, 36, 38, 39, 41, 43, 45, 46, 41, 34];
  const { fl } = follow(low, perform(low, 0.5, { fundamental: 0.2 }));
  check(fl.cur === low.length - 1, `low register B♭1–B♭2: reached ${fl.cur + 1}/${low.length}`);
}

// ---------- 6. high register ----------
{
  const high = [70, 72, 74, 75, 77, 79, 81, 82, 77, 70];
  const { fl } = follow(high, perform(high, 0.3));
  check(fl.cur === high.length - 1, `high register B♭4–B♭5: reached ${fl.cur + 1}/${high.length}`);
}

// ---------- 7. legato slur (no tonguing gap) and sustained note does not advance ----------
{
  const seq = [Bb3, C4, D4, Eb3 + 12, F3 + 12];
  const sig = concat([silence(0.3), ...seq.map((m) => tone(m, 0.4, { attack: 0.005, release: 0.005 })), silence(0.3)]);
  const { fl } = follow(seq, sig);
  check(fl.cur === seq.length - 1, `legato: reached ${fl.cur + 1}/${seq.length}`);
  const hold = follow([F3, F3, G3], concat([silence(0.2), tone(F3, 2.5), silence(0.3)]));
  check(hold.fl.cur === 0, `one long F3 against score F3 F3 G3 stays on note 1 (cur=${hold.fl.cur + 1})`);
}

// ---------- 8. repeat sign not expanded in the score: player goes back to bar 1 ----------
{
  const played = [...piece.slice(0, 12), ...piece.slice(0, 8)];
  const { fl } = follow(piece, perform(played));
  check(fl.cur === 7, `jump back for a repeat: ended on note ${fl.cur + 1} (expected 8)`);
}

// ---------- 9. noise only: no movement ----------
{
  const { fl } = follow(piece, silence(3, 0.004));
  check(fl.cur === -1, 'room noise below the gate does not move the cursor');
}

console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
