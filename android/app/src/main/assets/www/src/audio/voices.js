/**
 * Synth voices. Everything here is generated from oscillators and noise at
 * runtime — there are no samples to load, which is what lets the timbre morph
 * continuously as the scene changes instead of crossfading between clips.
 *
 * Every voice takes an `io` bundle from the engine:
 *   { ctx, dry, reverb, delay, noiseBuffer, hasWorklets }
 * where dry/reverb/delay are destination GainNodes (the sends).
 */

import { midiToFreq } from './theory.js';

const SILENCE = 0.0001; // exponential ramps cannot reach true zero

/* ------------------------------------------------------------------ shared */

/**
 * Route a voice to the dry path plus optional reverb and delay sends, and
 * tear the whole chain down once it has finished sounding.
 */
function route(io, node, endTime, { reverb = 0, delay = 0 } = {}) {
  node.connect(io.dry);

  const extras = [];
  if (reverb > 0 && io.reverb) {
    const g = io.ctx.createGain();
    g.gain.value = reverb;
    node.connect(g).connect(io.reverb);
    extras.push(g);
  }
  if (delay > 0 && io.delay) {
    const g = io.ctx.createGain();
    g.gain.value = delay;
    node.connect(g).connect(io.delay);
    extras.push(g);
  }

  // Disconnect a little after the tail so nothing is left hanging on the bus.
  const ms = Math.max(0, (endTime - io.ctx.currentTime + 0.3)) * 1000;
  setTimeout(() => {
    try {
      node.disconnect();
      extras.forEach((g) => g.disconnect());
    } catch { /* already gone */ }
  }, ms);
}

/** Slow swell / slow fall, used by sustained voices. */
function swellEnvelope(param, { time, dur, peak, attack, release }) {
  const a = Math.min(attack, dur * 0.45);
  const r = Math.min(release, dur * 0.5);
  param.setValueAtTime(SILENCE, time);
  param.exponentialRampToValueAtTime(Math.max(SILENCE, peak), time + a);
  param.setValueAtTime(Math.max(SILENCE, peak), time + Math.max(a, dur - r));
  param.exponentialRampToValueAtTime(SILENCE, time + dur);
}

/** Instant attack, exponential fall, used by struck/plucked voices. */
function pluckEnvelope(param, { time, peak, attack = 0.006, decay }) {
  param.setValueAtTime(SILENCE, time);
  param.linearRampToValueAtTime(Math.max(SILENCE, peak), time + attack);
  param.exponentialRampToValueAtTime(SILENCE, time + attack + decay);
}

function noiseSource(io, time, duration) {
  const src = io.ctx.createBufferSource();
  src.buffer = io.noiseBuffer;
  src.loop = true;
  src.playbackRate.value = 0.85 + Math.random() * 0.3;

  // Start somewhere random in the buffer so repeated hits do not phase-lock
  // into an audible pattern. The source loops, so `duration` may exceed the
  // buffer length — only the offset has to stay inside it.
  const maxOffset = Math.max(0, io.noiseBuffer.duration - 0.05);
  src.start(time, Math.random() * maxOffset);
  src.stop(time + duration);
  return src;
}

/* -------------------------------------------------------------------- pads */

/**
 * Chord pad: detuned saw/triangle stack through a lowpass that opens with the
 * swell. The backbone of the score.
 */
export function padVoice(io, {
  notes, time, dur, gain = 0.1, wave = 'sawtooth',
  detune = 8, cutoff = 1400, resonance = 0.7, reverb = 0.5, spreadStereo = true,
}) {
  const ctx = io.ctx;
  const out = ctx.createGain();
  swellEnvelope(out.gain, { time, dur, peak: gain, attack: 2.4, release: 3.2 });

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = resonance;
  filter.frequency.setValueAtTime(Math.max(180, cutoff * 0.45), time);
  filter.frequency.linearRampToValueAtTime(cutoff, time + Math.min(3.5, dur * 0.5));
  filter.frequency.linearRampToValueAtTime(Math.max(180, cutoff * 0.6), time + dur);
  filter.connect(out);

  const oscs = [];
  notes.forEach((note, i) => {
    const freq = midiToFreq(note);
    // Two slightly detuned copies per note give the pad its movement.
    for (const cents of [-detune, detune]) {
      const osc = ctx.createOscillator();
      osc.type = wave;
      osc.frequency.value = freq;
      osc.detune.value = cents;

      const voiceGain = ctx.createGain();
      // Roll the top of the chord back so it does not get shrill.
      voiceGain.gain.value = (1 / (notes.length * 2)) * (1 - i * 0.08);

      if (spreadStereo && ctx.createStereoPanner) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = (cents > 0 ? 1 : -1) * (0.15 + i * 0.12);
        osc.connect(voiceGain).connect(pan).connect(filter);
      } else {
        osc.connect(voiceGain).connect(filter);
      }

      osc.start(time);
      osc.stop(time + dur + 0.1);
      oscs.push(osc);
    }
  });

  route(io, out, time + dur, { reverb });
  return out;
}

