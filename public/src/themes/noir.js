/**
 * Theme: Noir — brushed drums, upright bass, rain on the window.
 *
 * Two things carry this one, and neither is the instruments:
 *
 * 1. **Swing.** Straight 16ths sound like a drum machine. Every second eighth
 *    is pushed late, which is the whole difference between a jazz feel and a
 *    rock one. Amount scales down as the tempo rises, the way players do it.
 *
 * 2. **A walking bass.** A held root is a rock bassline; jazz walks in quarter
 *    notes, and crucially approaches the *next* chord chromatically on beat 4.
 *    That approach note is what makes the harmony sound like it is going
 *    somewhere.
 *
 * Chords are sevenths throughout — plain triads sound naive here.
 */

import {
  mulberry32, noteName, pickMode, pickProgression, scaleNote,
} from '../audio/theory.js';
import {
  bellVoice, brush, hat, kick, padVoice, pizzVoice, pulseVoice,
} from '../audio/voices.js';
import { gate, quantise, rnd, swingOffset } from './util.js';

const MODES = [
  'locrian', 'phrygian', 'aeolian', 'harmonicMinor', 'dorian',
  'minorPentatonic', 'mixolydian', 'ionian',
];

/** ii–V–i and its relatives. Degree 1 is ii, 4 is V, 0 is i. */
const PROGRESSIONS = [
  { name: 'i — ♭II — i', degrees: [0, 1, 0, 0], brightness: 0.12 },
  { name: 'ii — V — i', degrees: [1, 4, 0, 0], brightness: 0.28 },
  { name: 'i — vi — ii — V', degrees: [0, 5, 1, 4], brightness: 0.36 },
  { name: 'i — iv', degrees: [0, 3], brightness: 0.42 },
  { name: 'i — VI — ii — V', degrees: [0, 5, 1, 4], brightness: 0.50 },
  { name: 'I — vi — ii — V', degrees: [0, 5, 1, 4], brightness: 0.66 },
  { name: 'I — IV — iii — VI', degrees: [0, 3, 2, 5], brightness: 0.78 },
];

