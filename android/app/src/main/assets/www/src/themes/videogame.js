/**
 * Theme: Video Game — bold, melodic, driving.
 *
 * Chiptune-adjacent rather than strictly 8-bit: pulse-wave lead and harmony,
 * triangle bass, noise percussion, and the fast broken-chord arpeggio that old
 * sound chips used to fake a third voice.
 *
 * The thing that makes game music memorable is a *motif* — a short phrase that
 * repeats and varies — so this theme generates one from the scene seed and
 * plays it against the chords rather than arpeggiating aimlessly. Walk back to
 * the same street and you get the same tune.
 */

import {
  chordNotes, mulberry32, noteName, pickMode, pickProgression, scaleNote,
} from '../audio/theory.js';
import {
  bassVoice, blipVoice, hat, kick, padVoice, pulseVoice, rim, shaker,
} from '../audio/voices.js';
import { gate, quantise, rnd } from './util.js';

const MODES = [
  'phrygian', 'aeolian', 'harmonicMinor', 'dorian', 'minorPentatonic',
  'mixolydian', 'ionian', 'majorPentatonic', 'lydian',
];

/** Fast harmonic rhythm, strong functional motion — the game-music staples. */
const PROGRESSIONS = [
  { name: 'i — VI — III — VII', degrees: [0, 5, 2, 6], brightness: 0.24 },
  { name: 'i — VII — VI — V', degrees: [0, 6, 5, 4], brightness: 0.30 },
  { name: 'i — iv — VII — III', degrees: [0, 3, 6, 2], brightness: 0.36 },
  { name: 'vi — IV — I — V', degrees: [5, 3, 0, 4], brightness: 0.52 },
  { name: 'I — V — vi — IV', degrees: [0, 4, 5, 3], brightness: 0.68 },
  { name: 'I — vi — IV — V', degrees: [0, 5, 3, 4], brightness: 0.74 },
  { name: 'I — IV — V — I', degrees: [0, 3, 4, 0], brightness: 0.84 },
];

/** Rhythmic templates for the motif: which 16ths carry a note. */
const MOTIF_RHYTHMS = [
  [0, 4, 6, 8, 12],
  [0, 2, 4, 8, 10, 12],
  [0, 3, 6, 8, 11, 14],
  [0, 4, 8, 10, 12, 14],
  [0, 2, 3, 6, 8, 12, 14],
];