/* -------------------------------------------------------------------- bass */

export function bassVoice(io, { note, time, dur, gain = 0.22, cutoff = 320, reverb = 0.08 }) {
  const ctx = io.ctx;
  const freq = midiToFreq(note);

  const out = ctx.createGain();
  out.gain.setValueAtTime(SILENCE, time);
  out.gain.linearRampToValueAtTime(gain, time + 0.04);
  out.gain.setValueAtTime(gain, time + Math.max(0.06, dur * 0.6));
  out.gain.exponentialRampToValueAtTime(SILENCE, time + dur);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  filter.Q.value = 0.6;
  filter.connect(out);

  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = freq;
  const subGain = ctx.createGain();
  subGain.gain.value = 0.85;
  sub.connect(subGain).connect(filter);

  // A quiet triangle an octave up keeps the bass audible on phone speakers.
  const body = ctx.createOscillator();
  body.type = 'triangle';
  body.frequency.value = freq * 2;
  const bodyGain = ctx.createGain();
  bodyGain.gain.value = 0.18;
  body.connect(bodyGain).connect(filter);

  sub.start(time); sub.stop(time + dur + 0.05);
  body.start(time); body.stop(time + dur + 0.05);

  route(io, out, time + dur, { reverb });
}

/* ------------------------------------------------------------------ plucks */

/**
 * Additive pluck — fundamental plus two decaying partials through a closing
 * lowpass. Reads as a soft mallet or a muted string depending on `bright`.
 */
export function pluckVoice(io, {
  note, time, gain = 0.12, decay = 1.2, bright = 0.5, reverb = 0.35, delay = 0.25, pan = 0,
}) {
  const ctx = io.ctx;
  const freq = midiToFreq(note);

  const out = ctx.createGain();
  pluckEnvelope(out.gain, { time, peak: gain, decay });

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  const openCutoff = Math.min(12000, freq * (4 + bright * 14));
  filter.frequency.setValueAtTime(openCutoff, time);
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(200, freq * 1.6), time + decay * 0.9);
  filter.Q.value = 0.8;

  if (pan !== 0 && ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    filter.connect(panner).connect(out);
  } else {
    filter.connect(out);
  }

  const partials = [
    { ratio: 1, level: 1.0, type: 'triangle' },
    { ratio: 2, level: 0.32 * bright, type: 'sine' },
    { ratio: 3.01, level: 0.14 * bright, type: 'sine' },
  ];
  const end = time + decay + 0.1;
  for (const p of partials) {
    if (p.level <= 0.001) continue;
    const osc = ctx.createOscillator();
    osc.type = p.type;
    osc.frequency.value = freq * p.ratio;
    const g = ctx.createGain();
    g.gain.setValueAtTime(p.level, time);
    // Upper partials die first, which is what makes it sound struck.
    g.gain.exponentialRampToValueAtTime(SILENCE, time + decay / p.ratio);
    osc.connect(g).connect(filter);
    osc.start(time);
    osc.stop(end);
  }

  route(io, out, end, { reverb, delay });
}

/* ------------------------------------------------------------------- bells */

