/**
 * Conditions — "when is this loop supposed to play?"
 *
 * One matcher serves both granularities the app needs:
 *
 *   { tag: 'gym' }                          any gym
 *   { category: 'sport' }                   anything sporty
 *   { place: 'Iron Works Gym' }             a gym with that name
 *   { near: { lat, lng, radius: 120 } }     *that* gym, wherever you saved it
 *
 * Matchers return a strength in `0..1`, not a boolean. That matters: a hard
 * on/off switch would make loops snap in and out as you walk, which is exactly
 * what the rest of the app works to avoid. A gym half a street away brings its
 * riff in quietly; standing outside it brings the riff up full.
 *
 * Multiple keys in one condition are ANDed (the weakest wins). `any` takes a
 * list and ORs it (the strongest wins).
 */

const DEFAULT_MIN = 0.08;
const DEFAULT_FULL = 0.45;
const DEFAULT_NEAR_RADIUS = 120;

/**
 * @param {object} condition
 * @param {object} scene from buildScene()
 * @returns {number} 0 = not here, 1 = definitively here
 */
export function matchStrength(condition, scene) {
  if (!condition) return 1;                       // no condition = always on
  if (!scene) return 0;

  if (Array.isArray(condition.any)) {
    let best = 0;
    for (const sub of condition.any) {
      best = Math.max(best, matchStrength(sub, scene));
      if (best >= 1) break;
    }
    return best;
  }

  let strength = 1;
  const clamp = (v) => Math.min(1, Math.max(0, v));

  // Ramp a raw weight through the condition's own thresholds.
  const ramp = (weight) => {
    const min = condition.min ?? DEFAULT_MIN;
    const full = condition.full ?? Math.max(min + 0.01, DEFAULT_FULL);
    return clamp((weight - min) / (full - min));
  };

  if (condition.tag !== undefined) {
    const tags = Array.isArray(condition.tag) ? condition.tag : [condition.tag];
    strength = Math.min(strength,
      clamp(Math.max(...tags.map((t) => ramp(scene.tagWeight(t))))));
  }

  if (condition.category !== undefined) {
    const cats = Array.isArray(condition.category) ? condition.category : [condition.category];
    strength = Math.min(strength,
      clamp(Math.max(...cats.map((c) => ramp(scene.categoryWeight(c))))));
  }

  if (condition.place !== undefined) {
    const names = Array.isArray(condition.place) ? condition.place : [condition.place];
    let best = 0;
    for (const name of names) {
      for (const hit of scene.named(name)) {
        // A named place fades in over the last 200 m rather than appearing.
        best = Math.max(best, clamp(1 - hit.distance / 200));
      }
    }
    strength = Math.min(strength, best);
  }

  if (condition.near !== undefined) {
    const { lat, lng, radius = DEFAULT_NEAR_RADIUS } = condition.near || {};
    const here = scene.position;
    if (!here || !Number.isFinite(lat) || !Number.isFinite(lng)) return 0;
    const d = haversine(here.lat, here.lng, lat, lng);
    // Full strength inside the radius, fading to nothing at twice it.
    strength = Math.min(strength, clamp(1 - (d - radius) / radius));
  }

  return strength;
}

/** Human-readable summary, for the UI and for error messages. */
export function describeCondition(condition) {
  if (!condition) return 'always';
  if (Array.isArray(condition.any)) {
    return condition.any.map(describeCondition).join(' or ');
  }
  const parts = [];
  if (condition.tag !== undefined) parts.push(`near ${[condition.tag].flat().join('/')}`);
  if (condition.category !== undefined) parts.push(`in ${[condition.category].flat().join('/')}`);
  if (condition.place !== undefined) parts.push(`at "${[condition.place].flat().join('" or "')}"`);
  if (condition.near !== undefined) {
    const { lat, lng, radius = DEFAULT_NEAR_RADIUS } = condition.near || {};
    parts.push(`within ${Math.round(radius)} m of ${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`);
  }
  return parts.length ? parts.join(' and ') : 'always';
}

/** Structural check. Returns an array of problems (empty means fine). */
export function validateCondition(condition, where = 'condition') {
  const errors = [];
  if (condition === undefined || condition === null) return errors;
  if (typeof condition !== 'object' || Array.isArray(condition)) {
    errors.push(`${where}: must be an object.`);
    return errors;
  }

  if (Array.isArray(condition.any)) {
    condition.any.forEach((sub, i) =>
      errors.push(...validateCondition(sub, `${where}.any[${i}]`)));
  }

  const known = ['tag', 'category', 'place', 'near', 'any', 'min', 'full'];
  for (const key of Object.keys(condition)) {
    if (!known.includes(key)) {
      errors.push(`${where}: unknown key "${key}". Expected one of ${known.join(', ')}.`);
    }
  }

  if (condition.near !== undefined) {
    const n = condition.near;
    if (!n || typeof n !== 'object' ||
        !Number.isFinite(Number(n.lat)) || !Number.isFinite(Number(n.lng))) {
      errors.push(`${where}.near: needs numeric lat and lng.`);
    }
  }

  const hasTest = ['tag', 'category', 'place', 'near', 'any']
    .some((k) => condition[k] !== undefined);
  if (!hasTest) {
    errors.push(`${where}: no test — needs at least one of tag, category, place, near, any.`);
  }

  return errors;
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
