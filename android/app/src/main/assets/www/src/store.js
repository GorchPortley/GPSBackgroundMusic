/**
 * Local persistence and the shareable pack.
 *
 * Everything a person customises — tag edits, saved locations, chosen theme —
 * lives in one JSON object that survives a reload and can be exported as a
 * file. That file is the unit you hand to someone else.
 *
 * It is deliberately data, never code. A pack from a stranger can retune the
 * music but cannot run anything, which is the difference between a shareable
 * format and a security problem.
 */

const KEY = 'gps-background-music/pack/v1';
export const PACK_VERSION = 1;

const DIMS = ['e', 'b', 'd', 't', 'w', 's'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_THEMES = 40;
const MAX_THEME_BYTES = 64 * 1024;
const MAX_CUES = 100;
const MAX_POLYGON_VERTICES = 64;   // same limit validateCondition enforces
const MAX_CONDITION_DEPTH = 8;

export function emptyPack() {
  return { version: PACK_VERSION, tagOverrides: {}, locations: [],
    themes: [], cues: [], theme: null };
}

export function loadPack() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyPack();
    return sanitise(JSON.parse(raw));
  } catch {
    // Corrupt or unavailable storage should never stop the app booting.
    return emptyPack();
  }
}

export function savePack(pack) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitise(pack)));
    return true;
  } catch {
    return false;
  }
}

/**
 * First-run card (C4.4): a flag under the app's prefix, so clearStore()
 * ("Reset everything") brings the card back. Storage that throws (private
 * mode, blocked site data) reads as "not dismissed" — the card shows and the
 * app carries on.
 */
const FIRST_RUN_KEY = 'gps-background-music/first-run-dismissed';

