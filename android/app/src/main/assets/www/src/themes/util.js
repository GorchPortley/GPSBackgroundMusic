/**
 * Helpers every theme needs.
 *
 * `rnd` is the important one: themes must be deterministic, because `plan()`
 * is rebuilt every 1.5 s and `step()` runs on every 16th note. If a theme used
 * Math.random the arrangement would shimmer and the same street would never
 * sound the same twice. Instead every "random" choice is a pure function of
 * (seed, bar, step, salt).
 */

import { voiceLead } from '../audio/theory.js';

/** 0 below `from`, ramping linearly to 1 over `width`. */
export function gate(value, from, width) {
  return Math.min(1, Math.max(0, (value - from) / width));
}

/**
 * Snap to five levels — the same resolution as the scene fingerprint that
 * seeds the plan. Use for anything discrete (mode, progression) so drifting a
 * few metres cannot flip the choice back and forth.
 */
export function quantise(value) {
  return Math.round(value * 4) / 4;
}

/** Deterministic float in [0,1) from a handful of integers. */
export function rnd(...nums) {
  let h = 2166136261 >>> 0;
  for (const n of nums) {
    h ^= n | 0;
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Swing: push the second eighth of each beat later, by `amount` of a 16th.
 * 0 is straight, ~0.6 is a hard jazz shuffle. Returns a time offset to add.
 */
export function swingOffset(stepInBar, stepDur, amount) {
  return stepInBar % 4 === 2 ? stepDur * amount : 0;
}

/**
 * Breath (C3.7): is this the bar of air? With `plan.form.breathEvery = n`
 * (n >= 1), the last bar of every n-th four-bar phrase is one — drums drop
 * out and the pad rings. 0 or absent never breathes. Needs the engine's
 * `pos.phrase` and `pos.barInPhrase`.
 */
export function breathing(plan, pos) {
  const every = plan.form?.breathEvery;
  if (!Number.isInteger(every) || every <= 0) return false;
  return pos.phrase % every === every - 1 && pos.barInPhrase === 3;
}

/**
 * Section form (P2): which section this phrase is in. With
 * `plan.form.sections = 'AABA'`, phrase n plays letter `sections[n % 4]` —
 * a pure function of the engine's phrase count, so it only ever changes at a
 * phrase seam and needs nothing from the engine's commit logic. `null` when
 * the theme has no `sections` (every phrase is then "A" for a layer's
 * `sections` gate).
 */
export function section(plan, pos) {
  const s = plan.form?.sections;
  if (typeof s !== 'string' || !s.length) return null;
  return s[pos.phrase % s.length];
}

/** Linear interpolation, for readability at call sites. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** A chordal part that has rested this many bars (past its chord length) starts fresh. */
const LEAD_STALE_BARS = 8;

/**
 * Voice-lead a chordal part: return the inversion of `notes` (its natural
 * voicing, e.g. from chordNotes) nearest to what this part played last, via
 * theory.voiceLead. `state` is a plain object the caller owns — one per
 * part: spec.js keeps it on the compiled layer, a code theme in its module.
 *
 * `tonic` is the MIDI note the part is written from (the `root + octave * 12`
 * passed to chordNotes). The lowest note is kept within a fourth below to a
 * fifth above it (`tonic - 5 .. tonic + 7`) — the span of the root-position
 * chords I to V — so the part keeps its register however long it plays, and
 * a chord that would sit high (vi, vii, or a degree that wraps past the
 * octave in a pentatonic mode) is voiced down into it instead.
 *
 * It starts again from the natural voicing when the theme, tonic or mode
 * changes (the discrete commits in engine.js), when the transport restarts,
 * or when the part has been silent for a while — so a theme or key always
 * opens on the chord it was written with, and the sequence from there is a
 * pure function of the plan.
 */
export function leadChord(state, plan, bar, notes, tonic = notes[0]) {
  const fresh = state.themeId !== plan.themeId || state.root !== plan.root ||
    state.scale !== plan.scale || !(bar >= state.bar) ||
    bar - state.bar > LEAD_STALE_BARS + (plan.barsPerChord || 1);
  const out = fresh || !state.prev
    ? notes
    : voiceLead(state.prev, notes, { anchor: tonic + 1, range: 6 });
  state.themeId = plan.themeId;
  state.root = plan.root;
  state.scale = plan.scale;
  state.bar = bar;
  state.prev = out;
  return out;
}