/** Two-operator FM bell. Sparse, high, drenched in reverb. */
export function bellVoice(io, {
  note, time, gain = 0.08, decay = 3.5, ratio = 2.01, index = 3, reverb = 0.75, delay = 0.3,
}) {
  const ctx = io.ctx;
  const freq = midiToFreq(note);
  const end = time + decay + 0.15;

  const out = ctx.createGain();
  pluckEnvelope(out.gain, { time, peak: gain, attack: 0.01, decay });

  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = freq;

  const modulator = ctx.createOscillator();
  modulator.type = 'sine';
  modulator.frequency.value = freq * ratio;

  const modDepth = ctx.createGain();
  modDepth.gain.setValueAtTime(freq * index, time);
  // Collapsing the modulation index is what turns a clang into a pure tone.
  modDepth.gain.exponentialRampToValueAtTime(freq * 0.05, time + decay * 0.45);

  modulator.connect(modDepth).connect(carrier.frequency);
  carrier.connect(out);

  modulator.start(time); modulator.stop(end);
  carrier.start(time); carrier.stop(end);

  route(io, out, end, { reverb, delay });
}

/** Finite number or the default — pack params can be anything. */
function finite(v, d) { return Number.isFinite(v) ? v : d; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/**
 * General two-operator FM: sine modulator at `f * ratio` → depth gain →
 * carrier.frequency. Unlike `bell` it holds for `dur` and releases, so it can
 * be an electric piano (`ratio: 1`), a bell (`3.5`) or a glassy lead (`7`).
 * `index` is the peak modulation depth in multiples of the carrier frequency;
 * it falls to 5% of that over `decay` seconds, which is what turns the struck
 * clang into a purer tone.
 */
export function fmVoice(io, {
  note, time, dur, gain = 0.08, ratio = 2, index = 2, decay = 0.6,
  release = 0.3, reverb = 0.3, delay = 0, pan = 0,
}) {
  const ctx = io.ctx;
  const freq = midiToFreq(note);
  if (!Number.isFinite(freq) || !Number.isFinite(time)) return;

  const d = clamp(finite(dur, 0.5), 0.02, 30);
  const peak = Math.max(0, finite(gain, 0.08));
  const r = clamp(finite(ratio, 2), 0.25, 12);
  const idx = clamp(finite(index, 2), 0, 12);
  const dec = clamp(finite(decay, 0.6), 0.01, 30);
  const rel = clamp(finite(release, 0.3), 0.01, 10);
  const p = clamp(finite(pan, 0), -1, 1);
  const end = time + d + rel + 0.1;

  const out = ctx.createGain();
  const attack = Math.min(0.005, d * 0.5);
  out.gain.setValueAtTime(SILENCE, time);
  out.gain.linearRampToValueAtTime(Math.max(SILENCE, peak), time + attack);
  out.gain.setValueAtTime(Math.max(SILENCE, peak), time + d);
  out.gain.exponentialRampToValueAtTime(SILENCE, time + d + rel);

  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = freq;

  const modulator = ctx.createOscillator();
  modulator.type = 'sine';
  modulator.frequency.value = freq * r;

  const modDepth = ctx.createGain();
  if (idx > 0) {
    modDepth.gain.setValueAtTime(idx * freq, time);
    modDepth.gain.exponentialRampToValueAtTime(idx * freq * 0.05, time + dec);
  } else {
    modDepth.gain.value = 0;
  }
  modulator.connect(modDepth).connect(carrier.frequency);

  let panner = null;
  if (p !== 0 && ctx.createStereoPanner) {
    panner = ctx.createStereoPanner();
    panner.pan.value = p;
    carrier.connect(panner).connect(out);
  } else {
    carrier.connect(out);
  }

  modulator.start(time); modulator.stop(end);
  carrier.start(time); carrier.stop(end);
  carrier.onended = () => {
    try {
      modulator.disconnect(); modDepth.disconnect(); carrier.disconnect();
      if (panner) panner.disconnect();
    } catch { /* already gone */ }
  };

  route(io, out, end, { reverb, delay });
}

/* ------------------------------------------------------ plucked string (KS) */

/**
 * Live Karplus–Strong nodes, for leak checks: `created` counts nodes made,
 * `ended` counts processors that reported they finished (and were
 * disconnected), `live` is the worklet scope's own count at the last report.
 */
export const ksStats = { created: 0, ended: 0, live: 0, fallback: 0 };

/**
 * Physically-modelled plucked string: one AudioWorkletNode per note running
 * the processor in worklets/ks.js. `decay` is roughly the time to fall 60 dB
 * and sets the loop damping; `bright` low-passes the pluck (0 dull thumb,
 * 1 bright pick). The node ends itself once the note has died, or after
 * `decay + 2 s` at the latest. Falls back to `pluckVoice` when the engine
 * could not load worklets (insecure context, old WebView, load failure).
 */
export function ksVoice(io, {
  note, time, gain = 0.1, decay = 1.5, bright = 0.5, reverb = 0.3, delay = 0.15, pan = 0,
}) {
  const ctx = io.ctx;
  const freq = midiToFreq(note);
  if (!Number.isFinite(freq) || !Number.isFinite(time)) return;

  const peak = Math.max(0, finite(gain, 0.1));
  const dec = clamp(finite(decay, 1.5), 0.05, 10);
  const b = clamp(finite(bright, 0.5), 0, 1);
  const p = clamp(finite(pan, 0), -1, 1);
  const rv = Math.max(0, finite(reverb, 0.3));
  const dl = Math.max(0, finite(delay, 0.15));

  if (!io.hasWorklets || typeof AudioWorkletNode === 'undefined') {
    ksStats.fallback++;
    pluckVoice(io, { note, time, gain: peak, decay: Math.min(dec, 2), bright: b, reverb: rv, delay: dl, pan: p });
    return;
  }

  const f = clamp(freq, 20, 5000);
  // Loop gain per period for a 60 dB fall over `dec`, less what the two-point
  // average already takes off the fundamental.
  const perPeriod = Math.pow(10, -3 / (f * dec));
  const damping = clamp(perPeriod / Math.cos(Math.PI * f / ctx.sampleRate), 0.9, 0.999);
  const life = dec + 2;
  // Deterministic per note, so a render is reproducible.
  const seed = (Math.imul(Math.round(note * 16) | 0, 2654435761) ^ Math.round(time * 1e4)) >>> 0;

  let node;
  try {
    node = new AudioWorkletNode(ctx, 'karplus-strong', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      parameterData: { frequency: f, damping, brightness: b },
      processorOptions: { startTime: time, maxDur: life, seed },
    });
  } catch {
    ksStats.fallback++;
    pluckVoice(io, { note, time, gain: peak, decay: Math.min(dec, 2), bright: b, reverb: rv, delay: dl, pan: p });
    return;
  }
  ksStats.created++;

  const out = ctx.createGain();
  // The string decays on its own; the envelope only guarantees silence by
  // the time the processor's hard stop comes round. The level is set from
  // now, not from `time`: if `time` falls a hair after the processor's start
  // frame, the first sample would otherwise pass at the default gain of 1.
  out.gain.setValueAtTime(Math.max(SILENCE, peak), Math.max(0, Math.min(ctx.currentTime, time)));
  out.gain.setValueAtTime(Math.max(SILENCE, peak), time + dec);
  out.gain.exponentialRampToValueAtTime(SILENCE, time + life - 0.05);

  let panner = null;
  if (p !== 0 && ctx.createStereoPanner) {
    panner = ctx.createStereoPanner();
    panner.pan.value = p;
    node.connect(panner).connect(out);
  } else {
    node.connect(out);
  }

  node.port.onmessage = (e) => {
    if (!e.data || !e.data.done) return;
    ksStats.ended++;
    ksStats.live = e.data.live;
    try {
      node.disconnect();
      if (panner) panner.disconnect();
    } catch { /* already gone */ }
    node.port.onmessage = null;
    node.port.close();
  };

  route(io, out, time + life, { reverb: rv, delay: dl });
}