export const noir = {
  id: 'noir',
  name: 'Noir',
  available: true,
  description: 'Brushed drums, upright bass, rain on the window.',

  /* ------------------------------------------------------------------ plan */

  plan(mood, seed) {
    const rng = mulberry32(seed);
    const { e, b, d, t, w, s } = mood;

    const scale = pickMode(quantise(b), quantise(t), MODES);
    const progression = pickProgression(quantise(b), rng(), PROGRESSIONS);
    const root = 34 + Math.floor(rng() * 12);
    const bpm = 62 + e * 44 + (rng() - 0.5) * 3;

    const layers = {
      drone: 0.02 + 0.05 * s,
      // The rain. This is the one theme where the noise bed is a literal
      // thing — but it must stay under the band, not wash it out.
      air: 0.010 + 0.026 * (0.4 + 0.6 * (1 - b)),
      // These have to keep climbing well past mid-energy, or a busy street
      // and a quiet one both end up with the whole band already at full tilt.
      keys: 0.45 + 0.55 * d,
      bass: gate(e, 0.06, 0.40),
      pad: 0.25 + 0.3 * s,
      horn: gate(b, 0.26, 0.5) * (0.4 + 0.6 * (1 - d)),
      perc: gate(e, 0.14, 0.55),
    };

    return {
      seed,
      mood,
      trim: 1.38,
      bpm,
      root,
      scale,
      progression: progression.degrees,
      barsPerChord: e < 0.35 ? 2 : 1,
      layers,

      // Hard shuffle at a ballad tempo, straighter as it gets quicker — which
      // is what players actually do.
      swing: 0.34 - Math.min(0.2, Math.max(0, (bpm - 70) / 200)),

      timbre: {
        keysRatio: 1.0,                 // FM ratio 1 with a low index ~ Rhodes
        keysIndex: 0.7 + t * 1.1,
        keysDecay: 1.6 + s * 1.6,
        bassDecay: 0.5 + (1 - e) * 0.3,
        bassCutoff: 700 + b * 500,
        hornDuty: 0.32,                 // narrow pulse ~ a muted horn
        hornCutoff: 1500 + b * 2200,
        padCutoff: 700 + b * 1600,
        chordSize: 4,                   // sevenths, always
        droneCutoff: 150 + b * 300,
        airCutoff: 700 + b * 2600,
        airQ: 0.6,
      },

      fx: {
        reverbMix: 0.22 + s * 0.40,
        reverbSeconds: 1.4 + s * 3.4,   // a club, not a cathedral
        delayMix: 0.04 + d * 0.14,
        delayFeedback: 0.12 + s * 0.22,
        delayTone: 1400 + b * 2400,
      },

      perc: {
        brushes: true,
        ride: gate(e, 0.22, 0.55),
        kick: e > 0.5,
        // A busy scene gets the drummer filling the bar, not just keeping time.
        fills: e > 0.62,
      },

      // Above this the bass stops walking in quarters and starts in eighths.
      doubleTime: e > 0.68,

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
    const { scale, progression, barsPerChord, layers, timbre, perc } = plan;

    const chordIndex = Math.floor(bar / barsPerChord) % progression.length;
    const degree = progression[chordIndex];
    const nextDegree = progression[(chordIndex + 1) % progression.length];
    const chordStart = stepInBar === 0 && bar % barsPerChord === 0;

    // Everything in this theme plays swung, so fold the offset into `time`.
    const swing = swingOffset(stepInBar, stepDur, plan.swing);
    const human = (salt) => (rnd(plan.seed, bar, step, salt) - 0.5) * 0.012;
    const at = (salt) => time + swing + human(salt);

    /* ---- pad: a thin sustained cushion, mostly felt not heard ---- */
    if (chordStart && layers.pad > 0.02) {
      const notes = [];
      for (let i = 0; i < 3; i++) notes.push(scaleNote(plan.root + 24, scale, degree + 2 + i * 2));
      padVoice(io, {
        notes,
        time,
        dur: barDur * barsPerChord * 1.05,
        gain: 0.035 * layers.pad,
        wave: 'triangle',
        detune: 6,
        cutoff: timbre.padCutoff,
        reverb: 0.5,
      });
    }

    /* ---- keys: comping on the off-beats, the way a pianist stabs chords ---- */
    if (layers.keys > 0.04) {
      const compSteps = plan.mood.d > 0.5 ? [2, 6, 11, 14] : [2, 11];
      if (compSteps.includes(stepInBar) &&
          rnd(plan.seed, bar, step, 1) < 0.45 + plan.mood.d * 0.45) {
        // Rootless voicing: 3rd, 5th, 7th, 9th. Leaving the root to the bass
        // is what stops the middle of the mix turning to mud.
        for (let i = 1; i < timbre.chordSize + 1; i++) {
          bellVoice(io, {
            note: scaleNote(plan.root + 24, scale, degree + i * 2),
            time: at(2) + i * 0.004,   // a touch of spread, like fingers
            gain: 0.05 * layers.keys,
            decay: timbre.keysDecay,
            ratio: timbre.keysRatio,
            index: timbre.keysIndex,
            reverb: 0.42,
            delay: 0.14,
          });
        }
      }
    }

    /* ---- walking bass: quarter notes, chromatic approach into the next chord ---- */
    const bassStep = plan.doubleTime ? stepInBar % 2 === 0 : stepInBar % 4 === 0;
    if (layers.bass > 0.05 && bassStep) {
      const beat = Math.floor(stepInBar / 4);
      const offBeat = plan.doubleTime && stepInBar % 4 !== 0;
      let note;
      if (beat === 3) {
        // Beat four leads to the next chord from a semitone away.
        const target = scaleNote(plan.root, scale, nextDegree);
        const from = rnd(plan.seed, bar, step, 3) < 0.5 ? -1 : 1;
        note = target + from;
      } else {
        // Root, then a chord tone, then another — the body of the walk.
        const shape = [0, 4, 2][beat] ?? 0;
        note = scaleNote(plan.root, scale, degree + shape);
      }

      // Off-beat eighths pass through the scale between the quarter-note
      // targets, which is what a walking line actually does at speed.
      if (offBeat) note = scaleNote(plan.root, scale, degree + beat * 2 + 1);

      pizzVoice(io, {
        note,
        time: at(4),
        gain: (offBeat ? 0.17 : 0.26) * layers.bass,
        decay: timbre.bassDecay * (offBeat ? 0.7 : 1),
        cutoff: timbre.bassCutoff,
        reverb: 0.18,
      });
    }

    /* ---- muted horn: a sparse line, entering late in a phrase ---- */
    if (layers.horn > 0.06 && barInPhrase >= 2 && (stepInBar === 4 || stepInBar === 10)) {
      if (rnd(plan.seed, bar, step, 5) < 0.32 * layers.horn) {
        const shape = [4, 6, 2, 8][Math.floor(rnd(plan.seed, bar, step, 6) * 4)];
        pulseVoice(io, {
          note: scaleNote(plan.root + 24, scale, degree + shape),
          time: at(7),
          dur: stepDur * (2 + Math.floor(rnd(plan.seed, bar, step, 8) * 4)),
          gain: 0.055 * layers.horn,
          duty: timbre.hornDuty,
          cutoff: timbre.hornCutoff,
          resonance: 2.2,
          attack: 0.05,               // horns speak slowly
          release: 0.14,
          vibrato: 16,
          reverb: 0.55,
          delay: 0.25,
        });
      }
    }

    /* ---- brushes: the swirl on every beat, accents on 2 and 4 ---- */
    if (layers.perc > 0.04) {
      const p = layers.perc;

      if (perc.brushes && stepInBar % 4 === 0) {
        const backbeat = stepInBar === 4 || stepInBar === 12;
        brush(io, {
          time: at(9),
          gain: (backbeat ? 0.055 : 0.032) * p,
          decay: backbeat ? 0.14 : 0.22,
          swirl: !backbeat,
          reverb: 0.3,
        });
      }

      // Ride pattern: the spang-a-lang. Beat, then the swung 'and' of 2 and 4.
      if (perc.ride > 0.05 && (stepInBar % 4 === 0 || stepInBar === 6 || stepInBar === 14)) {
        hat(io, {
          time: at(10),
          gain: 0.03 * p * perc.ride * (stepInBar % 8 === 0 ? 1 : 0.7),
          decay: 0.07,
          reverb: 0.3,
        });
      }

      if (perc.kick && stepInBar === 0) {
        kick(io, { time: at(11), gain: 0.2 * p, tone: 120 });
      }

      // Fills across the last bar of a phrase.
      if (perc.fills && barInPhrase === 3 && stepInBar >= 8 && stepInBar % 2 === 0) {
        brush(io, {
          time: at(12),
          gain: 0.03 * p * (0.5 + (stepInBar - 8) / 16),
          decay: 0.1,
          reverb: 0.35,
        });
      }
    }
  },
};
