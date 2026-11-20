// AudioWorklet: collects mic samples, low-passes + decimates to ~24 kHz, and posts
// overlapping analysis frames to the main thread (where YIN runs).
// A 1024-sample frame at 24 kHz covers lags down to ~47 Hz, below pedal B♭1 (58 Hz).

const FRAME = 1024;
const HOP = 256; // ≈ 10.7 ms at 24 kHz

class PitchFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate is a global in AudioWorkletGlobalScope
    this.factor = sampleRate >= 88200 ? 4 : sampleRate >= 44100 ? 2 : 1;
    this.outRate = sampleRate / this.factor;
    this.ring = new Float32Array(FRAME);
    this.write = 0;
    this.sinceHop = 0;
    this.acc = 0;
    this.accN = 0;
    this.prev = 0;
    this.port.postMessage({ type: 'init', sampleRate: this.outRate });
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // simple 2-tap smoothing + boxcar decimation (euphonium energy is far below the new Nyquist)
      const x = 0.5 * (ch[i] + this.prev);
      this.prev = ch[i];
      this.acc += x;
      if (++this.accN < this.factor) continue;
      const y = this.acc / this.factor;
      this.acc = 0;
      this.accN = 0;

      this.ring[this.write] = y;
      this.write = (this.write + 1) % FRAME;
      if (++this.sinceHop >= HOP) {
        this.sinceHop = 0;
        const frame = new Float32Array(FRAME);
        frame.set(this.ring.subarray(this.write));
        frame.set(this.ring.subarray(0, this.write), FRAME - this.write);
        this.port.postMessage({ type: 'frame', frame, time: currentTime }, [frame.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('pitch-frame-processor', PitchFrameProcessor);
