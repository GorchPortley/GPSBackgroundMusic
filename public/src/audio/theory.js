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
