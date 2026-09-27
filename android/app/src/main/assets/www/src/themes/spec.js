/**
 * Declarative themes.
 *
 * A code theme (wanderer.js and friends) is a pair of JavaScript functions. A
 * *spec* theme is a plain object: modes, chord sequences, and a list of layers
 * each with a loop written in mini-notation. This module turns one into the
 * same `{ plan, step }` contract the engine already speaks, so a spec theme is
 * a first-class citizen — the engine cannot tell the difference.
 *
 * Two things this buys:
 *
 *   1. You can write a theme with defined melodies and drum patterns, rather
 *      than describing generative rules.
 *   2. A spec is data, so it can be exported, shared and imported safely. No
 *      part of a spec is ever evaluated as code.
 *
 * A number in a spec is either a constant, or `[min, max, dimension]` which
 * interpolates across a mood dimension — `[96, 138, 'e']` means "96 bpm when
 * nothing is happening, 138 when everything is".
 *
 * See THEMES.md for the full reference.
 */

import {
  chordNotes, mulberry32, noteName, pickMode, pickProgression, scaleNote,
} from '../audio/theory.js';
import {
  bassVoice, bellVoice, blipVoice, brush, clank, fluteVoice, fmVoice, hat, kick,
  ksVoice, padVoice, pizzVoice, pluckVoice, pulseVoice, rim, shaker, stringVoice,
  sweepVoice,
} from '../audio/voices.js';
import { parsePattern, queryPattern, readValue } from './pattern.js';
import { matchStrength, validateCondition } from './match.js';
import { gate, quantise, rnd } from './util.js';

const STEPS_PER_BAR = 16;

/* ----------------------------------------------------------------- voices */

/**
 * How each voice name in a spec maps onto the synth library.
 *
 * `pitched` voices receive a note; `chordal` ones receive the whole chord;
 * `unpitched` ones ignore pitch entirely (percussion).
 */
export const VOICES = {
  pad: { kind: 'chordal', gain: 0.08, play: (io, o) => padVoice(io, o) },
  strings: { kind: 'chordal', gain: 0.08, play: (io, o) => stringVoice(io, o) },
  bass: { kind: 'pitched', gain: 0.24, play: (io, o) => bassVoice(io, o) },
  pizz: { kind: 'pitched', gain: 0.22, play: (io, o) => pizzVoice(io, o) },
  pluck: { kind: 'pitched', gain: 0.11, play: (io, o) => pluckVoice(io, o) },
  bell: { kind: 'pitched', gain: 0.07, play: (io, o) => bellVoice(io, o) },
  flute: { kind: 'pitched', gain: 0.09, play: (io, o) => fluteVoice(io, o) },
  pulse: { kind: 'pitched', gain: 0.085, play: (io, o) => pulseVoice(io, o) },
  blip: { kind: 'pitched', gain: 0.05, play: (io, o) => blipVoice(io, o) },
  fm: { kind: 'pitched', gain: 0.08, play: (io, o) => fmVoice(io, o) },
  string: { kind: 'pitched', gain: 0.10, play: (io, o) => ksVoice(io, o) },
  kick: { kind: 'unpitched', gain: 0.38, play: (io, o) => kick(io, o) },
  hat: { kind: 'unpitched', gain: 0.05, play: (io, o) => hat(io, o) },
  shaker: { kind: 'unpitched', gain: 0.035, play: (io, o) => shaker(io, o) },
  rim: { kind: 'unpitched', gain: 0.08, play: (io, o) => rim(io, o) },
  clank: { kind: 'unpitched', gain: 0.09, play: (io, o) => clank(io, o) },
  brush: { kind: 'unpitched', gain: 0.05, play: (io, o) => brush(io, o) },
  sweep: { kind: 'unpitched', gain: 0.06, play: (io, o) => sweepVoice(io, o) },
};

/** Voices that take `dur`; the rest are one-shots with their own decay. */
const SUSTAINED = new Set(['pad', 'strings', 'bass', 'pulse', 'flute', 'fm']);

const DEFAULT_MODES = [
  'phrygian', 'aeolian', 'minorPentatonic', 'dorian',
  'mixolydian', 'ionian', 'majorPentatonic', 'lydian',
];

const DEFAULT_FX = {
  reverbMix: 0.3,
  reverbSeconds: 2.5,
  delayMix: 0.15,
  delayFeedback: 0.25,
  delayTone: 2400,
};

