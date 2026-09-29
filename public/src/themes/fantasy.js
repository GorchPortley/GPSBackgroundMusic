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
 *
 * The harp is the sampled concert harp (P5); until its recordings are decoded
 * — and for good if they cannot be — it plays the Karplus–Strong string
 * (C3.3), which itself falls back to the synth pluck. It rolls the same
 * voice-led chord the strings hold (P1), an octave up, so the two move
 * together.
 *
 * Form (P2): A A B B, the shape of a folk tune — an A strain played twice, a
 * B strain on other chords, higher. The flute's tune is generated per place
 * (C3.8) and comes back every time its strain does. The last bar of every
 * fourth phrase is air — no harp, no drums, the strings ring (C3.7) — and
 * before a handover the harp sweeps a glissando into the new downbeat (C3.6).
 */

import {
  chordNotes, mulberry32, noteName, pickMode, pickProgression, SCALES, scaleNote,
} from '../audio/theory.js';
import {
  bassVoice, fluteVoice, kick, rim, sampleVoice, shaker, stringVoice,
} from '../audio/voices.js';
import {
  breathing, chordAt, gate, hasPerfectFifth, leadChord, melodyAt, melodyEvent, quantise, rnd,
} from './util.js';

// Voice-leading memory for the string bed (util.leadChord), and the tune's
// bar cache (util.melodyAt). Only this theme touches them; both start over on
// any theme, tonic or mode change.
const stringsLead = {};
const tune = {};

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

/** Where the harp rolls, per density; two versions, swapped each time round. */
const HARP_PATTERNS = {
  sparse: [[0, 8], [0, 10]],
  busy: [[0, 4, 8, 12], [0, 6, 8, 14]],
};

/**
 * A section's chord on `d` if the mode gives it a perfect fifth, else the
 * nearest neighbour that has one — never the tonic, or the section would
 * not leave home.
 */
function sectionChord(scale, d) {
  const len = (SCALES[scale] || SCALES.aeolian).length;
  return [d, d - 2, d + 2, d - 1, d + 1]
    .map((x) => ((x % len) + len) % len)
    .find((x) => x !== 0 && hasPerfectFifth(scale, x)) ?? d;
}

