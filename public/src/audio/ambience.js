/**
 * Ambience — the place, literally.
 *
 * The music expresses the *mood* of where you are; this layer expresses the
 * *place*: birds in a park, water by a river, a low traffic hum on a main
 * road, a murmur of voices near cafés and bars. It sits quietly under the
 * music on its own bus (engine.ambienceGain), with its own slider.
 *
 * Everything is synthesised — no samples. Budget: the four continuous beds
 * each own one looping noise source (water, traffic, murmur, rain), all
 * reading one shared noise buffer made once per AudioContext; with the
 * engine's own "air" bed that is five noise sources in total, never more.
 * Grains (bird chirps, rain drips) are short sine oscillators that stop and
 * disconnect themselves.
 *
 * Every generator has the same shape: `start(ctx, out)`, `setLevel(v, t)`,
 * `stop(when)`, plus `schedule(until)` for the ones with events, which the
 * engine calls from its look-ahead tick so grains land sample-accurately.
 * Levels always glide (setTargetAtTime), so nothing here can pop.
 *
 * Randomness is seeded (mulberry32), so a render is repeatable.
 */

import { hashString, mulberry32 } from './theory.js';

/** Generator names, in the order they are built. */
export const AMBIENCE_KINDS = ['birds', 'water', 'traffic', 'murmur', 'rain'];

/**
 * Time constant for every level change. ~95 % of the way in 1.8 s, and a
 * fade to zero is 43 dB down after 3 s — the "glide in/out over 3 s" of the
 * spec, and silent within 3 s when the slider goes to 0.
 */
export const AMBIENCE_TC = 0.6;

/** Seconds of shared noise. Stereo, so beds have width without extra sources. */
const NOISE_SECONDS = 4;

/*
 * Per-generator gain at level 1. Calibrated in an offline render so each bed
 * alone peaks roughly alike, and all five at level 1 together stay more than
 * 18 dB under the music's −3 dBFS target even under the loudest theme trim
 * (1.76). The bus gain itself is engine.js's AMBIENCE_BUS.
 */
const MAX = {
  birds: 0.42,
  water: 0.55,
  traffic: 1.4,
  murmur: 0.35,
  rain: 0.18,
};

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/* ------------------------------------------------------------------- host */

export class Ambience {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} bus  where every generator ends up (engine.ambienceGain)
   */
  constructor(ctx, bus) {
    this.ctx = ctx;
    this.bus = bus;
    this.levels = Object.fromEntries(AMBIENCE_KINDS.map((k) => [k, 0]));
    this.gens = null;
    this._starts = 0;
    this._noise = null;
    // Debug counters (engine.ambienceStats()). `nodes` is every node this
    // layer has made and not yet disconnected; it must not grow over time.
    this.stats = { nodes: 0, grains: 0, sources: 0 };
  }

  /** One buffer of seeded white noise, shared by every bed. Made once. */
  get noise() {
    if (!this._noise) {
      const ctx = this.ctx;
      const rng = mulberry32(hashString('ambience-noise'));
      const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
      }
      this._noise = buf;
    }
    return this._noise;
  }

  /** Register a node with the debug counter. */
  track(node) {
    this.stats.nodes++;
    return node;
  }

  /** Disconnect nodes and take them off the counter. */
  drop(...nodes) {
    for (const n of nodes) {
      if (!n) continue;
      try { n.disconnect(); } catch { /* already gone */ }
      this.stats.nodes--;
    }
  }

  /** A looping noise source at a seeded offset, counted as a source. */
  noiseSource(rng) {
    const src = this.track(this.ctx.createBufferSource());
    src.buffer = this.noise;
    src.loop = true;
    src._offset = rng() * (NOISE_SECONDS - 0.1);
    this.stats.sources++;
    return src;
  }

  /** Build every generator (silent) and fade in whatever levels are set. */
  start() {
    if (this.gens) return;
    this._starts++;
    const rng = mulberry32(hashString(`ambience:${this._starts}`));
    this.gens = {
      birds: new Birds(this, rng),
      water: new Water(this, rng),
      traffic: new Traffic(this, rng),
      murmur: new Murmur(this, rng),
      // Driven by the weather (C3.10): main.js sets it from rain mm/h, and
      // leaves it at 0 while the weather toggle is off.
      rain: new Rain(this, rng),
    };
    for (const g of Object.values(this.gens)) g.start(this.ctx, this.bus);
    this.setLevels(this.levels);
  }

  /**
   * Target levels 0..1 by generator name. Unknown names are ignored, missing
   * names keep their current level. Each glides (AMBIENCE_TC).
   */
  setLevels(levels = {}) {
    for (const k of AMBIENCE_KINDS) {
      if (k in levels) this.levels[k] = clamp01(levels[k]);
    }
    if (!this.gens) return;
    const now = this.ctx.currentTime;
    for (const k of AMBIENCE_KINDS) this.gens[k].setLevel(this.levels[k], now);
  }

  /** Called from the engine's look-ahead tick. */
  schedule(until) {
    if (!this.gens) return;
    for (const g of Object.values(this.gens)) g.schedule?.(until);
  }

  /**
   * Stop every source at `when` and disconnect everything once it has.
   * The engine fades the master to silence by then, so there is no click.
   */
  stop(when = this.ctx.currentTime) {
    if (!this.gens) return;
    for (const g of Object.values(this.gens)) g.stop(when);
    this.gens = null;
  }
}