/* -------------------------------------------------------------- percussion */

export function kick(io, { time, gain = 0.5, tone = 130 }) {
  const ctx = io.ctx;
  const end = time + 0.4;

  const out = ctx.createGain();
  out.gain.setValueAtTime(SILENCE, time);
  out.gain.linearRampToValueAtTime(gain, time + 0.004);
  out.gain.exponentialRampToValueAtTime(SILENCE, time + 0.3);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(tone, time);
  osc.frequency.exponentialRampToValueAtTime(42, time + 0.09);
  osc.connect(out);
  osc.start(time);
  osc.stop(end);

  route(io, out, end, { reverb: 0.05 });
}

export function hat(io, { time, gain = 0.08, decay = 0.045, reverb = 0.12 }) {
  const ctx = io.ctx;
  const end = time + decay + 0.05;

  const out = ctx.createGain();
  pluckEnvelope(out.gain, { time, peak: gain, attack: 0.001, decay });

  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 7200;
  filter.connect(out);

  noiseSource(io, time, decay + 0.03).connect(filter);
  route(io, out, end, { reverb });
}

export function shaker(io, { time, gain = 0.05, decay = 0.09, reverb = 0.18 }) {
  const ctx = io.ctx;
  const end = time + decay + 0.05;

  const out = ctx.createGain();
  pluckEnvelope(out.gain, { time, peak: gain, attack: 0.012, decay });

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 5200;
  filter.Q.value = 1.4;
  filter.connect(out);

  noiseSource(io, time, decay + 0.04).connect(filter);
  route(io, out, end, { reverb });
}