/** The B strain: VI — VII — iv — v where the mode has them, else a neighbour. */
function strainB(scale, barsPerChord) {
  const wish = barsPerChord > 1 ? [5, 6] : [5, 6, 3, 4];
  return wish.map((d) => sectionChord(scale, d));
}

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
      // Brightness brings the flute forward; a dark place still has a quiet one.
      flute: (0.25 + 0.75 * gate(b, 0.30, 0.48)) * (0.45 + 0.55 * (1 - e * 0.5)),
      perc: gate(e, 0.44, 0.40),
    };

    const tuneA = {
      name: 'fantasy-flute',
      density: 0.12 + 0.35 * d,
      rest: 0.70 - 0.15 * d,
      leap: 0.05 + 0.3 * t,             // folk tunes step; tension makes them leap
      contour: (b - 0.5) * 1.2,
      lo: 0,
      hi: 7,
    };

    return {
      seed,
      mood,
      trim: 1.09,
      bpm: 54 + e * 42 + (rng() - 0.5) * 3,
      root,
      scale,
      progression: progression.degrees,
      barsPerChord,
      layers,
      // Forests and rivers are half of this theme: the place comes through in full.
      ambience: 1,
      // A A B B. Depends only on scale and chord rate (discrete fields).
      form: {
        breathEvery: 4,
        sections: 'AABB',
        B: { progression: strainB(scale, barsPerChord) },
      },

      timbre: {
        stringCutoff: 900 + b * 2600,
        stringDetune: 5 + t * 12,
        stringVibrato: 6 + w * 8,
        chordSize: t > 0.5 ? 4 : 3,
        harpRelease: 1.4 + s * 2.4,     // the hall (or forest) the harp rings in
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
        patterns: d > 0.6 ? HARP_PATTERNS.busy : HARP_PATTERNS.sparse,
      },

      // The tune (C3.8). The B strain sits higher, as B strains do.
      gen: { A: tuneA, B: { ...tuneA, lo: 3, hi: 10 } },

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
    const { step, stepInBar, bar, phrase, time, stepDur, barDur } = pos;
    const { scale, barsPerChord, layers, timbre, perc, harp } = plan;

    const { degree, letter, chordChange } = chordAt(plan, bar);
    const chordStart = stepInBar === 0 && chordChange;
    const strainTwo = letter === 'B';
    // The last bar before a waiting change lands (C3.6): its second half is
    // the fill, and the fill wins over the bar of air, as in spec.js.
    const fillBar = pos.stepsToCommit !== undefined && pos.stepsToCommit <= 16;
    const filling = fillBar && stepInBar >= 8;
    const breath = breathing(plan, pos) && !fillBar;
    const cycle = Math.floor(phrase / 4);
    const human = (salt) => (rnd(plan.seed, bar, step, salt) - 0.5) * 0.008;

    const harpNote = (note, at, gain, pan) => sampleVoice(io, {
      instrument: 'harp',
      note,
      time: at,
      dur: stepDur * 3,
      gain,
      release: timbre.harpRelease,
      reverb: 0.45,
      delay: 0.15,
      pan,
    });

    /* ---- strings: the bed ---- */
    if (chordStart && layers.strings > 0.02) {
      stringVoice(io, {
        // Nearest inversion to the last chord: a section moves by steps.
        notes: leadChord(stringsLead, plan, bar,
          chordNotes(plan.root + 24, scale, degree, timbre.chordSize), plan.root + 24),
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
    if (layers.bass > 0.05 && (stepInBar === 0 || (stepInBar === 8 && plan.mood.e > 0.45 && !breath))) {
      bassVoice(io, {
        note: scaleNote(plan.root, scale, degree + (stepInBar === 8 ? 4 : 0)),
        time: time + human(1),
        dur: stepDur * 7,
        gain: 0.24 * layers.bass,
        cutoff: 240 + plan.mood.b * 220,
        reverb: 0.14,
      });
    }

    /* ---- fill: a harp glissando up the mode into the new downbeat ---- */
    if (filling) {
      const i = stepInBar - 8;                      // 0..7
      harpNote(scaleNote(plan.root + 36, scale, degree + i),
        time + human(15), 0.07 * Math.max(0.55, layers.harp) * (0.7 + i * 0.05), -0.35 + i * 0.1);
    }

    /* ---- harp: rolled chords, never struck all at once. It rolls the
       strings' voice-led chord an octave up (plus the octave of its lowest
       note on top), so harp and strings move together. Rests in the bar of
       air and under the glissando. ---- */
    const pattern = harp.patterns[rnd(plan.seed, cycle, 23) < 0.5 ? 0 : 1];
    if (layers.harp > 0.05 && !breath && !filling && pattern.includes(stepInBar)) {
      // The strings' current voicing, if it is this plan's (not a moment
      // after a key change, before the strings have re-voiced).
      const own = stringsLead.prev && stringsLead.themeId === plan.themeId &&
        stringsLead.root === plan.root && stringsLead.scale === plan.scale;
      const led = (own ? stringsLead.prev : chordNotes(plan.root + 24, scale, degree, 3))
        .slice().sort((a, x) => a - x);
      const chord = led.map((n) => n + 12);
      if (chord.length < 4) chord.push(chord[0] + 12);
      const ascending = rnd(plan.seed, bar, stepInBar, 2) < 0.78;
      const size = 4;
      for (let i = 0; i < size; i++) {
        const which = ascending ? i : size - 1 - i;
        // The roll: each note a 32nd behind the last.
        harpNote(chord[which],
          time + i * stepDur * harp.rollSteps * 0.5 + human(3 + i),
          0.085 * layers.harp * (1 - i * 0.12),
          -0.25 + (i / (size - 1)) * 0.5);
      }
    }

    /* ---- flute: the tune. Generated per place, stepwise and modal; each
       strain has its own and it comes back every time that strain does. A
       note holds until the next one (or a beat and a half). ---- */
    if (layers.flute > 0.05 && !filling) {
      const { degree: d0, events } = melodyAt(tune, plan, bar, strainTwo ? plan.gen.B : plan.gen.A);
      const ev = melodyEvent(events, stepInBar);
      if (ev) {
        const next = events.find((x) => x.begin > ev.begin);
        const steps = next ? Math.round((next.begin - ev.begin) * 16) : 16 - stepInBar;
        fluteVoice(io, {
          note: scaleNote(plan.root + 36, scale, d0 + Number(ev.value)),
          time: time + human(11),
          dur: stepDur * Math.min(6, Math.max(1.5, steps)),
          gain: 0.08 * layers.flute * (stepInBar % 4 === 0 ? 1 : 0.8),
          breath: timbre.fluteBreath,
          vibrato: 12,
          reverb: 0.55,
          delay: 0.2,
        });
      }
    }

    /* ---- percussion: frame drum and shaker, no kit. Rests in the bar of
       air; in the fill the frame drum rolls under the glissando. ---- */
    if (layers.perc > 0.04 && !breath) {
      const p = layers.perc;

      if (filling) {
        if (perc.frame && stepInBar % 2 === 0) {
          kick(io, { time: time + human(12), gain: 0.16 * p * (0.6 + (stepInBar - 8) / 14), tone: 165 });
        }
      } else {
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
    }
  },
};
