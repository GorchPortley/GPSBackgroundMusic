/**
 * Weather (C3.10) — Open-Meteo, keyless, CORS-enabled, off by default.
 *
 * Rain darkens the music and adds the `rain` ambience bed; wind opens up the
 * space; overcast dims brightness slightly (the amounts live in scene.js
 * `contextualise`). This module only fetches and normalises.
 *
 * Privacy: the only thing ever sent is latitude and longitude rounded to
 * 2 dp (~1.1 km) — see `weatherUrl`. Nothing else, no key, no identifier.
 *
 * Rules it keeps:
 *   - Guarded like `fetchPlaces` (HANDOFF §3.14): every request takes a
 *     sequence number and a response that has been overtaken is discarded,
 *     so a slow answer for where you were cannot clobber where you are.
 *   - Cached 15 minutes, and refreshed early only once you have moved more
 *     than WEATHER_MOVE_M. The weather is coarse; a lookup per fix is waste.
 *   - Fails silently. Offline, blocked or malformed → no weather change, no
 *     status line, no thrown error; the last good reading is kept for up to
 *     WEATHER_KEEP_MS and the next attempt waits WEATHER_RETRY_MS.
 *   - Never awaited by the caller: `refresh()` fires and forgets, and the
 *     result reaches the app through `onChange`, read on the next replan.
 */

import { haversine } from './geo.js';

export const WEATHER_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
/** A reading is reused this long before asking again. */
export const WEATHER_TTL_MS = 15 * 60 * 1000;
/** Moved further than this from the last reading's spot → ask again now. */
export const WEATHER_MOVE_M = 3000;
/** After a failure, wait this long before trying again. */
export const WEATHER_RETRY_MS = 60 * 1000;
/** Without a successful refresh, a reading is dropped after this long. */
export const WEATHER_KEEP_MS = 60 * 60 * 1000;
/** Give up on a single request after this long. */
const WEATHER_TIMEOUT_MS = 8000;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** 2 dp — about 1.1 km of latitude. The only precision that leaves the device. */
export function round2(v) {
  return Math.round(v * 100) / 100;
}

/** The request URL. Coordinates are rounded here and nowhere else. */
export function weatherUrl(lat, lng) {
  const q = `latitude=${round2(lat).toFixed(2)}&longitude=${round2(lng).toFixed(2)}`;
  return `${WEATHER_ENDPOINT}?${q}&current=precipitation,wind_speed_10m,cloud_cover,is_day`;
}

/**
 * Open-Meteo `current` → `{ rainMmH, windKmh, cloudPct, isDay }`, or null if
 * the body is not usable. Default units: precipitation mm, wind km/h, cloud %.
 *
 * `current.precipitation` is the total over the preceding `current.interval`
 * seconds (900 — Open-Meteo's current conditions are 15-minutely), so it is
 * scaled to mm per hour. With no interval it is taken as already per hour.
 */
export function parseWeather(body) {
  const c = body && typeof body === 'object' ? body.current : null;
  if (!c || typeof c !== 'object') return null;
  const { precipitation: p, wind_speed_10m: wind, cloud_cover: cloud, is_day: day } = c;
  if (!finite(p) && !finite(wind) && !finite(cloud)) return null;
  const interval = finite(c.interval) && c.interval > 0 ? Math.min(3600, Math.max(60, c.interval)) : 3600;
  return {
    rainMmH: finite(p) ? Math.min(200, Math.max(0, p * 3600 / interval)) : 0,
    windKmh: finite(wind) ? Math.min(300, Math.max(0, wind)) : 0,
    cloudPct: finite(cloud) ? Math.min(100, Math.max(0, cloud)) : 0,
    isDay: day === 1 || day === true,
  };
}

/**
 * Weather as three 0..1 factors, the only form the mood and the ambience read:
 *
 *   rain01  = clamp01(rain mm/h ÷ 4)   4 mm/h is moderate-to-heavy rain; drizzle
 *                                      (~0.5 mm/h) is a light touch (0.125)
 *   cloud01 = cloud % ÷ 100            overcast is 1
 *   wind01  = clamp01(wind km/h ÷ 40)  40 km/h (a strong breeze, Beaufort 6)
 *                                      is "fully windy"
 *
 * No weather (off, not fetched yet, or failed) → all zero: no effect at all.
 */