export function rim(io, { time, gain = 0.1, reverb = 0.3 }) {
  const ctx = io.ctx;
  const decay = 0.06;
  const end = time + 0.2;

  const out = ctx.createGain();
  pluckEnvelope(out.gain, { time, peak: gain, attack: 0.001, decay });

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1900;
  filter.Q.value = 4;
  filter.connect(out);

  noiseSource(io, time, decay + 0.03).connect(filter);

  const blip = ctx.createOscillator();
  blip.type = 'triangle';
  blip.frequency.setValueAtTime(430, time);
  blip.frequency.exponentialRampToValueAtTime(210, time + 0.05);
  const blipGain = ctx.createGain();
  blipGain.gain.setValueAtTime(0.5, time);
  blipGain.gain.exponentialRampToValueAtTime(SILENCE, time + 0.06);
  blip.connect(blipGain).connect(out);
  blip.start(time);
  blip.stop(end);

  route(io, out, end, { reverb });
}

/* ==========================================================================
 * Extended voice set — used by the Sci-Fi, Video Game, Fantasy and Noir
 * themes. Wanderer does not need these, so they cost nothing until a theme
 * actually reaches for one.
 * ========================================================================== */

/**
 * Variable-width pulse waves. Web Audio only ships a fixed 50% square, so the
 * duty cycle is built from its Fourier series: the nth harmonic of a pulse of
 * width d has amplitude (2 / n*pi) * sin(n*pi*d).
 *
 * Cached per context — building a PeriodicWave per note would be wasteful.
 */
const pulseCache = new WeakMap();

export function pulseWave(ctx, duty = 0.5, harmonics = 32) {
  let byDuty = pulseCache.get(ctx);
  if (!byDuty) pulseCache.set(ctx, (byDuty = new Map()));

  const key = duty.toFixed(3);
  const hit = byDuty.get(key);
  if (hit) return hit;

  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  }

  const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  byDuty.set(key, wave);
  return wave;
}

/**
 * Pulse voice — the backbone of both the chiptune lead and the sci-fi
 * sequencer. `duty` shapes the character: 0.5 hollow, 0.25 nasal, 0.125 thin.
 */
export function pulseVoice(io, {
  note, time, dur, gain = 0.1, duty = 0.5, cutoff = 6000, resonance = 1,
  attack = 0.004, release = 0.05, glideFrom = null, vibrato = 0,
  reverb = 0.2, delay = 0.2, pan = 0,
}) {
  const ctx = io.ctx;
  const freq = midiToFreq(note);
  const end = time + dur + release + 0.05;

  const out = ctx.createGain();
  out.gain.setValueAtTime(SILENCE, time);
  out.gain.linearRampToValueAtTime(Math.max(SILENCE, gain), time + attack);
  out.gain.setValueAtTime(Math.max(SILENCE, gain), time + Math.max(attack, dur));
  out.gain.exponentialRampToValueAtTime(SILENCE, time + dur + release);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  filter.Q.value = resonance;

  if (pan !== 0 && ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    filter.connect(panner).connect(out);
  } else {
    filter.connect(out);
  }

  const osc = ctx.createOscillator();
  osc.setPeriodicWave(pulseWave(ctx, duty));
  if (glideFrom !== null) {
    // Portamento: the sound of a machine changing its mind.
    osc.frequency.setValueAtTime(midiToFreq(glideFrom), time);
    osc.frequency.exponentialRampToValueAtTime(freq, time + Math.min(0.25, dur * 0.6));
  } else {
    osc.frequency.value = freq;
  }
  osc.connect(filter);
  osc.start(time);
  osc.stop(end);

  if (vibrato > 0) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.4;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, time);
    depth.gain.linearRampToValueAtTime(vibrato, time + Math.min(0.35, dur * 0.5));
    lfo.connect(depth).connect(osc.detune);
    lfo.start(time);
    lfo.stop(end);
  }

  route(io, out, end, { reverb, delay });
}