/* ------------------------------------------------------------- generators */

/** Shared plumbing: an output gain the level glides on. */
class Generator {
  constructor(host, rng, max) {
    this.host = host;
    this.rng = rng;
    this.max = max;
    this.level = 0;
    this.out = null;
    this.persistent = [];   // nodes torn down on stop()
    this.running = [];      // sources/oscillators to stop on stop()
  }

  _out(ctx, dest) {
    this.ctx = ctx;
    this.out = this.host.track(ctx.createGain());
    this.out.gain.value = 0;
    this.out.connect(dest);
    this.persistent.push(this.out);
    return this.out;
  }

  node(n) {
    this.host.track(n);
    this.persistent.push(n);
    return n;
  }

  /** A started oscillator used as an LFO. */
  lfo(freq, depth, target) {
    const osc = this.node(this.ctx.createOscillator());
    osc.frequency.value = freq;
    const g = this.node(this.ctx.createGain());
    g.gain.value = depth;
    osc.connect(g).connect(target);
    osc.start();
    this.running.push(osc);
    return osc;
  }

  noise() {
    const src = this.host.noiseSource(this.rng);
    this.persistent.push(src);
    this.running.push(src);
    return src;
  }

  setLevel(v, t) {
    this.level = v;
    if (!this.out) return;
    this.out.gain.setTargetAtTime(v * this.max, t, AMBIENCE_TC);
  }

  stop(when) {
    if (!this.out) return;
    const host = this.host;
    const nodes = this.persistent;
    const running = this.running;
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    let sourcesLeft = running.filter((n) => n instanceof AudioBufferSourceNode).length;
    for (const n of running) {
      try { n.stop(when); } catch { /* never started */ }
    }
    // Tear down once the first thing actually stops (they all stop at `when`).
    let done = false;
    const teardown = () => {
      if (done) return;
      done = true;
      host.stats.sources -= sourcesLeft;
      sourcesLeft = 0;
      host.drop(...nodes);
    };
    if (running.length) running[0].onended = teardown;
    else setTimeout(teardown, Math.max(0, when - this.ctx.currentTime + 0.1) * 1000);
    this.persistent = [];
    this.running = [];
    this.out = null;
  }

  /**
   * A short sine grain: `shape(osc.frequency, env.gain)` sets its automation.
   * Stops at `end` and disconnects itself.
   */
  grain(t, end, pan, shape) {
    const ctx = this.ctx;
    const host = this.host;
    const osc = host.track(ctx.createOscillator());
    const env = host.track(ctx.createGain());
    const p = host.track(ctx.createStereoPanner());
    osc.type = 'sine';
    env.gain.value = 0;
    p.pan.value = pan;
    shape(osc.frequency, env.gain);
    osc.connect(env).connect(p).connect(this.out);
    host.stats.grains++;
    osc.onended = () => {
      host.stats.grains--;
      host.drop(osc, env, p);
    };
    osc.start(t);
    osc.stop(end);
  }
}

