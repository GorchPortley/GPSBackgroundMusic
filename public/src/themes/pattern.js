/**
 * Mini-notation: a compact way to write a loop.
 *
 * The grammar is a subset of TidalCycles / Strudel, deliberately — that
 * notation is already documented and taught, so anything you learn from their
 * material transfers here. The difference is that this is *parsed*, not
 * evaluated: a pattern is a string, never code. That is what makes a theme
 * safe to accept from a stranger.
 *
 *   "0 2 4 7"          four events, one per quarter of the cycle
 *   "0 ~ 4 ~"          `~` is a rest
 *   "[0 2] 4"          brackets subdivide one slot
 *   "<0 4>"            angle brackets alternate, one per cycle
 *   "0*4 7"            `*n` repeats within the slot
 *   "0@3 7"            `@n` makes a slot n times longer
 *   "0!3 7"            `!n` repeats the value across n slots
 *   "x(3,8)"           Euclidean: 3 hits spread evenly over 8 slots
 *   "x(3,8,2)"         …rotated left by 2 slots
 *   "c4 e4 g4"         note names work too, as absolute pitches
 *   "x ~ x x"          `x` is a hit, for percussion
 *
 * A cycle is one bar. Numbers are scale degrees relative to the current
 * chord, so the same pattern follows the harmony wherever it goes.
 */

const NOTE_OFFSETS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/* ------------------------------------------------------------------ parse */

const cache = new Map();

export function parsePattern(source) {
  const key = String(source);
  if (cache.has(key)) return cache.get(key);

  let node;
  try {
    const tokens = tokenise(key);
    const state = { tokens, i: 0 };
    node = parseSequence(state, null);
    if (state.i < state.tokens.length) {
      throw new Error(`unexpected "${state.tokens[state.i].value}"`);
    }
  } catch (err) {
    node = { type: 'error', message: err.message };
  }

  cache.set(key, node);
  return node;
}

function tokenise(src) {
  const tokens = [];
  // `(k,n)` / `(k,n,rot)` is a Euclidean modifier. Any other parenthesised
  // text is caught by the last alternative so it is reported, not skipped.
  const re = /\s+|([[\]<>])|([*@!])\s*(\d+)|\((\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+))?\)|([^\s[\]<>*@!()]+)|(\([^)]*\)?|\))/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) tokens.push({ type: m[1] });
    else if (m[2]) tokens.push({ type: 'mod', op: m[2], count: Number(m[3]) });
    else if (m[4] !== undefined) {
      tokens.push({
        type: 'euclid',
        k: Number(m[4]),
        n: Number(m[5]),
        rot: m[6] === undefined ? 0 : Number(m[6]),
      });
    }
    else if (m[7]) tokens.push({ type: 'word', value: m[7] });
    else if (m[8]) throw new Error(`unexpected "${m[8]}" — a Euclidean rhythm is written x(hits,steps) or x(hits,steps,rotation)`);
  }
  return tokens;
}

/**
 * k ones spread as evenly as possible over n slots (Bjorklund / Toussaint).
 * bjorklund(3, 8) → 1 0 0 1 0 0 1 0, the tresillo.
 */
function bjorklund(k, n) {
  if (k <= 0) return Array(n).fill(0);
  if (k >= n) return Array(n).fill(1);
  let a = Array.from({ length: k }, () => [1]);
  let b = Array.from({ length: n - k }, () => [0]);
  while (b.length > 1) {
    const m = Math.min(a.length, b.length);
    const next = [];
    for (let i = 0; i < m; i++) next.push(a[i].concat(b[i]));
    const rest = a.length > m ? a.slice(m) : b.slice(m);
    a = next; b = rest;
  }
  return a.concat(b).flat();
}

/**
 * `term(k,n,rot)` → a subdivision of n slots: slot i is the term where
 * bjorklund(k, n)[(i + rot) % n] is 1, a rest otherwise (rotate left, as
 * Tidal does). Expanded here at parse time, so query never sees it.
 * n is clamped to 1..64 like the other modifiers; k ≥ n means every slot.
 */
function euclid(node, k, n, rot) {
  const steps = Math.max(1, Math.min(64, n));
  const hits = Math.max(0, Math.min(steps, k));
  const bits = bjorklund(hits, steps);
  const { weight, ...slot } = node;
  const children = [];
  for (let i = 0; i < steps; i++) {
    children.push(bits[(i + rot) % steps] ? slot : { type: 'rest' });
  }
  const out = { type: 'seq', children };
  if (weight) out.weight = weight;
  return out;
}

/** A sequence runs until `closer` (or the end of input). */
function parseSequence(state, closer) {
  const children = [];

  while (state.i < state.tokens.length) {
    const token = state.tokens[state.i];

    if (token.type === ']' || token.type === '>') {
      if (token.type !== closer) throw new Error(`unmatched "${token.type}"`);
      state.i++;
      return { type: 'seq', children };
    }

    children.push(parseTerm(state));
  }

  if (closer) throw new Error(`missing "${closer}"`);
  return { type: 'seq', children };
}

