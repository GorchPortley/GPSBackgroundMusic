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
 *
 * Form (P2): A A B A, like a level theme. A is the seeded motif on the pulse
 * channels. B is a bridge on its own chords with a generated tune (C3.8) on
 * a two-operator FM lead — the 16-bit console answering the 8-bit one (C3.2).
 * The drums are Euclidean (C3.1): a tresillo kick and hats spread k over 16
 * by energy. The noise channel plays a short fill into and out of the
 * bridge and a full snare roll into a handover (C3.6); the last bar of each
 * form drops the drums (C3.7). Each time round the form the motif takes a
 * different answer, so minutes in it is still the same tune but not a loop.
 */

import {
  chordNotes, mulberry32, noteName, pickMode, pickProgression, SCALES, scaleNote,
} from '../audio/theory.js';
import {
  bassVoice, blipVoice, fmVoice, hat, kick, padVoice, pulseVoice, rim, shaker,
} from '../audio/voices.js';
import {
  breathing, chordAt, euclid, gate, hasPerfectFifth, leadChord, melodyAt, melodyEvent,
  quantise, rnd,
} from './util.js';

// Voice-leading memory for the pad, and the bridge tune's bar cache.
const padLead = {};
const bridgeTune = {};

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

/** The bridge: IV — V — iii — vi where the mode has them, else a neighbour. */
function bridge(scale) {
  return [3, 4, 2, 5].map((d) => sectionChord(scale, d));
}

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
      trim: 1.18,
      bpm: 84 + e * 52 + (rng() - 0.5) * 4,
      root,
      scale,
      progression: progression.degrees,
      barsPerChord: 1,                    // chords change every bar
      layers,
      // A game has its own world; the street is only a hint under it.
      ambience: 0.3,
      form: { breathEvery: 4, sections: 'AABA', B: { progression: bridge(scale) } },

      timbre: {
        leadDuty: [0.5, 0.25, 0.125][Math.floor(rng() * 3)],
        harmonyDuty: 0.5,
        leadCutoff: 3200 + b * 6000,
        // The FM lead: brassier when tense, rounder when warm.
        fmIndex: 1.6 + t * 2.2 + (1 - w) * 0.8,
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

      // The bridge tune (C3.8): the same every time B comes round here.
      gen: {
        name: 'vg-bridge',
        density: 0.25 + 0.5 * d,
        rest: 0.5 - 0.2 * d,
        leap: 0.1 + 0.4 * t,
        contour: (b - 0.5) * 1.2,
        lo: 2,
        hi: 11,
      },

      arp: {
        // The classic three-note broken chord, cycling every 16th.
        rate: d > 0.66 ? 1 : 2,
      },

      perc: {
        // Euclidean (C3.1): two kicks (0, 8) when calm, the tresillo (3 of 8)
        // from mid energy; hats 5..11 of 16 as energy climbs.
        kick: euclid(e > 0.45 ? 3 : 2, 8),
        backbeat: e > 0.4,
        hat: gate(e, 0.2, 0.4),
        hatSteps: euclid(5 + Math.round(gate(e, 0.3, 0.6) * 6), 16),
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
    const { step, stepInBar, bar, barInPhrase, phrase, time, stepDur, barDur } = pos;
    const { scale, layers, timbre, perc, motif, arp } = plan;

    const { degree, letter } = chordAt(plan, bar);
    const bridgeSection = letter === 'B';
    const fillBar = pos.stepsToCommit !== undefined && pos.stepsToCommit <= 16;
    // A handover's fill wins over the bar of air, as in spec.js.
    const breath = breathing(plan, pos) && !fillBar;
    const filling = fillBar && stepInBar >= 8;
    // A short noise-channel fill leads into the bridge and out of it.
    const miniFill = !fillBar && !breath && barInPhrase === 3 && (phrase % 4 === 1 || phrase % 4 === 2) &&
      stepInBar >= 12;
    const cycle = Math.floor(phrase / 4);
    const human = (salt) => (rnd(plan.seed, bar, step, salt) - 0.5) * 0.004;

    /* ---- pad: quiet chord support under the melody, voice-led ---- */
    if (stepInBar === 0 && layers.pad > 0.02) {
      padVoice(io, {
        notes: leadChord(padLead, plan, bar,
          chordNotes(plan.root + 24, scale, degree, timbre.chordSize), plan.root + 24),
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
    if (layers.bass > 0.05 && stepInBar % 2 === 0 && !(breath && stepInBar >= 8)) {
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
    if (layers.arp > 0.05 && stepInBar % arp.rate === 0 && !filling) {
      const tone = (Math.floor(stepInBar / arp.rate)) % 3;
      // In the bridge the broken chord runs downward.
      const t3 = bridgeSection ? 2 - tone : tone;
      blipVoice(io, {
        note: scaleNote(plan.root + 36, scale, degree + t3 * 2),
        time: time + human(2),
        gain: 0.036 * layers.arp,
        decay: 0.055,
        duty: 0.25,
        reverb: 0.16,
        delay: 0.22,
      });
    }

    const pulseLead = (deg, salt, gainScale = 1) => {
      pulseVoice(io, {
        note: scaleNote(plan.root + 36, scale, deg),
        time: time + human(salt),
        dur: stepDur * 1.6,
        gain: 0.085 * layers.lead * gainScale,
        duty: timbre.leadDuty,
        cutoff: timbre.leadCutoff,
        resonance: 1.1,
        attack: 0.003,
        release: 0.04,
        reverb: 0.22,
        delay: 0.3,
      });
    };
    const pulseHarmony = (deg, salt) => {
      pulseVoice(io, {
        note: scaleNote(plan.root + 36, scale, deg - 2),
        time: time + human(salt),
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
    };

    /* ---- fill: the lead runs up the scale into the new downbeat ---- */
    if (filling && layers.lead > 0.05 && stepInBar % 2 === 0) {
      pulseLead(degree + (stepInBar - 8) / 2 * 2, 4, 0.8 + (stepInBar - 8) / 40);
    } else if (layers.lead > 0.05 && !filling && !bridgeSection) {
      /* ---- lead (A): the motif, transposed onto each chord. Each time
         round the form it answers differently: an octave lift, a sequence
         up a third, or the rhythm pushed a 16th late. ---- */
      const variant = Math.floor(rnd(plan.seed, cycle, 41) * 3);
      const push = variant === 2 && barInPhrase % 2 === 1 ? 1 : 0;
      const idx = motif.rhythm.indexOf(stepInBar - push);
      if (idx >= 0 && stepInBar - push >= 0) {
        const lift = variant === 1 ? (barInPhrase % 2 === 1 ? 2 : 0)
          : barInPhrase >= 2 ? 7 : 0;
        // One bar in four gets a variation so it is not a pure loop.
        const vary = barInPhrase === 3 && rnd(plan.seed, bar, step, 3) < 0.45 ? 1 : 0;
        const deg = degree + motif.contour[idx] + lift + vary;
        pulseLead(deg, 4);
        /* ---- harmony: a third below, the way two pulse channels were used ---- */
        if (layers.harmony > 0.05) pulseHarmony(deg, 5);
      }
    } else if (layers.lead > 0.05 && !filling && bridgeSection) {
      /* ---- lead (B): a generated tune on the FM channel ---- */
      const { degree: d0, events } = melodyAt(bridgeTune, plan, bar, plan.gen);
      const ev = melodyEvent(events, stepInBar);
      if (ev) {
        const deg = d0 + Number(ev.value);
        fmVoice(io, {
          note: scaleNote(plan.root + 36, scale, deg),
          time: time + human(4),
          dur: stepDur * 1.4,
          gain: 0.075 * layers.lead,
          ratio: 1,
          index: timbre.fmIndex,
          decay: 0.18,
          release: 0.12,
          reverb: 0.22,
          delay: 0.28,
          pan: -0.1,
        });
        if (layers.harmony > 0.05 && stepInBar % 4 === 0) pulseHarmony(deg, 5);
      }
    }

    /* ---- percussion: noise channel. Rests in the breath bar. ---- */
    if (layers.perc > 0.04 && !breath) {
      const p = layers.perc;
      if (filling || miniFill) {
        // Snare roll on the noise channel, 16ths, getting louder.
        const k = (stepInBar - 8) / 7;
        rim(io, { time: time + human(7), gain: 0.05 * p * (0.6 + 0.6 * k), reverb: 0.2 });
        if (stepInBar === 15 || (miniFill && stepInBar === 14)) {
          kick(io, { time: time + human(6), gain: 0.3 * p });
        }
      } else {
        if (perc.kick.includes(stepInBar)) {
          kick(io, { time: time + human(6), gain: 0.36 * p * (stepInBar === 0 ? 1 : 0.65) });
        }
        if (perc.backbeat && (stepInBar === 4 || stepInBar === 12)) {
          rim(io, { time: time + human(7), gain: 0.09 * p, reverb: 0.2 });
        }
        if (perc.hat > 0.05 && perc.hatSteps.includes(stepInBar)) {
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
    }
  },
};
