/**
 * Cues — loops bound to a place rather than to a theme.
 *
 * A theme describes how everywhere sounds. A cue describes how *somewhere*
 * sounds: extra layers that appear when you are near a particular kind of
 * place, or a particular one.
 *
 *   { name: 'Any gym',  when: { tag: 'gym' },                       layers: [...] }
 *   { name: 'My gym',   when: { near: { lat, lng, radius: 120 } },  layers: [...] }
 *   { name: 'Omega',    when: { place: 'Omega Music' }, theme: 'noir' }
 *
 * Cue layers are stacked on top of whatever theme is playing rather than
 * replacing it, and because pattern degrees are relative to the current chord
 * they stay in key and in tempo automatically. A riff written against one
 * theme works under all of them.
 *
 * A cue may also pin a theme, for when a place deserves its own genre.
 */

import { compileLayers, resolveLevels, stepLayers, validateSpec } from './spec.js';
import { matchStrength, validateCondition, describeCondition } from './match.js';
import { bearing, haversine } from '../geo.js';

/** How quickly a cue fades in and out as you approach. Seconds-ish. */
const CUE_SMOOTHING = 0.25;

/**
 * Taking over the theme is harder than keeping it.
 *
 * With one threshold, a cue whose strength hovers around it swaps the theme
 * back and forth every time you take a few steps — walking down a shopping
 * street flipped between two themes four times in 500 m. A gap between the
 * on and off points costs nothing and removes that entirely.
 */
const PIN_ON = 0.55;
const PIN_OFF = 0.32;

/**
 * Spatial cues (`spatial: true` with a `when.near`): how far a place dead to
 * one side pans, and the speed below which heading is noise. Standing still
 * — or right on top of the centre, where the bearing spins — holds the last
 * pan instead of chasing it.
 */
const SPATIAL_MAX_PAN = 0.7;
const SPATIAL_MIN_SPEED = 0.5;   // m/s
const SPATIAL_MIN_DIST = 3;      // metres

export function validateCue(cue, index = 0) {
  const errors = [];
  const where = `cue ${index}${cue?.name ? ` ("${cue.name}")` : ''}`;

  if (!cue || typeof cue !== 'object' || Array.isArray(cue)) {
    return [`${where}: must be an object.`];
  }
  if (!cue.name || typeof cue.name !== 'string') {
    errors.push(`${where}: missing "name".`);
  }
  errors.push(...validateCondition(cue.when, `${where}.when`));

  if (cue.layers !== undefined) {
    if (!Array.isArray(cue.layers)) {
      errors.push(`${where}: "layers" must be an array.`);
    } else if (cue.layers.length) {
      // Reuse the theme validator by wrapping the layers in a throwaway spec.
      const check = validateSpec({ id: 'cue', name: cue.name, layers: cue.layers });
      errors.push(...check.errors.map((e) => `${where}: ${e}`));
    }
  }
  if (cue.spatial !== undefined && typeof cue.spatial !== 'boolean') {
    errors.push(`${where}: "spatial" must be true or false.`);
  }
  if (cue.theme !== undefined && typeof cue.theme !== 'string') {
    errors.push(`${where}: "theme" must be a theme id.`);
  }
  if (!cue.layers?.length && !cue.theme) {
    errors.push(`${where}: does nothing — give it "layers", a "theme", or both.`);
  }

  return errors;
}

/**
 * Compile a list of cues. Invalid ones are dropped with a report rather than
 * throwing, so one bad cue in a shared pack cannot silence the app.
 */
export function compileCues(cues) {
  const compiled = [];
  const report = [];

  (cues || []).forEach((cue, i) => {
    const errors = validateCue(cue, i);
    if (errors.length) {
      report.push({ name: cue?.name ?? `cue ${i}`, ok: false, errors });
      return;
    }
    compiled.push({
      name: cue.name,
      when: cue.when,
      theme: cue.theme || null,
      layers: compileLayers(cue.layers || []),
      spec: cue,
      // Smoothed strength, so walking past a gym swells rather than switches.
      strength: 0,
      // Whether this cue currently holds the theme (see pinnedTheme).
      pinned: false,
      // Pan toward the place (see spatialPan). Only for `near` cues: nothing
      // else has one centre to point at.
      spatial: cue.spatial === true && !!cue.when?.near,
      pan: 0,
    });
    report.push({ name: cue.name, ok: true, description: describeCondition(cue.when) });
  });

  return { cues: compiled, report };
}

/**
 * Which cues apply right now, with their smoothed strengths updated.
 * Call once per replan.
 */
