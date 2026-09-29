/**
 * Theme: Sci-Fi — cold, wide, mechanical.
 *
 * Vast drones under quartal pads, a pulse sequencer that ticks like a system
 * doing something in another room, inharmonic bells, a glassy FM line, telemetry
 * blips, and noise sweeps that mark phrase boundaries the way a film cue would.
 *
 * Harmony deliberately avoids resolving: fourths instead of thirds, whole-tone
 * and octatonic modes in the middle of the brightness range, and chord
 * sequences that shift by step rather than by function. The quartal stacks
 * move in parallel on purpose — planing is the sound — so they are *not*
 * voice-led.
 *
 * Form (P2): A A B A. In B the whole harmony planes up a scale step, the
 * sequencer thins to every other hit and the glass line comes forward. The
 * sequencer's rhythm is Euclidean (C3.1) — k hits spread over the bar, k from
 * density — and its rotation and walk shift each time round the form. The
 * last bar of every fourth phrase is air (C3.7): the machine stops and the
 * pad rings. Before a handover the sequencer scans up in 16ths (C3.6).
 */

import {
  mulberry32, noteName, pickMode, pickProgression, scaleNote,
} from '../audio/theory.js';
import {
  bassVoice, bellVoice, blipVoice, clank, fmVoice, hat, kick, padVoice, pulseVoice, sweepVoice,
} from '../audio/voices.js';
import {
  breathing, chordAt, euclid, gate, melodyAt, melodyEvent, quantise, rnd,
} from './util.js';

// The glass line's bar cache (util.melodyAt).
const glass = {};

/** Dark to bright. The floating modes sit in the middle, where they unsettle most. */
const MODES = [
  'locrian', 'phrygian', 'octatonic', 'aeolian', 'wholeTone', 'dorian', 'lydian',
];

/** Static or stepwise. Nothing here resolves like a cadence. */
const PROGRESSIONS = [
  { name: 'drone', degrees: [0], brightness: 0.50 },
  { name: 'i — ♭II', degrees: [0, 1], brightness: 0.16 },
  { name: 'i — VII', degrees: [0, 6], brightness: 0.30 },
  { name: 'i — VI', degrees: [0, 5], brightness: 0.38 },
  { name: 'i — iv — i — VII', degrees: [0, 3, 0, 6], brightness: 0.42 },
  { name: 'I — II', degrees: [0, 1], brightness: 0.66 },
  { name: 'I — III', degrees: [0, 2], brightness: 0.74 },
  { name: 'I — V — I — IV', degrees: [0, 4, 0, 3], brightness: 0.82 },
];

/** Sequencer hits per bar (Euclidean k of 16), sparse to relentless. */
const SEQ_HITS = [2, 3, 4, 4, 6, 8, 11];

/** Degree offsets the sequencer walks, in scale steps above the chord root. */
const SEQ_SHAPE = [0, 3, 7, 3, 10, 7, 3, 0, 0, 3, 7, 10, 14, 10, 7, 3];