export function weatherFactors(w) {
  if (!w) return { rain01: 0, cloud01: 0, wind01: 0 };
  return {
    rain01: clamp01((Number(w.rainMmH) || 0) / 4),
    cloud01: clamp01((Number(w.cloudPct) || 0) / 100),
    wind01: clamp01((Number(w.windKmh) || 0) / 40),
  };
}

/**
 * One glyph for the band badge, plus a line for its tooltip. Text-style
 * symbols (U+FE0E) so Android does not swap in colour emoji.
 */
export function describeWeather(w) {
  if (!w) return null;
  const f = weatherFactors(w);
  let glyph;
  if (w.rainMmH >= 0.1) glyph = '☂︎';          // ☂ umbrella
  else if (f.wind01 >= 0.6) glyph = '≋';             // ≋ wind
  else if (f.cloud01 >= 0.7) glyph = '☁︎';      // ☁ cloud
  else glyph = w.isDay ? '☀︎' : '☾︎'; // ☀ sun / ☾ moon
  const text = `Rain ${w.rainMmH.toFixed(1)} mm/h · wind ${Math.round(w.windKmh)} km/h`
    + ` · cloud ${Math.round(w.cloudPct)}%`;
  return { glyph, text };
}

/** Plain GET with a timeout. Resolves to parsed weather; throws on any failure. */
export async function fetchWeather(lat, lng) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const res = await fetch(weatherUrl(lat, lng), {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`weather ${res.status}`);
    const w = parseWeather(await res.json());
    if (!w) throw new Error('weather: unusable response');
    return w;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The app's one weather source. `current` is the reading in use (or null);
 * `onChange(current)` fires whenever that changes.
 */
export class WeatherSource {
  constructor({ onChange } = {}) {
    this.onChange = onChange || (() => {});
    this.current = null;
    this.seq = 0;
    this.inflight = null;   // { seq, lat, lng } of the newest request
    this.last = null;       // { lat, lng, at } of the reading in `current`
    this.retryAt = 0;
    this.failed = null;     // { lat, lng } of the last failed attempt
    this.requests = 0;      // debug: requests sent this session
  }

  /**
   * Ask again if the reading is missing, older than the TTL or from more than
   * WEATHER_MOVE_M away. Cheap to call on every tick; never awaits.
   */
  refresh(pos) {
    if (!pos || !finite(pos.lat) || !finite(pos.lng)) return;
    const now = Date.now();

    if (this.last && now - this.last.at > WEATHER_KEEP_MS) this._set(null);

    const here = { lat: pos.lat, lng: pos.lng };
    const far = (ref) => !ref || haversine(ref.lat, ref.lng, here.lat, here.lng) > WEATHER_MOVE_M;

    // A request is already on its way for about here: let it land.
    if (this.inflight && !far(this.inflight)) return;
    // The reading in hand is recent and for about here.
    if (this.last && !far(this.last) && now - this.last.at < WEATHER_TTL_MS) return;
    // It just failed for about here: back off. Moving far tries at once.
    if (now < this.retryAt && !far(this.failed)) return;

    this._fetch(here);
  }

  /** Weather off: forget the reading and discard anything in flight. */
  disable() {
    this.seq++;
    this.inflight = null;
    this.last = null;
    this.retryAt = 0;
    this.failed = null;
    this._set(null);
  }

  async _fetch(here) {
    const seq = ++this.seq;
    this.inflight = { seq, ...here };
    this.requests++;
    try {
      const w = await fetchWeather(here.lat, here.lng);
      if (seq !== this.seq) return;          // overtaken (or turned off)
      this.last = { ...here, at: Date.now() };
      this.retryAt = 0;
      this._set(w);
    } catch {
      // Silent by design: offline is a normal state for a phone on a walk.
      if (seq === this.seq) {
        this.retryAt = Date.now() + WEATHER_RETRY_MS;
        this.failed = here;
      }
    } finally {
      if (seq === this.seq) this.inflight = null;
    }
  }

  _set(w) {
    if (w === this.current) return;
    this.current = w;
    try { this.onChange(w); } catch { /* the UI must not break the source */ }
  }
}
