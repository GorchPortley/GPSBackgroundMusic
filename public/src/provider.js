/**
 * Where place data comes from, seen from the browser.
 *
 * Two paths, tried in that order:
 *
 *   1. The local server (`/api/places`). It holds the Google key, caches
 *      aggressively, and is what you get when running `npm start`.
 *
 *   2. Overpass and Nominatim directly. Both allow cross-origin browser
 *      requests, so with no server at all — an installed PWA on a phone, or
 *      the static files on any host — the app still works.
 *
 * The fallback means "installed on the phone" is not a lesser mode: it is the
 * same app, minus Google's popularity data.
 */

import { osmType, prettyOsm } from './osm-tags.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/** Only the main Overpass instance sends CORS headers; mirrors do not. */
const TIMEOUT_MS = 25000;
const MAX_PLACES = 30;
/** Slots held back for mapped areas so a lake cannot be crowded out. */
const AREA_SLOTS = 8;
const MIN_GAP_MS = 1100;

let lastDirectAt = 0;
let serverAvailable = null;   // null = not yet known

/* ------------------------------------------------------------------- api */

export function usingServer() {
  return serverAvailable;
}

/**
 * Nearby places. Falls back to Overpass if the server is not reachable.
 * @returns {{source, places, radius, center, direct?, warning?}}
 */
export async function fetchPlaces(lat, lng, radius) {
  if (serverAvailable !== false) {
    try {
      const res = await fetch(`/api/places?lat=${lat}&lng=${lng}&radius=${radius}`);
      if (res.ok) {
        serverAvailable = true;
        return await res.json();
      }
      // A served 4xx/5xx is a real answer — the server exists but complained.
      if (serverAvailable === true) throw new Error(`Lookup failed (${res.status})`);
      serverAvailable = false;
    } catch (err) {
      if (serverAvailable === true) throw err;   // it was there and broke
      serverAvailable = false;                    // it was never there
    }
  }

  const places = await overpassNearby(lat, lng, radius);
  return { source: 'osm', direct: true, places, radius, center: { lat, lng } };
}

export async function geocode(query) {
  if (serverAvailable !== false) {
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
      if (res.ok) return (await res.json()).results;
    } catch { /* fall through */ }
  }

  const url = `${NOMINATIM}?${new URLSearchParams({
    q: query, format: 'jsonv2', limit: '6',
  })}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
  return (await res.json()).map((r) => ({
    name: r.display_name,
    short: r.name || String(r.display_name).split(',')[0],
    lat: Number(r.lat),
    lng: Number(r.lon),
    kind: r.type,
  })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

/* -------------------------------------------------------------- overpass */

function buildQuery(lat, lng, radius) {
  const at = `(around:${Math.round(radius)},${lat.toFixed(6)},${lng.toFixed(6)})`;
  const clauses = [
    `nwr${at}["amenity"]`,
    `nwr${at}["shop"]`,
    `nwr${at}["leisure"]`,
    `nwr${at}["tourism"]`,
    `nwr${at}["historic"]`,
    `nwr${at}["healthcare"]`,
    `nwr${at}["railway"~"^(station|halt|tram_stop|subway_entrance)$"]`,
    `nwr${at}["public_transport"~"^(station|stop_position)$"]`,
    `nwr${at}["highway"="bus_stop"]`,
    `nwr${at}["natural"~"^(water|wood|beach|peak|bay)$"]`,
    `nwr${at}["waterway"~"^(river|stream|canal|riverbank)$"]`,
    `nwr${at}["office"="government"]`,
  ];
  return `[out:json][timeout:25];\n(\n  ${clauses.join(';\n  ')};\n);\nout bb 90;`;
}

async function overpassNearby(lat, lng, radius) {
  // Overpass is a volunteer service. Space requests out even when the browser
  // is the one asking.
  const wait = Math.max(0, lastDirectAt + MIN_GAP_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastDirectAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: buildQuery(lat, lng, radius) }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429 || res.status === 504) {
    throw new Error('OpenStreetMap is busy — try again in a moment');
  }
  if (!res.ok) throw new Error(`OpenStreetMap HTTP ${res.status}`);

  const json = await res.json();
  const places = [];

  for (const el of json.elements || []) {
    const tags = el.tags || {};
    const type = osmType(tags);
    if (!type) continue;

    const at = positionOf(el);
    const distance = distanceTo(el, lat, lng);
    if (!at || distance === null) continue;

    places.push({
      id: `osm-${el.type}-${el.id}`,
      name: tags.name || tags['name:en'] || tags.operator || prettyOsm(type),
      types: [type],
      primaryType: type,
      lat: at.lat,
      lng: at.lng,
      distance,
      // Ways and relations are mapped areas: parks, lakes, campuses.
      isArea: el.type !== 'node',
      rating: null,
      ratingCount: { relation: 2000, way: 120 }[el.type] ?? 0,
    });
  }

  places.sort((a, b) => a.distance - b.distance);
  return trimPlaces(places);
}

/**
 * Trim to the nearest N, without letting areas get squeezed out.
 *
 * A lake or a park you are standing beside can still sort below a dozen car
 * parks, and a straight top-N cut then silently drops it. Reserve a few slots.
 */
function trimPlaces(places) {
  const areas = places.filter((p) => p.isArea);
  const points = places.filter((p) => !p.isArea);
  const kept = [
    ...areas.slice(0, AREA_SLOTS),
    ...points.slice(0, Math.max(0, MAX_PLACES - Math.min(AREA_SLOTS, areas.length))),
  ];
  return kept.sort((a, b) => a.distance - b.distance);
}

/**
 * How far you are from an element.
 *
 * Nodes are a point, so it is just the distance. Ways and relations are areas,
 * and this is where a centroid lies to you: Belmont Park's centre is 450 m from
 * a house whose garden backs onto it, and a river's centroid can be a mile
 * upstream. Overpass will return a bounding box instead (`out bb`), so measure
 * to the box — zero when you are inside it, honest when you are not.
 */
function distanceTo(el, lat, lng) {
  if (el.type === 'node') return haversine(lat, lng, el.lat, el.lon);

  const b = el.bounds;
  if (!b) return null;

  // Zero on the axes where the point falls inside the box.
  const dLat = Math.max(b.minlat - lat, 0, lat - b.maxlat);
  const dLng = Math.max(b.minlon - lng, 0, lng - b.maxlon);

  const mPerLat = 111320;
  const mPerLng = Math.max(1, 111320 * Math.cos((lat * Math.PI) / 180));
  return Math.hypot(dLat * mPerLat, dLng * mPerLng);
}

/** Where to draw it: the node itself, or the middle of the area. */
function positionOf(el) {
  if (el.type === 'node') return { lat: el.lat, lng: el.lon };
  const b = el.bounds;
  if (!b) return null;
  return { lat: (b.minlat + b.maxlat) / 2, lng: (b.minlon + b.maxlon) / 2 };
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