/**
 * Birds (category `nature`). A grain scheduler: every 0.4–3 s a 60–180 ms
 * sine chirp gliding 2.8 → 4.5 kHz (or down), with a tiny random pan.
 * Main.js holds the level at 0 at night (22:00–05:00).
 */
class Birds extends Generator {
  constructor(host, rng) { super(host, rng, MAX.birds); }

  start(ctx, dest) {
    this._out(ctx, dest);
    this.next = ctx.currentTime + 0.3 + this.rng() * 1.2;
  }

  schedule(until) {
    if (!this.out) return;
    const now = this.ctx.currentTime;
    if (this.next < now) this.next = now + 0.05;   // never catch up a backlog
    while (this.next < until) {
      const t = this.next;
      // Draw every chirp's numbers even when silent, so the sequence (and a
      // render) does not depend on when the level happened to change.
      const dur = 0.06 + this.rng() * 0.12;
      const up = this.rng() < 0.5;
      const spread = 0.92 + this.rng() * 0.16;
      const pan = (this.rng() - 0.5) * 0.5;
      const peak = 0.6 + this.rng() * 0.4;
      this.next += 0.4 + this.rng() * 2.6;
      if (this.level < 0.01) continue;

      const f0 = (up ? 2800 : 4500) * spread;
      const f1 = (up ? 4500 : 2800) * spread;
      this.grain(t, t + dur + 0.02, pan, (freq, gain) => {
        freq.setValueAtTime(f0, t);
        freq.exponentialRampToValueAtTime(f1, t + dur);
        gain.setValueAtTime(0, t);
        gain.linearRampToValueAtTime(peak, t + Math.min(0.015, dur * 0.25));
        gain.linearRampToValueAtTime(peak * 0.7, t + dur * 0.6);
        gain.linearRampToValueAtTime(0, t + dur);
      });
    }
  }
}

/**
 * Water (category `water`). White noise → bandpass 500 Hz, Q 0.7, its centre
 * swept by two slow LFOs (0.07 Hz and 0.13 Hz, ±75 Hz each: ±150 Hz together).
 */
class Water extends Generator {
  constructor(host, rng) { super(host, rng, MAX.water); }

  start(ctx, dest) {
    const out = this._out(ctx, dest);
    const src = this.noise();
    const bp = this.node(ctx.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 500;
    bp.Q.value = 0.7;
    src.connect(bp).connect(out);
    this.lfo(0.07, 75, bp.frequency);
    this.lfo(0.13, 75, bp.frequency);
    src.start(ctx.currentTime, src._offset);
  }
}

/**
 * Traffic (categories `transit` + `service`, or a built-up scene). Brown-ish
 * rumble (white → lowpass 180 Hz) with a slow LFO on its level, and every
 * 6–20 s a pass-by: a bandpass on the same noise swept 300 → 900 → 300 Hz over
 * 2.5 s at low gain. The pass-by is automation on persistent nodes, so it
 * creates nothing.
 */
class Traffic extends Generator {
  constructor(host, rng) { super(host, rng, MAX.traffic); }

  start(ctx, dest) {
    const out = this._out(ctx, dest);
    const src = this.noise();

    const lp = this.node(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 180;
    lp.Q.value = 0.5;
    const rumble = this.node(ctx.createGain());
    rumble.gain.value = 0.75;
    src.connect(lp).connect(rumble).connect(out);
    this.lfo(0.05 + this.rng() * 0.03, 0.25, rumble.gain);

    this.bp = this.node(ctx.createBiquadFilter());
    this.bp.type = 'bandpass';
    this.bp.frequency.value = 300;
    this.bp.Q.value = 1.4;
    this.pass = this.node(ctx.createGain());
    this.pass.gain.value = 0;
    src.connect(this.bp).connect(this.pass).connect(out);

    src.start(ctx.currentTime, src._offset);
    this.next = ctx.currentTime + 3 + this.rng() * 8;
  }

  schedule(until) {
    if (!this.out) return;
    const now = this.ctx.currentTime;
    if (this.next < now) this.next = now + 0.05;
    while (this.next < until) {
      const t = this.next;
      const peak = 0.10 + this.rng() * 0.08;
      this.next += 6 + this.rng() * 14;   // always longer than one pass-by
      if (this.level < 0.01) continue;
      const f = this.bp.frequency;
      f.setValueAtTime(300, t);
      f.exponentialRampToValueAtTime(900, t + 1.25);
      f.exponentialRampToValueAtTime(300, t + 2.5);
      const g = this.pass.gain;
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(peak, t + 1.25);
      g.linearRampToValueAtTime(0, t + 2.5);
    }
  }
}

/**
 * Murmur (categories `food` + `nightlife` + `retail`). Six bandpassed voices
 * at 400–1200 Hz on one shared noise source, each with its own slow random
 * walk in gain (and a little in centre frequency) and its own place in the
 * stereo field: a distant crowd, not a hiss.
 */
class Murmur extends Generator {
  constructor(host, rng) { super(host, rng, MAX.murmur); }

