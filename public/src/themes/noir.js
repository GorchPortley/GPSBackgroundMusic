/**
 * Theme: Noir — brushed drums, upright bass, a piano in a smoky room.
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
 *
 * The comping piano is the sampled upright (P5); until it is decoded, and for
 * good if it cannot be, the FM electric piano plays instead (C3.2) — either
 * suits a bar at 2 a.m. Its rootless voicings are voice-led (P1), so the
 * hands barely move while the harmony does.
 *
 * Form (P2): A A B A, the shape of a standard. The muted horn plays a head
 * generated for this place (C3.8) in the A phrases; the bridge goes to iv and
 * back through ii — V, the horn lays out and the piano takes a single-note
 * line over held chords. The last bar of every form is a stop-time break:
 * drums out, one bass note, the tune alone (C3.7). Before a handover the
 * drummer fills and the bass climbs into it (C3.6).
 */

import {
  chordNotes, mulberry32, noteName, pickMode, pickProgression, scaleNote,
} from '../audio/theory.js';
import {
  brush, hat, kick, padVoice, pizzVoice, pulseVoice, sampleVoice,
} from '../audio/voices.js';
import {
  breathing, chordAt, gate, leadChord, melodyAt, melodyEvent, quantise, rnd, swingOffset,
} from './util.js';

// Voice-leading memory for the pad and the piano's rootless voicings, and the
// bar caches of the two generated lines. Only this theme touches them.
const padLead = {};
const keysLead = {};
const head = {};
const solo = {};

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

/**
 * Piano comping rhythms (16ths, before swing), by density. Two per density;
 * which one plays changes each time round the form. The Charleston (1, the
 * and of 2) is the sparse one.
 */
const COMPS = {
  sparse: [[0, 6], [2, 11]],
  busy: [[2, 6, 11, 14], [0, 6, 10, 14]],
};