/**
 * Bowed string — a saw stack that swells, with vibrato arriving after the bow
 * has settled rather than from the first instant.
 */
export function stringVoice(io, {
  notes, time, dur, gain = 0.09, cutoff = 2200, detune = 7,
  vibrato = 9, reverb = 0.6,
}) {
  const ctx = io.ctx;
  const out = ctx.createGain();
  swellEnvelope(out.gain, { time, dur, peak: gain, attack: 0.9, release: 1.4 });

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.max(200, cutoff * 0.5), time);
  filter.frequency.linearRampToValueAtTime(cutoff, time + Math.min(1.6, dur * 0.4));
  filter.Q.value = 0.9;
  filter.connect(out);

  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5.1;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(0, time);
  depth.gain.linearRampToValueAtTime(vibrato, time + Math.min(1.2, dur * 0.45));
  lfo.start(time);
  lfo.stop(time + dur + 0.1);

  notes.forEach((n, i) => {
    for (const cents of [-detune, detune]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midiToFreq(n);
      osc.detune.value = cents;
      lfo.connect(depth).connect(osc.detune);

      const g = ctx.createGain();
      g.gain.value = (1 / (notes.length * 2)) * (1 - i * 0.06);
      osc.connect(g).connect(filter);
      osc.start(time);
      osc.stop(time + dur + 0.1);
    }
  });

  route(io, out, time + dur, { reverb });
}

/** Wooden flute: near-sine tone, breath noise on top, vibrato that fades in. */
export function fluteVoice(io, {
  note, time, dur, gain = 0.1, breath = 0.16, vibrato = 14, reverb = 0.5, delay = 0.15,
}) {
  const ctx = io.ctx;
  const freq = midiToFreq(note);
  const end = time + dur + 0.25;

  const out = ctx.createGain();
  swellEnvelope(out.gain, { time, dur, peak: gain, attack: 0.12, release: 0.22 });

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;

  // A little triangle gives the tone an edge; pure sine reads as a test tone.
  const edge = ctx.createOscillator();
  edge.type = 'triangle';
  edge.frequency.value = freq;
  const edgeGain = ctx.createGain();
  edgeGain.gain.value = 0.22;

  const lfo = ctx.createOscillator();
  lfo.frequency.value = 4.8;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(0, time);
  depth.gain.linearRampToValueAtTime(vibrato, time + Math.min(0.6, dur * 0.5));
  lfo.connect(depth);
  depth.connect(osc.detune);
  depth.connect(edge.detune);

  osc.connect(out);
  edge.connect(edgeGain).connect(out);

  if (breath > 0) {
    const air = ctx.createBiquadFilter();
    air.type = 'bandpass';
    air.frequency.value = freq * 2.2;
    air.Q.value = 1.1;
    const airGain = ctx.createGain();
    airGain.gain.value = breath;
    air.connect(airGain).connect(out);
    noiseSource(io, time, dur + 0.2).connect(air);
  }

  for (const n of [osc, edge, lfo]) { n.start(time); n.stop(end); }
  route(io, out, end, { reverb, delay });
}

/** Pizzicato / upright bass: short, woody, with a finger thump on the front. */
export function pizzVoice(io, {
  note, time, gain = 0.22, decay = 0.65, cutoff = 900, reverb = 0.2, delay = 0,
}) {
  const ctx = io.ctx;
  const freq = midiToFreq(note);
  const end = time + decay + 0.12;

  const out = ctx.createGain();
  pluckEnvelope(out.gain, { time, peak: gain, attack: 0.008, decay });

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(cutoff, time);
  filter.frequency.exponentialRampToValueAtTime(Math.max(160, freq * 2), time + decay * 0.7);
  filter.Q.value = 1.2;
  filter.connect(out);

  for (const [type, ratio, level] of [['triangle', 1, 1], ['sine', 2, 0.22], ['sawtooth', 1, 0.12]]) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq * ratio;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, time);
    g.gain.exponentialRampToValueAtTime(SILENCE, time + decay / ratio);
    osc.connect(g).connect(filter);
    osc.start(time);
    osc.stop(end);
  }

  // The thump of a finger leaving the string.
  const thump = ctx.createBiquadFilter();
  thump.type = 'bandpass';
  thump.frequency.value = 220;
  thump.Q.value = 2;
  const thumpGain = ctx.createGain();
  // Kept well under the note itself: a real upright thumps, but not with a
  // transient twice the height of the tone. Big spikes here cost headroom
  // across the whole mix for something you barely hear.
  pluckEnvelope(thumpGain.gain, { time, peak: gain * 0.3, attack: 0.004, decay: 0.05 });
  thump.connect(thumpGain).connect(out);
  noiseSource(io, time, 0.08).connect(thump);

  route(io, out, end, { reverb, delay });
}

