// Score follower: turns a stream of pitch frames into note onsets and matches them to
// the expected note sequence. Pure logic, no DOM — also used by the Node tests.
//
// Model: `cur` is the index of the last score note matched to the player (-1 = nothing yet).
// Each detected onset is matched against a small window of upcoming notes; skipping notes
// costs a little, a wrong octave (typical YIN error) or a semitone slip costs more. After
// several unmatched onsets in a row, the last few played pitches are searched across the
// whole piece, so jumps (repeats, D.S., starting mid-piece) are recovered.

const DEFAULTS = {
  gate: 0.01,          // RMS below this = silence
  minStableSec: 0.045, // a pitch must hold this long to count as a note
  minStableFrames: 3,
  dipRatio: 0.45,      // RMS falling below this fraction of the recent peak = articulation (tonguing)
  recoverRatio: 1.6,   // ...and rising this much above the dip minimum = new attack
  peakHalfLifeSec: 0.15,
  skipCost: 0.3,       // per skipped score note
  octaveCost: 0.5,
  semitoneCost: 0.8,
  maxCost: 1.0,
  window: 6,
  relocateAfter: 2,    // unmatched onsets in a row before a global search
  relocateCost: 1.5,   // ...or when the last few matches were this expensive in total (lots of skipping)
  relocateLen: 4,      // how many recent onsets the global search matches
};

