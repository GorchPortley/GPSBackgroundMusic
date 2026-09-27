/**
 * Karplus–Strong plucked string, as an AudioWorkletProcessor.
 *
 * Loaded by AudioEngine.start() with audioWorklet.addModule(); played by
 * `ksVoice` in voices.js, one node per note. A delay line one period long is
 * filled with a burst of (low-passed) noise, then each output sample is the
 * average of two neighbouring samples, scaled by `damping`, written back into
 * the line. The averaging is a gentle low-pass inside the loop, so the upper
 * harmonics lose more per trip than the fundamental — which is exactly why it
 * sounds like a string rather than a buzz.
 *
 * AudioParams (k-rate):
 *   frequency   20–5000 Hz — clamped so the delay line stays a sane length
 *   damping     0.90–0.999 — loop gain per period (how long it rings)
 *   brightness  0–1        — low-pass on the excitation burst (and the burst
 *                            is only read at note start)
 *
 * processorOptions:
 *   startTime   seconds (AudioContext time) at which to pluck
 *   maxDur      seconds after startTime after which the node always ends
 *   seed        integer, seeds the noise so a note is reproducible
 *
 * The processor terminates (returns false) once the note has decayed below
 * audibility or maxDur has passed, so nodes never leak. Nothing is allocated
 * in process(); the delay line is sized once, for the lowest frequency.
 */

const MIN_FREQ = 20;
const MAX_FREQ = 5000;
const SILENT = 1e-4;        // block peak under which a decayed note ends
const FADE_S = 0.03;        // fade at the hard stop so a cap never clicks

// Live processors in this worklet scope; reported back when each one ends.
let live = 0;

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function finite(v, d) { return Number.isFinite(v) ? v : d; }

class KarplusStrongProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 220, minValue: MIN_FREQ, maxValue: MAX_FREQ, automationRate: 'k-rate' },
      { name: 'damping', defaultValue: 0.996, minValue: 0.9, maxValue: 0.999, automationRate: 'k-rate' },
      { name: 'brightness', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.startFrame = Math.max(0, Math.round(finite(o.startTime, 0) * sampleRate));
    const maxDur = clamp(finite(o.maxDur, 3), 0.05, 32);
    this.endFrame = this.startFrame + Math.round(maxDur * sampleRate);
    this.fadeFrames = Math.max(1, Math.round(FADE_S * sampleRate));
    this.seed = (finite(o.seed, 1) >>> 0) || 1;

    // One period at the lowest frequency, plus room for interpolation.
    this.len = Math.ceil(sampleRate / MIN_FREQ) + 4;
    this.buf = new Float32Array(this.len);
    this.w = 0;
    this.plucked = false;
    this.done = false;
    live++;
  }

  /** xorshift32 in [-1, 1) — deterministic per note. */
  _rand() {
    let x = this.seed;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.seed = x || 1;
    return (x / 4294967296) * 2 - 1;
  }

  /** Fill one period of the line with a low-passed, zero-mean noise burst. */
  _excite(freq, brightness) {
    const n = Math.min(this.len - 4, Math.max(2, Math.round(sampleRate / freq)));
    const a = 0.08 + 0.92 * brightness * brightness;   // one-pole coefficient
    const buf = this.buf;
    buf.fill(0);
    let s = 0, mean = 0;
    for (let i = 0; i < n; i++) {
      s += a * (this._rand() - s);
      buf[i] = s;
      mean += s;
    }
    mean /= n;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      buf[i] -= mean;
      const m = Math.abs(buf[i]);
      if (m > peak) peak = m;
    }
    const norm = peak > 0 ? 1 / peak : 0;
    for (let i = 0; i < n; i++) buf[i] *= norm;
    this.w = n % this.len;
    this.plucked = true;
  }

  _finish() {
    if (!this.done) {
      this.done = true;
      live--;
      this.port.postMessage({ done: true, live });
    }
    return false;
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0] && outputs[0][0];
    if (!out || this.done) return this._finish();
    const blockStart = currentFrame;
    const blockLen = out.length;

    if (blockStart + blockLen <= this.startFrame) return true;   // not yet
    if (blockStart >= this.endFrame) return this._finish();

    const freq = clamp(finite(parameters.frequency[0], 220), MIN_FREQ, MAX_FREQ);
    const damping = clamp(finite(parameters.damping[0], 0.996), 0.9, 0.999);
    if (!this.plucked) {
      this._excite(freq, clamp(finite(parameters.brightness[0], 0.5), 0, 1));
    }

    // Loop delay is D + 0.5 samples (the two-point average adds half a
    // sample), so read D = period − 0.5 behind the write head.
    const d = clamp(sampleRate / freq - 0.5, 1, this.len - 3);
    const di = Math.floor(d);
    const frac = d - di;
    const buf = this.buf, len = this.len;
    const fadeFrom = this.endFrame - this.fadeFrames;

    let w = this.w, peak = 0;
    const first = Math.max(0, this.startFrame - blockStart);
    for (let i = 0; i < first; i++) out[i] = 0;
    for (let i = first; i < blockLen; i++) {
      // Fractional read at d and d + 1, linear interpolation.
      let r0 = w - di; if (r0 < 0) r0 += len;
      let r1 = r0 - 1; if (r1 < 0) r1 += len;
      let r2 = r1 - 1; if (r2 < 0) r2 += len;
      const x0 = buf[r0] + (buf[r1] - buf[r0]) * frac;   // delay d
      const x1 = buf[r1] + (buf[r2] - buf[r1]) * frac;   // delay d + 1
      const y = damping * 0.5 * (x0 + x1);
      buf[w] = y;
      w++; if (w >= len) w = 0;

      const f = blockStart + i;
      const g = f >= fadeFrom ? Math.max(0, (this.endFrame - f) / this.fadeFrames) : 1;
      const v = y * g;
      out[i] = v;
      const m = v < 0 ? -v : v;
      if (m > peak) peak = m;
    }
    this.w = w;

    // Past the first period, a block this quiet means the string has died.
    const age = blockStart + blockLen - this.startFrame;
    if (age > sampleRate / freq * 2 && peak < SILENT) return this._finish();
    return true;
  }
}

registerProcessor('karplus-strong', KarplusStrongProcessor);