export const scifi = {
  id: 'scifi',
  name: 'Sci-Fi',
  available: true,
  description: 'Cold synthesis, wide drones, distant machinery.',
  color: '#5cc8ff',

  /* ------------------------------------------------------------------ plan */

  plan(mood, seed) {
    const rng = mulberry32(seed);
    const { e, b, d, t, w, s } = mood;

    const scale = pickMode(quantise(b), quantise(t), MODES);
    const progression = pickProgression(quantise(b), rng(), PROGRESSIONS);

    // Sits a little lower than Wanderer — sci-fi lives in the basement.
    const root = 33 + Math.floor(rng() * 12);

    // Harmony moves rarely. Space makes it move even less.
    const barsPerChord = s > 0.68 ? 4 : 2;

    const layers = {
      // The drone and the air bed are the genre, so both sit forward — but
      // they are sustained, so they add up fast. Kept near Wanderer's range.
      drone: 0.055 + 0.085 * (0.4 + 0.6 * s),
      air: 0.013 + 0.030 * (0.5 + 0.5 * s),
      pad: 0.70 + 0.30 * (1 - e * 0.3),
      bass: gate(e, 0.08, 0.38),
      seq: gate(d, 0.18, 0.45),
      // The glass line is present even when nothing else moves.
      glass: 0.5 + 0.5 * gate(d, 0.25, 0.5),
      bell: gate(t, 0.30, 0.5) * (0.4 + 0.6 * s),
      blip: gate(d, 0.30, 0.5),
      perc: gate(e, 0.42, 0.36),
      sweep: 0.35 + 0.65 * s,
    };

    return {
      seed,
      mood,
      trim: 1.05,
      bpm: 56 + e * 40 + (rng() - 0.5) * 3,
      root,
      scale,
      progression: progression.degrees,
      barsPerChord,
      layers,
      // Birdsong and café murmur fight a starship; keep the place faint.
      ambience: 0.4,
      // A A B A; B is the same harmony planed up a step. Constant, so it can
      // never change mid-phrase.
      form: { breathEvery: 4, sections: 'AABA', B: { degreeShift: 1 } },

      timbre: {
        padCutoff: 380 + b * 2600 + e * 500,
        padDetune: 9 + t * 26,          // wide detune is the cold, uncanny part
        padResonance: 0.8 + t * 1.8,
        chordSize: 4,
        seqDuty: 0.5 - 0.28 * d,        // thinner and more nasal as it gets busy
        seqCutoff: 700 + b * 5200,
        seqResonance: 3 + t * 7,        // resonant filter = machine
        bellRatio: t > 0.55 ? 1.414 : 3.7, // tritone or a high inharmonic clang
        // Glass: an inharmonic FM ratio, more metal when tense, softer when warm.
        glassRatio: t > 0.5 ? 3.5 : 7,
        glassIndex: 1.2 + t * 2.4 + (1 - w) * 0.8,
        glassRelease: 0.6 + s * 1.6,
        droneCutoff: 110 + b * 380,
        airCutoff: 300 + b * 2400,
        airQ: 0.5 + (1 - s) * 1.2,
      },

      fx: {
        reverbMix: 0.30 + s * 0.48,
        reverbSeconds: 2.6 + s * 6.2,   // never small; this is a big space
        delayMix: 0.10 + d * 0.30,
        delayFeedback: 0.28 + s * 0.36,
        delayTone: 700 + b * 3600,
      },

      seq: {
        hits: SEQ_HITS[Math.min(SEQ_HITS.length - 1, Math.floor(d * SEQ_HITS.length))],
        glide: t > 0.5,
      },

      // The glass line (C3.8): high, sparse, and it leaps when tense.
      gen: {
        name: 'scifi-glass',
        density: 0.08 + 0.35 * d,
        rest: 0.90 - 0.25 * d,
        leap: 0.2 + 0.5 * t,
        contour: (b - 0.5) * 1.4,
        lo: 2,
        hi: 12,
      },

      perc: {
        kick: e > 0.44,
        clank: d > 0.5 && e > 0.4,
        hat: gate(e, 0.5, 0.4),
      },

      meta: {
        key: noteName(root),
        mode: scale,
        progression: progression.name,
      },
    };
  },

  /* ------------------------------------------------------------------ step */

  step(io, plan, pos) {
    const { step, stepInBar, bar, barInPhrase, phrase, time, stepDur, barDur } = pos;
    const { scale, barsPerChord, layers, timbre, perc, seq } = plan;

    const { degree, letter, chordChange } = chordAt(plan, bar);
    const chordStart = stepInBar === 0 && chordChange;
    const drift = letter === 'B';
    // The last bar before a waiting change lands (C3.6): its second half is
    // the fill, and the fill wins over the bar of air, as in spec.js.
    const fillBar = pos.stepsToCommit !== undefined && pos.stepsToCommit <= 16;
    const filling = fillBar && stepInBar >= 8;
    const breath = breathing(plan, pos) && !fillBar;
    const cycle = Math.floor(phrase / 4);
    const human = (salt) => (rnd(plan.seed, bar, step, salt) - 0.5) * 0.006;

    /* ---- pad: quartal voicing. Stacking fourths instead of thirds is what
       stops this sounding like an orchestra and starts it sounding like a
       ship. Three scale steps is a fourth in a seven-note scale. ---- */
    if (chordStart && layers.pad > 0.02) {
      const notes = [];
      for (let i = 0; i < timbre.chordSize; i++) {
        notes.push(scaleNote(plan.root + 24, scale, degree + i * 3));
      }
      padVoice(io, {
        notes,
        time,
        dur: barDur * barsPerChord * 1.1,
        gain: 0.075 * layers.pad,
        wave: 'sawtooth',
        detune: timbre.padDetune,
        cutoff: timbre.padCutoff,
        resonance: timbre.padResonance,
        reverb: 0.7,
      });
    }

    /* ---- sub bass: long, flat, unhurried ---- */
    if (layers.bass > 0.05 && stepInBar === 0 && (chordChange || bar % Math.max(1, barsPerChord / 2) === 0)) {
      bassVoice(io, {
        note: scaleNote(plan.root, scale, degree),
        time: time + human(1),
        dur: barDur * 0.92,
        gain: 0.28 * layers.bass,
        cutoff: 180 + plan.mood.b * 200,
        reverb: 0.18,
      });
    }

    /* ---- sequencer: the signature layer. Euclidean hits; the rotation and
       the point it starts its walk move each time round the form. In the
       fill it scans up in 16ths instead. ---- */
    const seqPulse = (idx, shape, prevShape, level, salt) => {
      pulseVoice(io, {
        note: scaleNote(plan.root + 24, scale, degree + shape),
        time: time + human(salt),
        dur: stepDur * 0.8,
        gain: 0.075 * level,
        duty: timbre.seqDuty,
        cutoff: timbre.seqCutoff,
        resonance: timbre.seqResonance,
        // Portamento between steps reads as something scanning.
        glideFrom: seq.glide && prevShape !== null
          ? scaleNote(plan.root + 24, scale, degree + prevShape) : null,
        reverb: 0.35,
        delay: 0.45,
        pan: idx % 2 ? 0.3 : -0.3,
      });
    };
    if (filling) {
      const i = stepInBar - 8;                     // 0..7, rising
      // Present even where the sequencer was silent: it is the cue.
      seqPulse(i, i * 2, i > 0 ? (i - 1) * 2 : null, (0.45 + 0.07 * i) * Math.max(0.5, layers.seq), 2);
    } else if (layers.seq > 0.05 && !breath) {
      const rot = Math.floor(rnd(plan.seed, cycle, 31) * 4);
      const pattern = euclid(seq.hits, 16, rot);
      const idx = pattern.indexOf(stepInBar);
      if (idx >= 0 && (!drift || idx % 2 === 0)) {
        const start = Math.floor(rnd(plan.seed, cycle, 32) * SEQ_SHAPE.length);
        const at = (k) => SEQ_SHAPE[((start + bar * pattern.length + k) % SEQ_SHAPE.length + SEQ_SHAPE.length) % SEQ_SHAPE.length];
        seqPulse(idx, at(idx), idx > 0 ? at(idx - 1) : null, layers.seq, 2);
      }
    }

    /* ---- glass: a generated FM line, high and far away. In A it only
       answers, in the second and fourth bars; in B it carries the phrase. ---- */
    if (layers.glass > 0.05 && !filling && (drift || barInPhrase % 2 === 1)) {
      const { degree: d0, events } = melodyAt(glass, plan, bar, plan.gen);
      const ev = melodyEvent(events, stepInBar);
      if (ev) {
        fmVoice(io, {
          // Two octaves above the pad, not three: at ratio 7 the modulator of
          // a higher note would pass Nyquist.
          note: scaleNote(plan.root + 36, scale, d0 + Number(ev.value)),
          time: time + human(6),
          dur: stepDur * 0.6,
          gain: 0.045 * layers.glass * (drift ? 1.35 : 1),
          ratio: timbre.glassRatio,
          index: timbre.glassIndex,
          decay: 0.25,
          release: timbre.glassRelease,
          reverb: 0.75,
          delay: 0.5,
          pan: (rnd(plan.seed, bar, step, 12) - 0.5) * 0.9,
        });
      }
    }

    /* ---- inharmonic bells at phrase starts ---- */
    if (layers.bell > 0.04 && barInPhrase === 0 && stepInBar === 0) {
      bellVoice(io, {
        note: scaleNote(plan.root + 48, scale, degree + 2),
        time: time + human(3),
        gain: 0.055 * layers.bell,
        decay: 3.5 + plan.mood.s * 4,
        ratio: timbre.bellRatio,
        index: 3 + plan.mood.t * 5,
        reverb: 0.85,
        delay: 0.4,
      });
    }

    /* ---- telemetry: sparse high blips, deliberately off-grid ---- */
    if (layers.blip > 0.05 && stepInBar % 4 === 3 && !breath && !filling) {
      if (rnd(plan.seed, bar, step, 4) < 0.22 * layers.blip) {
        const up = rnd(plan.seed, bar, step, 5) < 0.5;
        blipVoice(io, {
          note: scaleNote(plan.root + 60, scale, degree + Math.floor(rnd(plan.seed, bar, step, 6) * 7)),
          time: time + human(7),
          gain: 0.045 * layers.blip,
          decay: 0.06 + rnd(plan.seed, bar, step, 8) * 0.08,
          duty: 0.5,
          bend: up ? 5 : -5,
          reverb: 0.4,
          delay: 0.5,
        });
      }
    }

    /* ---- sweeps: a riser into each phrase. Not when a change is waiting —
       the engine plays its own riser into a handover. ---- */
    if (layers.sweep > 0.2 && stepInBar === 0 && barInPhrase === 3 && pos.stepsToCommit === undefined) {
      sweepVoice(io, {
        time,
        dur: barDur * 0.95,
        gain: 0.05 * layers.sweep,
        from: 300,
        to: 6000,
        q: 2.5,
        reverb: 0.8,
      });
    }

    /* ---- percussion: deep and metallic, never a drum kit ---- */
    if (layers.perc > 0.04 && !breath) {
      const p = layers.perc;

      if (perc.kick && stepInBar === 0) {
        kick(io, { time: time + human(9), gain: 0.34 * p, tone: 105 });
      }
      if (perc.clank && stepInBar === 8) {
        clank(io, {
          time: time + human(10),
          gain: 0.075 * p,
          tone: 900 + plan.mood.b * 1600,
          decay: 0.4 + plan.mood.s * 0.6,
          reverb: 0.55,
        });
      }
      if (perc.hat > 0.05 && stepInBar % 4 === 2) {
        hat(io, { time: time + human(11), gain: 0.035 * p * perc.hat, decay: 0.03 });
      }
    }
  },
};
