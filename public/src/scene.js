/**
 * Places -> scene.
 *
 * Turns a list of nearby Google Maps places (plus context: how fast you are
 * moving, what time it is) into a single mood vector, a stable scene key for
 * seeding the composer, and a human-readable name for the HUD.
 */

import { canonicalType, DIMS, IGNORED_TYPES, NEUTRAL, profileFor } from './tags.js';

/** A place's own type counts more than the extra types Google attaches. */
const PRIMARY_TYPE_WEIGHT = 1.0;
const SECONDARY_TYPE_WEIGHT = 0.4;

/**
 * Half-saturation point for "how built-up is it here".
 *
 * This used to be a hard `min(1, weight / 8)`, which pegged at 1.0 for
 * essentially every city block — Central Park scored the same as Times Square.
 * A saturating curve `w / (w + K)` discriminates across the whole range and
 * never clips, and it makes the measure provider-agnostic: Google caps a search
 * at 20 results while Overpass happily returns 30+, and under the old formula
 * that difference alone changed the music.
 */
const URBAN_HALF_WEIGHT = 14;

/**
 * Averaging a dozen places drags every neighbourhood back toward 0.5, so a
 * nightlife strip ends up sounding like an industrial estate. Three correctives,
 * applied in order:
 *
 *  1. EMPHASIS  — opinionated place types count for more than bland ones, so a
 *                 car park dilutes a nightclub less than one-place-one-vote.
 *  2. PEAK_PULL — a strong nearby place drags the average toward itself; one
 *                 cathedral really does define a block.
 *  3. CONTRAST  — a logistic curve about 0.5 that widens what is left, without
 *                 ever clipping at the ends.
 */
const EMPHASIS_FLOOR = 0.5;
const EMPHASIS_GAIN = 3.0;
const PEAK_PULL = 0.34;
/** A type must reach this share of the strongest type's weight to be a peak. */
const PEAK_MIN_SHARE = 0.18;
const CONTRAST_K = 1.75;

/**
 * Repeated instances of one type accumulate sub-linearly (the nth counts 1/vn).
 *
 * Without this, quantity beats character: the Great Lawn in Central Park is
 * mapped as fourteen separate ball pitches, so the park scored as a sports
 * arena. A street of twelve restaurants has the same problem. More of a thing
 * should still count for more — the fourteenth just should not count as much
 * as the first.
 */
function repeatFalloff(occurrence) {
  return 1 / Math.sqrt(occurrence);
}

/** Nothing tagged nearby: open ground. Quiet, wide, faintly bright. */
const EMPTY_MOOD = { e: 0.22, b: 0.55, d: 0.20, t: 0.25, w: 0.62, s: 0.92 };

/* --------------------------------------------------------------- analysis */

/**
 * @param {Array} places  normalised places from /api/places
 * @param {number} radius search radius in metres
 */
export function analyzePlaces(places, radius) {
  const sums = zeroed();
  const tagWeights = new Map();
  const catWeights = new Map();
  const unknown = new Set();
  const contributions = [];
  let total = 0;

  // Nearest first, so the closest instance of a type is the one that gets full
  // weight before the falloff below starts discounting repeats.
  const ordered = [...(places || [])].sort((a, b) => a.distance - b.distance);
  const typeCounts = new Map();

  for (const place of ordered) {
    const geoW = distanceWeight(place.distance, radius) * prominence(place);
    if (geoW <= 0) continue;

    const seen = new Set();
    for (const type of place.types || []) {
      if (seen.has(type) || IGNORED_TYPES.has(type)) continue;
      seen.add(type);

      const profile = profileFor(type);
      if (!profile) {
        unknown.add(type);
        continue;
      }

      // Count repeats by canonical type, so `italian_restaurant` and
      // `pizza_restaurant` are two restaurants rather than one of each.
      const canonical = canonicalType(type) || type;
      const occurrence = (typeCounts.get(canonical) || 0) + 1;
      typeCounts.set(canonical, occurrence);

      const w = geoW
        * (type === place.primaryType ? PRIMARY_TYPE_WEIGHT : SECONDARY_TYPE_WEIGHT)
        * emphasis(profile)
        * repeatFalloff(occurrence);

      for (const d of DIMS) sums[d] += (profile[d] ?? NEUTRAL[d]) * w;
      total += w;
      contributions.push({ profile, w });

      tagWeights.set(type, (tagWeights.get(type) || 0) + w);
      catWeights.set(profile.cat, (catWeights.get(profile.cat) || 0) + w);
    }
  }

  let mood;
  if (total > 0) {
    const mean = Object.fromEntries(DIMS.map((d) => [d, sums[d] / total]));
    mood = sharpen(mean, contributions);
  } else {
    mood = { ...EMPTY_MOOD };
  }

  // The displayed name stays the specific one Google gave us ("italian
  // restaurant" says more than "restaurant"); only the profile is resolved.
  const tags = [...tagWeights.entries()]
    .map(([type, weight]) => ({ type, weight, cat: profileFor(type).cat }))
    .sort((a, b) => b.weight - a.weight);

  const categories = [...catWeights.entries()]
    .map(([cat, weight]) => ({ cat, weight }))
    .sort((a, b) => b.weight - a.weight);

  return {
    mood,
    tags,
    categories,
    totalWeight: total,
    urbanness: total / (total + URBAN_HALF_WEIGHT),
    placeCount: (places || []).length,
    unknownTypes: [...unknown],
  };
}

