/**
 * Theme: Wanderer — the default, deliberately genre-neutral one.
 *
 * Warm cinematic ambient. Sustained pads over a drone, a soft bass, mallet-ish
 * plucks that thicken as a place gets busier, a quiet generated tune, occasional
 * bells, and percussion that only shows up once there is real energy around
 * you. It aims to sit behind whatever you are doing rather than demand
 * attention.
 *
 * A theme has two jobs:
 *   plan(mood, seed) — turn a mood vector into a concrete arrangement
 *   step(io, plan, pos) — schedule notes for one 16th-note step
 *
 * The engine handles everything about *changing* between plans smoothly, so a
 * theme can treat each plan as a static description.
 *
 * Form, so it does not loop: phrases run A A B A (P2). B lifts to the
 * subdominant side, thins the arpeggio and hands the tune from a soft FM
 * mallet to a plucked string (C3.3). Every third phrase ends on a bar of air
 * (C3.7). The arpeggio's rhythm changes each time round the form, and in the
 * bar before a handover the plucks climb into the new downbeat (C3.6).
 */

import {
  chordNotes, mulberry32, noteName, pickMode, pickProgression, SCALES, scaleNote,
} from '../audio/theory.js';
import {
  bassVoice, bellVoice, fmVoice, hat, kick, ksVoice, padVoice, pluckVoice, rim, shaker,
} from '../audio/voices.js';
import {
  breathing, chordAt, gate, hasPerfectFifth, leadChord, melodyAt, melodyEvent, quantise, rnd,
} from './util.js';

// Voice-leading memory for the pad (util.leadChord), and the tune's bar cache
// (util.melodyAt). Only this theme touches them; both start over on any
// theme, tonic or mode change.
const padLead = {};
const tune = {};

/**
 * Arpeggio shapes in 16th-note positions, sparse to busy. Two rhythms per
 * density; which one plays changes each time round the A A B A form.
 */
const PLUCK_PATTERNS = [
  [[0, 6, 10], [0, 4, 10]],
  [[0, 4, 8, 12], [0, 3, 8, 11]],
  [[0, 3, 6, 9, 12, 14], [0, 2, 6, 8, 10, 14]],
  [[0, 2, 4, 6, 8, 10, 12, 14], [0, 2, 3, 6, 8, 10, 11, 14]],
];

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

/** B, the bridge: IV — vi — IV — V where the mode has them, else a neighbour. */
function bridge(scale, barsPerChord) {
  const wish = barsPerChord > 1 ? [3, 4] : [3, 5, 3, 4];
  return wish.map((d) => sectionChord(scale, d));
}

