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
  SCALES, chordNotes, mulberry32, noteName, pickMode, pickProgression, scaleNote,
} from '../audio/theory.js';
import {
  bassVoice, bellVoice, blipVoice, brush, clank, fluteVoice, fmVoice, hat, kick,
  ksVoice, padVoice, pizzVoice, pluckVoice, pulseVoice, rim, shaker, stringVoice,
  sweepVoice,
} from '../audio/voices.js';
import { parsePattern, queryPattern, readValue } from './pattern.js';
import { matchStrength, validateCondition } from './match.js';
import { breathing, gate, leadChord, quantise, rnd, section } from './util.js';
import { markovBar } from './melody.js';

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
 * A theme colour (C4.3): exactly `#rrggbb`. It ends up in a CSS custom
 * property, so nothing looser — no names, no `#rgb`, no functions, no `url()`.
 */
export function isThemeColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

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
    // A layer is written out (`pattern`) or generated (`generate`, C3.8) —
    // exactly one of the two.
    if (layer.generate !== undefined) {
      if (layer.pattern !== undefined) {
        errors.push(`${where}: has both "pattern" and "generate" — use one.`);
      }
      const gen = checkGenerate(layer.generate, `${where}: generate`);
      errors.push(...gen.errors);
      warnings.push(...gen.warnings);
      const genKind = VOICES[layer.voice]?.kind;
      if (genKind && genKind !== 'pitched' && genKind !== 'chordal') {
        errors.push(`${where}: "generate" makes a melody, so it needs a pitched ` +
          `or chordal voice, not "${layer.voice}".`);
      }
    } else if (typeof layer.pattern !== 'string' || !layer.pattern.trim()) {
      errors.push(`${where}: missing "pattern" (or "generate").`);
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
    // Optional: does this layer drop out in the breath bar? Default: only
    // percussion does.
    if (layer.breath !== undefined && typeof layer.breath !== 'boolean') {
      errors.push(`${where}: "breath" must be true or false.`);
    }
    // Optional: the sections (P2, `form.sections`) this layer plays in.
    if (layer.sections !== undefined && !isSections(layer.sections, MAX_LAYER_SECTIONS)) {
      errors.push(`${where}: "sections" must be 1–${MAX_LAYER_SECTIONS} of the letters ` +
        `A–D, e.g. "B" or "AB".`);
    }
    const kind = VOICES[layer.voice]?.kind;
    if (kind === 'unpitched' && layer.chord) {
      warnings.push(`${where}: "chord" has no effect on a percussion voice.`);
    }
    // Voice leading: on by default for chordal voices; `false` keeps every
    // chord in its written (root-position) voicing.
    if (layer.voiceLead !== undefined) {
      if (typeof layer.voiceLead !== 'boolean') {
        errors.push(`${where}: "voiceLead" must be true or false.`);
      } else if (kind && kind !== 'chordal') {
        warnings.push(`${where}: "voiceLead" only affects chordal voices (pad, strings).`);
      }
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
  // Form: every `breathEvery` phrases the last bar drops the drums (C3.7).
  if (spec.form !== undefined) {
    if (!spec.form || typeof spec.form !== 'object' || Array.isArray(spec.form)) {
      errors.push('"form" must be an object, e.g. { "breathEvery": 4 }.');
    } else {
      if (spec.form.breathEvery !== undefined &&
          !(Number.isInteger(spec.form.breathEvery) && spec.form.breathEvery >= 0)) {
        errors.push('"form.breathEvery" must be a whole number, 0 or more (0 = never).');
      }
      const form = checkForm(spec.form);
      errors.push(...form.errors);
      warnings.push(...form.warnings);
    }
  }
  // A layer that only plays in sections the theme never reaches is silent.
  const reached = isSections(spec.form?.sections) ? spec.form.sections : 'A';
  for (const layer of layers) {
    if (isSections(layer?.sections, MAX_LAYER_SECTIONS) &&
        ![...layer.sections].some((l) => reached.includes(l))) {
      warnings.push(`layer "${layer.name || layer.voice}": "sections" is "${layer.sections}" ` +
        `but the theme only plays "${reached}", so it is never heard.`);
    }
  }
  // How much of the place's own ambience (birds, water, traffic, murmur) this
  // theme lets through: a plain number, 0 = none at all.
  if (spec.ambience !== undefined &&
      (typeof spec.ambience !== 'number' || !(spec.ambience >= 0 && spec.ambience <= 1))) {
    errors.push('"ambience" must be a number from 0 to 1.');
  }
  // The UI accent while this theme is playing (C4.3). Optional.
  if (spec.color !== undefined && !isThemeColor(spec.color)) {
    errors.push('"color" must be a hex colour like "#a1b2c3".');
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

/** Is this a spec number: a finite constant or a [min, max, dim?] ramp? */
function numError(v, label) {
  if (typeof v === 'number') return Number.isFinite(v) ? null : `${label} must be a finite number.`;
  if (Array.isArray(v)) {
    const [min, max, dim] = v;
    if (v.length < 2 || v.length > 3 || !Number.isFinite(min) || !Number.isFinite(max)) {
      return `${label} — a [min, max, dimension] ramp needs two numbers.`;
    }
    if (dim !== undefined && !(typeof dim === 'string' && dim.length === 1 && 'ebdtws'.includes(dim))) {
      return `${label} — "${dim}" is not a mood dimension (e, b, d, t, w, s).`;
    }
    return null;
  }
  return `${label} must be a number or [min, max, dimension].`;
}

/* ------------------------------------------------------------ section form */

/** Section letters (P2). A form is at most 8 phrases; a layer names up to 4. */
const SECTION_LETTERS = ['A', 'B', 'C', 'D'];
const MAX_FORM_SECTIONS = 8;
const MAX_LAYER_SECTIONS = 4;
const SECTION_KEYS = ['progression', 'degreeShift', 'density'];
const MAX_SECTION_CHORDS = 16;

/** Is this a string of 1..max section letters, e.g. "AABA"? */
function isSections(v, max = MAX_FORM_SECTIONS) {
  return typeof v === 'string' && v.length >= 1 && v.length <= max && /^[A-D]+$/.test(v);
}

/**
 * Check the section half of `form` (P2): `sections` and the per-letter
 * tweaks `form.A`…`form.D` = `{ progression?, degreeShift?, density? }`.
 */
function checkForm(form) {
  const errors = [];
  const warnings = [];
  if (form.sections !== undefined && !isSections(form.sections)) {
    errors.push(`"form.sections" must be 1–${MAX_FORM_SECTIONS} of the letters A–D, ` +
      'one per four-bar phrase, e.g. "AABA".');
  }
  for (const letter of SECTION_LETTERS) {
    const part = form[letter];
    if (part === undefined) continue;
    const label = `"form.${letter}"`;
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      errors.push(`${label} must be an object, e.g. { "progression": [3, 3, 0, 4] }.`);
      continue;
    }
    if (part.progression !== undefined &&
        !(Array.isArray(part.progression) && part.progression.length >= 1 &&
          part.progression.length <= MAX_SECTION_CHORDS &&
          part.progression.every((d) => Number.isInteger(d) && Math.abs(d) <= 14))) {
      errors.push(`${label}.progression must be 1–${MAX_SECTION_CHORDS} whole scale degrees ` +
        '(−14…14), e.g. [3, 3, 0, 4].');
    }
    if (part.degreeShift !== undefined &&
        !(Number.isInteger(part.degreeShift) && Math.abs(part.degreeShift) <= 7)) {
      errors.push(`${label}.degreeShift must be a whole number of scale degrees, −7…7.`);
    }
    if (part.density !== undefined &&
        !(typeof part.density === 'number' && part.density >= -1 && part.density <= 1)) {
      errors.push(`${label}.density must be a number from −1 to 1 (added to the scene's density).`);
    }
    for (const k of Object.keys(part)) {
      if (!SECTION_KEYS.includes(k)) warnings.push(`${label}: unknown field "${k}" is ignored.`);
    }
    if (!(isSections(form.sections) ? form.sections : 'A').includes(letter)) {
      warnings.push(`${label} is never used: "form.sections" has no "${letter}".`);
    }
  }
  return { errors, warnings };
}

/**
 * The resolved per-section tweaks for a plan, or `{}` when the theme has no
 * sections. Only letters that change something get an entry; `density`
 * becomes the levels (and mood, for `generate`) that section plays with.
 */
function resolveSections(form, layers, mood, scene) {
  const out = {};
  if (!isSections(form?.sections)) return out;
  out.sections = form.sections;
  for (const letter of SECTION_LETTERS) {
    const p = form[letter];
    if (!p || typeof p !== 'object' || !form.sections.includes(letter)) continue;
    const part = {};
    if (Array.isArray(p.progression)) part.progression = p.progression;
    if (p.degreeShift) part.degreeShift = p.degreeShift;
    if (p.density) {
      const shifted = { ...mood, d: Math.min(1, Math.max(0, (mood.d ?? 0.5) + p.density)) };
      part.mood = shifted;
      part.levels = resolveLevels(layers, shifted, scene);
    }
    if (Object.keys(part).length) out[letter] = part;
  }
  return out;
}

/**
 * The chord under this step. Without a section tweak this is the plan's own
 * progression, indexed by the absolute bar (as it always was). A section with
 * its own `progression` starts it from its first chord at the phrase seam, so
 * the swap lines up with the phrase and nothing clashes mid-phrase;
 * `degreeShift` moves whichever progression is playing by that many degrees.
 * `chordChange` is also true on the first bar of a new section.
 */
function harmonyAt(plan, pos, letter) {
  const part = letter ? plan.form[letter] : null;
  const bpc = plan.barsPerChord;
  const own = part?.progression;
  const prog = own || plan.progression;
  const bars = own ? pos.barInPhrase : pos.bar;
  let degree = prog[Math.floor(bars / bpc) % prog.length];
  if (part?.degreeShift) degree += part.degreeShift;
  const seam = letter !== null && pos.barInPhrase === 0 &&
    letter !== plan.form.sections[(pos.phrase + plan.form.sections.length - 1) % plan.form.sections.length];
  return { degree, chordChange: bars % bpc === 0 || seam, part };
}

const GENERATE_KEYS = ['kind', 'density', 'range', 'leap', 'rest', 'contour'];
/** Degrees a generated melody may span, either side of the tonic. */
const GENERATE_MAX_DEGREE = 28;

/** Check a layer's `generate` block (C3.8). Returns `{ errors, warnings }`. */
function checkGenerate(gen, label) {
  const errors = [];
  const warnings = [];
  if (!gen || typeof gen !== 'object' || Array.isArray(gen)) {
    return { errors: [`${label} must be an object, e.g. { "kind": "markov" }.`], warnings };
  }
  if (gen.kind !== undefined && gen.kind !== 'markov') {
    errors.push(`${label}.kind — only "markov" is available.`);
  }
  for (const k of ['density', 'leap', 'rest', 'contour']) {
    if (gen[k] === undefined) continue;
    const e = numError(gen[k], `${label}.${k}`);
    if (e) errors.push(e);
  }
  if (gen.range !== undefined) {
    if (!Array.isArray(gen.range) || gen.range.length !== 2) {
      errors.push(`${label}.range must be [low, high] in scale degrees, e.g. [0, 9].`);
    } else {
      gen.range.forEach((v, i) => {
        const e = numError(v, `${label}.range[${i}]`);
        if (e) { errors.push(e); return; }
        const ends = typeof v === 'number' ? [v] : v.slice(0, 2);
        if (ends.some((n) => Math.abs(n) > GENERATE_MAX_DEGREE)) {
          errors.push(`${label}.range[${i}] — keep within ±${GENERATE_MAX_DEGREE} degrees.`);
        }
      });
    }
  }
  for (const k of Object.keys(gen)) {
    if (!GENERATE_KEYS.includes(k)) warnings.push(`${label}: unknown field "${k}" is ignored.`);
  }
  return { errors, warnings };
}

/* ------------------------------------------------------------------ layers */

/**
 * Parse a list of spec layers once. Shared by themes and by cues, which are
 * just layers with a condition attached.
 */
export function compileLayers(specLayers) {
  return (specLayers || []).map((layer) => {
    const fill = typeof layer.fill === 'string' ? parsePattern(layer.fill) : null;
    const generated = !!layer.generate && typeof layer.generate === 'object';
    return {
      ...layer,
      // A generated layer has no loop; its events come from generatedEvents().
      node: generated ? null : parsePattern(layer.pattern),
      fillNode: fill && fill.type !== 'error' ? fill : null,
      def: VOICES[layer.voice],
      genCache: null,
      // Voice-leading memory for a chordal layer (util.leadChord): per
      // compiled layer, so two themes or two cues never share it.
      leadState: {},
    };
  }).filter((layer) => layer.def && (layer.node ? layer.node.type !== 'error' : layer.generate));
}

/**
 * One bar of a `generate` layer (C3.8), in the shape queryPattern returns.
 *
 * Cached on the compiled layer per bar (and seed), so the notes are fixed
 * for the whole bar even though the plan — and with it the mood that the
 * `generate` numbers follow — is replaced every replan tick. A new bar, or a
 * new place's seed arriving with a committed change, draws a fresh bar.
 *
 * `at` (from stepLayers) carries the chord under the bar and, when the theme
 * has sections (P2), the section letter and bar-in-phrase that key the walk
 * instead of the absolute bar. Without it: the plan's own progression.
 */
export function generatedEvents(layer, plan, bar, at = null) {
  const letter = at?.letter ?? null;
  const c = layer.genCache;
  if (c && c.bar === bar && c.seed === plan.seed && c.letter === letter) return c.events;

  const g = layer.generate;
  const mood = at?.mood || plan.mood || {};
  const unit = (v, fallback) => Math.min(1, Math.max(0, num(v, mood, fallback)));
  const [lo, hi] = Array.isArray(g.range) ? g.range : [0, 9];
  const chordIndex = Math.floor(bar / plan.barsPerChord) % plan.progression.length;
  const name = layer.name || layer.voice;

  // Section form (P2): with `form.sections` the walk is keyed on the section
  // letter and the bar within the phrase instead of the absolute bar, so each
  // letter has its own motif and it comes back every time that letter does
  // (the A phrases of AABA match, B differs). Without sections: as before.
  const events = markovBar({
    seed: plan.seed >>> 0,
    bar: letter ? at.barInPhrase : bar,
    name: letter ? `${name}/${letter}` : name,
    chordDegree: at ? at.degree : plan.progression[chordIndex],
    chordChange: at ? at.chordChange : bar % plan.barsPerChord === 0,
    scaleLength: (SCALES[plan.scale] || SCALES.aeolian).length,
    density: unit(g.density, 0.45),
    leap: unit(g.leap, 0.2),
    rest: unit(g.rest, 0.35),
    contour: Math.min(1, Math.max(-1, num(g.contour, mood, 0))),
    lo: num(lo, mood, 0),
    hi: num(hi, mood, 9),
  });
  layer.genCache = { bar, seed: plan.seed, letter, events };
  return events;
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
 *
 * Breath (C3.7, `plan.form.breathEvery`): in the last bar of every n-th
 * phrase, percussion layers and layers with `breath: true` rest (a layer can
 * opt out with `breath: false`). When that bar is also a fill bar, the fill
 * wins for the layers that have one — the handover matters more than the
 * air — and the other eligible layers still rest. Cue layers go through here
 * too, so they breathe with whatever theme they sit on.
 *
 * Generated layers (C3.8, `generate`) are ordinary layers here: a `fill`
 * replaces the generated bar exactly as it replaces a loop, and breath
 * follows the same rule — being pitched, they play through the breath bar
 * unless they say `breath: true`.
 *
 * Section form (P2, `plan.form.sections`): the phrase number picks a letter;
 * a layer with `sections` sits out the others, and the letter's
 * `progression` / `degreeShift` (see harmonyAt) set the chord — for cue
 * layers too, so they stay in the theme's harmony. Breath and fills are
 * unchanged by it; voice leading carries across the swap because the led
 * state lives on the layer, not the section.
 */
export function stepLayers(io, plan, pos, layers, levels) {
  const { stepInBar, bar, time, stepDur, barDur, stepsToCommit } = pos;
  const finalBar = stepsToCommit !== undefined && stepsToCommit <= STEPS_PER_BAR;
  const breath = breathing(plan, pos);
  const letter = section(plan, pos);
  const { degree, chordChange, part } = harmonyAt(plan, pos, letter);
  const at = { letter, degree, chordChange, barInPhrase: pos.barInPhrase, mood: part?.mood };

  for (const layer of layers) {
    const key = layer.name || layer.voice;
    const gainLevel = levels[key] ?? 1;
    if (gainLevel <= 0.02) continue;
    // Section form (P2): a layer with `sections` plays only in those; with no
    // form every phrase counts as "A". Checked before the fill, so a layer
    // that is out of its section stays out even in a fill bar.
    if (typeof layer.sections === 'string' && !layer.sections.includes(letter || 'A')) continue;

    // One cycle is one bar. Loops advance with the bar count, so a
    // <> alternation moves on each time round.
    const filling = finalBar && layer.fillNode;
    if (breath && !filling && (layer.breath ?? layer.def.kind === 'unpitched')) continue;
    const node = filling ? layer.fillNode : layer.node;
    const events = node ? queryPattern(node, bar) : generatedEvents(layer, plan, bar, at);
    for (const ev of events) {
      const exact = ev.begin * STEPS_PER_BAR;
      if (Math.floor(exact + 1e-9) !== stepInBar) continue;

      // Patterns finer than a 16th land between steps rather than stacking.
      const offset = (exact - stepInBar) * stepDur;
      const parsed = readValue(ev.value);
      if (!parsed) continue;

      play(io, plan, layer, parsed, degree, {
        time: time + offset + humanise(layer, plan, bar, stepInBar),
        bar,
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
    // Validated above; absent means the app's default accent.
    color: spec.color,
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
        // Part of the theme, so it only changes with themeId; step reads it
        // live from the sounding plan. Default: breathe every 4th phrase.
        // With `form.sections` (P2) it also carries the section letters and
        // each letter's resolved tweaks; a section is a function of the phrase
        // number, so it changes only at a phrase seam and is not a plan
        // field the engine has to hold back.
        form: { breathEvery: spec.form?.breathEvery ?? 4,
          ...resolveSections(spec.form, layers, mood, scene) },

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
      // A section with a `density` tweak plays with its own layer levels.
      const letter = section(plan, pos);
      stepLayers(io, plan, pos, layers, (letter && plan.form[letter]?.levels) || plan.levels || {});
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
    if (parsed.kind === 'midi') {
      // A note name is absolute: its chord stays exactly where it is written.
      options.notes = [midi, midi + 4, midi + 7].slice(0, size);
    } else {
      const notes = chordNotes(plan.root + octave * 12, plan.scale, degree + (parsed.degree || 0), size);
      options.notes = layer.voiceLead === false
        ? notes
        : leadChord(layer.leadState, plan, ctx.bar, notes, plan.root + octave * 12);
    }
  } else {
    options.note = midi;
  }

  def.play(io, options);
}