/**
 * How opinionated a place type is: its distance from a neutral profile. A
 * nightclub says a lot about a street; a car park says very little.
 */
function emphasis(profile) {
  let sum = 0;
  for (const d of DIMS) sum += ((profile[d] ?? NEUTRAL[d]) - 0.5) ** 2;
  return EMPHASIS_FLOOR + Math.sqrt(sum / DIMS.length) * EMPHASIS_GAIN;
}

/**
 * Pull the weighted mean toward its most extreme well-represented contributor,
 * then widen what remains. Turns a muddy average back into a place with a
 * character you can actually hear.
 */
function sharpen(mean, contributions) {
  const maxW = contributions.reduce((m, c) => Math.max(m, c.w), 0);
  const threshold = maxW * PEAK_MIN_SHARE;
  const out = {};

  for (const d of DIMS) {
    let peak = mean[d];
    let peakDev = 0;
    for (const { profile, w } of contributions) {
      if (w < threshold) continue;
      const v = profile[d] ?? NEUTRAL[d];
      const dev = Math.abs(v - 0.5);
      if (dev > peakDev) {
        peakDev = dev;
        peak = v;
      }
    }
    out[d] = contrast(mean[d] + (peak - mean[d]) * PEAK_PULL, CONTRAST_K);
  }
  return out;
}

/**
 * Logistic contrast about 0.5: k > 1 pushes values away from the middle and
 * asymptotes at 0 and 1, so it can widen the range without ever clipping.
 */
function contrast(v, k) {
  const x = Math.min(0.999, Math.max(0.001, v));
  return 1 / (1 + (x / (1 - x)) ** -k);
}

/** Closer places define the place you are in; falloff is smooth, not a cliff. */
function distanceWeight(distance, radius) {
  const d = Math.max(0, Number(distance) || 0);
  const half = Math.max(30, radius * 0.45);
  return 1 / (1 + (d / half) ** 2);
}

/** A landmark everyone reviews shapes a neighbourhood more than a lock-up. */
function prominence(place) {
  const count = Math.max(0, Number(place.ratingCount) || 0);
  return Math.min(1.6, 1 + Math.log10(1 + count) / 6);
}

/* ---------------------------------------------------------------- context */

export const TIME_BANDS = [
  { id: 'night', label: 'Night', from: 22, to: 5, mod: { b: -0.14, e: -0.08, s: +0.12, w: -0.04 } },
  { id: 'dawn', label: 'Dawn', from: 5, to: 8, mod: { b: +0.08, e: -0.04, s: +0.06, w: +0.06 } },
  { id: 'day', label: 'Day', from: 8, to: 17, mod: { b: +0.04, e: +0.04 } },
  { id: 'dusk', label: 'Dusk', from: 17, to: 22, mod: { b: -0.04, w: +0.10, s: +0.06 } },
];

export function timeBand(hour) {
  return TIME_BANDS.find(({ from, to }) =>
    from < to ? hour >= from && hour < to : hour >= from || hour < to) ?? TIME_BANDS[2];
}

/**
 * Fold in the things that are true about *you* rather than about the map:
 * how built-up it is here, how fast you are travelling, and the hour.
 *
 * @param {object} analysis result of analyzePlaces
 * @param {{speed?: number, hour?: number}} ctx speed in m/s
 */
