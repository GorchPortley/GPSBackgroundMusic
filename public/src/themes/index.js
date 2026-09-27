/**
 * Theme registry.
 *
 * A theme is the whole musical personality of the app — instruments, harmony,
 * rhythm — sitting on top of the same mood vector. Swapping themes scores the
 * same walk for a different film.
 *
 * There are two kinds, and the engine cannot tell them apart:
 *
 *   Code themes  export `{ id, name, plan(mood, seed), step(io, plan, pos) }`.
 *                Full control; needed for anything algorithmic (Noir's walking
 *                bass, Video Game's generated motifs).
 *
 *   Spec themes  are plain data — modes, chord sequences, and layers whose
 *                loops are written in mini-notation. Compiled by spec.js.
 *                Less powerful, but writable without JavaScript and safe to
 *                share, because no part of a spec is ever evaluated.
 *
 * See THEMES.md for the full reference for both.
 */

import { wanderer } from './wanderer.js';
import { scifi } from './scifi.js';
import { videogame } from './videogame.js';
import { fantasy } from './fantasy.js';
import { noir } from './noir.js';
import { overworld } from './presets/overworld.js';
import { themeFromSpec, validateSpec } from './spec.js';

/** Themes that ship with the app. */
const BUILT_IN = [wanderer, scifi, videogame, fantasy, noir];

/** Spec themes that ship with the app, compiled at load. */
const BUILT_IN_SPECS = [overworld];

/**
 * Themes added at runtime from an imported pack. Kept separate so a bad
 * user theme can never take a built-in one down with it.
 */
const custom = new Map();

function compile(spec) {
  const check = validateSpec(spec);
  if (!check.ok) {
    console.warn(`Skipping theme "${spec?.id ?? '?'}":\n  ${check.errors.join('\n  ')}`);
    return null;
  }
  if (check.warnings.length) {
    console.warn(`Theme "${spec.id}": ${check.warnings.join(' ')}`);
  }
  try {
    return themeFromSpec(spec);
  } catch (err) {
    console.warn(`Could not compile theme "${spec?.id ?? '?'}":`, err.message);
    return null;
  }
}

const compiledBuiltInSpecs = BUILT_IN_SPECS.map(compile).filter(Boolean);

export const DEFAULT_THEME_ID = wanderer.id;

/** Every theme currently available, built-in first. */
export function allThemes() {
  return [...BUILT_IN, ...compiledBuiltInSpecs, ...custom.values()];
}

/** Kept as a live getter so the UI list picks up imported themes. */
export const THEMES = new Proxy([], {
  get(_, prop) {
    const list = allThemes();
    const value = list[prop];
    return typeof value === 'function' ? value.bind(list) : value;
  },
  has(_, prop) {
    return prop in allThemes();
  },
  ownKeys() {
    return Reflect.ownKeys(allThemes());
  },
  getOwnPropertyDescriptor(_, prop) {
    return Object.getOwnPropertyDescriptor(allThemes(), prop);
  },
});

export function getTheme(id) {
  return allThemes().find((t) => t.id === id && t.available) || wanderer;
}

/**
 * Install theme specs from a pack. Returns a per-theme report so the UI can
 * say which ones were rejected and why, rather than silently dropping them.
 */
export function registerSpecs(specs) {
  const report = [];
  for (const spec of specs || []) {
    const check = validateSpec(spec);
    if (!check.ok) {
      report.push({ id: spec?.id ?? '?', ok: false, errors: check.errors });
      continue;
    }
    // Never let a shared theme shadow one that ships with the app.
    if (BUILT_IN.some((t) => t.id === spec.id) ||
        compiledBuiltInSpecs.some((t) => t.id === spec.id)) {
      report.push({
        id: spec.id,
        ok: false,
        errors: [`"${spec.id}" is the id of a built-in theme; rename it.`],
      });
      continue;
    }
    const theme = compile(spec);
    if (theme) {
      custom.set(spec.id, theme);
      report.push({ id: spec.id, ok: true, warnings: check.warnings });
    } else {
      report.push({ id: spec.id, ok: false, errors: ['Could not compile.'] });
    }
  }
  return report;
}

export function customSpecs() {
  return [...custom.values()].map((t) => t.spec);
}

export function removeCustom(id) {
  return custom.delete(id);
}
