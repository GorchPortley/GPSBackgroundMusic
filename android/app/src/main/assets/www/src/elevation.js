/**
 * Hills (P3) — climbing adds tension. Off by default.
 *
 * What matters is *climbing*, not absolute height: a flat walk along a
 * clifftop is not tense, a steep street in a low town is. So this keeps a
 * short, smoothed elevation history and reports the grade you have been
 * walking — the gain over the last TERRAIN_WINDOW_M of travel (or the last
 * TERRAIN_WINDOW_MS, whichever is shorter). The amounts it moves the mood
 * live in scene.js `contextualise`; this module only measures.
 *
 * Where the height comes from, in order of preference:
 *   1. GPS `coords.altitude`, when the fix has one with an altitudeAccuracy of
 *      GPS_ALT_MAX_ACC m or better (or none stated). No network at all. It is
 *      often null (desktop, network fixes) and noisy (±5–20 m), so it is
 *      smoothed and the grade has a dead zone.
 *   2. Open-Meteo's keyless elevation API (90 m DEM). Only 2-dp grid points
 *      are ever sent: the four corners of the 0.01° cell you are in (the same
 *      ~1.1 km of precision as rounding), batched in one request, and each
 *      corner is cached in memory for the session — terrain does not move, so
 *      a cell is asked about once. Height between the corners is bilinear, so
 *      it changes smoothly as you walk instead of in 1 km steps; hills smaller
 *      than a cell are flattened, which is the price of the privacy.
 * GPS altitude is ellipsoidal and the DEM is above sea level — tens of metres
 * apart — so a change of source starts the history afresh rather than reading
 * the offset as a cliff.
 *
 * Rules it keeps (like weather.js):
 *   - Guarded (HANDOFF §3.14): every request takes a sequence number, and a
 *     response that has been overtaken (you moved to another cell, or the
 *     toggle went off) is discarded — not used, not cached.
 *   - Fails silently: offline or malformed → no sample, no status line, no
 *     thrown error; that cell is retried after ELEV_RETRY_MS.
 *   - Never awaited by the caller: `update()` fires and forgets.
 */

import { haversine } from './geo.js';

export const ELEVATION_ENDPOINT = 'https://api.open-meteo.com/v1/elevation';

/** GPS altitude is trusted only this accurate (m), when accuracy is stated. */
export const GPS_ALT_MAX_ACC = 30;
/** The grade is measured over at most this much travel … */
export const TERRAIN_WINDOW_M = 250;
/** … and at most this long, so standing at the top lets the tension go. */
export const TERRAIN_WINDOW_MS = 5 * 60 * 1000;
/** Grade denominator floor (m): a few metres of GPS noise over a short run is not a cliff. */
export const GRADE_MIN_RUN_M = 150;
/** A new sample after moving this far … */
const SAMPLE_MIN_M = 10;
/** … or after this long (so a still window ages out). */
const SAMPLE_MIN_MS = 15 * 1000;
/** A step longer than this between samples is a jump (a saved place, a new pin), not a walk. */
const JUMP_M = 500;
/** GPS altitude missing this long (ms) → fall back to the DEM (history restarts). */
const GPS_HOLD_MS = 30 * 1000;
/** EMA weight per sample for GPS altitude; the DEM is already smooth. */
const GPS_ALPHA = 0.3;
/** After a failed lookup, wait this long before asking for that cell again. */
export const ELEV_RETRY_MS = 60 * 1000;
const ELEV_TIMEOUT_MS = 8000;
/** In-memory corner cache cap (~a 30 km × 30 km area). */
const CACHE_MAX = 4000;

/*
 * Grade → 0..1. Street grades: under 2 % reads as flat (and absorbs smoothed
 * GPS noise, ~3 m over 150 m); 5 % is a noticeable hill; 8 % is a steep
 * street you feel in your legs — "fully climbing". Linear between.
 */
const GRADE_FLAT = 0.02;
const GRADE_FULL = 0.08;
/** Height above where the history started at which "high up" is full (m). */
const HIGH_FULL_M = 150;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Integer index of the 0.01° grid line at or below `v`. */
const gridIndex = (v) => Math.floor(Math.round(v * 1e6) / 1e4);
const gridKey = (i, j) => `${i},${j}`;
const gridCoord = (i) => (i / 100).toFixed(2);

