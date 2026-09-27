/**
 * Sample bank (P5): fetches and decodes a bundled instrument's files the
 * first time a playing plan asks for one, once per AudioContext, and keeps
 * the decoded buffers for the life of that context.
 *
 * Nothing loads at startup. `sampleVoice` (voices.js) calls `instrument()`
 * for every note; the first call starts the load and returns null, so that
 * note — and every note until all the instrument's zones are decoded — is
 * played by the fallback synth instead. A failed load (offline PWA without a
 * cached copy, a missing file, a WebView that cannot decode Ogg) marks the
 * instrument failed for that context and the fallback simply carries on.
 *
 * URLs come only from the manifest (samples/instruments.js), never from a
 * pack: an unknown id is refused here too.
 */

import { INSTRUMENTS, isInstrument, sampleUrl } from '../../samples/instruments.js';

/** ctx → Map(id → { state: 'loading' | 'ready' | 'failed', zones, promise }). */
const banks = new WeakMap();

/** Counters for leak and fallback checks (like voices.js `ksStats`). */
export const sampleStats = {
  loads: 0, ready: 0, failed: 0,  // instrument loads started / finished / failed
  created: 0, ended: 0,           // sampled notes started / finished and disconnected
  fallback: 0,                    // notes played by the fallback synth instead
};

function bankFor(ctx) {
  let bank = banks.get(ctx);
  if (!bank) { bank = new Map(); banks.set(ctx, bank); }
  return bank;
}

/** Promise-based decode that also works where only the callback form exists. */
function decode(ctx, data) {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

/**
 * Start (or join) the load of `id` on `ctx`. Resolves to the entry either
 * way; check `entry.state`. Safe to call any number of times.
 */
export function loadInstrument(ctx, id) {
  if (!ctx || !isInstrument(id)) return Promise.resolve({ state: 'failed', zones: [] });
  const bank = bankFor(ctx);
  const have = bank.get(id);
  if (have) return have.promise;

  const entry = { state: 'loading', zones: [], promise: null };
  bank.set(id, entry);
  sampleStats.loads++;
  entry.promise = Promise.all(INSTRUMENTS[id].zones.map(async ([midi, cents]) => {
    const res = await fetch(sampleUrl(id, midi));
    if (!res.ok) throw new Error(`${res.status} for ${id} ${midi}`);
    const buffer = await decode(ctx, await res.arrayBuffer());
    return { midi, cents, buffer };
  })).then((zones) => {
    entry.zones = zones.sort((a, b) => a.midi - b.midi);
    entry.state = 'ready';
    sampleStats.ready++;
    return entry;
  }, (e) => {
    entry.state = 'failed';
    sampleStats.failed++;
    console.warn(`Sampled "${id}" unavailable; its synth fallback keeps playing.`, e);
    return entry;
  });
  return entry.promise;
}

/**
 * The decoded instrument if it is ready on this context, else null — and on
 * the first ask, the load starts in the background.
 */
export function instrument(ctx, id) {
  if (!ctx || !isInstrument(id)) return null;
  const entry = banks.get(ctx)?.get(id);
  if (!entry) { loadInstrument(ctx, id); return null; }
  return entry.state === 'ready' ? entry : null;
}

/** 'none' (never asked) | 'loading' | 'ready' | 'failed' — for the UI and checks. */
export function instrumentState(ctx, id) {
  return (ctx && banks.get(ctx)?.get(id)?.state) || 'none';
}

/** The zone nearest to `note` (ties go to the lower zone, which shifts up). */
export function nearestZone(zones, note) {
  let best = null;
  for (const z of zones) {
    if (!best || Math.abs(note - z.midi) < Math.abs(note - best.midi)) best = z;
  }
  return best;
}
