/**
 * OpenStreetMap provider — nearby places with no API key and no account.
 *
 * This is what makes the project runnable by anyone: Overpass is a free
 * community service, so `npm start` works out of the box and auditioning a
 * hundred locations costs nothing.
 *
 * The tradeoff versus Google is real and worth knowing: OSM has no popularity
 * signal (no review counts), coverage is uneven outside cities, and Overpass is
 * a shared volunteer service that must not be hammered. Caching upstream is not
 * a nicety here, it is the price of admission.
 */

/**
 * The main public instance is often saturated. Mirrors are volunteer-run too,
 * so we try them in order rather than in parallel and only on a retryable
 * failure — never hammering all three for one lookup.
 */
import { osmType, prettyOsm } from '../public/src/osm-tags.js';

const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const ENDPOINTS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL.trim()]
  : DEFAULT_ENDPOINTS;
const USER_AGENT = 'GPSBackgroundMusic/0.1 (self-hosted generative music app)';

/** Overpass is a shared service; never have more than one query in flight. */
const MIN_REQUEST_GAP_MS = 1100;
let lastRequestAt = 0;
let inFlight = Promise.resolve();

const TIMEOUT_MS = 25000;
const MAX_ELEMENTS = 90;

/**
 * Google caps a Nearby Search at 20 results; Overpass will happily return 100+.
 * That difference is not free — `urbanness` in scene.js is calibrated against
 * a typical tag weight, so an unbounded provider would peg every location at
 * maximum density. Keep the nearest N so both providers feed the analyser
 * comparable magnitudes.
 */
const MAX_PLACES = 30;
/** Slots held back for mapped areas so a lake cannot be crowded out. */
const AREA_SLOTS = 8;

/**
 * The OSM keys worth asking for. Anything outside this set is either noise
 * (individual benches, street lamps) or too rare to matter musically.
 */
function buildQuery(lat, lng, radius) {
  const r = Math.round(radius);
  const at = `(around:${r},${lat.toFixed(6)},${lng.toFixed(6)})`;
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
  return `[out:json][timeout:${Math.floor(TIMEOUT_MS / 1000)}];\n(\n  ${clauses.join(';\n  ')};\n);\nout bb ${MAX_ELEMENTS};`;
}

export async function overpassNearby(lat, lng, radius) {
  // Serialise and space out requests — Overpass bans clients that flood it.
  const run = inFlight.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();

    let lastErr;
    for (let i = 0; i < ENDPOINTS.length; i++) {
      try {
        return await fetchOverpass(ENDPOINTS[i], lat, lng, radius);
      } catch (err) {
        lastErr = err;
        if (!err.retryable) throw err;
        // Busy instance: pause, then try the next mirror.
        await new Promise((r) => setTimeout(r, 1200));
        lastRequestAt = Date.now();
      }
    }
    throw lastErr;
  });
  // Keep the chain alive even when one query fails.
  inFlight = run.catch(() => {});
  return run;
}

async function fetchOverpass(endpoint, lat, lng, radius) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS + 3000);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      body: new URLSearchParams({ data: buildQuery(lat, lng, radius) }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429 || res.status === 504) {
    throw Object.assign(
      new Error(`Overpass busy (${res.status})`), { retryable: true });
  }
  if (!res.ok) {
    throw new Error(`Overpass HTTP ${res.status}`);
  }

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
      // OSM has no popularity signal, so stand in with mapped geometry:
      // a relation is usually a large container (a park, a campus, a complex),
      // a way is a building or a field, a node is a single point of interest.
      ratingCount: { relation: 2000, way: 120 }[el.type] ?? 0,
    });
  }

  places.sort((a, b) => a.distance - b.distance);
  return { source: 'osm', places: trimPlaces(places) };
}

/* ------------------------------------------------------------- geocoding */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
let lastGeocodeAt = 0;

/**
 * Place name -> coordinates, also keyless. Nominatim's usage policy caps this
 * at one request per second, which is plenty for someone typing.
 */
export async function geocode(query, limit = 5) {
  const wait = Math.max(0, lastGeocodeAt + 1100 - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocodeAt = Date.now();

  const url = `${NOMINATIM}?${new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(Math.min(10, Math.max(1, limit))),
    addressdetails: '0',
  })}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);

  const json = await res.json();
  return (json || []).map((r) => ({
    name: r.display_name,
    short: r.name || String(r.display_name).split(',')[0],
    lat: Number(r.lat),
    lng: Number(r.lon),
    kind: r.type,
  })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

/* ------------------------------------------------------------------ utils */

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
