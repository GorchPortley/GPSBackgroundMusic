/**
 * Nearby-places lookup.
 *
 * Two providers share one interface:
 *   - google: Places API (New) `places:searchNearby`, key held server-side.
 *   - mock:   deterministic offline generator, used when no key is configured
 *             (or when Google errors) so the app always makes sound.
 *
 * Both return: { source, places: [{ id, name, types, primaryType, lat, lng,
 *                                   distance, rating, ratingCount }] }
 */

import { overpassNearby } from './osm.js';

const KEY = (process.env.GOOGLE_MAPS_API_KEY || '').trim();

/**
 * auto  — Google if a key is configured, otherwise OpenStreetMap
 * google / osm / mock — force one
 */
const FORCED = (process.env.PLACES_PROVIDER || 'auto').trim().toLowerCase();

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.types',
  'places.primaryType',
  'places.location',
  'places.rating',
  'places.userRatingCount',
].join(',');

export function providerName() {
  if (FORCED === 'google' || FORCED === 'osm' || FORCED === 'mock') return FORCED;
  return KEY ? 'google' : 'osm';
}

/* ------------------------------------------------------------------ cache */

/** Google data (ratings, opening hours) drifts; OSM geometry barely does. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_TTL_OSM_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
/** Snap lookups to a ~110 m grid so a slow walk reuses one paid request. */
const CACHE_GRID_DEG = 0.001;
const cache = new Map();

function cacheKey(lat, lng, radius) {
  const q = (v) => (Math.round(v / CACHE_GRID_DEG) * CACHE_GRID_DEG).toFixed(4);
  return `${q(lat)}:${q(lng)}:${Math.round(radius)}`;
}

/** Most recent cached result within ~1 km, for riding out a provider outage. */
function nearestCached(lat, lng, radius) {
  let best = null;
  for (const [key, entry] of cache) {
    const [clat, clng, crad] = key.split(':').map(Number);
    if (Math.round(crad) !== Math.round(radius)) continue;
    const d = Math.hypot((clat - lat) * 111320,
      (clng - lng) * 111320 * Math.cos((lat * Math.PI) / 180));
    if (d > 1000) continue;
    if (!best || d < best.d) best = { d, data: entry.data };
  }
  return best?.data ?? null;
}

/* ------------------------------------------------------------------- main */

export async function getNearbyPlaces(lat, lng, radius) {
  const key = cacheKey(lat, lng, radius);
  const hit = cache.get(key);
  const ttl = hit?.data?.source === 'osm' ? CACHE_TTL_OSM_MS : CACHE_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) {
    return { ...hit.data, cached: true };
  }

  const provider = providerName();
  let data;

  if (provider === 'mock') {
    data = mockNearby(lat, lng, radius);
  } else {
    try {
      data = provider === 'google'
        ? await googleNearby(lat, lng, radius)
        : await overpassNearby(lat, lng, radius);
    } catch (err) {
      // Deliberately NOT falling back to the mock generator. Inventing a
      // nightlife strip where there is a park is worse than admitting the
      // lookup failed — the whole point is that the music reflects reality.
      // Reuse a nearby cached answer if we have one, otherwise return nothing
      // and let the scene read as open ground.
      const stale = nearestCached(lat, lng, radius);
      data = stale
        ? { ...stale, warning: `${provider}: ${err.message} — reusing a recent nearby lookup` }
        : { source: provider, places: [], warning: `${provider}: ${err.message}` };
    }
  }

  cache.set(key, { at: Date.now(), data });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return { ...data, cached: false };
}

/* ----------------------------------------------------------------- google */

async function googleNearby(lat, lng, radius) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({
      maxResultCount: 20,
      rankPreference: 'POPULARITY',
      locationRestriction: {
        circle: { center: { latitude: lat, longitude: lng }, radius },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 200);
    try {
      detail = JSON.parse(body)?.error?.message ?? detail;
    } catch {
      /* keep the raw text */
    }
    throw new Error(`HTTP ${res.status} ${detail}`);
  }

  const json = await res.json();
  const places = (json.places || []).map((p) => {
    const plat = p.location?.latitude ?? lat;
    const plng = p.location?.longitude ?? lng;
    return {
      id: p.id,
      name: p.displayName?.text || 'Unnamed',
      types: p.types || [],
      primaryType: p.primaryType || (p.types || [])[0] || null,
      lat: plat,
      lng: plng,
      distance: haversine(lat, lng, plat, plng),
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? 0,
    };
  });

  return { source: 'google', places };
}

/* ------------------------------------------------------------------- mock */

/**
 * Districts the mock world is built from. Each grid cell deterministically
 * picks one, so re-visiting a spot always sounds the same and the demo route
 * walks through recognisably different neighbourhoods.
 */