export const wanderer = {
  id: 'wanderer',
  name: 'Wanderer',
  available: true,
  description: 'Warm cinematic ambient. Neutral enough for anywhere.',
  color: '#6ee7d0',

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
      // The tune is there even somewhere quiet — a few notes a bar — and
      // comes forward as the place fills up.
      tune: 0.45 + 0.55 * gate(d, 0.30, 0.50),
      bell: gate(b, 0.44, 0.40) * (0.35 + 0.65 * s),
      perc: gate(e, 0.34, 0.34),
    };

    return {
      seed,
      mood,
      trim: 1.22,
      bpm: 58 + e * 46 + (rng() - 0.5) * 4,
      root,
      scale,
      progression: progression.degrees,
      barsPerChord,
      layers,
      // The generalist hears the place about as it is (C3.4).
      ambience: 0.85,
      // A A B A, a bar of air every third phrase. Depends only on the scale
      // and chord rate — discrete fields — so it never changes mid-phrase.
      form: {
        breathEvery: 3,
        sections: 'AABA',
        B: { progression: bridge(scale, barsPerChord) },
      },

      timbre: {
        // Warm places get triangles; cold ones get the harder sawtooth edge.
        padWave: w > 0.58 ? 'triangle' : 'sawtooth',
        padDetune: 4 + t * 20,
        padCutoff: 520 + b * 3000 + e * 700,
        padResonance: 0.6 + t * 1.6,
        chordSize: t > 0.45 || s > 0.62 ? 4 : 3,
        pluckBright: 0.25 + b * 0.7,
        pluckDecay: 0.55 + s * 2.1,
        // The mallet: a soft sine-on-sine; colder places get more edge.
        malletIndex: 0.5 + (1 - w) * 1.1 + t * 0.6,
        malletRelease: 0.6 + s * 1.4,
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
        patterns: PLUCK_PATTERNS[Math.min(PLUCK_PATTERNS.length - 1, Math.floor(d * 4))],
        // The generated tune (C3.8): density fills in the 16ths, tension
        // makes it leap, brightness makes it climb.
        gen: {
          name: 'wanderer-tune',
          density: 0.15 + 0.5 * d,
          rest: 0.80 - 0.20 * d,
          leap: 0.08 + 0.4 * t,
          contour: (b - 0.5) * 1.2,
          lo: 2,
          hi: 9,
        },
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
    const { scale, barsPerChord, layers, timbre, perc, melody } = plan;

    const { degree, letter, chordChange } = chordAt(plan, bar);
    const chordStart = stepInBar === 0 && chordChange;
    const bridgeSection = letter === 'B';
    // The last bar before a waiting change lands (C3.6): its second half is
    // the fill, and the fill wins over the bar of air, as in spec.js.
    const fillBar = pos.stepsToCommit !== undefined && pos.stepsToCommit <= 16;
    const filling = fillBar && stepInBar >= 8;
    const breath = breathing(plan, pos) && !fillBar;
    // Once round the whole A A B A form.
    const cycle = Math.floor(phrase / 4);

    // Tiny timing scatter keeps repeated bars from sounding machine-stamped.
    const human = (salt) => (rnd(plan.seed, bar, step, salt) - 0.5) * 0.007;

    /* ---- pad: the chord bed, retriggered on each chord change ---- */
    if (chordStart && layers.pad > 0.02) {
      // Nearest inversion to the last pad chord, so the bed moves by steps.
      const notes = leadChord(padLead, plan, bar,
        chordNotes(plan.root + 24, scale, degree, timbre.chordSize), plan.root + 24);
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
      } else if (stepInBar === 10 && perc.push && !breath) {
        bassVoice(io, {
          note: bassNote,
          time: time + human(2),
          dur: stepDur * 3,
          gain: 0.18 * layers.bass,
          cutoff: 240 + plan.mood.b * 240,
        });
      }
    }

    /* ---- the fill: plucks climb the chord into the new downbeat ---- */
    if (filling) {
      if (stepInBar % 2 === 0) {
        const i = (stepInBar - 8) / 2;               // 0..3
        pluckVoice(io, {
          note: scaleNote(plan.root + 24, scale, degree + [0, 2, 4, 7][i]),
          time: time + human(16),
          gain: (0.045 + 0.014 * i) * (0.5 + 0.5 * Math.max(layers.pluck, layers.tune)),
          decay: timbre.pluckDecay,
          bright: timbre.pluckBright,
          reverb: 0.4,
          delay: 0.3,
          pan: -0.3 + i * 0.2,
        });
      }
      if (layers.perc > 0.04 && perc.shaker > 0.05) {
        shaker(io, { time: time + human(17), gain: 0.02 * layers.perc * (0.5 + (stepInBar - 8) / 14) });
      }
    }

    /* ---- plucks: arpeggio over the current chord. Thinner in B; rests in
       the bar of air. The rhythm changes each time round the form. ---- */
    if (layers.pluck > 0.05 && !filling && !breath) {
      const pattern = melody.patterns[rnd(plan.seed, cycle, 21) < 0.5 ? 0 : 1];
      const idx = pattern.indexOf(stepInBar);
      if (idx >= 0 && (!bridgeSection || idx % 2 === 0)) {
        const ascending = bar % 2 === 0;
        const position = ascending ? idx : pattern.length - 1 - idx;
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

    /* ---- the tune: a generated line (C3.8), the same every time a section
       comes back at this place. A soft FM mallet in A; in B it passes to a
       plucked string an octave down. ---- */
    if (layers.tune > 0.05 && !filling) {
      const { degree: d0, events } = melodyAt(tune, plan, bar, melody.gen);
      const ev = melodyEvent(events, stepInBar);
      if (ev) {
        const deg = d0 + Number(ev.value);
        const accent = stepInBar % 4 === 0 ? 1 : 0.75;
        if (bridgeSection) {
          ksVoice(io, {
            note: scaleNote(plan.root + 24, scale, deg),
            time: time + human(5),
            gain: 0.1 * layers.tune * accent,
            decay: 1.2 + plan.mood.s * 2,
            bright: 0.3 + plan.mood.b * 0.4,
            reverb: 0.45,
            delay: 0.3,
            pan: 0.15,
          });
        } else {
          fmVoice(io, {
            note: scaleNote(plan.root + 36, scale, deg),
            time: time + human(5),
            dur: stepDur * 1.5,
            gain: 0.062 * layers.tune * accent,
            ratio: 1,
            index: timbre.malletIndex,
            decay: 0.35,
            release: timbre.malletRelease,
            reverb: 0.55,
            delay: 0.35,
            pan: -0.12,
          });
        }
      }
    }

    /* ---- bells: phrase markers, high and washed out. Always on the seam
       into and out of the bridge. ---- */
    if (layers.bell > 0.04 || (bridgeSection && layers.bell > 0.01)) {
      const onPhrase = barInPhrase === 0 && stepInBar === 0;
      const midPhrase = barInPhrase === 2 && stepInBar === 8 &&
        rnd(plan.seed, bar, step, 8) < 0.5;
      if (onPhrase || midPhrase) {
        const tone = [2, 4, 6][Math.floor(rnd(plan.seed, bar, step, 9) * 3)];
        bellVoice(io, {
          note: scaleNote(plan.root + 48, scale, degree + tone),
          time: time + human(10),
          gain: 0.07 * Math.max(layers.bell, bridgeSection ? 0.3 : 0) * (onPhrase ? 1 : 0.65),
          decay: 2.5 + plan.mood.s * 3.5,
          ratio: 2.01,
          index: 2 + plan.mood.t * 3,
          reverb: 0.8,
          delay: 0.35,
        });
      }
    }

    /* ---- percussion (rests in the breath bar; the fill has its own) ---- */
    if (layers.perc > 0.04 && !breath && !filling) {
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