/** The four 2-dp grid points around a position, and where it sits between them. */
export function cellCorners(lat, lng) {
  const i = gridIndex(lat);
  const j = gridIndex(lng);
  return {
    cell: gridKey(i, j),
    fx: clamp01(lat * 100 - i),
    fy: clamp01(lng * 100 - j),
    corners: [[i, j], [i, j + 1], [i + 1, j], [i + 1, j + 1]],
  };
}

/** Request URL for a list of [i, j] grid points. Every coordinate is 2 dp. */
export function elevationUrl(points) {
  const lat = points.map(([i]) => gridCoord(i)).join(',');
  const lng = points.map(([, j]) => gridCoord(j)).join(',');
  return `${ELEVATION_ENDPOINT}?latitude=${lat}&longitude=${lng}`;
}

/** `{ elevation: [m, …] }` → array of metres, or null if unusable. */
export function parseElevation(body, n) {
  const arr = body && typeof body === 'object' ? body.elevation : null;
  if (!Array.isArray(arr) || arr.length !== n) return null;
  if (!arr.every((m) => finite(m) && m > -500 && m < 9000)) return null;
  return arr.slice();
}

/** Plain GET with a timeout. Resolves to metres per point; throws on any failure. */
export async function fetchElevation(points) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ELEV_TIMEOUT_MS);
  try {
    const res = await fetch(elevationUrl(points), {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`elevation ${res.status}`);
    const m = parseElevation(await res.json(), points.length);
    if (!m) throw new Error('elevation: unusable response');
    return m;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The terrain reading as the 0..1 factors the mood reads:
 *   climb01   grade from +2 % (0) to +8 % (1)
 *   descent01 the same for going down
 *   high01    height above where the history started, ÷ 150 m
 * No reading (off, not known yet, flat) → all zero: no effect.
 */
export function terrainFactors(t) {
  if (!t || !finite(t.grade)) return { climb01: 0, descent01: 0, high01: 0 };
  const span = GRADE_FULL - GRADE_FLAT;
  return {
    climb01: clamp01((t.grade - GRADE_FLAT) / span),
    descent01: clamp01((-t.grade - GRADE_FLAT) / span),
    high01: clamp01((Number(t.aboveM) || 0) / HIGH_FULL_M),
  };
}

/**
 * A glyph for the band badge (only when climbing or descending) and a line
 * for its tooltip. Text-style arrows (U+FE0E) so Android keeps them monochrome.
 */
export function describeTerrain(t) {
  if (!t) return null;
  const f = terrainFactors(t);
  const glyph = f.climb01 >= 0.25 ? '↗︎' : f.descent01 >= 0.25 ? '↘︎' : '';
  const pct = Math.round(t.grade * 100);
  const word = f.climb01 > 0 ? 'Climbing' : f.descent01 > 0 ? 'Descending' : 'Level';
  const text = `${word} ${pct > 0 ? '+' : ''}${pct}% · ${Math.round(t.aboveM)} m above start`
    + (t.source === 'gps' ? ' (GPS)' : '');
  return { glyph, text };
}

/**
 * The app's one terrain source. `update(pos)` on every fix; `terrain()` on
 * every replan → `{ grade, aboveM, gainM, runM, source }` or null.
 */
export class ElevationSource {
  constructor() {
    this.cache = new Map();   // "i,j" → metres, grid corners only
    this.seq = 0;
    this.inflight = null;     // { seq, cell }
    this.failed = null;       // { cell, until }
    this.samples = [];        // { t, d, elev, lat, lng }
    this.source = null;       // 'gps' | 'dem' of the samples in hand
    this.start = null;        // smoothed metres at the first sample
    this.lastPos = null;
    this.requests = 0;        // debug: requests sent this session
    this.discarded = 0;       // debug: overtaken responses dropped
    this.urls = [];           // debug: the last few URLs sent
  }

  /** One position fix. Cheap; never awaits; never throws. */
  update(pos, now = Date.now()) {
    try {
      this._update(pos, now);
    } catch { /* terrain must never break the position path */ }
  }

  _update(pos, now) {
    if (!pos || !finite(pos.lat) || !finite(pos.lng)) return;
    this.lastPos = pos;
    const last = this.samples[this.samples.length - 1];

    // Coarse GPS (C2.3) means standing still: its jitter is not travel. Hold
    // the last height and let time age the window out.
    if (pos.mode === 'coarse') {
      if (last && now - last.t >= SAMPLE_MIN_MS) {
        this._push({ ...last, t: now }, now);
      }
      return;
    }

    const acc = pos.altitudeAccuracy;
    const gpsOk = finite(pos.altitude) && (!finite(acc) || acc <= GPS_ALT_MAX_ACC);
    let raw;
    let source;
    if (gpsOk) {
      raw = pos.altitude;
      source = 'gps';
    } else if (this.source === 'gps' && last && now - last.t < GPS_HOLD_MS) {
      return;   // one fix without altitude is not a reason to change source
    } else {
      raw = this._demAt(pos.lat, pos.lng, now);
      source = 'dem';
      if (raw === null) return;   // asked; the next fix after it lands samples
    }

    const step = last ? haversine(last.lat, last.lng, pos.lat, pos.lng) : 0;
    if (last && (source !== this.source || step > JUMP_M)) {
      this._reset();
      return this._update(pos, now);
    }
    if (last && step < SAMPLE_MIN_M && now - last.t < SAMPLE_MIN_MS) return;

    const alpha = source === 'gps' ? GPS_ALPHA : 1;
    const elev = last ? last.elev + (raw - last.elev) * alpha : raw;
    this.source = source;
    if (this.start === null) this.start = elev;
    this._push({ t: now, d: (last?.d ?? 0) + step, elev, lat: pos.lat, lng: pos.lng }, now);
  }

  _push(sample, now) {
    this.samples.push(sample);
    // Keep the last TERRAIN_WINDOW_M of travel, and nothing older than
    // TERRAIN_WINDOW_MS — but always the newest two, so there is a slope.
    const s = this.samples;
    const d = sample.d;
    while (s.length > 2 && (d - s[1].d >= TERRAIN_WINDOW_M || now - s[0].t > TERRAIN_WINDOW_MS)) s.shift();
  }

  /** The reading in use, or null until there are two samples. */
  terrain(now = Date.now()) {
    const s = this.samples;
    if (s.length < 2) return null;
    // Time window again here: a still phone gets no new fixes to prune on.
    let k = 0;
    while (k < s.length - 2 && now - s[k].t > TERRAIN_WINDOW_MS) k++;
    const first = s[k];
    const last = s[s.length - 1];
    const runM = last.d - first.d;
    const gainM = last.elev - first.elev;
    const stale = now - last.t > TERRAIN_WINDOW_MS;
    return {
      grade: stale ? 0 : gainM / Math.max(runM, GRADE_MIN_RUN_M),
      gainM,
      runM,
      aboveM: last.elev - this.start,
      source: this.source,
    };
  }

  /** Toggle off: forget everything measured and discard anything in flight. The corner cache stays (terrain is terrain). */
  disable() {
    this.seq++;
    this.inflight = null;
    this.failed = null;
    this.lastPos = null;
    this._reset();
  }

  _reset() {
    this.samples = [];
    this.source = null;
    this.start = null;
  }

  /** Bilinear height from cached corners, or null (and a lookup started). */
  _demAt(lat, lng, now) {
    const { cell, fx, fy, corners } = cellCorners(lat, lng);
    const h = corners.map(([i, j]) => this.cache.get(gridKey(i, j)));
    if (h.every(finite)) {
      const [h00, h01, h10, h11] = h;
      return (h00 * (1 - fy) + h01 * fy) * (1 - fx) + (h10 * (1 - fy) + h11 * fy) * fx;
    }
    if (this.inflight?.cell === cell) return null;               // on its way
    if (this.failed?.cell === cell && now < this.failed.until) return null;  // backing off
    const missing = corners.filter(([i, j]) => !this.cache.has(gridKey(i, j)));
    this._fetch(cell, missing, now);
    return null;
  }

  async _fetch(cell, points, now) {
    const seq = ++this.seq;
    this.inflight = { seq, cell };
    this.requests++;
    this.urls.push(elevationUrl(points));
    if (this.urls.length > 20) this.urls.shift();
    try {
      const metres = await fetchElevation(points);
      if (seq !== this.seq) { this.discarded++; return; }   // overtaken (or turned off)
      points.forEach(([i, j], n) => this.cache.set(gridKey(i, j), metres[n]));
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
      this.failed = null;
      this.inflight = null;
      // Sample where we are now, rather than waiting for the next fix.
      if (this.lastPos) this.update(this.lastPos);
    } catch {
      // Silent by design: offline is a normal state for a phone on a walk.
      if (seq === this.seq) this.failed = { cell, until: now + ELEV_RETRY_MS };
    } finally {
      if (seq === this.seq && this.inflight?.seq === seq) this.inflight = null;
    }
  }
}