export const videogame = {
  id: 'videogame',
  name: 'Video Game',
  available: true,
  description: 'Chiptune-adjacent loops, bold melodies, overworld energy.',
  color: '#ff7eb6',

  /* ------------------------------------------------------------------ plan */

  plan(mood, seed) {
    const rng = mulberry32(seed);
    const { e, b, d, t, w, s } = mood;

    const scale = pickMode(quantise(b), quantise(t), MODES);
    const progression = pickProgression(quantise(b), rng(), PROGRESSIONS);
    const root = 36 + Math.floor(rng() * 12);

    // Build the motif once, from the seed. Contour is a small random walk over
    // chord tones so the phrase holds together instead of jumping about.
    const rhythm = MOTIF_RHYTHMS[Math.floor(rng() * MOTIF_RHYTHMS.length)];
    const contour = [];
    let cursor = Math.floor(rng() * 3) * 2; // start on a chord tone
    for (let i = 0; i < rhythm.length; i++) {
      contour.push(cursor);
      const move = rng();
      if (move < 0.34) cursor += 1;
      else if (move < 0.62) cursor -= 1;
      else if (move < 0.82) cursor += 2;
      else cursor -= 2;
      cursor = Math.max(-2, Math.min(9, cursor));
    }

    const layers = {
      drone: 0.02 + 0.05 * s,
      air: 0.004 + 0.018 * s,
      pad: 0.35 + 0.35 * (1 - e * 0.5),   // pad is support here, not the star
      bass: 0.55 + gate(e, 0.1, 0.5) * 0.45,
      lead: gate(d, 0.10, 0.40),
      arp: gate(d, 0.34, 0.42),
      harmony: gate(d, 0.48, 0.42),
      perc: gate(e, 0.22, 0.36),
    };

    return {
      seed,
      mood,
      // Games run fast. Even a sleepy town theme sits above an ambient tempo.
      trim: 0.88,
      bpm: 84 + e * 52 + (rng() - 0.5) * 4,
      root,
      scale,
      progression: progression.degrees,
      barsPerChord: 1,                    // chords change every bar
      layers,

      timbre: {
        leadDuty: [0.5, 0.25, 0.125][Math.floor(rng() * 3)],
        harmonyDuty: 0.5,
        leadCutoff: 3200 + b * 6000,
        padCutoff: 900 + b * 2400,
        padDetune: 5 + t * 12,
        chordSize: 3,
        bassCutoff: 420 + b * 380,
        droneCutoff: 200 + b * 400,
        airCutoff: 900 + b * 3200,
        airQ: 1.0,
      },

      fx: {
        // Tight and forward: a little delay, not much room.
        reverbMix: 0.10 + s * 0.26,
        reverbSeconds: 0.9 + s * 2.0,
        delayMix: 0.12 + d * 0.26,
        delayFeedback: 0.20 + s * 0.24,
        delayTone: 2400 + b * 4200,
      },

      motif: { rhythm, contour },

      arp: {
        // The classic three-note broken chord, cycling every 16th.
        rate: d > 0.66 ? 1 : 2,
      },

      perc: {
        kick: true,
        backbeat: e > 0.4,
        hat: gate(e, 0.2, 0.4),
        shaker: gate(e, 0.5, 0.4),
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
    const { scale, progression, layers, timbre, perc, motif, arp } = plan;

    const degree = progression[bar % progression.length];
    const human = (salt) => (rnd(plan.seed, bar, step, salt) - 0.5) * 0.004;

    /* ---- pad: quiet chord support under the melody ---- */
    if (stepInBar === 0 && layers.pad > 0.02) {
      padVoice(io, {
        notes: chordNotes(plan.root + 24, scale, degree, timbre.chordSize),
        time,
        dur: barDur * 1.05,
        gain: 0.05 * layers.pad,
        wave: 'sawtooth',
        detune: timbre.padDetune,
        cutoff: timbre.padCutoff,
        resonance: 0.7,
        reverb: 0.3,
      });
    }

    /* ---- bass: driving eighths, the engine of the whole thing ---- */
    if (layers.bass > 0.05 && stepInBar % 2 === 0) {
      const onBeat = stepInBar % 4 === 0;
      // Root on the beat, fifth off it — the standard game bassline shape.
      const note = scaleNote(plan.root, scale, degree + (onBeat ? 0 : 4));
      bassVoice(io, {
        note,
        time: time + human(1),
        dur: stepDur * 1.7,
        gain: (onBeat ? 0.26 : 0.17) * layers.bass,
        cutoff: timbre.bassCutoff,
        reverb: 0.05,
      });
    }

    /* ---- arpeggio: the fake third voice ---- */
    if (layers.arp > 0.05 && stepInBar % arp.rate === 0) {
      const tone = (Math.floor(stepInBar / arp.rate)) % 3;
      blipVoice(io, {
        note: scaleNote(plan.root + 36, scale, degree + tone * 2),
        time: time + human(2),
        gain: 0.036 * layers.arp,
        decay: 0.055,
        duty: 0.25,
        reverb: 0.16,
        delay: 0.22,
      });
    }

    /* ---- lead: the motif, transposed onto each chord ---- */
    if (layers.lead > 0.05) {
      const idx = motif.rhythm.indexOf(stepInBar);
      if (idx >= 0) {
        // Second half of the phrase lifts an octave — the classic answer.
        const lift = barInPhrase >= 2 ? 7 : 0;
        // One bar in four gets a variation so it is not a pure loop.
        const vary = barInPhrase === 3 && rnd(plan.seed, bar, step, 3) < 0.45 ? 1 : 0;
        const deg = degree + motif.contour[idx] + lift + vary;

        pulseVoice(io, {
          note: scaleNote(plan.root + 36, scale, deg),
          time: time + human(4),
          dur: stepDur * 1.6,
          gain: 0.085 * layers.lead,
          duty: timbre.leadDuty,
          cutoff: timbre.leadCutoff,
          resonance: 1.1,
          attack: 0.003,
          release: 0.04,
          reverb: 0.22,
          delay: 0.3,
        });

        /* ---- harmony: a third below, the way two pulse channels were used ---- */
        if (layers.harmony > 0.05) {
          pulseVoice(io, {
            note: scaleNote(plan.root + 36, scale, deg - 2),
            time: time + human(5),
            dur: stepDur * 1.5,
            gain: 0.045 * layers.harmony,
            duty: timbre.harmonyDuty,
            cutoff: timbre.leadCutoff * 0.8,
            attack: 0.003,
            release: 0.04,
            reverb: 0.2,
            delay: 0.2,
            pan: 0.25,
          });
        }
      }
    }

    /* ---- percussion: noise channel ---- */
    if (layers.perc > 0.04) {
      const p = layers.perc;

      if (perc.kick && (stepInBar === 0 || stepInBar === 6)) {
        kick(io, { time: time + human(6), gain: 0.36 * p * (stepInBar === 0 ? 1 : 0.65) });
      }
      if (perc.backbeat && (stepInBar === 4 || stepInBar === 12)) {
        rim(io, { time: time + human(7), gain: 0.09 * p, reverb: 0.2 });
      }
      if (perc.hat > 0.05 && stepInBar % 2 === 0) {
        hat(io, {
          time: time + human(8),
          gain: 0.04 * p * perc.hat * (stepInBar % 4 === 0 ? 1 : 0.6),
          decay: 0.035,
        });
      }
      if (perc.shaker > 0.05 && stepInBar % 2 === 1) {
        shaker(io, { time: time + human(9), gain: 0.022 * p * perc.shaker });
      }
    }
  },
};