/**
 * Noise sweep — riser or faller. The sci-fi theme uses these to mark phrase
 * boundaries the way a film cue would.
 */
export function sweepVoice(io, {
  time, dur = 2.5, gain = 0.07, from = 200, to = 5000, q = 3, reverb = 0.7,
}) {
  const ctx = io.ctx;
  const end = time + dur + 0.2;

  const out = ctx.createGain();
  out.gain.setValueAtTime(SILENCE, time);
  out.gain.exponentialRampToValueAtTime(Math.max(SILENCE, gain), time + dur * 0.75);
  out.gain.exponentialRampToValueAtTime(SILENCE, time + dur);

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = q;
  filter.frequency.setValueAtTime(Math.max(40, from), time);
  filter.frequency.exponentialRampToValueAtTime(Math.max(60, to), time + dur);
  filter.connect(out);

  noiseSource(io, time, dur + 0.15).connect(filter);
  route(io, out, end, { reverb });
}

/** Short telemetry blip — console beeps, pickups, UI chirps. */
export function blipVoice(io, {
  note, time, gain = 0.07, decay = 0.09, duty = 0.5, bend = 0, reverb = 0.25, delay = 0.2,
}) {
  const ctx = io.ctx;
  const freq = midiToFreq(note);
  const end = time + decay + 0.06;

  const out = ctx.createGain();
  pluckEnvelope(out.gain, { time, peak: gain, attack: 0.002, decay });

  const osc = ctx.createOscillator();
  osc.setPeriodicWave(pulseWave(ctx, duty));
  osc.frequency.setValueAtTime(freq, time);
  if (bend !== 0) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(20, freq * 2 ** (bend / 12)), time + decay);
  }
  osc.connect(out);
  osc.start(time);
  osc.stop(end);

  route(io, out, end, { reverb, delay });
}

/** Metallic hit: inharmonic resonances, for machinery and sci-fi percussion. */
export function clank(io, { time, gain = 0.12, tone = 1400, decay = 0.5, reverb = 0.45 }) {
  const ctx = io.ctx;
  const end = time + decay + 0.1;

  const out = ctx.createGain();
  out.gain.value = 1;

  const src = noiseSource(io, time, decay + 0.05);
  // Ratios chosen to be deliberately inharmonic — that is what reads as metal.
  for (const [ratio, q, level] of [[1, 12, 1], [1.71, 16, 0.6], [2.64, 20, 0.4]]) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = tone * ratio;
    bp.Q.value = q;
    const g = ctx.createGain();
    pluckEnvelope(g.gain, { time, peak: gain * level, attack: 0.001, decay: decay / ratio });
    src.connect(bp).connect(g).connect(out);
  }

  route(io, out, end, { reverb });
}

/** Brushed snare — the swirl of a jazz kit rather than a hit. */
export function brush(io, { time, gain = 0.05, decay = 0.18, swirl = false, reverb = 0.25 }) {
  const ctx = io.ctx;
  const end = time + decay + 0.08;

  const out = ctx.createGain();
  pluckEnvelope(out.gain, {
    time, peak: gain, attack: swirl ? 0.06 : 0.004, decay,
  });

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(swirl ? 1800 : 2600, time);
  if (swirl) filter.frequency.linearRampToValueAtTime(3200, time + decay);
  filter.Q.value = 0.8;
  filter.connect(out);

  noiseSource(io, time, decay + 0.05).connect(filter);
  route(io, out, end, { reverb });
}
