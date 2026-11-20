// Microphone input → AudioWorklet frames → YIN on the main thread.
import { yin, rms } from './yin.js';
import { freqToMidi } from './notes.js';

export class PitchListener {
  /** @param {(f:{t:number, midi:number|null, freq:number|null, clarity:number, rms:number}) => void} onFrame */
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.rate = 24000;
    this.scratch = new Float32Array(2048);
    this.threshold = 0.15;
  }

  get running() { return !!this.ctx; }

  async start() {
    if (this.ctx) return;
    if (!window.isSecureContext) {
      throw new Error('The microphone needs a secure page: open the app via http://localhost or https://.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Speech processing ruins music: turn it all off.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(new URL('./pitch-worklet.js', import.meta.url));
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pitch-frame-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.node.port.onmessage = (e) => this.handle(e.data);
    src.connect(this.node);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  handle(msg) {
    if (msg.type === 'init') { this.rate = msg.sampleRate; return; }
    if (msg.type !== 'frame') return;
    const frame = msg.frame;
    const level = rms(frame);
    let freq = null, clarity = 0;
    if (level > 0.002) {
      const r = yin(frame, this.rate, { threshold: this.threshold, minFreq: 45, maxFreq: 1000, scratch: this.scratch });
      if (r) { freq = r.freq; clarity = r.clarity; }
    }
    this.onFrame({ t: msg.time, freq, midi: freq ? freqToMidi(freq) : null, clarity, rms: level });
  }

  async stop() {
    if (this.node) this.node.port.onmessage = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) await this.ctx.close();
    this.ctx = this.stream = this.node = null;
  }
}
