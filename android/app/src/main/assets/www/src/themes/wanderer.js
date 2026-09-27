/**
 * Theme: Wanderer — the default, deliberately genre-neutral one.
 *
 * Warm cinematic ambient. Sustained pads over a drone, a soft bass, mallet-ish
 * plucks that thicken as a place gets busier, occasional bells, and percussion
 * that only shows up once there is real energy around you. It aims to sit
 * behind whatever you are doing rather than demand attention.
 *
 * A theme has two jobs:
 *   plan(mood, seed) — turn a mood vector into a concrete arrangement
 *   step(io, plan, pos) — schedule notes for one 16th-note step
 *
 * The engine handles everything about *changing* between plans smoothly, so a
 * theme can treat each plan as a static description.
 */

import {
  chordNotes, mulberry32, noteName, pickMode, pickProgression, scaleNote,
} from '../audio/theory.js';
import {
  bassVoice, bellVoice, hat, kick, padVoice, pluckVoice, rim, shaker,
} from '../audio/voices.js';
import { gate, quantise, rnd } from './util.js';

/** Arpeggio shapes in 16th-note positions, sparse to busy. */
const PLUCK_PATTERNS = [
  [0, 6, 10],
  [0, 4, 8, 12],
  [0, 3, 6, 9, 12, 14],
  [0, 2, 4, 6, 8, 10, 12, 14],
];