  start(ctx, dest) {
    const out = this._out(ctx, dest);
    const src = this.noise();
    this.voices = [];
    for (let i = 0; i < 6; i++) {
      const centre = 400 + (800 * (i + this.rng() * 0.8)) / 6;
      const bp = this.node(ctx.createBiquadFilter());
      bp.type = 'bandpass';
      bp.frequency.value = centre;
      bp.Q.value = 3;
      const g = this.node(ctx.createGain());
      g.gain.value = 0.5;
      const p = this.node(ctx.createStereoPanner());
      p.pan.value = ((i / 5) - 0.5) * 0.8;
      src.connect(bp).connect(g).connect(p).connect(out);
      this.voices.push({ bp, g, centre, value: 0.5 });
    }
    src.start(ctx.currentTime, src._offset);
    this.next = ctx.currentTime + 0.2;
  }

  schedule(until) {
    if (!this.out) return;
    const now = this.ctx.currentTime;
    if (this.next < now) this.next = now + 0.05;
    while (this.next < until) {
      const t = this.next;
      this.next += 0.6 + this.rng() * 0.6;
      for (const v of this.voices) {
        v.value = Math.min(1, Math.max(0.08, v.value + (this.rng() - 0.5) * 0.7));
        const f = v.centre * (0.94 + this.rng() * 0.12);
        if (this.level < 0.01) continue;
        v.g.gain.setTargetAtTime(v.value, t, 0.35);
        v.bp.frequency.setTargetAtTime(f, t, 0.8);
      }
    }
  }
}

/**
 * Rain. White noise → highpass 1.5 kHz with a gentle level modulation, plus
 * sparse drips (very short sine pings). Driven by the weather (C3.10):
 * main.js sets its level from rain mm/h; at level 0 it schedules no drips.
 */
class Rain extends Generator {
  constructor(host, rng) { super(host, rng, MAX.rain); }

  start(ctx, dest) {
    const out = this._out(ctx, dest);
    const src = this.noise();
    const hp = this.node(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 1500;
    hp.Q.value = 0.5;
    const body = this.node(ctx.createGain());
    body.gain.value = 0.8;
    src.connect(hp).connect(body).connect(out);
    this.lfo(0.09, 0.15, body.gain);
    src.start(ctx.currentTime, src._offset);
    this.next = ctx.currentTime + 0.5;
  }

  schedule(until) {
    if (!this.out) return;
    const now = this.ctx.currentTime;
    if (this.next < now) this.next = now + 0.05;
    while (this.next < until) {
      const t = this.next;
      const f = 1800 + this.rng() * 2400;
      const pan = (this.rng() - 0.5) * 1.2;
      const peak = 0.4 + this.rng() * 0.6;
      this.next += 0.12 + this.rng() * 0.6;
      if (this.level < 0.01) continue;
      this.grain(t, t + 0.05, pan, (freq, gain) => {
        freq.setValueAtTime(f, t);
        freq.exponentialRampToValueAtTime(f * 0.8, t + 0.03);
        gain.setValueAtTime(0, t);
        gain.linearRampToValueAtTime(peak, t + 0.002);
        gain.linearRampToValueAtTime(peak * 0.25, t + 0.012);
        gain.linearRampToValueAtTime(0, t + 0.035);
      });
    }
  }
}