/* ------------------------------------------------------------- resolution */

/** A spec number: constant, or [min, max, moodDimension]. */
function num(value, mood, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length >= 2) {
    const [min, max, dim] = value;
    const t = dim && mood[dim] !== undefined ? mood[dim] : 0.5;
    return min + (max - min) * t;
  }
  return fallback;
}

/** A layer's level: constant 0..1, or ['dim', from, width] as a gate. */
function level(spec, mood) {
  if (spec === undefined) return 1;
  if (typeof spec === 'number') return Math.min(1, Math.max(0, spec));
  if (Array.isArray(spec) && spec.length >= 3 && typeof spec[0] === 'string') {
    const [dim, from, width] = spec;
    return gate(mood[dim] ?? 0.5, from, width);
  }
  return num(spec, mood, 1);
}

/* -------------------------------------------------------------- validation */

/**
 * Check a spec before it is used. Returns `{ ok, errors, warnings }`.
 *
 * Themes get shared, so a broken one must produce a readable complaint rather
 * than a silent absence of sound or an exception inside the audio callback.
 */
export function validateSpec(spec) {
  const errors = [];
  const warnings = [];

  if (!spec || typeof spec !== 'object') {
    return { ok: false, errors: ['Theme must be an object.'], warnings };
  }
  if (!spec.id || typeof spec.id !== 'string') errors.push('Missing "id".');
  if (!spec.name || typeof spec.name !== 'string') errors.push('Missing "name".');

  const layers = Array.isArray(spec.layers) ? spec.layers : [];
  if (!layers.length) errors.push('A theme needs at least one layer.');

  layers.forEach((layer, i) => {
    const where = `layer ${i}${layer?.name ? ` ("${layer.name}")` : ''}`;
    if (!layer || typeof layer !== 'object') {
      errors.push(`${where}: not an object.`);
      return;
    }
    if (!VOICES[layer.voice]) {
      errors.push(`${where}: unknown voice "${layer.voice}". ` +
        `Available: ${Object.keys(VOICES).join(', ')}.`);
    }
    if (typeof layer.pattern !== 'string' || !layer.pattern.trim()) {
      errors.push(`${where}: missing "pattern".`);
    } else {
      errors.push(...checkPattern(layer.pattern, `${where}: pattern`));
    }
    // Optional: what the layer plays in the last bar before a change lands.
    if (layer.fill !== undefined) {
      if (typeof layer.fill !== 'string' || !layer.fill.trim()) {
        errors.push(`${where}: "fill" must be a pattern string.`);
      } else {
        errors.push(...checkPattern(layer.fill, `${where}: fill`));
      }
    }
    const kind = VOICES[layer.voice]?.kind;
    if (kind === 'unpitched' && layer.chord) {
      warnings.push(`${where}: "chord" has no effect on a percussion voice.`);
    }
    // Layer levels are merged into plan.layers alongside the engine's own two
    // continuous beds, so these names would silently fight with them.
    if (layer.name === 'drone' || layer.name === 'air') {
      errors.push(`${where}: "${layer.name}" is reserved for the engine's ` +
        `continuous layers — use another name and set the top-level ` +
        `"${layer.name}" field instead.`);
    }
    const names = layers.map((l) => l?.name).filter(Boolean);
    if (layer.name && names.indexOf(layer.name) !== i) {
      errors.push(`${where}: duplicate layer name "${layer.name}".`);
    }
    errors.push(...validateCondition(layer.when, `${where}.when`));

    for (const [k, v] of Object.entries(layer.params || {})) {
      if (!Array.isArray(v)) continue;
      const [min, max, dim] = v;
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        errors.push(`${where}: param "${k}" — a [min, max, dimension] ramp needs two numbers.`);
      } else if (dim !== undefined && !'ebdtws'.includes(dim)) {
        errors.push(`${where}: param "${k}" — "${dim}" is not a mood dimension (e, b, d, t, w, s).`);
      }
    }
  });

  if (spec.progressions !== undefined && !Array.isArray(spec.progressions)) {
    errors.push('"progressions" must be an array.');
  }
  for (const mode of spec.modes || []) {
    if (typeof mode !== 'string') errors.push(`Bad mode: ${JSON.stringify(mode)}.`);
  }
  // How much of the place's own ambience (birds, water, traffic, murmur) this
  // theme lets through: a plain number, 0 = none at all.
  if (spec.ambience !== undefined &&
      (typeof spec.ambience !== 'number' || !(spec.ambience >= 0 && spec.ambience <= 1))) {
    errors.push('"ambience" must be a number from 0 to 1.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Parse a mini-notation string and report what is wrong with it, if anything. */
function checkPattern(text, label) {
  const node = parsePattern(text);
  if (node.type === 'error') return [`${label} — ${node.message}`];
  const bad = queryPattern(node, 0)
    .map((e) => e.value)
    .find((v) => readValue(v) === null);
  return bad ? [`${label} — unrecognised value "${bad}".`] : [];
}

/* ------------------------------------------------------------------ layers */

/**
 * Parse a list of spec layers once. Shared by themes and by cues, which are
 * just layers with a condition attached.
 */
export function compileLayers(specLayers) {
  return (specLayers || []).map((layer) => {
    const fill = typeof layer.fill === 'string' ? parsePattern(layer.fill) : null;
    return {
      ...layer,
      node: parsePattern(layer.pattern),
      fillNode: fill && fill.type !== 'error' ? fill : null,
      def: VOICES[layer.voice],
    };
  }).filter((layer) => layer.def && layer.node.type !== 'error');
}

/**
 * Resolve each layer's audible level for this mood and scene.
 *
 * `level` answers "how busy does it need to be here"; `when` answers "is the
 * right *kind of place* here". They multiply, so a gym riff gated on energy
 * still only shows up at a gym.
 */
export function resolveLevels(layers, mood, scene) {
  const levels = {};
  for (const layer of layers) {
    const key = layer.name || layer.voice;
    levels[key] = level(layer.level, mood) * matchStrength(layer.when, scene);
  }
  return levels;
}

/**
 * Schedule one step for a set of compiled layers.
 *
 * `pos.stepsToCommit` (engine.js) is set only while a change is waiting for
 * its seam; in the final bar before it lands, a layer with a `fill` plays
 * that pattern instead of its loop.
 */
export function stepLayers(io, plan, pos, layers, levels) {
  const { stepInBar, bar, time, stepDur, barDur, stepsToCommit } = pos;
  const finalBar = stepsToCommit !== undefined && stepsToCommit <= STEPS_PER_BAR;
  const chordIndex = Math.floor(bar / plan.barsPerChord) % plan.progression.length;
  const degree = plan.progression[chordIndex];

  for (const layer of layers) {
    const key = layer.name || layer.voice;
    const gainLevel = levels[key] ?? 1;
    if (gainLevel <= 0.02) continue;

    // One cycle is one bar. Loops advance with the bar count, so a
    // <> alternation moves on each time round.
    const node = finalBar && layer.fillNode ? layer.fillNode : layer.node;
    for (const ev of queryPattern(node, bar)) {
      const exact = ev.begin * STEPS_PER_BAR;
      if (Math.floor(exact + 1e-9) !== stepInBar) continue;

      // Patterns finer than a 16th land between steps rather than stacking.
      const offset = (exact - stepInBar) * stepDur;
      const parsed = readValue(ev.value);
      if (!parsed) continue;

      play(io, plan, layer, parsed, degree, {
        time: time + offset + humanise(layer, plan, bar, stepInBar),
        stepDur,
        barDur,
        gainLevel,
        span: (ev.end - ev.begin) * barDur,
      });
    }
  }
}

/* ------------------------------------------------------------------ build */

/**
 * Compile a spec into a theme. Throws if the spec is invalid — callers should
 * run validateSpec first and show the errors.
 */
export function themeFromSpec(spec) {
  const check = validateSpec(spec);
  if (!check.ok) {
    throw new Error(`Theme "${spec?.id ?? '?'}" is invalid:\n  ${check.errors.join('\n  ')}`);
  }

  const modes = spec.modes?.length ? spec.modes : DEFAULT_MODES;
  const progressions = spec.progressions?.length
    ? spec.progressions
    : [{ name: 'i — VI — III — VII', degrees: [0, 5, 2, 6], brightness: 0.4 }];

  const layers = compileLayers(spec.layers);

  return {
    id: spec.id,
    name: spec.name,
    available: true,
    description: spec.description || 'A custom theme.',
    source: 'spec',
    spec,

    plan(mood, seed, scene) {
      const rng = mulberry32(seed);

      const scale = pickMode(quantise(mood.b), quantise(mood.t), modes);
      const progression = pickProgression(quantise(mood.b), rng(), progressions);

      const [rootLo, rootHi] = spec.rootRange || [36, 47];
      const root = rootLo + Math.floor(rng() * Math.max(1, rootHi - rootLo + 1));

      const levels = resolveLevels(layers, mood, scene);

      return {
        seed,
        mood,
        trim: num(spec.trim, mood, 1),
        // Continuous: main.js folds it into the ambience levels every replan.
        ambience: spec.ambience ?? 1,
        bpm: num(spec.bpm, mood, 90),
        root,
        scale,
        progression: progression.degrees,
        barsPerChord: Math.max(1, Math.round(num(spec.barsPerChord, mood, 1))),

        // The engine drives these two itself.
        layers: {
          drone: num(spec.drone, mood, 0.04),
          air: num(spec.air, mood, 0.012),
          ...levels,
        },
        timbre: {
          droneCutoff: num(spec.droneCutoff, mood, 220),
          airCutoff: num(spec.airCutoff, mood, 1200),
          airQ: num(spec.airQ, mood, 0.9),
        },
        fx: {
          reverbMix: num(spec.fx?.reverbMix, mood, DEFAULT_FX.reverbMix),
          reverbSeconds: num(spec.fx?.reverbSeconds, mood, DEFAULT_FX.reverbSeconds),
          delayMix: num(spec.fx?.delayMix, mood, DEFAULT_FX.delayMix),
          delayFeedback: num(spec.fx?.delayFeedback, mood, DEFAULT_FX.delayFeedback),
          delayTone: num(spec.fx?.delayTone, mood, DEFAULT_FX.delayTone),
        },

        levels,
        meta: {
          key: noteName(root),
          mode: scale,
          progression: progression.name,
        },
      };
    },

    step(io, plan, pos) {
      stepLayers(io, plan, pos, layers, plan.levels || {});
    },
  };
}

function humanise(layer, plan, bar, step) {
  const amount = typeof layer.humanise === 'number' ? layer.humanise : 0.004;
  if (amount <= 0) return 0;
  return (rnd(plan.seed, bar, step, layer.voice.length) - 0.5) * amount * 2;
}

function play(io, plan, layer, parsed, degree, ctx) {
  const { def } = layer;
  const gainValue = (layer.gain ?? def.gain) * ctx.gainLevel;
  if (gainValue <= 0.0005) return;

  const extras = {};
  for (const [k, v] of Object.entries(layer.params || {})) {
    // Only numbers and [min,max,dim] ramps get resolved. Strings and booleans
    // are real parameter values — `wave: 'sawtooth'`, `swirl: true` — and
    // passing them through num() silently turned them into 0, which browsers
    // then quietly ignored. Wrong sound, no error, very hard to spot.
    extras[k] = (typeof v === 'number' || Array.isArray(v))
      ? num(v, plan.mood, 0)
      : v;
  }

  const options = { time: ctx.time, gain: gainValue, ...extras };

  if (SUSTAINED.has(layer.voice)) {
    // `dur` is in steps; default to the length of the pattern event.
    options.dur = layer.dur !== undefined
      ? num(layer.dur, plan.mood, 1) * ctx.stepDur
      : ctx.span;
  }

  if (def.kind === 'unpitched') {
    def.play(io, options);
    return;
  }

  // Pitch. A degree is relative to the current chord; a note name is absolute.
  const octave = Math.round(num(layer.octave, plan.mood, 2));
  let midi;
  if (parsed.kind === 'midi') {
    midi = parsed.midi;
  } else if (parsed.kind === 'degree') {
    midi = scaleNote(plan.root + octave * 12, plan.scale, degree + parsed.degree);
  } else {
    // A bare `x` on a pitched voice plays the chord root.
    midi = scaleNote(plan.root + octave * 12, plan.scale, degree);
  }

  if (def.kind === 'chordal') {
    const size = Math.max(2, Math.round(num(layer.chordSize, plan.mood, 3)));
    options.notes = parsed.kind === 'midi'
      ? [midi, midi + 4, midi + 7].slice(0, size)
      : chordNotes(plan.root + octave * 12, plan.scale, degree + (parsed.degree || 0), size);
  } else {
    options.note = midi;
  }

  def.play(io, options);
}