export class Follower {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.notes = [];
    this.reset();
  }

  setOptions(opts) { Object.assign(this.o, opts); }

  /** @param {number[]} midis concert-pitch MIDI number of each score note, in order */
  setScore(midis) {
    this.notes = midis.slice();
    this.setPosition(0);
  }

  /** Make score note k the next one expected. */
  setPosition(k) {
    this.cur = Math.max(-1, Math.min(this.notes.length - 1, k - 1));
    this.misses = 0;
    this.history = [];
    this.costs = [];
  }

  reset() {
    this.cur = -1;
    this.misses = 0;
    this.history = [];
    this.costs = [];
    this.candPitch = null;
    this.candSince = 0;
    this.candFrames = 0;
    this.candCommitted = false;
    this.committedPitch = null;
    this.articulated = false;
    this.dipLevel = Infinity;
    this.peak = 0;
    this.lastT = null;
  }

  /** Index to display: the note being played, or the first expected note before anything matched. */
  get displayIndex() { return Math.max(this.cur, Math.min(0, this.notes.length - 1)); }

  /**
   * Feed one analysis frame.
   * @param {{t:number, midi:number|null, rms:number}} f
   * @returns {{onset:number|null, moved:boolean, index:number, relocated?:boolean}}
   */
  process(f) {
    const o = this.o;
    const dt = this.lastT == null ? 0.01 : Math.max(0.001, f.t - this.lastT);
    this.lastT = f.t;
    const out = { onset: null, moved: false, index: this.cur };

    // Envelope peak with exponential decay; detect articulation dips.
    this.peak = Math.max(f.rms, this.peak * Math.pow(0.5, dt / o.peakHalfLifeSec));
    const voiced = f.midi != null && f.rms >= o.gate;

    if (!voiced) {
      if (this.committedPitch != null) this.articulated = true;
      this.dipLevel = Math.min(this.dipLevel, f.rms);
      this.candPitch = null;
      return out;
    }

    if (f.rms < this.peak * o.dipRatio) {
      if (!this.articulated) this.articulated = true;
      this.dipLevel = Math.min(this.dipLevel, f.rms);
      this.candSince = f.t; // need fresh stability after the dip
      this.candFrames = 0;
      this.candCommitted = false;
    }

    const p = Math.round(f.midi);
    if (p !== this.candPitch) {
      this.candPitch = p;
      this.candSince = f.t;
      this.candFrames = 0;
      this.candCommitted = false;
    }
    this.candFrames++;

    const stable = f.t - this.candSince >= o.minStableSec && this.candFrames >= o.minStableFrames;
    if (!stable || this.candCommitted) return out;

    const changed = p !== this.committedPitch;
    const reattacked = this.articulated && f.rms > this.dipLevel * o.recoverRatio;
    if (!changed && !reattacked) return out;

    this.candCommitted = true;
    this.committedPitch = p;
    this.articulated = false;
    this.dipLevel = Infinity;
    out.onset = p;
    const res = this.onOnset(p, !changed);
    out.moved = res.moved;
    out.relocated = res.relocated;
    out.index = this.cur;
    return out;
  }

  pitchCost(p, e, skipped) {
    const d = Math.abs(p - e);
    if (d === 0) return 0;
    if ((d === 12 || d === 24) && skipped <= 1) return this.o.octaveCost;
    if (d === 1 && skipped === 0) return this.o.semitoneCost;
    return Infinity;
  }

  /** Match one onset. Exposed for tests. */
  onOnset(p, rearticulated = false) {
    const o = this.o, n = this.notes.length;
    if (!n) return { moved: false };

    // Re-tonguing the note we're already on, when the score doesn't repeat it: ignore.
    if (rearticulated && this.cur >= 0 && this.notes[this.cur] === p &&
        !(this.cur + 1 < n && this.notes[this.cur + 1] === p)) {
      return { moved: false };
    }

    this.history.push(p);
    if (this.history.length > 16) this.history.shift();

    let best = -1, bestCost = Infinity;
    for (let j = this.cur + 1; j < Math.min(n, this.cur + 1 + o.window); j++) {
      const skipped = j - this.cur - 1;
      const c = skipped * o.skipCost + this.pitchCost(p, this.notes[j], skipped);
      if (c < bestCost) { bestCost = c; best = j; }
    }
    let moved = false;
    if (best >= 0 && bestCost <= o.maxCost) {
      this.cur = best;
      this.misses = 0;
      this.costs.push(bestCost);
      moved = true;
    } else {
      this.misses++;
      this.costs.push(1);
    }
    if (this.costs.length > 16) this.costs.shift();

    // Lost? Either several misses in a row, or a run of expensive (skipping) matches
    // that doesn't agree with the score at the current spot.
    const recentCost = this.costs.slice(-o.relocateLen).reduce((a, b) => a + b, 0);
    if ((this.misses >= o.relocateAfter || recentCost >= o.relocateCost) && !this.historyMatchesAt(this.cur, 3)) {
      const j = this.relocate();
      if (j >= 0 && j !== this.cur) {
        this.cur = j;
        this.misses = 0;
        this.costs = [];
        return { moved: true, relocated: true };
      }
    }
    return { moved };
  }

  /** Do the last L played pitches equal the score notes ending at index j? */
  historyMatchesAt(j, L, mode = 'exact') {
    const h = this.history;
    if (h.length < L || j - L + 1 < 0) return false;
    for (let k = 0; k < L; k++) {
      const a = this.notes[j - L + 1 + k], b = h[h.length - L + k];
      if (mode === 'exact' ? a !== b : ((a - b) % 12 + 12) % 12 !== 0) return false;
    }
    return true;
  }

  /** Find where the last few played pitches occur in the score; closest to the current spot wins. */
  relocate() {
    const L = this.o.relocateLen, n = this.notes.length;
    // Longest exact match first, then a shorter one, then ignoring octave (detector octave slips).
    for (const [len, mode] of [[L, 'exact'], [L - 1, 'exact'], [L, 'class']]) {
      if (this.history.length < len || len < 2) continue;
      let best = -1, bestDist = Infinity;
      for (let j = len - 1; j < n; j++) {
        if (!this.historyMatchesAt(j, len, mode)) continue;
        const dist = Math.abs(j - this.cur) + (j < this.cur ? 0.5 : 0); // tie-break forwards
        if (dist < bestDist) { bestDist = dist; best = j; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }
}