function parseTerm(state) {
  const token = state.tokens[state.i];
  let node;

  if (token.type === '[') {
    state.i++;
    node = parseSequence(state, ']');
  } else if (token.type === '<') {
    state.i++;
    const seq = parseSequence(state, '>');
    node = { type: 'alt', children: seq.children };
  } else if (token.type === 'word') {
    state.i++;
    node = token.value === '~'
      ? { type: 'rest' }
      : { type: 'atom', value: token.value };
  } else if (token.type === 'euclid') {
    throw new Error(`"(${token.k},${token.n})" needs something before it, e.g. x(${token.k},${token.n})`);
  } else {
    throw new Error(`unexpected "${token.op || token.type}"`);
  }

  // Modifiers bind to the term just parsed, and may be chained.
  while (state.i < state.tokens.length &&
         (state.tokens[state.i].type === 'mod' || state.tokens[state.i].type === 'euclid')) {
    const mod = state.tokens[state.i];
    state.i++;
    if (mod.type === 'euclid') {
      node = euclid(node, mod.k, mod.n, mod.rot);
      continue;
    }
    const { op, count } = mod;
    const n = Math.max(1, Math.min(64, count));
    if (op === '*') node = { type: 'repeat', count: n, child: node };
    else if (op === '@') node = { ...node, weight: n };
    else if (op === '!') node = { type: 'replicate', count: n, child: node };
  }

  return node;
}

/* ------------------------------------------------------------------ query */

/**
 * Events for one cycle, as `{ value, begin, end }` with begin/end in [0,1).
 *
 * @param {object} node   from parsePattern
 * @param {number} cycle  which cycle (bar) — drives `<>` alternation
 */
export function queryPattern(node, cycle = 0) {
  const out = [];
  if (!node || node.type === 'error') return out;
  emit(node, Math.floor(cycle), 0, 1, out);
  return out;
}

function emit(node, cycle, t0, t1, out) {
  switch (node.type) {
    case 'rest':
      return;

    case 'atom':
      out.push({ value: node.value, begin: t0, end: t1 });
      return;

    case 'seq': {
      // `!n` occupies n slots, `@n` stretches one — both are just weight.
      const slots = [];
      for (const child of node.children) {
        if (child.type === 'replicate') {
          for (let i = 0; i < child.count; i++) slots.push(child.child);
        } else {
          slots.push(child);
        }
      }
      if (!slots.length) return;

      const total = slots.reduce((sum, c) => sum + (c.weight || 1), 0);
      const span = t1 - t0;
      let cursor = t0;
      for (const child of slots) {
        const width = ((child.weight || 1) / total) * span;
        emit(child, cycle, cursor, cursor + width, out);
        cursor += width;
      }
      return;
    }

    case 'alt': {
      if (!node.children.length) return;
      const n = node.children.length;
      const pick = ((cycle % n) + n) % n;
      emit(node.children[pick], cycle, t0, t1, out);
      return;
    }

    case 'repeat': {
      const width = (t1 - t0) / node.count;
      for (let i = 0; i < node.count; i++) {
        emit(node.child, cycle, t0 + i * width, t0 + (i + 1) * width, out);
      }
      return;
    }

    case 'replicate':
      // Only meaningful inside a sequence; alone it behaves as its child.
      emit(node.child, cycle, t0, t1, out);
      return;

    default:
  }
}

/* ------------------------------------------------------------------ notes */

/**
 * Turn a pattern value into something playable.
 *
 * Returns one of:
 *   { kind: 'hit' }                 — percussion trigger (`x`)
 *   { kind: 'degree', degree: n }   — scale degree relative to the chord
 *   { kind: 'midi', midi: n }       — an absolute pitch, from a note name
 *   null                            — unrecognised
 */
export function readValue(value) {
  if (value === 'x' || value === 'X') return { kind: 'hit' };

  // Scale degrees: plain integers, optionally signed.
  if (/^[+-]?\d+$/.test(value)) {
    return { kind: 'degree', degree: Number(value) };
  }

  // Note names: c4, f#3, bb2, C#-1
  const m = /^([a-gA-G])([#sb]?)(-?\d+)?$/.exec(value);
  if (m) {
    const base = NOTE_OFFSETS[m[1].toLowerCase()];
    const accidental = m[2] === '#' || m[2] === 's' ? 1 : m[2] === 'b' ? -1 : 0;
    const octave = m[3] === undefined ? 4 : Number(m[3]);
    return { kind: 'midi', midi: (octave + 1) * 12 + base + accidental };
  }

  return null;
}

/** Human-readable check used by the theme validator. */
export function describePattern(source) {
  const node = parsePattern(source);
  if (node.type === 'error') return { ok: false, error: node.message };

  const events = queryPattern(node, 0);
  const unreadable = events
    .map((e) => e.value)
    .filter((v) => readValue(v) === null);

  if (unreadable.length) {
    return { ok: false, error: `unrecognised value "${unreadable[0]}"`, expansion: formatNode(node, true) };
  }
  return { ok: true, events: events.length, expansion: formatNode(node, true) };
}

/**
 * The parsed tree written back as mini-notation, with Euclidean terms
 * expanded: "x(3,8)" → "x ~ ~ x ~ ~ x ~". A group that holds only another
 * group is unwrapped ("[[a b]]" is "[a b]"; at the top, "a b").
 */
function formatNode(node, top = false) {
  let s;
  switch (node.type) {
    case 'rest': s = '~'; break;
    case 'atom': s = node.value; break;
    case 'seq': {
      // "[[a b]]" is "[a b]"; keep the outer weight, if any.
      const only = node.children.length === 1 ? node.children[0] : null;
      if (only && only.type === 'seq' && !only.weight) {
        return formatNode(node.weight ? { ...only, weight: node.weight } : only, top);
      }
      const inner = node.children.map((c) => formatNode(c)).join(' ');
      s = top ? inner : `[${inner}]`;
      break;
    }
    case 'alt': s = `<${node.children.map((c) => formatNode(c)).join(' ')}>`; break;
    case 'repeat': s = `${formatNode(node.child)}*${node.count}`; break;
    case 'replicate': s = `${formatNode(node.child)}!${node.count}`; break;
    default: s = '?';
  }
  return node.weight && node.weight !== 1 ? `${s}@${node.weight}` : s;
}
