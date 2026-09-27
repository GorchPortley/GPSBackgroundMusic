/**
 * Overworld — a worked example of a *spec* theme.
 *
 * Nothing here is code. It is a plain object with loops written in
 * mini-notation, and it is the reference for anyone writing their own: copy
 * this file, change the patterns, register it.
 *
 * Where the other themes describe generative rules ("plucks get denser as the
 * street gets busier"), this one has an actual tune. The melody is a fixed
 * loop that follows the chords, which is how game music tends to work — you
 * remember the phrase, not the texture.
 *
 * The mood still does plenty: it picks the mode and the chord sequence, sets
 * the tempo, and decides which layers are audible. A quiet lane gets the pad
 * and a sparse bass; a busy junction gets the full arrangement.
 */

export const overworld = {
  id: 'overworld',
  name: 'Overworld',
  description: 'Bright looping melody over a walking bass. A worked spec example.',

  /* --------------------------------------------------------------- global */

  // Fast, and faster still where there is a lot going on.
  bpm: [104, 148, 'e'],
  barsPerChord: 1,
  trim: 0.92,
  rootRange: [38, 47],

  // Deliberately narrow and bright — an overworld theme should not go
  // phrygian on you just because you walked past a police station.
  modes: ['dorian', 'minorPentatonic', 'mixolydian', 'ionian', 'majorPentatonic', 'lydian'],

  progressions: [
    { name: 'i — VII — VI — VII', degrees: [0, 6, 5, 6], brightness: 0.25 },
    { name: 'vi — IV — I — V', degrees: [5, 3, 0, 4], brightness: 0.5 },
    { name: 'I — V — vi — IV', degrees: [0, 4, 5, 3], brightness: 0.7 },
    { name: 'I — IV — V — I', degrees: [0, 3, 4, 0], brightness: 0.88 },
  ],

  drone: [0.015, 0.05, 's'],
  air: [0.004, 0.016, 's'],
  droneCutoff: [180, 420, 'b'],
  airCutoff: [900, 3400, 'b'],

  fx: {
    reverbMix: [0.08, 0.30, 's'],
    reverbSeconds: [0.8, 2.2, 's'],
    delayMix: [0.10, 0.28, 'd'],
    delayFeedback: 0.22,
    delayTone: [2200, 4800, 'b'],
  },

  /* --------------------------------------------------------------- layers */

  layers: [
    {
      // The tune. `<>` alternates the second half every other bar, so the
      // eight-bar phrase does not feel like a two-bar loop.
      name: 'lead',
      voice: 'pulse',
      pattern: '0 ~ 2 4 ~ <7 9> 4 ~ 2 ~ ~ <4 2> ~ 0 ~ ~',
      octave: 3,
      gain: 0.085,
      dur: 1.6,
      level: ['d', 0.06, 0.34],
      params: { duty: 0.25, cutoff: [2600, 7000, 'b'], resonance: 1.1, release: 0.05 },
    },
    {
      // A third below the lead, entering only once the scene is busy.
      name: 'harmony',
      voice: 'pulse',
      pattern: '-2 ~ 0 2 ~ <5 7> 2 ~ 0 ~ ~ <2 0> ~ -2 ~ ~',
      octave: 3,
      gain: 0.042,
      dur: 1.5,
      level: ['d', 0.5, 0.4],
      params: { duty: 0.5, cutoff: [2000, 5200, 'b'], pan: 0.25 },
    },
    {
      // Driving eighths, root and fifth — the engine of the whole thing.
      name: 'bass',
      voice: 'bass',
      pattern: '0 4 0 4 0 4 0 4',
      octave: 0,
      gain: 0.24,
      dur: 1.7,
      level: ['e', 0.02, 0.4],
      params: { cutoff: [380, 760, 'b'] },
    },
    {
      name: 'chords',
      voice: 'pad',
      pattern: '0',
      octave: 2,
      gain: 0.05,
      chordSize: 3,
      level: 0.7,
      params: { wave: 'sawtooth', detune: 7, cutoff: [900, 2600, 'b'], reverb: 0.3 },
    },
    {
      // Fast broken chord — the trick old sound chips used to fake a third
      // voice out of two.
      name: 'arp',
      voice: 'blip',
      pattern: '[0 2 4]*4',
      octave: 4,
      gain: 0.03,
      level: ['d', 0.42, 0.4],
      params: { duty: 0.25, decay: 0.05, reverb: 0.14 },
    },
    {
      name: 'kick',
      voice: 'kick',
      pattern: 'x ~ ~ ~ ~ ~ x ~ ~ ~ ~ ~ x ~ ~ ~',
      gain: 0.34,
      level: ['e', 0.16, 0.36],
    },
    {
      name: 'snare',
      voice: 'rim',
      pattern: '~ ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~ x ~ ~ ~',
      gain: 0.085,
      level: ['e', 0.34, 0.4],
    },
    {
      name: 'hats',
      voice: 'hat',
      pattern: 'x*8',
      gain: 0.032,
      level: ['e', 0.28, 0.45],
      params: { decay: 0.035 },
    },
  ],
};
