/**
 * Helpers every theme needs.
 *
 * `rnd` is the important one: themes must be deterministic, because `plan()`
 * is rebuilt every 1.5 s and `step()` runs on every 16th note. If a theme used
 * Math.random the arrangement would shimmer and the same street would never
 * sound the same twice. Instead every "random" choice is a pure function of
 * (seed, bar, step, salt).
 */

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

/** Linear interpolation, for readability at call sites. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}
