/**
 * Generative melody (C3.8): a seeded Markov walk over scale degrees.
 *
 * A spec layer may say `generate: { kind: 'markov', ... }` instead of
 * `pattern`. spec.js resolves the mood expressions and calls `markovBar` once
 * per bar (and caches the result on the layer), so the melody is:
 *
 *   - different in every place    — the plan's seed comes from the scene,
 *   - stable while you stand there — the same (seed, bar, layer) always gives
 *                                    the same notes, and a bar never changes
 *                                    under the listener once it has started,
 *   - always in key                — it only ever names scale degrees, and
 *                                    steps 0 and 8 land on a chord tone.
 *
 * Tension drives `leap` (how often it jumps a 4th–6th instead of stepping),
 * brightness drives `contour` (whether it tends to climb or fall), density
 * drives `density` (how many off-8th 16ths are allowed to sound).
 *
 * Nothing here touches audio or the DOM, so it runs under Node for tests.
 */

import { hashString, mulberry32 } from '../audio/theory.js';

export const STEPS = 16;

/** Knuth's multiplicative constant: floor(2^32 / golden ratio). */
const GOLDEN = 2654435761;

/** Chord tones relative to the chord root: root, third, fifth. */
const CHORD_TONES = [0, 2, 4];

/**
 * The RNG for one bar of one layer.
 *
 * HANDOFF specifies `mulberry32(plan.seed ^ (bar * 2654435761 >>> 0) ^
 * hashString(layer.name))`. Precedence: `*` binds tighter than `>>>`, which
 * binds tighter than `^`, so that already reads as
 * `seed ^ ((bar * K) >>> 0) ^ hash` — the bar hashed to 32 bits, then mixed
 * with the seed and the layer name. That is the intent, and it is what is
 * written here, with one change: `Math.imul(bar, K) >>> 0` instead of
 * `(bar * K) >>> 0`. Both give the same low 32 bits while the product is an
 * exact double (bar < 2^53 / K ≈ 3.39 million bars ≈ 80 days at 120 bpm);
 * past that the plain `*` silently loses the low bits, imul never does.
 */
export function barRng(seed, bar, name) {
  return mulberry32((seed ^ (Math.imul(bar, GOLDEN) >>> 0) ^ hashString(String(name))) >>> 0);
}

/**
 * One bar of melody. Every option is already a plain number (spec.js has
 * resolved the mood expressions):
 *
 * @param {object} o
 * @param {number} o.seed          plan.seed
 * @param {number} o.bar           engine bar index
 * @param {string} o.name          layer name (salts the RNG per layer)
 * @param {number} o.chordDegree   current chord root, as a scale degree
 * @param {boolean} o.chordChange  is this bar the first of a new chord?
 * @param {number} o.scaleLength   notes per octave in the current scale
 * @param {number} o.density       0..1 chance a 16th off the 8th grid is eligible
 * @param {number} o.leap          0..1 chance a move is a leap of 3–5 degrees
 * @param {number} o.rest          0..1 chance any step is skipped
 * @param {number} o.contour       -1..1 bias toward falling / rising
 * @param {number} o.lo, o.hi      range, in scale degrees above the layer's tonic
 * @returns {{value: string, begin: number, end: number}[]} the same shape as
 *   queryPattern. `value` is the degree **relative to the current chord**,
 *   because that is how stepLayers reads a pattern degree; the walk itself
 *   happens in absolute degrees (above the tonic), so `range` is fixed pitch
 *   space and the melody does not jump when the chord changes.
 */
export function markovBar(o) {
  const rng = barRng(o.seed, o.bar, o.name);
  const len = Math.max(1, Math.round(o.scaleLength) || 7);
  let lo = Math.round(o.lo);
  let hi = Math.round(o.hi);
  if (lo > hi) [lo, hi] = [hi, lo];
  const chord = Math.round(o.chordDegree) || 0;
  const contour = clamp(o.contour, -1, 1);
  const upChance = (1 + contour * 0.6) / 2;

  const isChordTone = (d) => CHORD_TONES.includes((((d - chord) % len) + len) % len);

  // Nearest chord tone inside the range; ties go the way the contour leans.
  // A range too narrow to hold one leaves the note where it is.
  const snap = (d) => {
    const first = contour >= 0 ? 1 : -1;
    for (let k = 0; k <= hi - lo; k++) {
      for (const cand of k === 0 ? [d] : [d + first * k, d - first * k]) {
        if (cand >= lo && cand <= hi && isChordTone(cand)) return cand;
      }
    }
    return d;
  };

  const move = (d) => {
    const size = rng() < o.leap
      ? 3 + Math.floor(rng() * 3)   // ±3..±5
      : 1 + Math.floor(rng() * 2);  // ±1 or ±2
    const sign = rng() < upChance ? 1 : -1;
    let next = d + sign * size;
    // Reflect off the bounds, then clamp in case the range is narrower than the step.
    if (next > hi) next = 2 * hi - next;
    if (next < lo) next = 2 * lo - next;
    return clamp(next, lo, hi);
  };

  const events = [];
  let cur = lo + Math.floor(rng() * (hi - lo + 1));
  let first = true;
  for (let i = 0; i < STEPS; i++) {
    // Step 0 of a chord-change bar always plays: the new chord gets a melody note.
    if (!(i === 0 && o.chordChange)) {
      if (rng() < o.rest) continue;
      if (i % 2 === 1 && rng() >= o.density) continue;
    }
    if (!first) cur = move(cur);
    first = false;
    if (i === 0 || i === 8) cur = snap(cur);
    events.push({ value: String(cur - chord), begin: i / STEPS, end: (i + 1) / STEPS });
  }
  return events;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));
}
