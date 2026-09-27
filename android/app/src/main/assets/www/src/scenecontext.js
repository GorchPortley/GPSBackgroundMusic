/**
 * Scene context — what is actually around you, not just its average.
 *
 * The mood vector is a lossy summary: six numbers that have already dissolved
 * "there is a gym here" into "energy is high". That is the right input for a
 * theme's overall character, and the wrong input for anything that wants to
 * react to a *particular* kind of place.
 *
 * This object travels alongside the mood so a theme (or a cue) can ask
 * questions the average cannot answer: is there a gym nearby, how strongly,
 * and is this that specific gym.
 *
 * Weights are the same ones the mood was computed from — distance-weighted,
 * prominence-weighted, and discounted for repeats — so `tagWeight('cafe')` of
 * 0.9 means cafés genuinely dominate here, not that one is 4 km away.
 */

import { canonicalType } from './tags.js';

/**
 * Added to the denominator when working out shares.
 *
 * A pure share asks "what fraction of what is here is a park", which misleads
 * where little is mapped: a quiet street whose only six known features include
 * two parks reads as 40% parkland. The floor stands in for everything nobody
 * has tagged, so sparse surroundings produce modest shares and a genuinely
 * dense scene is barely affected. Measured totals run ~2 on a residential
 * street and ~16 in a town centre.
 */
const PRESENCE_FLOOR = 1.6;

/**
 * @param {object} analysis result of analyzePlaces
 * @param {Array}  places   the raw places behind it
 * @param {object} position current position, for distance-based matching
 */
export function buildScene(analysis, places, position) {
  const tagWeights = new Map();
  const catWeights = new Map();
  let total = 0;

  for (const tag of analysis?.tags || []) {
    // Fold specific types into their canonical one: `italian_restaurant` and
    // `pizza_restaurant` both answer a question about `restaurant`.
    const key = canonicalType(tag.type) || tag.type;
    tagWeights.set(key, (tagWeights.get(key) || 0) + tag.weight);
    total += tag.weight;
  }
  for (const cat of analysis?.categories || []) {
    catWeights.set(cat.cat, cat.weight);
  }

  /*
   * Weights are a SHARE of the scene, not a fraction of the strongest thing in
   * it. Normalising by the maximum made whatever happened to top the list read
   * 1.0 — so a cue on `church` fired at full strength anywhere a single distant
   * church was the most notable thing, which in a suburb is most places.
   *
   * A share answers the question a cue actually asks: how much of where I am
   * is this? Dominant tags land around 0.2-0.4, incidental ones below 0.05.
   */
  const norm = total + PRESENCE_FLOOR;

  const list = (places || []).map((p) => ({
    id: p.id,
    name: p.name || '',
    type: canonicalType(p.primaryType) || p.primaryType,
    rawType: p.primaryType,
    distance: p.distance ?? Infinity,
    lat: p.lat,
    lng: p.lng,
  })).sort((a, b) => a.distance - b.distance);

  return {
    position: position || null,
    places: list,
    tags: [...tagWeights.entries()]
      .map(([type, weight]) => ({ type, weight: weight / norm }))
      .sort((a, b) => b.weight - a.weight),
    categories: [...catWeights.entries()]
      .map(([cat, weight]) => ({ cat, weight: weight / norm }))
      .sort((a, b) => b.weight - a.weight),

    /** 0..1 — how much this kind of place defines where you are. */
    tagWeight(type) {
      const key = canonicalType(type) || type;
      return (tagWeights.get(key) || 0) / norm;
    },

    categoryWeight(cat) {
      return (catWeights.get(cat) || 0) / norm;
    },

    /** The closest place of a given type, or null. */
    nearest(type) {
      const key = canonicalType(type) || type;
      return list.find((p) => p.type === key) || null;
    },

    /** Places whose name contains `text`, case-insensitively. */
    named(text) {
      const needle = String(text || '').trim().toLowerCase();
      if (!needle) return [];
      return list.filter((p) => p.name.toLowerCase().includes(needle));
    },
  };
}

/** An empty scene, so callers never have to null-check. */
export function emptyScene() {
  return buildScene({ tags: [], categories: [] }, [], null);
}