export const wanderer = {
  id: 'wanderer',
  name: 'Wanderer',
  available: true,
  description: 'Warm cinematic ambient. Neutral enough for anywhere.',

  /* ------------------------------------------------------------------ plan */

  plan(mood, seed) {
    const rng = mulberry32(seed);
    const { e, b, d, t, w, s } = mood;

    // Harmony is chosen from a coarsened mood so that drifting a few metres
    // cannot flip the mode back and forth. Everything else below tracks the
    // live values continuously.
    const scale = pickMode(quantise(b), quantise(t));
    const progression = pickProgression(quantise(b), rng());

    // Tonic in the bass register. Keyed off the seed so one scene keeps one
    // key, and a genuinely different place gets a genuinely different one.
    const root = 36 + Math.floor(rng() * 12);

    // Spacious or sleepy scenes hold each chord twice as long.
    const barsPerChord = s > 0.62 || e < 0.30 ? 2 : 1;

    const layers = {
      drone: 0.035 + 0.11 * s * (1 - e * 0.35),
      air: 0.008 + 0.042 * s * (0.55 + 0.45 * (1 - w)),
      pad: 0.72 + 0.28 * (1 - e * 0.4),
      bass: gate(e, 0.12, 0.42),
      pluck: gate(d, 0.24, 0.52),
      bell: gate(b, 0.44, 0.40) * (0.35 + 0.65 * s),
      perc: gate(e, 0.34, 0.34),
    };

    return {
      seed,
      mood,
      trim: 1.00,
      bpm: 58 + e * 46 + (rng() - 0.5) * 4,
      root,
      scale,
      progression: progression.degrees,
      barsPerChord,
      layers,

      timbre: {
        // Warm places get triangles; cold ones get the harder sawtooth edge.
        padWave: w > 0.58 ? 'triangle' : 'sawtooth',
        padDetune: 4 + t * 20,
        padCutoff: 520 + b * 3000 + e * 700,
        padResonance: 0.6 + t * 1.6,
        chordSize: t > 0.45 || s > 0.62 ? 4 : 3,
        pluckBright: 0.25 + b * 0.7,
        pluckDecay: 0.55 + s * 2.1,
        droneCutoff: 150 + b * 520,
        airCutoff: 480 + b * 2900,
        airQ: 0.7 + (1 - s) * 1.4,
      },

      fx: {
        reverbMix: 0.18 + s * 0.52,
        reverbSeconds: 1.2 + s * 6.0,
        delayMix: 0.05 + d * 0.26,
        delayFeedback: 0.16 + s * 0.36,
        delayTone: 900 + b * 4000,
      },

      perc: {
        kick: e > 0.48,
        push: e > 0.70,
        hat: gate(e, 0.44, 0.40),
        shaker: gate(e, 0.28, 0.40),
        rim: d > 0.58 && e > 0.52,
      },

      melody: {
        density: d,
        pattern: PLUCK_PATTERNS[Math.min(PLUCK_PATTERNS.length - 1, Math.floor(d * 4))],
        leadChance: gate(d, 0.35, 0.5) * 0.45,
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
    const { scale, progression, barsPerChord, layers, timbre, perc, melody } = plan;

    const chordIndex = Math.floor(bar / barsPerChord) % progression.length;
    const degree = progression[chordIndex];
    const chordStart = stepInBar === 0 && bar % barsPerChord === 0;

    // Tiny timing scatter keeps repeated bars from sounding machine-stamped.
    const human = (salt) => (rnd(plan.seed, bar, step, salt) - 0.5) * 0.007;

    /* ---- pad: the chord bed, retriggered on each chord change ---- */
    if (chordStart && layers.pad > 0.02) {
      const notes = chordNotes(plan.root + 24, scale, degree, timbre.chordSize);
      padVoice(io, {
        notes,
        time,
        dur: barDur * barsPerChord * 1.08, // overlap so chords dissolve into each other
        gain: 0.082 * layers.pad,
        wave: timbre.padWave,
        detune: timbre.padDetune,
        cutoff: timbre.padCutoff,
        resonance: timbre.padResonance,
        reverb: 0.55,
      });
    }

    /* ---- bass ---- */
    if (layers.bass > 0.05) {
      const bassNote = scaleNote(plan.root, scale, degree);
      if (stepInBar === 0) {
        bassVoice(io, {
          note: bassNote,
          time: time + human(1),
          dur: stepDur * 6,
          gain: 0.26 * layers.bass,
          cutoff: 260 + plan.mood.b * 260,
        });
      } else if (stepInBar === 10 && perc.push) {
        bassVoice(io, {
          note: bassNote,
          time: time + human(2),
          dur: stepDur * 3,
          gain: 0.18 * layers.bass,
          cutoff: 240 + plan.mood.b * 240,
        });
      }
    }

    /* ---- plucks: arpeggio over the current chord ---- */
    if (layers.pluck > 0.05) {
      const idx = melody.pattern.indexOf(stepInBar);
      if (idx >= 0) {
        const ascending = bar % 2 === 0;
        const position = ascending ? idx : melody.pattern.length - 1 - idx;
        // Chord tones are two scale steps apart, so stepping by 2 arpeggiates.
        let deg = degree + position * 2;
        // Occasional passing tone on a weak step, for a little life.
        if (stepInBar % 4 !== 0 && rnd(plan.seed, bar, step, 3) < 0.18) deg += 1;

        pluckVoice(io, {
          note: scaleNote(plan.root + 24, scale, deg),
          time: time + human(4),
          gain: 0.105 * layers.pluck * (stepInBar === 0 ? 1 : 0.72),
          decay: timbre.pluckDecay,
          bright: timbre.pluckBright,
          reverb: 0.35,
          delay: 0.3,
          pan: (idx % 2 ? 0.22 : -0.22),
        });
      }
    }

    /* ---- lead: a sparse line wandering around the chord's fifth ---- */
    if (melody.leadChance > 0.02 && (stepInBar === 4 || stepInBar === 12)) {
      if (rnd(plan.seed, bar, step, 5) < melody.leadChance) {
        const wobble = Math.round(rnd(plan.seed, bar, step, 6) * 4) - 2;
        pluckVoice(io, {
          note: scaleNote(plan.root + 36, scale, degree + 4 + wobble),
          time: time + human(7),
          gain: 0.07 * layers.pluck,
          decay: timbre.pluckDecay * 1.6,
          bright: timbre.pluckBright * 0.8,
          reverb: 0.6,
          delay: 0.45,
        });
      }
    }

    /* ---- bells: phrase markers, high and washed out ---- */
    if (layers.bell > 0.04) {
      const onPhrase = barInPhrase === 0 && stepInBar === 0;
      const midPhrase = barInPhrase === 2 && stepInBar === 8 &&
        rnd(plan.seed, bar, step, 8) < 0.5;
      if (onPhrase || midPhrase) {
        const tone = [2, 4, 6][Math.floor(rnd(plan.seed, bar, step, 9) * 3)];
        bellVoice(io, {
          note: scaleNote(plan.root + 48, scale, degree + tone),
          time: time + human(10),
          gain: 0.07 * layers.bell * (onPhrase ? 1 : 0.65),
          decay: 2.5 + plan.mood.s * 3.5,
          ratio: 2.01,
          index: 2 + plan.mood.t * 3,
          reverb: 0.8,
          delay: 0.35,
        });
      }
    }

    /* ---- percussion ---- */
    if (layers.perc > 0.04) {
      const p = layers.perc;

      if (perc.kick && (stepInBar === 0 || (stepInBar === 10 && perc.push))) {
        kick(io, { time: time + human(11), gain: 0.40 * p * (stepInBar === 0 ? 1 : 0.7) });
      }

      if (perc.hat > 0.05 && stepInBar % 4 === 2) {
        hat(io, { time: time + human(12), gain: 0.05 * p * perc.hat });
      }
      // Very busy places fill in the remaining 16ths.
      if (perc.hat > 0.7 && stepInBar % 2 === 1 && stepInBar % 4 !== 2) {
        hat(io, { time: time + human(13), gain: 0.022 * p * perc.hat, decay: 0.03 });
      }

      if (perc.shaker > 0.05 && stepInBar % 2 === 1) {
        const accent = stepInBar % 8 === 5 ? 1 : 0.6;
        shaker(io, {
          time: time + human(14),
          gain: 0.034 * p * perc.shaker * accent,
        });
      }

      if (perc.rim && stepInBar === 8) {
        rim(io, { time: time + human(15), gain: 0.07 * p });
      }
    }
  },
};
