/**
 * Theme: Fantasy — strings, harp and modal folk lines.
 *
 * Bowed string beds over an open-fifth drone, rolled harp chords, and a wooden
 * flute carrying the tune. The harmony is modal rather than functional: it
 * leans on ♭VII and iv, and mostly refuses the leading tone, which is what
 * separates a folk tune from a classical one.
 *
 * Rolled chords matter more than they sound like they should — a harp never
 * strikes all its notes at once, and staggering them by a 16th is most of what
 * makes the instrument read as a harp at all.
 */

import {
  chordNotes, mulberry32, noteName, pickMode, pickProgression, scaleNote,
} from '../audio/theory.js';
import {
  bassVoice, fluteVoice, kick, pluckVoice, rim, shaker, stringVoice,
} from '../audio/voices.js';
import { gate, quantise, rnd } from './util.js';

const MODES = [
  'phrygian', 'aeolian', 'harmonicMinor', 'minorPentatonic', 'dorian',
  'mixolydian', 'ionian', 'lydian',
];

/** Modal motion — ♭VII and iv do the work a dominant would elsewhere. */
const PROGRESSIONS = [
  { name: 'i — ♭II — i', degrees: [0, 1, 0], brightness: 0.14 },
  { name: 'i — VII — VI — VII', degrees: [0, 6, 5, 6], brightness: 0.26 },
  { name: 'i — iv — i — VII', degrees: [0, 3, 0, 6], brightness: 0.34 },
  { name: 'i — VI — VII', degrees: [0, 5, 6], brightness: 0.42 },
  { name: 'I — VII — IV — I', degrees: [0, 6, 3, 0], brightness: 0.58 },
  { name: 'I — V — IV — I', degrees: [0, 4, 3, 0], brightness: 0.70 },
  { name: 'I — IV — vi — V', degrees: [0, 3, 5, 4], brightness: 0.80 },
  { name: 'open fifths', degrees: [0], brightness: 0.50 },
];

/** Where the flute enters. Sparse — it should feel sung, not played. */
const FLUTE_ENTRIES = [0, 6, 10];

