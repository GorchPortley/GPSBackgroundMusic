/**
 * Audio engine.
 *
 * Owns the AudioContext, the master effects chain, the two continuous layers
 * (drone and air), and the look-ahead scheduler that drives the composer.
 *
 * The split with themes: the engine knows how to *make sound and change
 * smoothly*; a theme knows *what to play*. A theme receives a step callback
 * and an `io` bundle and schedules voices onto it.
 *
 * Everything a moving listener hears change is ramped, never jumped —
 * continuous parameters glide, and anything discrete (key, mode, chord
 * sequence) waits for the next 4-bar phrase boundary.
 */

export const STEPS_PER_BAR = 16;   // 16th notes in 4/4
export const BARS_PER_PHRASE = 4;
const STEPS_PER_PHRASE = STEPS_PER_BAR * BARS_PER_PHRASE;

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_S = 0.25;
const START_DELAY_S = 0.12;

/** How fast continuous parameters chase their target (seconds). */
const MORPH_TC = 2.5;
const REVERB_CROSSFADE_S = 3.0;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.hasWorklets = false;
    this._init = null;

    // A plan and the theme that produced it are one unit and must never be
    // separated: a theme's step() reads fields only its own plan() writes, so
    // handing Noir's step() a Sci-Fi plan produces NaN note times. Both swap
    // together, at a phrase boundary.
    this.plan = null;
    this.stepFn = null;
    this._pending = null;

    this._step = 0;
    this._nextStepTime = 0;
    this._timer = null;
    this._bpm = 72;
    this._targetBpm = 72;

    this._reverbCache = new Map();
    this._reverbSlot = 'a';
    this._reverbSeconds = 0;
  }

  /* ----------------------------------------------------------- lifecycle */

  /** Must be called from a user gesture (browsers block audio otherwise). */
  async start() {
    // iOS mutes Web Audio entirely when the ringer switch is on silent, unless
    // the page declares itself as playback rather than ambient (iOS 16.4+).
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {
      /* not supported here; nothing to fall back to */
    }

    // Memoised: a second start() while the first is still loading the
    // worklet must wait for the same graph, not build another.
    if (!this._init) {
      this._init = this._createContext().catch((e) => { this._init = null; this.ctx = null; throw e; });
    }
    await this._init;
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    if (this.running) return;
    this.running = true;

    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), now);
    this.master.gain.linearRampToValueAtTime(this._volume, now + 1.2);

    this._step = 0;
    this._nextStepTime = now + START_DELAY_S;
    this._timer = setInterval(() => this._tick(), LOOKAHEAD_MS);
  }

  async _createContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('This browser has no Web Audio support.');
    // Not published as this.ctx until the graph is built, so applyPlan()
    // and friends keep treating the engine as unstarted during the await.
    const ctx = new Ctx({ latencyHint: 'playback' });
    // Ask to resume while still inside the user gesture; iOS may refuse a
    // resume() that only happens after the await below.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    // Worklet voices (the Karplus–Strong string) need their module loaded
    // before any node is made. AudioWorklet needs a secure context (HTTPS,
    // localhost, or the APK's appassets origin); if it is missing or the
    // load fails, voices fall back to their oscillator versions and the app
    // still plays. Resolved against this file, so it works under any root
    // (dev server and appassets both serve it at /src/audio/worklets/ks.js).
    this.hasWorklets = false;
    try {
      if (ctx.audioWorklet) {
        await ctx.audioWorklet.addModule(new URL('./worklets/ks.js', import.meta.url).href);
        this.hasWorklets = true;
      }
    } catch (e) {
      console.warn('AudioWorklet unavailable; string voice falls back to pluck.', e);
    }
    this.ctx = ctx;
    this._build();
  }

  /** Fade out, then park the scheduler. Safe to call repeatedly. */
  stop() {
    if (!this.running || !this.ctx) return;
    this.running = false;

    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0.0001, now + 1.0);

    clearInterval(this._timer);
    this._timer = null;
    setTimeout(() => {
      if (!this.running && this.ctx?.state === 'running') this.ctx.suspend();
    }, 1300);
  }

  setVolume(v) {
    this._volume = Math.min(1, Math.max(0, v));
    if (this.ctx && this.running) {
      this.master.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.1);
    }
  }

  /* ---------------------------------------------------------------- graph */

  _build() {
    const ctx = this.ctx;
    this._volume = 0.8;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.82;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0001;

    // Gentle glue, plus insurance against a dense scene stacking up.
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 22;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.008;
    this.compressor.release.value = 0.3;

    // Makeup after the compressor. A forest genuinely should be quieter than a
    // station, so the scenes keep their relative levels — this only lifts the
    // whole range into usable territory instead of leaving 12 dB unused.
    this.makeup = ctx.createGain();
    this.makeup.gain.value = 1.65;

    // Brickwall after the volume control, so the busiest scene at full volume
    // still cannot clip the output.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;

    this.mix = ctx.createGain();
    this.mix.gain.value = 1;

    // Per-theme output trim. Themes are written at whatever internal levels
    // suit their instrumentation — a sparse jazz kit and a wall of sci-fi
    // drones do not naturally land in the same place — so each declares a
    // trim and they all arrive at the compressor matched.
    this.themeTrim = ctx.createGain();
    this.themeTrim.gain.value = 1;

    this.mix.connect(this.themeTrim);
    this.themeTrim.connect(this.compressor);
    this.compressor.connect(this.makeup);
    this.makeup.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.limiter.connect(this.analyser);

    // --- dry path
    this.dry = ctx.createGain();
    this.dry.gain.value = 1;
    this.dry.connect(this.mix);

    // --- reverb: two convolvers so the room size can change without a click
    this.reverbBus = ctx.createGain();
    this.reverbBus.gain.value = 1;

    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.5;
    this.reverbReturn.connect(this.mix);

    this.convA = ctx.createConvolver();
    this.convB = ctx.createConvolver();
    this.convAGain = ctx.createGain();
    this.convBGain = ctx.createGain();
    this.convAGain.gain.value = 1;
    this.convBGain.gain.value = 0;

    this.reverbBus.connect(this.convA).connect(this.convAGain).connect(this.reverbReturn);
    this.reverbBus.connect(this.convB).connect(this.convBGain).connect(this.reverbReturn);

    this.convA.buffer = this._impulse(3.0);
    this.convB.buffer = this._impulse(3.0);
    this._reverbSeconds = 3.0;

    // --- tempo-synced feedback delay
    this.delayBus = ctx.createGain();
    this.delayBus.gain.value = 1;

    this.delayNode = ctx.createDelay(2.0);
    this.delayNode.delayTime.value = 0.375;

    this.delayFeedback = ctx.createGain();
    this.delayFeedback.gain.value = 0.32;

    this.delayTone = ctx.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 2600;

    this.delayReturn = ctx.createGain();
    this.delayReturn.gain.value = 0.3;

    this.delayBus.connect(this.delayNode);
    this.delayNode.connect(this.delayTone);
    this.delayTone.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayNode);   // the repeat loop
    this.delayNode.connect(this.delayReturn);
    this.delayReturn.connect(this.mix);
    this.delayReturn.connect(this.reverbBus);     // echoes sit in the room too

    this.noiseBuffer = this._noise(3);

    this._buildDrone();
    this._buildAir();

    /** Bundle handed to every voice. */
    this.io = {
      ctx,
      dry: this.dry,
      reverb: this.reverbBus,
      delay: this.delayBus,
      noiseBuffer: this.noiseBuffer,
      hasWorklets: !!this.hasWorklets,
    };
  }

  /** Sustained low tone under everything; carries the sense of place. */
  _buildDrone() {
    const ctx = this.ctx;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;

    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 500;
    this.droneFilter.Q.value = 0.8;
    this.droneFilter.connect(this.droneGain);

    this.droneGain.connect(this.dry);
    const send = ctx.createGain();
    send.gain.value = 0.4;
    this.droneGain.connect(send).connect(this.reverbBus);

    this.droneOscs = [
      { type: 'sine', mul: 1, level: 0.6, detune: 0 },
      { type: 'sawtooth', mul: 2, level: 0.10, detune: -7 },
      { type: 'sawtooth', mul: 2, level: 0.10, detune: 7 },
      { type: 'triangle', mul: 3, level: 0.05, detune: 3 },
    ].map((spec) => {
      const osc = ctx.createOscillator();
      osc.type = spec.type;
      osc.frequency.value = 55 * spec.mul;
      osc.detune.value = spec.detune;
      const g = ctx.createGain();
      g.gain.value = spec.level;
      osc.connect(g).connect(this.droneFilter);
      osc.start();
      return { osc, mul: spec.mul };
    });
  }

  /** Filtered noise bed: wind, room tone, distance. */
  _buildAir() {
    const ctx = this.ctx;
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0;

    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = 'bandpass';
    this.airFilter.frequency.value = 900;
    this.airFilter.Q.value = 0.9;
    this.airFilter.connect(this.airGain);

    this.airGain.connect(this.dry);
    const send = ctx.createGain();
    send.gain.value = 0.85;
    this.airGain.connect(send).connect(this.reverbBus);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.connect(this.airFilter);
    src.start();
    this.airSource = src;

    // Very slow sweep so the bed breathes instead of sitting still.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const depth = ctx.createGain();
    depth.gain.value = 400;
    lfo.connect(depth).connect(this.airFilter.frequency);
    lfo.start();
    this.airLfoDepth = depth;
  }

  /* --------------------------------------------------------------- buffers */

  _noise(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  /**
   * Procedural impulse response: decaying noise, one-pole low-passed so the
   * tail is a room rather than a hiss, with a short pre-swell for the early
   * reflections.
   */
  _impulse(seconds) {
    const key = seconds.toFixed(2);
    if (this._reverbCache.has(key)) return this._reverbCache.get(key);

    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    const decay = 3.2;

    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const white = Math.random() * 2 - 1;
        lp += 0.22 * (white - lp);                 // one-pole lowpass
        const build = Math.min(1, i / (rate * 0.012)); // soften the very front
        data[i] = lp * (1 - t) ** decay * build;
      }
    }

    this._reverbCache.set(key, buf);
    return buf;
  }

  /** Swap room size by crossfading between the two convolvers. */
  _setReverbSize(seconds) {
    const target = Math.round(Math.min(9, Math.max(0.8, seconds)) * 2) / 2;
    if (Math.abs(target - this._reverbSeconds) < 0.25) return;
    this._reverbSeconds = target;

    const now = this.ctx.currentTime;
    const incoming = this._reverbSlot === 'a' ? 'b' : 'a';
    const conv = incoming === 'a' ? this.convA : this.convB;
    const gainIn = incoming === 'a' ? this.convAGain : this.convBGain;
    const gainOut = incoming === 'a' ? this.convBGain : this.convAGain;

    conv.buffer = this._impulse(target);
    gainIn.gain.setTargetAtTime(1, now, REVERB_CROSSFADE_S / 3);
    gainOut.gain.setTargetAtTime(0, now, REVERB_CROSSFADE_S / 3);
    this._reverbSlot = incoming;
  }

  /* ------------------------------------------------------------------ plan */

  /**
   * Hand the engine a new arrangement. Continuous parameters start moving now;
   * anything that would clash mid-phrase is held until the next phrase.
   */
  applyPlan(plan, stepFn, { urgent = false } = {}) {
    if (!this.ctx) return;
    this._applyContinuous(plan);

    if (!this.plan) {
      this._commit(plan, stepFn);
    } else if (isDiscreteChange(this.plan, plan)) {
      // `urgent` means the listener jumped rather than walked, so wait only
      // for the next bar. A four-bar phrase is right for a transition you walk
      // into and far too long for one you asked for.
      //
      // Urgency sticks until the change is actually taken. Position updates
      // arrive about once a second and each one lands here, so a plain
      // reassignment would let the very next tick quietly downgrade a jump
      // back to a full phrase — which is the slow handover it was meant to fix.
      this._pending = { plan, stepFn, urgent: urgent || !!this._pending?.urgent };
    } else {
      // Same harmony and same theme, new shading — keep the current phrase and
      // take everything else immediately.
      this.plan = { ...plan, root: this.plan.root, scale: this.plan.scale,
        progression: this.plan.progression, barsPerChord: this.plan.barsPerChord };
      this.stepFn = stepFn;
    }
  }

  _applyContinuous(plan) {
    const now = this.ctx.currentTime;
    const set = (param, value, tc = MORPH_TC) =>
      param.setTargetAtTime(value, now, tc);

    this._targetBpm = plan.bpm;

    // Ramp rather than jump: switching theme mid-walk should not click.
    set(this.themeTrim.gain, plan.trim ?? 1, 0.6);

    set(this.reverbReturn.gain, plan.fx.reverbMix);
    set(this.delayReturn.gain, plan.fx.delayMix);
    set(this.delayFeedback.gain, Math.min(0.72, plan.fx.delayFeedback));
    set(this.delayTone.frequency, plan.fx.delayTone, 1.5);
    this._setReverbSize(plan.fx.reverbSeconds);

    set(this.droneGain.gain, plan.layers.drone);
    set(this.droneFilter.frequency, plan.timbre.droneCutoff, 3);
    set(this.airGain.gain, plan.layers.air);
    set(this.airFilter.frequency, plan.timbre.airCutoff, 3.5);
    set(this.airFilter.Q, plan.timbre.airQ ?? 0.9, 3);
  }

  /** Take on the parts that can only change at a musical seam. */
  _commit(plan, stepFn) {
    this.plan = plan;
    this.stepFn = stepFn;
    if (!this.ctx) return;

    const now = this.ctx.currentTime;

    // Glide the drone to the new key rather than jumping.
    const rootFreq = 55 * 2 ** ((plan.root - 45) / 12); // A2 = midi 45
    for (const { osc, mul } of this.droneOscs) {
      const target = Math.max(20, rootFreq * mul);
      osc.frequency.cancelScheduledValues(now);
      osc.frequency.setValueAtTime(osc.frequency.value, now);
      osc.frequency.exponentialRampToValueAtTime(target, now + 2.5);
    }

    // Keep the delay musical: a dotted eighth at the new tempo.
    const dotted = (60 / plan.bpm / 4) * 3;
    this.delayNode.delayTime.cancelScheduledValues(now);
    this.delayNode.delayTime.setValueAtTime(this.delayNode.delayTime.value, now);
    this.delayNode.delayTime.linearRampToValueAtTime(
      Math.min(1.9, dotted), now + 2.0);
  }

  /* ------------------------------------------------------------- transport */

  _tick() {
    const ctx = this.ctx;
    while (this._nextStepTime < ctx.currentTime + SCHEDULE_AHEAD_S) {
      const step = this._step;

      // Phrase seam: safe point to change key, mode or chord sequence.
      const boundary = this._pending?.urgent ? STEPS_PER_BAR : STEPS_PER_PHRASE;
      if (step % boundary === 0 && this._pending) {
        this._commit(this._pending.plan, this._pending.stepFn);
        this._pending = null;
      }

      if (this.plan && this.stepFn) {
        const stepDur = 60 / this._bpm / 4;
        // A theme throwing must not take the transport down with it — that
        // matters most for themes someone else wrote.
        try {
          this.stepFn(this.io, this.plan, {
            step,
            time: this._nextStepTime,
            stepDur,
            barDur: stepDur * STEPS_PER_BAR,
            stepInBar: step % STEPS_PER_BAR,
            bar: Math.floor(step / STEPS_PER_BAR),
            barInPhrase: Math.floor(step / STEPS_PER_BAR) % BARS_PER_PHRASE,
            phrase: Math.floor(step / STEPS_PER_PHRASE),
          });
        } catch (err) {
          if (!this._stepErrorLogged) {
            this._stepErrorLogged = true;
            console.error('theme step() failed; skipping affected steps:', err);
          }
        }
      }

      // Ease toward the target tempo so speeding up feels like acceleration.
      this._bpm += (this._targetBpm - this._bpm) * 0.02;
      this._nextStepTime += 60 / this._bpm / 4;
      this._step++;
    }
  }

  get bpm() {
    return this._bpm;
  }

  /** Master level for the visualiser, 0..1. */
  level() {
    if (!this.analyser) return 0;
    const buf = this._levelBuf ||= new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    return sum / buf.length / 255;
  }

  spectrum() {
    if (!this.analyser) return null;
    const buf = this._specBuf ||= new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(buf);
    return buf;
  }
}

/** Does this plan change something we must not swap mid-phrase? */
function isDiscreteChange(a, b) {
  // A theme change is always discrete, even if the harmony happens to match.
  return a.themeId !== b.themeId ||
    a.root !== b.root ||
    a.scale !== b.scale ||
    a.barsPerChord !== b.barsPerChord ||
    a.progression.join() !== b.progression.join();
}
