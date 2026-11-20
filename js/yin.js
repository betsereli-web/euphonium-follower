// YIN fundamental-frequency estimator (de Cheveigné & Kawahara, 2002).
// Pure function, no DOM — also used by the Node tests.

/**
 * @param {Float32Array} buf   analysis frame (mono)
 * @param {number} sampleRate  rate of `buf`
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.15] absolute threshold on the CMND function
 * @param {number} [opts.minFreq=45]     lowest pitch searched (Hz) — below pedal B♭1 (58 Hz)
 * @param {number} [opts.maxFreq=1000]   highest pitch searched (Hz) — above B♭5 (932 Hz)
 * @param {Float32Array} [opts.scratch]  optional reusable work buffer (length >= buf.length/2 + 1)
 * @returns {{freq:number, clarity:number}|null} null when unvoiced
 */
export function yin(buf, sampleRate, opts = {}) {
  const threshold = opts.threshold ?? 0.15;
  const minFreq = opts.minFreq ?? 45;
  const maxFreq = opts.maxFreq ?? 1000;

  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const tauMax = Math.min(Math.floor(sampleRate / minFreq), Math.floor(buf.length / 2));
  if (tauMax <= tauMin + 2) return null;
  const W = buf.length - tauMax;

  const d = opts.scratch && opts.scratch.length > tauMax ? opts.scratch : new Float32Array(tauMax + 1);

  // Step 2: difference function
  d[0] = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < W; j++) {
      const diff = buf[j] - buf[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // Step 3: cumulative mean normalized difference
  let running = 0;
  d[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }

  // Step 4: absolute threshold — first dip below threshold, then walk to its local minimum
  let tauEst = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau] < threshold) {
      while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
      tauEst = tau;
      break;
    }
  }
  if (tauEst === -1) {
    // No dip below threshold: fall back to the global minimum, but only accept clear-ish periodicity.
    let best = tauMin;
    for (let tau = tauMin + 1; tau <= tauMax; tau++) if (d[tau] < d[best]) best = tau;
    if (d[best] > 0.35) return null;
    tauEst = best;
  }

  // Step 5: parabolic interpolation
  let betterTau = tauEst;
  if (tauEst > 1 && tauEst < tauMax) {
    const s0 = d[tauEst - 1], s1 = d[tauEst], s2 = d[tauEst + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tauEst + (s2 - s0) / denom;
  }
  const freq = sampleRate / betterTau;
  if (freq < minFreq || freq > maxFreq) return null;
  return { freq, clarity: 1 - d[tauEst] };
}

export function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}