export function contextualise(analysis, ctx = {}) {
  const mood = { ...analysis.mood };
  const urban = analysis.urbanness;

  // Density of tagged places is itself a signal: a dense block is busier and
  // more enclosed than a sparse one, whatever the individual places are.
  mood.e += (urban - 0.5) * 0.14;
  mood.d += (urban - 0.5) * 0.22;
  mood.s -= (urban - 0.5) * 0.20;
  mood.w -= (urban - 0.5) * 0.08;

  // Movement. 14 m/s ~ 50 km/h, treated as "fully in motion".
  //
  // Applied proportionally to the headroom left rather than added flat: a flat
  // bonus pins energy at 1.0 for every built-up area once you are driving, and
  // then a high street and a industrial estate score identically. Scaling by
  // (1 - value) keeps the ordering intact and can never saturate.
  const speed = Math.max(0, Number(ctx.speed) || 0);
  const motion = clamp01(speed / 14);
  mood.e += motion * 0.30 * (1 - mood.e);
  mood.d += motion * 0.18 * (1 - mood.d);
  mood.b += motion * 0.08 * (1 - mood.b);

  const band = timeBand(Number.isFinite(ctx.hour) ? ctx.hour : new Date().getHours());
  for (const [dim, delta] of Object.entries(band.mod)) mood[dim] += delta;

  for (const d of DIMS) mood[d] = clamp01(mood[d]);
  return { mood, motion, band };
}

/* ------------------------------------------------------------------ names */

const NOUNS = {
  nature: 'Green',
  water: 'Tide',
  food: 'Table',
  nightlife: 'Neon',
  retail: 'Exchange',
  transit: 'Transit',
  culture: 'Gallery',
  education: 'Quad',
  sacred: 'Nave',
  civic: 'Precinct',
  health: 'Ward',
  sport: 'Arena',
  lodging: 'Rest',
  industry: 'Works',
  finance: 'Ledger',
  attraction: 'Midway',
  service: 'Parlour',
};

/**
 * Adjectives as sparse points in mood space — only the dimensions listed are
 * compared, so "Golden" is about light and warmth and says nothing about pace.
 */
const ADJECTIVES = [
  { word: 'Golden', b: 0.85, w: 0.85 },
  { word: 'Amber', b: 0.70, w: 0.85, e: 0.35 },
  { word: 'Bright', b: 0.90, e: 0.62 },
  { word: 'Open', s: 0.90, d: 0.20 },
  { word: 'Wide', s: 0.95, b: 0.70 },
  { word: 'Hollow', s: 0.90, e: 0.15, b: 0.30 },
  { word: 'Deep', b: 0.25, s: 0.85, e: 0.30 },
  { word: 'Quiet', e: 0.15, d: 0.20 },
  { word: 'Still', e: 0.10, d: 0.15, t: 0.20 },
  { word: 'Soft', w: 0.85, e: 0.30, t: 0.15 },
  { word: 'Drifting', e: 0.30, s: 0.80, d: 0.30 },
  { word: 'Humming', d: 0.70, e: 0.55, t: 0.35 },
  { word: 'Restless', e: 0.78, d: 0.75 },
  { word: 'Racing', e: 0.94, d: 0.90 },
  { word: 'Electric', e: 0.82, b: 0.55, t: 0.45, w: 0.42 },
  { word: 'Cold', w: 0.15, b: 0.40 },
  { word: 'Iron', b: 0.25, w: 0.25, t: 0.62 },
  { word: 'Uneasy', t: 0.78, e: 0.35 },
  { word: 'Fraying', t: 0.82, e: 0.58 },
];

export function sceneName(mood, categories) {
  let best = ADJECTIVES[0];
  let bestScore = Infinity;

  for (const adj of ADJECTIVES) {
    let score = 0;
    let n = 0;
    for (const d of DIMS) {
      if (adj[d] === undefined) continue;
      score += (mood[d] - adj[d]) ** 2;
      n++;
    }
    // Normalise so adjectives that pin more dimensions are not penalised.
    score = n ? score / n : Infinity;
    if (score < bestScore) {
      bestScore = score;
      best = adj;
    }
  }

  const topCat = categories?.[0]?.cat;
  return `${best.word} ${NOUNS[topCat] || 'Expanse'}`;
}

/**
 * A coarse fingerprint of the scene. The composer seeds its random choices
 * from this, so the same kind of place always produces the same arrangement
 * and small GPS jitter does not reshuffle the music.
 */
export function sceneKey(mood, categories) {
  const q = DIMS.map((d) => Math.round(mood[d] * 4)).join('');
  const cats = (categories || []).slice(0, 2).map((c) => c.cat).join('-');
  return `${cats}:${q}`;
}

/* ------------------------------------------------------------------ utils */

function zeroed() {
  return Object.fromEntries(DIMS.map((d) => [d, 0]));
}

export function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/** Exponential move of `from` toward `to`; used to keep mood changes gradual. */
export function lerpMood(from, to, alpha) {
  const out = {};
  for (const d of DIMS) out[d] = from[d] + (to[d] - from[d]) * alpha;
  return out;
}

export function moodDistance(a, b) {
  let s = 0;
  for (const d of DIMS) s += (a[d] - b[d]) ** 2;
  return Math.sqrt(s / DIMS.length);
}