export const noir = {
  id: 'noir',
  name: 'Noir',
  available: true,
  description: 'Brushed drums, upright bass, rain on the window.',
  color: '#d4b483',

  /* ------------------------------------------------------------------ plan */

  plan(mood, seed) {
    const rng = mulberry32(seed);
    const { e, b, d, t, w, s } = mood;

    const scale = pickMode(quantise(b), quantise(t), MODES);
    const progression = pickProgression(quantise(b), rng(), PROGRESSIONS);
    const root = 34 + Math.floor(rng() * 12);
    const bpm = 62 + e * 44 + (rng() - 0.5) * 3;
    const barsPerChord = e < 0.35 ? 2 : 1;

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

    const tune = {
      density: 0.12 + 0.3 * d,
      rest: 0.74 - 0.12 * d,
      leap: 0.12 + 0.4 * t,
      contour: (b - 0.5) * 1.2,
    };

    return {
      seed,
      mood,
      trim: 1.58,
      bpm,
      root,
      scale,
      progression: progression.degrees,
      barsPerChord,
      layers,
      // A room with the door shut: the street is heard, but through the wall.
      ambience: 0.5,
      // A A B A; the bridge is iv — iv — ii — V (iv — V at two bars a
      // chord). Only the chord rate picks it, so it never changes mid-phrase.
      form: {
        breathEvery: 4,
        sections: 'AABA',
        B: { progression: barsPerChord > 1 ? [3, 4] : [3, 3, 1, 4] },
      },

      // Hard shuffle at a ballad tempo, straighter as it gets quicker — which
      // is what players actually do.
      swing: 0.34 - Math.min(0.2, Math.max(0, (bpm - 70) / 200)),

      timbre: {
        keysRelease: 0.5 + s * 0.9,
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

      comps: d > 0.5 ? COMPS.busy : COMPS.sparse,

      // The head (horn, A) and the bridge's piano line (B), both generated.
      gen: {
        head: { name: 'noir-head', ...tune, lo: 2, hi: 9 },
        solo: { name: 'noir-solo', ...tune, rest: tune.rest - 0.08, lo: 4, hi: 12 },
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
    const { step, stepInBar, bar, barInPhrase, phrase, time, stepDur, barDur } = pos;
    const { scale, barsPerChord, layers, timbre, perc } = plan;

    const { degree, letter, chordChange } = chordAt(plan, bar);
    const after = chordAt(plan, bar + 1);
    // Beat four walks into the next chord only when the next bar brings one.
    const nextDegree = after.chordChange ? after.degree : degree;
    const chordStart = stepInBar === 0 && chordChange;
    const bridge = letter === 'B';
    const fillBar = pos.stepsToCommit !== undefined && pos.stepsToCommit <= 16;
    // A handover's fill wins over the break, as in spec.js.
    const stopTime = breathing(plan, pos) && !fillBar;
    const filling = fillBar && stepInBar >= 8;
    const cycle = Math.floor(phrase / 4);

    // Everything in this theme plays swung, so fold the offset into `time`.
    const swing = swingOffset(stepInBar, stepDur, plan.swing);
    const human = (salt) => (rnd(plan.seed, bar, step, salt) - 0.5) * 0.012;
    const at = (salt) => time + swing + human(salt);

    const piano = (note, when, dur, gain, pan = 0) => sampleVoice(io, {
      instrument: 'piano',
      note,
      time: when,
      dur,
      gain,
      release: timbre.keysRelease,
      reverb: 0.42,
      delay: 0.12,
      pan,
    });

    /* ---- pad: a thin sustained cushion, mostly felt not heard ---- */
    if (chordStart && layers.pad > 0.02) {
      padVoice(io, {
        notes: leadChord(padLead, plan, bar,
          chordNotes(plan.root + 24, scale, degree + 2, 3), plan.root + 24),
        time,
        dur: barDur * barsPerChord * 1.05,
        gain: 0.035 * layers.pad,
        wave: 'triangle',
        detune: 6,
        cutoff: timbre.padCutoff,
        reverb: 0.5,
      });
    }

    /* ---- keys: comping, the way a pianist stabs chords. Rootless voicing —
       3rd, 5th, 7th, 9th — voice-led so the hands barely move. In the bridge
       it holds each chord instead; in the break, one chord on the one. ---- */
    if (layers.keys > 0.04) {
      const pattern = plan.comps[rnd(plan.seed, cycle, 51) < 0.5 ? 0 : 1];
      const held = (bridge && chordStart) || (stopTime && stepInBar === 0);
      const stab = !bridge && !stopTime && !filling && pattern.includes(stepInBar) &&
        rnd(plan.seed, bar, step, 1) < 0.5 + plan.mood.d * 0.4;
      if (held || stab) {
        // Leaving the root to the bass is what stops the middle of the mix
        // turning to mud.
        const notes = leadChord(keysLead, plan, bar,
          chordNotes(plan.root + 24, scale, degree + 2, timbre.chordSize), plan.root + 24);
        const dur = held ? barDur * barsPerChord * 0.9 : stepDur * 1.6;
        notes.forEach((note, i) => {
          // A touch of spread, like fingers; a held chord is rolled a little more.
          piano(note, at(2) + i * (held ? 0.018 : 0.006), dur,
            (held ? 0.042 : 0.05) * layers.keys * (1 - i * 0.06), -0.15 + i * 0.1);
        });
      }
    }

    /* ---- walking bass: quarter notes, chromatic approach into the next
       chord. In the break it plays the one and stops; in the fill it
       climbs a scale into the new downbeat. ---- */
    const bassStep = plan.doubleTime ? stepInBar % 2 === 0 : stepInBar % 4 === 0;
    if (layers.bass > 0.05 && bassStep && !(stopTime && stepInBar > 0)) {
      const beat = Math.floor(stepInBar / 4);
      const offBeat = plan.doubleTime && stepInBar % 4 !== 0;
      let note;
      if (filling) {
        // Up the scale from the third, then a half step under the next chord.
        note = stepInBar === (plan.doubleTime ? 14 : 12)
          ? scaleNote(plan.root, scale, nextDegree) - 1
          : scaleNote(plan.root, scale, degree + 2 + (stepInBar - 8) / 2);
      } else if (beat === 3 && !offBeat) {
        // Beat four leads to the next chord from a semitone away.
        const target = scaleNote(plan.root, scale, nextDegree);
        const from = rnd(plan.seed, bar, step, 3) < 0.5 ? -1 : 1;
        note = target + from;
      } else if (offBeat) {
        // Off-beat eighths pass through the scale between the quarter-note
        // targets, which is what a walking line actually does at speed.
        note = scaleNote(plan.root, scale, degree + beat * 2 + 1);
      } else {
        // Root, then a chord tone, then another — the body of the walk.
        const shape = [0, 4, 2][beat] ?? 0;
        note = scaleNote(plan.root, scale, degree + shape);
      }

      pizzVoice(io, {
        note,
        time: at(4),
        gain: (offBeat ? 0.17 : 0.26) * layers.bass,
        decay: timbre.bassDecay * (offBeat ? 0.7 : 1) * (stopTime ? 2.5 : 1),
        cutoff: timbre.bassCutoff,
        reverb: 0.18,
      });
    }

    /* ---- the tune: a head on the muted horn in A, a single-note piano
       line in the bridge. Generated for this place; each comes back every
       time its section does. A note holds until the next. ---- */
    if (!filling) {
      const line = bridge ? solo : head;
      const level = bridge ? layers.keys * 0.8 : layers.horn;
      if (level > 0.06) {
        const { degree: d0, events } = melodyAt(line, plan, bar, bridge ? plan.gen.solo : plan.gen.head);
        const ev = melodyEvent(events, stepInBar);
        if (ev) {
          const next = events.find((x) => x.begin > ev.begin);
          const steps = Math.min(5, Math.max(1.5, next ? Math.round((next.begin - ev.begin) * 16) : 4));
          if (bridge) {
            piano(scaleNote(plan.root + 36, scale, d0 + Number(ev.value)), at(7),
              stepDur * steps * 0.8, 0.07 * level, 0.1);
          } else {
            pulseVoice(io, {
              note: scaleNote(plan.root + 24, scale, d0 + Number(ev.value)),
              time: at(7),
              dur: stepDur * steps,
              gain: 0.055 * level,
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
      }
    }

    /* ---- brushes: the swirl on every beat, accents on 2 and 4. Out in the
       break. ---- */
    if (layers.perc > 0.04 && !stopTime) {
      const p = layers.perc;

      if (perc.brushes && stepInBar % 4 === 0 && !filling) {
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

      // Fills: into every handover (whatever the energy), and in a busy
      // scene into and out of the bridge.
      const phraseFill = perc.fills && barInPhrase === 3 && (phrase % 4 === 1 || phrase % 4 === 2) &&
        stepInBar >= 8;
      if ((filling || phraseFill) && stepInBar % 2 === 0) {
        brush(io, {
          time: at(12),
          gain: (filling ? 0.04 : 0.03) * Math.max(p, filling ? 0.5 : 0) * (0.5 + (stepInBar - 8) / 16),
          decay: 0.1,
          reverb: 0.35,
        });
      }
      // The drummer's setup: a kick on the and of four, into the new bar.
      if (filling && stepInBar === 14) {
        kick(io, { time: at(13), gain: 0.18 * Math.max(p, 0.5), tone: 120 });
      }
    }
  },
};