export function evaluateCues(cues, scene, { snap = false } = {}) {
  const active = [];
  for (const cue of cues) {
    const target = matchStrength(cue.when, scene);
    // Exponential approach: no cue ever appears or vanishes on one tick.
    //
    // `snap` skips that, for when you did not travel — jumping to a saved
    // place is a teleport, and easing over fifteen seconds there just looks
    // like nothing happened.
    cue.strength = snap ? target : cue.strength + (target - cue.strength) * CUE_SMOOTHING;
    if (cue.strength < PIN_OFF) cue.pinned = false;
    if (cue.strength > 0.02 || target > 0.02) active.push(cue);
  }
  return active;
}

/** The theme a cue wants, if any — strongest match wins. */
export function pinnedTheme(activeCues) {
  let best = null;
  for (const cue of activeCues) {
    if (!cue.theme) continue;

    // Latch: needs PIN_ON to take over, but only falls below PIN_OFF to let go.
    cue.pinned = cue.pinned
      ? cue.strength >= PIN_OFF
      : cue.strength >= PIN_ON;

    if (!cue.pinned) continue;
    if (!best || cue.strength > best.strength) best = cue;
  }
  return best ? { id: best.theme, cue: best.name } : null;
}

/**
 * Wrap a theme so its plan and step also carry the active cues' layers.
 *
 * The result satisfies the same `{ plan, step }` contract, so the engine —
 * which insists a plan and its step function travel together — is unaffected.
 */
export function withCues(theme, activeCues, position = null) {
  const withLayers = activeCues.filter((c) => c.layers.length);
  if (!withLayers.length) return theme;

  // Spatial pans are worked out once per replan, not per plan() call, and
  // held on the cue so standing still keeps the last one.
  for (const cue of withLayers) {
    if (cue.spatial) cue.pan = spatialPan(cue, position);
  }

  return {
    ...theme,
    id: theme.id,
    plan(mood, seed, scene) {
      const base = theme.plan(mood, seed, scene);
      const cueLevels = {};

      for (const cue of withLayers) {
        const levels = resolveLevels(cue.layers, mood, scene);
        for (const [key, value] of Object.entries(levels)) {
          // Namespaced so a cue layer called "bass" cannot collide with the
          // theme's own, and scaled by how present the cue is.
          cueLevels[`${cue.name}/${key}`] = value * cue.strength;
        }
      }

      // Make room. A cue riff arriving on top of a full arrangement pushes
      // the mix into the limiter, so pull the theme back a little while it
      // plays — which is what you would do on a desk anyway.
      const pressure = Math.min(1, withLayers.reduce((sum, c) => sum + c.strength, 0));
      const trim = (base.trim ?? 1) * (1 - 0.22 * pressure);

      return {
        ...base,
        trim,
        cueLevels,
        cueNames: withLayers.map((c) => c.name),
        // Continuous: the engine glides each spatial cue's own panner here
        // (engine.js _applyCuePans). A list rather than an object keyed by
        // name, because names come from packs.
        cuePans: withLayers.filter((c) => c.spatial).map((c) => ({ name: c.name, pan: c.pan })),
      };
    },
    step(io, plan, pos) {
      theme.step(io, plan, pos);

      for (const cue of withLayers) {
        const levels = {};
        for (const layer of cue.layers) {
          const key = layer.name || layer.voice;
          levels[key] = plan.cueLevels?.[`${cue.name}/${key}`] ?? 0;
        }
        // A spatial cue's voices play into its own panner instead of the dry
        // bus, so the whole loop moves together and glides between replans.
        // Sends stay central: the room is all around you either way.
        const out = cue.spatial ? io.cueOut?.(cue.name) : null;
        stepLayers(out ? { ...io, dry: out } : io, plan, pos, cue.layers, levels);
      }
    },
  };
}

/**
 * Pan for a spatial cue: sin(bearing to the place − heading) × 0.7, so a
 * place dead ahead or behind is centred and one abeam is 0.7 to that side.
 * Heading only means something while moving, so below 0.5 m/s (or within a
 * few metres of the centre) the last pan is held.
 */
export function spatialPan(cue, position) {
  const centre = cue.when?.near;
  if (!position || !centre) return cue.pan;
  const { lat, lng, speed, heading } = position;
  if (!(speed > SPATIAL_MIN_SPEED) || !Number.isFinite(heading)) return cue.pan;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return cue.pan;
  if (haversine(lat, lng, centre.lat, centre.lng) < SPATIAL_MIN_DIST) return cue.pan;
  const rel = (bearing(lat, lng, centre.lat, centre.lng) - heading) * Math.PI / 180;
  const pan = Math.sin(rel) * SPATIAL_MAX_PAN;
  return Math.max(-SPATIAL_MAX_PAN, Math.min(SPATIAL_MAX_PAN, pan));
}