export function firstRunDismissed() {
  try {
    return localStorage.getItem(FIRST_RUN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setFirstRunDismissed(dismissed) {
  try {
    if (dismissed) localStorage.setItem(FIRST_RUN_KEY, '1');
    else localStorage.removeItem(FIRST_RUN_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Forget everything this app has stored in localStorage: the pack and any
 * other key under the app's prefix (so a flag added later is covered too).
 * Other sites' or other apps' keys on the same origin are left alone.
 */
export function clearStore() {
  try {
    const prefix = KEY.slice(0, KEY.indexOf('/') + 1);
    const mine = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) mine.push(k);
    }
    for (const k of mine) localStorage.removeItem(k);
    return mine.length;
  } catch {
    return 0;
  }
}

/**
 * Validate anything that came from a file or from storage. Packs are shared,
 * so treat every field as untrusted: wrong types, out-of-range numbers and
 * unexpected keys are dropped rather than trusted.
 */
export function sanitise(input) {
  const pack = emptyPack();
  if (!input || typeof input !== 'object') return pack;

  if (input.tagOverrides && typeof input.tagOverrides === 'object') {
    for (const [type, profile] of Object.entries(input.tagOverrides)) {
      if (typeof type !== 'string' || type.length > 64) continue;
      // Assigning these by name reassigns an object's prototype instead of
      // storing a key. Harmless here, but not a trap worth leaving in code
      // that parses files from other people.
      if (UNSAFE_KEYS.has(type)) continue;
      if (!profile || typeof profile !== 'object') continue;

      const clean = {};
      for (const dim of DIMS) {
        const v = Number(profile[dim]);
        if (Number.isFinite(v)) clean[dim] = Math.min(1, Math.max(0, v));
      }
      if (Object.keys(clean).length) pack.tagOverrides[type] = clean;
    }
  }

  if (Array.isArray(input.locations)) {
    for (const loc of input.locations.slice(0, 200)) {
      if (!loc || typeof loc !== 'object') continue;
      const lat = Number(loc.lat);
      const lng = Number(loc.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      pack.locations.push({
        name: String(loc.name ?? 'Unnamed').slice(0, 80),
        lat,
        lng,
      });
    }
  }

  if (typeof input.theme === 'string' && input.theme.length <= 32) {
    pack.theme = input.theme;
  }

  // A label for a shared pack (P4), shown in the import confirm. Display
  // text only — always rendered through textContent — and never merged into
  // the stored pack by applyPack.
  if (typeof input.name === 'string') {
    const name = input.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
    if (name) pack.name = name;
  }

  // Theme specs are only structurally checked here — size and shape. Their
  // real validation is validateSpec() at registration time, which knows what
  // a voice and a pattern are and reports what is wrong with each.
  if (Array.isArray(input.themes)) {
    for (let spec of input.themes.slice(0, MAX_THEMES)) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
      spec = stripUnsafe(spec, 0);
      if (typeof spec.id !== 'string' || !spec.id || spec.id.length > 48) continue;
      if (typeof spec.name !== 'string' || !spec.name) continue;
      // Refuse anything absurd rather than letting it into localStorage.
      let size = 0;
      try { size = JSON.stringify(spec).length; } catch { continue; }
      if (size > MAX_THEME_BYTES) continue;
      pack.themes.push(spec);
    }
  }

  // Cues get the same treatment as themes: structural limits here, real
  // validation in compileCues() which knows what a condition and a loop are.
  //
  // `_ui: true` marks a cue made in the in-app editor, which is what lets the
  // editor offer to change it. Allowed only as exactly `true`; anything else
  // under that key is dropped. `spatial` likewise survives only as a boolean.
  if (Array.isArray(input.cues)) {
    for (let cue of input.cues.slice(0, MAX_CUES)) {
      if (!cue || typeof cue !== 'object' || Array.isArray(cue)) continue;
      cue = stripUnsafe(cue, 0);
      if (typeof cue.name !== 'string' || !cue.name || cue.name.length > 80) continue;
      if ('_ui' in cue && cue._ui !== true) {
        const { _ui, ...rest } = cue;
        cue = rest;
      }
      // `spatial` (pan toward a `near` cue's place) is a plain boolean or gone.
      if ('spatial' in cue && typeof cue.spatial !== 'boolean') {
        const { spatial, ...rest } = cue;
        cue = rest;
      }
      if (cue.when && typeof cue.when === 'object') {
        cue = { ...cue, when: cleanCondition(cue.when, 0) };
      }
      let size = 0;
      try { size = JSON.stringify(cue).length; } catch { continue; }
      if (size > MAX_THEME_BYTES) continue;
      pack.cues.push(cue);
    }
  }

  return pack;
}

/**
 * Walk a cue condition (through `any` lists) and tidy every `inside` polygon.
 * Only `inside` is rewritten; every other key passes through for
 * validateCondition to judge.
 *
 * - The vertex list is cut to one more than the limit, so a huge polygon
 *   cannot bloat storage but validateCondition still sees that it was too big
 *   and reports it (rather than a silent truncation reshaping the fence).
 * - Each vertex that parses as two finite numbers is clamped to lat ±90,
 *   lng ±180; anything else becomes `null`, which validation rejects by index.
 * - `edge` is clamped to 1..5000 m, or dropped (default 60 m) if not numeric.
 */
function cleanCondition(cond, depth) {
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return cond;
  const out = { ...cond };
  if (Array.isArray(cond.any)) {
    out.any = depth >= MAX_CONDITION_DEPTH ? [] : cond.any.map((c) => cleanCondition(c, depth + 1));
  }
  if ('inside' in cond) {
    const src = cond.inside;
    if (!src || typeof src !== 'object' || Array.isArray(src) || !Array.isArray(src.polygon)) {
      out.inside = {};
    } else {
      const clean = {
        polygon: src.polygon.slice(0, MAX_POLYGON_VERTICES + 1).map((p) => {
          if (!Array.isArray(p) || p.length !== 2) return null;
          const lat = toNumber(p[0]);
          const lng = toNumber(p[1]);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          return [Math.min(90, Math.max(-90, lat)), Math.min(180, Math.max(-180, lng))];
        }),
      };
      const edge = toNumber(src.edge);
      if (Number.isFinite(edge)) clean.edge = Math.min(5000, Math.max(1, edge));
      out.inside = clean;
    }
  }
  return out;
}

/**
 * A copy of a theme or cue with every `__proto__` / `constructor` /
 * `prototype` key removed, at any depth. JSON.parse makes `"__proto__"` an
 * ordinary own key, harmless until something copies it with Object.assign or
 * a `[k] =` loop and it becomes a prototype. Themes and cues are otherwise
 * passed through structurally, so they are cleaned here once, before storage.
 * Past MAX_NEST levels (no real spec comes close) the branch is emptied.
 */
const MAX_NEST = 32;
function stripUnsafe(value, depth) {
  if (Array.isArray(value)) {
    return depth >= MAX_NEST ? [] : value.map((v) => stripUnsafe(v, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  if (depth >= MAX_NEST) return out;
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = stripUnsafe(v, depth + 1);
  }
  return out;
}

/** A number, or a non-blank numeric string; anything else is NaN. */
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim()) return Number(v);
  return NaN;
}

/** Hand the browser a .json file to save. */
export function downloadPack(pack, filename = 'gps-music-pack.json') {
  const blob = new Blob([JSON.stringify(sanitise(pack), null, 2)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readPackFile(file) {
  const text = await file.text();
  return sanitise(JSON.parse(text));
}
