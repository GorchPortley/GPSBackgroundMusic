/**
 * Small music-theory toolkit: scales, scale-degree arithmetic, diatonic chords
 * and a set of progressions tagged by how bright they sound.
 *
 * Everything speaks MIDI note numbers; the synths convert to frequency.
 */

export const SCALES = {
  lydian: [0, 2, 4, 6, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  hirajoshi: [0, 2, 3, 7, 8],
  wholeTone: [0, 2, 4, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  lydianDominant: [0, 2, 4, 6, 7, 9, 10],
  octatonic: [0, 2, 3, 5, 6, 8, 9, 11],
  insen: [0, 1, 5, 7, 10],
};

/** Modes ordered dark -> bright; brightness picks a position on this list. */
export const MODE_LADDER = [
  'phrygian',
  'aeolian',
  'minorPentatonic',
  'dorian',
  'mixolydian',
  'ionian',
  'majorPentatonic',
  'lydian',
];

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function noteName(midi) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/**
 * Nth degree of a scale, wrapping into higher/lower octaves for degrees
 * outside 0..len-1. Degree 7 of a 7-note scale is the root an octave up.
 */
export function scaleNote(rootMidi, scaleName, degree) {
  const scale = SCALES[scaleName] || SCALES.aeolian;
  const len = scale.length;
  const octave = Math.floor(degree / len);
  const index = ((degree % len) + len) % len;
  return rootMidi + scale[index] + 12 * octave;
}

/** Diatonic chord built by stacking scale thirds on `degree`. */
export function chordNotes(rootMidi, scaleName, degree, size = 3) {
  const notes = [];
  for (let i = 0; i < size; i++) notes.push(scaleNote(rootMidi, scaleName, degree + i * 2));
  return notes;
}

/**
 * Progressions as scale degrees (0 = tonic). `brightness` is the mood value
 * each one sits best at, used to pick a progression that matches the scene.
 */
export const PROGRESSIONS = [
  { name: 'i — VI — III — VII', degrees: [0, 5, 2, 6], brightness: 0.30 },
  { name: 'i — VII — VI — VII', degrees: [0, 6, 5, 6], brightness: 0.22 },
  { name: 'i — iv', degrees: [0, 3], brightness: 0.34 },
  { name: 'i — VI', degrees: [0, 5], brightness: 0.38 },
  { name: 'vi — IV — I — V', degrees: [5, 3, 0, 4], brightness: 0.55 },
  { name: 'I — V — vi — IV', degrees: [0, 4, 5, 3], brightness: 0.78 },
  { name: 'I — IV', degrees: [0, 3], brightness: 0.70 },
  { name: 'I — ii — IV — I', degrees: [0, 1, 3, 0], brightness: 0.66 },
  { name: 'I — iii — IV — vi', degrees: [0, 2, 3, 5], brightness: 0.62 },
  { name: 'drone', degrees: [0], brightness: 0.50 },
];

/**
 * Pick a progression near `brightness`. `variant` shuffles between the close
 * candidates so two similar places do not always land on the same four chords.
 */
export function pickProgression(brightness, variant = 0, pool = PROGRESSIONS) {
  const ranked = [...pool].sort(
    (a, b) => Math.abs(a.brightness - brightness) - Math.abs(b.brightness - brightness),
  );
  const near = ranked.slice(0, Math.min(3, ranked.length));
  return near[Math.floor(variant * near.length) % near.length];
}

/** Choose a mode from the dark->bright ladder. */
export function pickMode(brightness, tension, ladder = MODE_LADDER) {
  // High tension drags the choice a step darker than brightness alone implies.
  const shifted = Math.min(1, Math.max(0, brightness - tension * 0.18));
  const index = Math.round(shifted * (ladder.length - 1));
  return ladder[index];
}

/**
 * Spread chord notes across a register instead of leaving them in a block.
 * Returns MIDI notes sorted low to high.
 */
export function voice(notes, { spread = 1, base = 0 } = {}) {
  return notes
    .map((n, i) => n + base + (i % spread === spread - 1 && i > 0 ? 12 : 0))
    .sort((a, b) => a - b);
}

/* ------------------------------------------------------------ voice leading */

/** Largest chord voiceLead() searches; bigger ones come back unled. */
const LEAD_MAX = 12;
// Scratch buffers. Pure working space, rewritten on every call and never read
// across calls, so sharing them between themes carries no state.
const _a = new Float64Array(LEAD_MAX);
const _b = new Float64Array(LEAD_MAX);
const _c = new Float64Array(LEAD_MAX);
const _dtw = new Float64Array(LEAD_MAX * LEAD_MAX);

function _load(dst, notes, n) {
  for (let i = 0; i < n; i++) {
    const v = notes[i];
    let j = i - 1;
    while (j >= 0 && dst[j] > v) { dst[j + 1] = dst[j]; j--; }
    dst[j + 1] = v;
  }
}

function _sortN(dst, n) {
  for (let i = 1; i < n; i++) {
    const v = dst[i];
    let j = i - 1;
    while (j >= 0 && dst[j] > v) { dst[j + 1] = dst[j]; j--; }
    dst[j + 1] = v;
  }
}

/**
 * Movement between two sorted voicings `a` (m notes) and `b` (n notes, each
 * shifted by `shift`), in semitones. Same size: voice i goes to voice i (for
 * sorted notes that pairing is the cheapest). Different sizes: the cheapest
 * monotone path that touches every note of both chords — a voice may split
 * in two or two may merge — so a triad to a seventh costs what the added
 * note travels, not a penalty.
 */
function _cost(a, m, b, n, shift) {
  if (m === n) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(a[i] - (b[i] + shift));
    return sum;
  }
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      const d = Math.abs(a[i] - (b[j] + shift));
      let best;
      if (i === 0 && j === 0) best = 0;
      else if (i === 0) best = _dtw[j - 1];
      else if (j === 0) best = _dtw[(i - 1) * n];
      else {
        best = Math.min(_dtw[(i - 1) * n + j], _dtw[i * n + j - 1], _dtw[(i - 1) * n + j - 1]);
      }
      _dtw[i * n + j] = best + d;
    }
  }
  return _dtw[m * n - 1];
}