const DISTRICTS = {
  park: {
    label: 'Parkland',
    count: [5, 10],
    pool: ['park', 'park', 'park', 'garden', 'playground', 'hiking_area',
      'natural_feature', 'cafe', 'parking', 'tourist_attraction'],
  },
  downtown: {
    label: 'Downtown',
    count: [14, 20],
    pool: ['store', 'clothing_store', 'restaurant', 'cafe', 'bank', 'atm',
      'shopping_mall', 'pharmacy', 'hair_care', 'book_store',
      'convenience_store', 'transit_station'],
  },
  nightlife: {
    label: 'Nightlife strip',
    count: [10, 16],
    pool: ['bar', 'bar', 'night_club', 'restaurant', 'liquor_store',
      'movie_theater', 'casino', 'meal_takeaway', 'parking'],
  },
  residential: {
    label: 'Residential',
    count: [3, 7],
    pool: ['school', 'park', 'convenience_store', 'church', 'pharmacy',
      'primary_school', 'bakery', 'laundry'],
  },
  industrial: {
    label: 'Industrial',
    count: [4, 9],
    pool: ['car_repair', 'storage', 'moving_company', 'gas_station',
      'car_dealer', 'hardware_store', 'parking', 'electrician'],
  },
  campus: {
    label: 'Campus',
    count: [6, 11],
    pool: ['university', 'library', 'book_store', 'cafe', 'school',
      'stadium', 'museum', 'gym', 'park'],
  },
  waterfront: {
    label: 'Waterfront',
    count: [4, 9],
    pool: ['beach', 'natural_feature', 'marina', 'restaurant', 'cafe',
      'tourist_attraction', 'lodging', 'park'],
  },
  transit: {
    label: 'Transit hub',
    count: [8, 14],
    pool: ['train_station', 'subway_station', 'bus_station', 'transit_station',
      'parking', 'convenience_store', 'meal_takeaway', 'atm', 'lodging'],
  },
  civic: {
    label: 'Civic centre',
    count: [5, 10],
    pool: ['city_hall', 'courthouse', 'police', 'post_office', 'library',
      'hospital', 'fire_station', 'museum', 'bank'],
  },
  quiet: {
    label: 'Open ground',
    count: [0, 3],
    pool: ['natural_feature', 'campground', 'cemetery', 'parking'],
  },
};

const DISTRICT_KEYS = Object.keys(DISTRICTS);
const NAME_A = ['Old', 'North', 'Silver', 'Elm', 'Harbour', 'Grand', 'Little',
  'Union', 'Maple', 'Kings', 'Ash', 'Willow', 'Iron', 'Sunset'];
const NAME_B = ['Row', 'Yard', 'House', 'Corner', 'Works', 'Hall', 'Green',
  'Market', 'Depot', 'Arms', 'Lane', 'Court', 'Bridge'];

/** Mock districts are ~600 m across, so a short walk crosses several. */
const MOCK_CELL_DEG = 0.006;

function mockNearby(lat, lng, radius) {
  const cx = Math.floor(lat / MOCK_CELL_DEG);
  const cy = Math.floor(lng / MOCK_CELL_DEG);
  const rng = mulberry32(hash2(cx, cy));

  const districtKey = DISTRICT_KEYS[Math.floor(rng() * DISTRICT_KEYS.length)];
  const district = DISTRICTS[districtKey];
  const [lo, hi] = district.count;
  const n = lo + Math.floor(rng() * (hi - lo + 1));

  // Metres -> degrees, corrected for longitude convergence at this latitude.
  const mPerDegLat = 111320;
  const mPerDegLng = Math.max(1, 111320 * Math.cos((lat * Math.PI) / 180));

  const places = [];
  for (let i = 0; i < n; i++) {
    const type = district.pool[Math.floor(rng() * district.pool.length)];
    // sqrt keeps points uniform over the disc instead of clumped at the centre
    const dist = radius * Math.sqrt(rng());
    const bearing = rng() * Math.PI * 2;
    const plat = lat + (dist * Math.cos(bearing)) / mPerDegLat;
    const plng = lng + (dist * Math.sin(bearing)) / mPerDegLng;
    const name =
      `${NAME_A[Math.floor(rng() * NAME_A.length)]} ${NAME_B[Math.floor(rng() * NAME_B.length)]}`;

    places.push({
      id: `mock-${cx}-${cy}-${i}`,
      name,
      types: [type],
      primaryType: type,
      lat: plat,
      lng: plng,
      distance: dist,
      rating: Math.round((2.5 + rng() * 2.5) * 10) / 10,
      ratingCount: Math.floor(rng() * 900),
    });
  }

  places.sort((a, b) => a.distance - b.distance);
  return { source: 'mock', district: district.label, places };
}

/* ------------------------------------------------------------------ utils */

function hash2(a, b) {
  let h = 2166136261 >>> 0;
  for (const v of [a | 0, b | 0]) {
    h ^= v & 0xff; h = Math.imul(h, 16777619);
    h ^= (v >>> 8) & 0xff; h = Math.imul(h, 16777619);
    h ^= (v >>> 16) & 0xff; h = Math.imul(h, 16777619);
    h ^= (v >>> 24) & 0xff; h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
