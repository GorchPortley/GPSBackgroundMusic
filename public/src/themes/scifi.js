/**
 * Theme: Sci-Fi — cold, wide, mechanical.
 *
 * Vast drones under quartal pads, a pulse sequencer that ticks like a system
 * doing something in another room, inharmonic bells, telemetry blips, and
 * noise sweeps that mark phrase boundaries the way a film cue would.
 *
 * Harmony deliberately avoids resolving: fourths instead of thirds, whole-tone
 * and octatonic modes in the middle of the brightness range, and chord
 * sequences that shift by step rather than by function.
 */

import {
  mulberry32, noteName, pickMode, pickProgression, scaleNote,
} from '../audio/theory.js';
import {
  bassVoice, bellVoice, blipVoice, clank, hat, kick, padVoice, pulseVoice, sweepVoice,
} from '../audio/voices.js';
import { gate, quantise, rnd } from './util.js';

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

/** Sequencer figures in 16th positions, sparse to relentless. */
const SEQ_PATTERNS = [
  [0, 8],
  [0, 6, 10],
  [0, 4, 8, 12],
  [0, 2, 4, 6, 8, 10, 12, 14],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
];

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
      bell: gate(t, 0.30, 0.5) * (0.4 + 0.6 * s),
      blip: gate(d, 0.30, 0.5),
      perc: gate(e, 0.42, 0.36),
      sweep: 0.35 + 0.65 * s,
    };

    return {
      seed,
      mood,
      trim: 0.72,
      bpm: 56 + e * 40 + (rng() - 0.5) * 3,
      root,
      scale,
      progression: progression.degrees,
      barsPerChord,
      layers,

      timbre: {
        padCutoff: 380 + b * 2600 + e * 500,
        padDetune: 9 + t * 26,          // wide detune is the cold, uncanny part
        padResonance: 0.8 + t * 1.8,
        chordSize: 4,
        seqDuty: 0.5 - 0.28 * d,        // thinner and more nasal as it gets busy
        seqCutoff: 700 + b * 5200,
        seqResonance: 3 + t * 7,        // resonant filter = machine
        bellRatio: t > 0.55 ? 1.414 : 3.7, // tritone or a high inharmonic clang
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
        pattern: SEQ_PATTERNS[Math.min(SEQ_PATTERNS.length - 1, Math.floor(d * 5))],
        glide: t > 0.5,
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
    const { step, stepInBar, bar, barInPhrase, time, stepDur, barDur } = pos;
    const { scale, progression, barsPerChord, layers, timbre, perc, seq } = plan;

    const chordIndex = Math.floor(bar / barsPerChord) % progression.length;
    const degree = progression[chordIndex];
    const chordStart = stepInBar === 0 && bar % barsPerChord === 0;
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
    if (layers.bass > 0.05 && stepInBar === 0 && bar % Math.max(1, barsPerChord / 2) === 0) {
      bassVoice(io, {
        note: scaleNote(plan.root, scale, degree),
        time: time + human(1),
        dur: barDur * 0.92,
        gain: 0.28 * layers.bass,
        cutoff: 180 + plan.mood.b * 200,
        reverb: 0.18,
      });
    }

    /* ---- sequencer: the signature layer ---- */
    if (layers.seq > 0.05) {
      const idx = seq.pattern.indexOf(stepInBar);
      if (idx >= 0) {
        const shape = SEQ_SHAPE[(bar * seq.pattern.length + idx) % SEQ_SHAPE.length];
        const note = scaleNote(plan.root + 24, scale, degree + shape);
        const prev = SEQ_SHAPE[(bar * seq.pattern.length + idx - 1 + SEQ_SHAPE.length) % SEQ_SHAPE.length];

        pulseVoice(io, {
          note,
          time: time + human(2),
          dur: stepDur * 0.8,
          gain: 0.075 * layers.seq,
          duty: timbre.seqDuty,
          cutoff: timbre.seqCutoff,
          resonance: timbre.seqResonance,
          // Portamento between steps reads as something scanning.
          glideFrom: seq.glide && idx > 0
            ? scaleNote(plan.root + 24, scale, degree + prev) : null,
          reverb: 0.35,
          delay: 0.45,
          pan: idx % 2 ? 0.3 : -0.3,
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
    if (layers.blip > 0.05 && stepInBar % 4 === 3) {
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

    /* ---- sweeps: a riser into each phrase, a faller out of the last one ---- */
    if (layers.sweep > 0.2 && stepInBar === 0) {
      const intoPhrase = barInPhrase === 3;
      if (intoPhrase) {
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
    }

    /* ---- percussion: deep and metallic, never a drum kit ---- */
    if (layers.perc > 0.04) {
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