/**
 * Semitones of movement from one voicing to another (see _cost). Used to
 * measure voice leading; order of the input notes does not matter.
 */
export function voiceDistance(from, to) {
  const m = Math.min(from?.length || 0, LEAD_MAX);
  const n = Math.min(to?.length || 0, LEAD_MAX);
  if (!m || !n) return 0;
  _load(_a, from, m);
  _load(_b, to, n);
  return _cost(_a, m, _b, n, 0);
}

/**
 * Nearest-inversion voice leading. Given the chord that just sounded
 * (`prev`, MIDI notes) and the next chord (`next`, MIDI notes in their
 * natural register, e.g. straight from chordNotes()), return the inversion of
 * `next` that moves least from `prev`. Sizes may differ (triad → seventh).
 *
 * Candidates are the rotations of `next` (bottom note up an octave, k times),
 * each shifted by whole octaves, keeping only those whose lowest note lies
 * within `range` semitones of `anchor` — plus `next` exactly as given, so
 * leading never moves more than not leading. The window is fixed (default:
 * around the lowest note of `next`; util.leadChord centres it on the part's
 * tonic), not following `prev`, which is what stops a long run of changes
 * drifting up or down: every result has its lowest note in the window or is
 * the natural voicing itself.
 *
 * Deterministic. Ties go to the lowest note nearest the anchor, then to the
 * lower inversion, then to the lower octave. Allocates only the result.
 * Returns MIDI notes sorted low to high. With no `prev`, returns the
 * candidate whose lowest note is nearest the anchor. `next` may be bare pitch
 * classes if you pass `anchor`.
 */
export function voiceLead(prev, next, { range = 6, anchor } = {}) {
  const k = next?.length || 0;
  if (!k) return [];
  if (k > LEAD_MAX) return Array.from(next).sort((x, y) => x - y);
  _load(_b, next, k);
  const home = Number.isFinite(anchor) ? anchor : _b[0];
  const m = Math.min(prev?.length || 0, LEAD_MAX);
  if (m) _load(_a, prev, m);

  let bestCost = Infinity;
  let bestAway = Infinity;
  let bestR = 0;
  let bestO = 0;
  for (let r = 0; r < k; r++) {
    // Rotation r: the lowest r notes go up an octave.
    for (let i = 0; i < k; i++) _c[i] = _b[i] + (i < r ? 12 : 0);
    _sortN(_c, k);
    const low = _c[0];
    let oLo = Math.ceil((home - range - low) / 12);
    let oHi = Math.floor((home + range - low) / 12);
    // `next` as written (rotation 0, no shift) is always in the running.
    if (r === 0) { oLo = Math.min(oLo, 0); oHi = Math.max(oHi, 0); }
    for (let o = oLo; o <= oHi; o++) {
      const shift = 12 * o;
      const cost = m ? _cost(_a, m, _c, k, shift) : 0;
      const away = Math.abs(low + shift - home);
      if (cost < bestCost || (cost === bestCost && away < bestAway)) {
        bestCost = cost;
        bestAway = away;
        bestR = r;
        bestO = o;
      }
    }
  }

  const out = new Array(k);
  for (let i = 0; i < k; i++) _c[i] = _b[i] + (i < bestR ? 12 : 0);
  _sortN(_c, k);
  for (let i = 0; i < k; i++) out[i] = _c[i] + 12 * bestO;
  return out;
}

/** Deterministic PRNG so a given scene always composes the same way. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