export const fantasy = {
  id: 'fantasy',
  name: 'Fantasy',
  available: true,
  description: 'Strings, harp and modal folk lines. Taverns and forests.',
  color: '#c3a6ff',

  /* ------------------------------------------------------------------ plan */

  plan(mood, seed) {
    const rng = mulberry32(seed);
    const { e, b, d, t, w, s } = mood;

    const scale = pickMode(quantise(b), quantise(t), MODES);
    const progression = pickProgression(quantise(b), rng(), PROGRESSIONS);
    const root = 36 + Math.floor(rng() * 12);
    const barsPerChord = s > 0.55 || e < 0.32 ? 2 : 1;

    const layers = {
      drone: 0.05 + 0.12 * s,
      air: 0.006 + 0.03 * s * (0.5 + 0.5 * (1 - w)),
      strings: 0.65 + 0.35 * (1 - e * 0.3),
      bass: gate(e, 0.10, 0.40),
      harp: gate(d, 0.18, 0.46),
      flute: gate(b, 0.30, 0.48) * (0.45 + 0.55 * (1 - e * 0.5)),
      perc: gate(e, 0.44, 0.40),
    };

    return {
      seed,
      mood,
      trim: 0.85,
      bpm: 54 + e * 42 + (rng() - 0.5) * 3,
      root,
      scale,
      progression: progression.degrees,
      barsPerChord,
      layers,

      timbre: {
        stringCutoff: 900 + b * 2600,
        stringDetune: 5 + t * 12,
        stringVibrato: 6 + w * 8,
        chordSize: t > 0.5 ? 4 : 3,
        harpBright: 0.15 + b * 0.4,     // harps are dark and woody, not glassy
        harpDecay: 1.4 + s * 2.4,
        fluteBreath: 0.10 + (1 - w) * 0.18,
        droneCutoff: 170 + b * 420,
        airCutoff: 420 + b * 2200,
        airQ: 0.8 + (1 - s) * 1.2,
      },

      fx: {
        reverbMix: 0.26 + s * 0.48,
        reverbSeconds: 1.8 + s * 5.0,   // a hall, or a forest
        delayMix: 0.04 + d * 0.16,      // sparing — echo is not a folk sound
        delayFeedback: 0.14 + s * 0.26,
        delayTone: 1600 + b * 3000,
      },

      harp: {
        rollSteps: 1,                   // 16th between rolled notes
        pattern: d > 0.6 ? [0, 4, 8, 12] : [0, 8],
      },

      perc: {
        frame: e > 0.46,                // frame drum
        shaker: gate(e, 0.52, 0.4),
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
    const { scale, progression, barsPerChord, layers, timbre, perc, harp } = plan;

    const chordIndex = Math.floor(bar / barsPerChord) % progression.length;
    const degree = progression[chordIndex];
    const chordStart = stepInBar === 0 && bar % barsPerChord === 0;
    const human = (salt) => (rnd(plan.seed, bar, step, salt) - 0.5) * 0.008;

    /* ---- strings: the bed ---- */
    if (chordStart && layers.strings > 0.02) {
      stringVoice(io, {
        notes: chordNotes(plan.root + 24, scale, degree, timbre.chordSize),
        time,
        dur: barDur * barsPerChord * 1.06,
        gain: 0.075 * layers.strings,
        cutoff: timbre.stringCutoff,
        detune: timbre.stringDetune,
        vibrato: timbre.stringVibrato,
        reverb: 0.6,
      });
    }

    /* ---- bass: root and fifth, an open sound with no third ---- */
    if (layers.bass > 0.05 && (stepInBar === 0 || (stepInBar === 8 && plan.mood.e > 0.45))) {
      bassVoice(io, {
        note: scaleNote(plan.root, scale, degree + (stepInBar === 8 ? 4 : 0)),
        time: time + human(1),
        dur: stepDur * 7,
        gain: 0.24 * layers.bass,
        cutoff: 240 + plan.mood.b * 220,
        reverb: 0.14,
      });
    }

    /* ---- harp: rolled chords, never struck all at once ---- */
    if (layers.harp > 0.05 && harp.pattern.includes(stepInBar)) {
      const ascending = rnd(plan.seed, bar, stepInBar, 2) < 0.78;
      const size = 4;
      for (let i = 0; i < size; i++) {
        const which = ascending ? i : size - 1 - i;
        pluckVoice(io, {
          note: scaleNote(plan.root + 24, scale, degree + which * 2),
          // The roll: each note a 16th behind the last.
          time: time + i * stepDur * harp.rollSteps * 0.5 + human(3 + i),
          gain: 0.085 * layers.harp * (1 - i * 0.12),
          decay: timbre.harpDecay,
          bright: timbre.harpBright,
          reverb: 0.45,
          delay: 0.15,
          pan: -0.25 + (i / (size - 1)) * 0.5,
        });
      }
    }

    /* ---- flute: the tune, stepwise and modal ---- */
    if (layers.flute > 0.05 && FLUTE_ENTRIES.includes(stepInBar)) {
      const chance = stepInBar === 0 ? 0.62 : 0.3;
      if (rnd(plan.seed, bar, step, 8) < chance * layers.flute) {
        // Stepwise motion around the chord tones — folk melodies rarely leap.
        const anchor = [0, 2, 4][Math.floor(rnd(plan.seed, bar, step, 9) * 3)];
        const passing = Math.round(rnd(plan.seed, bar, step, 10) * 2) - 1;
        const long = stepInBar === 0 && barInPhrase % 2 === 0;

        fluteVoice(io, {
          note: scaleNote(plan.root + 36, scale, degree + anchor + passing),
          time: time + human(11),
          dur: stepDur * (long ? 6 : 3),
          gain: 0.085 * layers.flute,
          breath: timbre.fluteBreath,
          vibrato: 12,
          reverb: 0.55,
          delay: 0.2,
        });
      }
    }

    /* ---- percussion: frame drum and shaker, no kit ---- */
    if (layers.perc > 0.04) {
      const p = layers.perc;

      if (perc.frame && (stepInBar === 0 || stepInBar === 6 || stepInBar === 10)) {
        kick(io, {
          time: time + human(12),
          gain: 0.26 * p * (stepInBar === 0 ? 1 : 0.6),
          tone: 165,                    // higher and woodier than a kick drum
        });
      }
      if (perc.frame && stepInBar === 8) {
        rim(io, { time: time + human(13), gain: 0.06 * p, reverb: 0.4 });
      }
      if (perc.shaker > 0.05 && stepInBar % 2 === 1) {
        shaker(io, {
          time: time + human(14),
          gain: 0.026 * p * perc.shaker * (stepInBar % 4 === 3 ? 1 : 0.6),
        });
      }
    }
  },
};
