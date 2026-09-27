/**
 * Position source.
 *
 * Two modes behind one callback:
 *   live    — navigator.geolocation.watchPosition
 *   sim     — walks a closed loop around an origin, so the whole pipeline can
 *             be exercised at a desk (and so a demo does not depend on the
 *             weather, a GPS lock, or actually going outside)
 *   explore — stands still at a chosen point. This is how you audition a place
 *             you are not at, which is the only practical way to tune the tag
 *             profiles: you need to hear a nightclub and a churchyard within a
 *             few seconds of each other.
 *
 * Emits { lat, lng, accuracy, speed (m/s), heading (deg), source, mode }.
 *
 * `mode` is 'fine' or 'coarse' for live and sim (null for explore). After
 * STATIONARY_MS standing still, live GPS is re-watched with low-accuracy
 * options to save battery; any real movement switches straight back. The
 * watch is swapped, never stopped: a cue crossing must still be seen. The
 * simulator runs the very same detector, so its readout shows the mode too.
 */

export const EARTH_RADIUS_M = 6371000;

export function haversine(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** Offset a coordinate by metres east/north. */
export function offsetMeters(lat, lng, east, north) {
  const mPerDegLat = 111320;
  const mPerDegLng = Math.max(1, 111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + north / mPerDegLat, lng: lng + east / mPerDegLng };
}

export const SIM_SPEEDS = [
  { id: 'still', label: 'Still', mps: 0 },
  { id: 'walk', label: 'Walk', mps: 1.4 },
  { id: 'run', label: 'Run', mps: 3.5 },
  { id: 'bike', label: 'Bike', mps: 6.5 },
  { id: 'drive', label: 'Drive', mps: 13 },
  { id: 'warp', label: 'Warp', mps: 45 },
];

/** Somewhere reliably dense, so the Google path has something to say too. */
export const DEFAULT_ORIGIN = { lat: 51.5072, lng: -0.1276 };

const SIM_TICK_MS = 1000;
/** Loop wide enough to cross several ~600 m mock districts. */
const SIM_LOOP_RADIUS_M = 1400;
const SIM_WAYPOINTS = 9;

/** Standing still this long drops live GPS to coarse. */
export const STATIONARY_MS = 120000;
/** Below this speed (m/s) counts as standing still. */
const STATIONARY_SPEED = 0.5;
/** Moving further than this from where you stopped switches back to fine. */
const MOVE_M = 25;
const FINE_OPTIONS = { enableHighAccuracy: true, maximumAge: 4000, timeout: 25000 };
const COARSE_OPTIONS = { enableHighAccuracy: false, maximumAge: 15000, timeout: 30000 };

export class GeoTracker {
  /**
   * @param {{onUpdate: Function, onError?: Function, onStatus?: Function}} handlers
   */
  constructor({ onUpdate, onError = () => {}, onStatus = () => {} } = {}) {
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.onStatus = onStatus;

    this.mode = 'sim';
    this.running = false;

    this._watchId = null;
    this._simTimer = null;
    this._simDistance = 0;
    this._simSpeed = SIM_SPEEDS.find((s) => s.id === 'walk').mps;
    this._route = buildLoop(DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lng);
    this._pin = { ...DEFAULT_ORIGIN, name: 'London' };

    this._last = null;

    /** 'fine' | 'coarse' — see _track. */
    this.gpsMode = 'fine';
    this._still = null;          // { lat, lng, since } where standing still began
    /** Overridable in a test harness; the shipped value is STATIONARY_MS. */
    this.stationaryMs = STATIONARY_MS;
  }

  get simSpeed() {
    return this._simSpeed;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const wasRunning = this.running;
    this.stop();
    this.mode = mode;
    if (wasRunning) this.start();
  }

  setSimSpeed(mps) {
    this._simSpeed = Math.max(0, Number(mps) || 0);
  }

  /** Re-centre the simulated loop (also used when live gives us a first fix). */
  setOrigin(lat, lng) {
    this._route = buildLoop(lat, lng);
    this._simDistance = 0;
  }

  get pin() {
    return { ...this._pin };
  }

  /**
   * Stand at a specific point. Also re-centres the simulated loop, so
   * switching from Explore to Simulate walks around wherever you were looking.
   */
  setPin(lat, lng, name = null) {
    this._pin = { lat, lng, name };
    this.setOrigin(lat, lng);
    if (this.running && this.mode === 'explore') {
      // Emit immediately rather than waiting for the next tick.
      this._emitPin();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._resetMotion();
    if (this.mode === 'live') this._startLive();
    else if (this.mode === 'explore') this._startExplore();
    else this._startSim();
  }

  stop() {
    this.running = false;
    if (this._watchId !== null) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
    if (this._simTimer !== null) {
      clearInterval(this._simTimer);
      this._simTimer = null;
    }
  }

  /* ------------------------------------------------------------------ live */

  _startLive() {
    if (!('geolocation' in navigator)) {
      this.onError(new Error('This browser has no Geolocation API.'));
      return;
    }
    if (!window.isSecureContext) {
      this.onError(new Error(
        'Geolocation needs a secure context. Use http://localhost, or serve over HTTPS to use a phone.'));
      return;
    }

    this.onStatus('Waiting for a GPS fix…');
    this._watch(FINE_OPTIONS);
  }

  /**
   * (Re-)register the live watch. The new watch is registered before the old
   * one is cleared, so there is never a moment with no watch while running.
   */
  _watch(options) {
    const old = this._watchId;
    this._watchId = navigator.geolocation.watchPosition(
      (pos) => this._handleLive(pos),
      (err) => this.onError(new Error(geoErrorMessage(err))),
      options,
    );
    if (old !== null) navigator.geolocation.clearWatch(old);
  }

  /* ------------------------------------------------------ fine / coarse */

  _resetMotion() {
    this.gpsMode = 'fine';
    this._still = null;
  }

  /**
   * Stationary detector shared by live and sim. `speed` is the source's own
   * speed when it reports one (sim always does); `nativeSpeed` says so.
   * Returns the mode to emit, switching the live watch when it changes.
   */
  _track(lat, lng, accuracy, speed, nativeSpeed, now) {
    const s = this._still;
    const dist = s ? haversine(s.lat, s.lng, lat, lng) : Infinity;

    if (this.gpsMode === 'coarse') {
      // Any movement: more than MOVE_M from where we stopped, or a speed the
      // source measured itself (a derived speed from coarse fixes is jitter).
      if (dist > MOVE_M || (nativeSpeed && speed >= STATIONARY_SPEED)) {
        this._still = { lat, lng, since: now };
        this._setGpsMode('fine');
      }
      return this.gpsMode;
    }

    // Without a measured speed, a fix-to-fix derived speed is mostly GPS
    // jitter (2 m in 1 s reads as walking pace). Staying within `accuracy` of
    // one spot for the whole period already bounds the speed far below
    // STATIONARY_SPEED, so the distance test alone decides.
    const v = nativeSpeed ? speed : 0;
    const tolerance = accuracy == null ? MOVE_M : Math.max(1, accuracy);
    if (!s || v >= STATIONARY_SPEED || dist > tolerance) {
      this._still = { lat, lng, since: now };
    } else if (now - s.since >= this.stationaryMs) {
      this._setGpsMode('coarse');
    }
    return this.gpsMode;
  }

  _setGpsMode(mode) {
    if (mode === this.gpsMode) return;
    this.gpsMode = mode;
    if (this.mode === 'live' && this.running && this._watchId !== null) {
      this._watch(mode === 'coarse' ? COARSE_OPTIONS : FINE_OPTIONS);
    }
  }

  _handleLive(pos) {
    const { latitude: lat, longitude: lng, accuracy, speed, heading } = pos.coords;
    const now = pos.timestamp || Date.now();

    // Browsers often report speed/heading as null on desktop; derive them.
    let derivedSpeed = speed;
    let derivedHeading = heading;
    if (this._last) {
      const dt = Math.max(0.5, (now - this._last.t) / 1000);
      const dist = haversine(this._last.lat, this._last.lng, lat, lng);
      if (derivedSpeed === null || derivedSpeed === undefined || Number.isNaN(derivedSpeed)) {
        derivedSpeed = dist / dt;
      }
      if ((derivedHeading === null || Number.isNaN(derivedHeading)) && dist > 2) {
        derivedHeading = bearing(this._last.lat, this._last.lng, lat, lng);
      }
    }

    this._last = { lat, lng, t: now };
    const nativeSpeed = speed !== null && speed !== undefined && !Number.isNaN(speed);
    const mode = this._track(lat, lng, accuracy ?? null, Math.max(0, derivedSpeed || 0),
      nativeSpeed, now);
    this.onStatus('');
    this.onUpdate({
      lat,
      lng,
      accuracy: accuracy ?? null,
      speed: Math.max(0, derivedSpeed || 0),
      heading: derivedHeading ?? 0,
      source: 'live',
      mode,
    });
  }

  /* --------------------------------------------------------------- explore */

  _emitPin() {
    this.onUpdate({
      lat: this._pin.lat,
      lng: this._pin.lng,
      accuracy: null,
      speed: 0,
      heading: 0,
      source: 'explore',
      mode: null,
      label: this._pin.name,
    });
  }

  _startExplore() {
    this.onStatus('');
    this._emitPin();
    // A slow heartbeat keeps the fetch-staleness logic ticking over without
    // pretending to move.
    this._simTimer = setInterval(() => this._emitPin(), 10000);
  }

  /* ------------------------------------------------------------------- sim */

  _startSim() {
    this.onStatus('');
    const tick = () => {
      this._simDistance += this._simSpeed * (SIM_TICK_MS / 1000);
      const { lat, lng, heading } = pointOnLoop(this._route, this._simDistance);
      const mode = this._track(lat, lng, 5, this._simSpeed, true, Date.now());
      this.onUpdate({
        lat,
        lng,
        accuracy: 5,
        speed: this._simSpeed,
        heading,
        source: 'sim',
        mode,
      });
    };
    tick();
    this._simTimer = setInterval(tick, SIM_TICK_MS);
  }
}

/* ------------------------------------------------------------ sim geometry */

/** A wobbly closed loop, so the simulated walk is not a perfect circle. */
function buildLoop(lat, lng) {
  const points = [];
  for (let i = 0; i < SIM_WAYPOINTS; i++) {
    const angle = (i / SIM_WAYPOINTS) * Math.PI * 2;
    // Deterministic wobble keyed to the vertex index.
    const wobble = 0.65 + 0.35 * (0.5 + 0.5 * Math.sin(i * 2.399));
    const r = SIM_LOOP_RADIUS_M * wobble;
    points.push(offsetMeters(lat, lng, Math.cos(angle) * r, Math.sin(angle) * r));
  }
  points.push(points[0]); // close the loop

  const legs = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = haversine(a.lat, a.lng, b.lat, b.lng);
    legs.push({ a, b, len, start: total, heading: bearing(a.lat, a.lng, b.lat, b.lng) });
    total += len;
  }
  return { legs, total };
}

function pointOnLoop(route, distance) {
  const d = ((distance % route.total) + route.total) % route.total;
  const leg = route.legs.find((l) => d < l.start + l.len) ?? route.legs[route.legs.length - 1];
  const f = leg.len > 0 ? (d - leg.start) / leg.len : 0;
  return {
    lat: leg.a.lat + (leg.b.lat - leg.a.lat) * f,
    lng: leg.a.lng + (leg.b.lng - leg.a.lng) * f,
    heading: leg.heading,
  };
}

function geoErrorMessage(err) {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'Location permission denied. Allow it in the browser, or use Simulate.';
    case err.POSITION_UNAVAILABLE:
      return 'Position unavailable — no GPS or network fix right now.';
    case err.TIMEOUT:
      return 'Timed out waiting for a fix. Still trying…';
    default:
      return err.message || 'Geolocation failed.';
  }
}
