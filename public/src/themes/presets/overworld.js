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
 *
 * It also shows off the song-form tools. Eight four-bar phrases go round as
 * A A B A C A B A: the tune, the tune again, a bridge with a composed line,
 * the tune, then a quieter "clearing" (C) where the drums step back and a
 * music-box bell and a plucked string take over, before the bridge brings the
 * band back in. Every drum layer has a `fill` for the bar before a handover,
 * and the last bar of every fourth phrase breathes.
 */

export const overworld = {
  id: 'overworld',
  name: 'Overworld',
  description: 'Bright looping melody over a walking bass. A worked spec example.',
  color: '#8fdc6a',

  /* --------------------------------------------------------------- global */

  // Fast, and faster still where there is a lot going on.
  bpm: [104, 148, 'e'],
  barsPerChord: 1,
  trim: 0.92,
  rootRange: [38, 47],
  // Outdoors: let the birds and the water through, a little under the band.
  ambience: 0.6,

  // Deliberately narrow and bright — an overworld theme should not go
  // phrygian on you just because you walked past a police station.
  modes: ['dorian', 'minorPentatonic', 'mixolydian', 'ionian', 'majorPentatonic', 'lydian'],

  progressions: [
    { name: 'i — VII — VI — VII', degrees: [0, 6, 5, 6], brightness: 0.25 },
    { name: 'vi — IV — I — V', degrees: [5, 3, 0, 4], brightness: 0.5 },
    { name: 'I — V — vi — IV', degrees: [0, 4, 5, 3], brightness: 0.7 },
    { name: 'I — IV — V — I', degrees: [0, 3, 4, 0], brightness: 0.88 },
  ],

  // Song form (P2): eight four-bar phrases, A A B A C A B A (about a minute
  // at walking pace). The tune and its harmony line play the A phrases. B is
  // a bridge — it moves to the IV chord, turns back through I and V into the
  // next A, and a composed (generated) line takes the melody. C is a
  // clearing: vi — IV — ii — V, thinner (density −0.15), no kit, a music-box
  // bell and a plucked string over a Euclidean tom. Both composed lines are
  // seeded by the place, so every place has its own, and they come back the
  // same each time round. Breath: the last bar of every fourth phrase drops
  // the drums (and the harmony line), the pad rings on.
  form: {
    sections: 'AABACABA',
    breathEvery: 4,
    B: { progression: [3, 3, 0, 4] },
    C: { progression: [5, 3, 1, 4], density: -0.15 },
  },

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
      // four-bar phrase does not feel like a two-bar loop.
      name: 'lead',
      voice: 'pulse',
      pattern: '0 ~ 2 4 ~ <7 9> 4 ~ 2 ~ ~ <4 2> ~ 0 ~ ~',
      sections: 'A',
      octave: 3,
      gain: 0.085,
      dur: 1.6,
      level: ['d', 0.06, 0.34],
      params: { duty: 0.25, cutoff: [2600, 7000, 'b'], resonance: 1.1, release: 0.05 },
    },
    {
      // A third below the lead, entering only once the scene is busy. It
      // sits out the breath bar with the drums, so the gap is audible.
      name: 'harmony',
      voice: 'pulse',
      pattern: '-2 ~ 0 2 ~ <5 7> 2 ~ 0 ~ ~ <2 0> ~ -2 ~ ~',
      sections: 'A',
      breath: true,
      octave: 3,
      gain: 0.042,
      dur: 1.5,
      level: ['d', 0.5, 0.4],
      params: { duty: 0.5, cutoff: [2000, 5200, 'b'], pan: 0.25 },
    },
    {
      // The bridge melody: only in the B phrase, composed for the place
      // rather than written out, in a thinner pulse so it reads as a new
      // voice. Same level curve as the lead, which it stands in for.
      name: 'bridge',
      voice: 'pulse',
      generate: { density: [0.25, 0.55, 'd'], range: [2, 9], leap: [0.1, 0.4, 't'],
        rest: 0.3, contour: [-0.4, 0.6, 'b'] },
      sections: 'B',
      octave: 3,
      gain: 0.08,
      dur: 1.6,
      level: ['d', 0.06, 0.34],
      params: { duty: 0.125, cutoff: [2400, 6000, 'b'], resonance: 1.1, release: 0.06, pan: -0.2 },
    },
    {
      // The clearing's melody: a music-box FM bell (ratio 3.5, a short
      // index decay), composed and sparser than the bridge, high and airy.
      name: 'chime',
      voice: 'fm',
      generate: { density: [0.1, 0.35, 'd'], range: [4, 11], leap: [0.2, 0.5, 't'],
        rest: 0.5, contour: [-0.2, 0.5, 'b'] },
      sections: 'C',
      octave: 3,
      gain: 0.07,
      dur: 1,
      level: ['d', 0.02, 0.3],
      params: { ratio: 3.5, index: [2, 3.2, 'b'], decay: 0.35, release: 1.1, reverb: 0.35, delay: 0.25, pan: 0.15 },
    },
    {
      // Driving eighths, root and fifth — the engine of the whole thing.
      name: 'bass',
      voice: 'bass',
      pattern: '0 4 0 4 0 4 0 4',
      sections: 'AB',
      octave: 0,
      gain: 0.24,
      dur: 1.7,
      level: ['e', 0.02, 0.4],
      params: { cutoff: [380, 760, 'b'] },
    },
    {
      // In the clearing the bass relaxes to a dotted figure. No `dur`: each
      // note lasts its slot, so the two never overlap.
      name: 'bass-c',
      voice: 'bass',
      pattern: '0@3 4',
      sections: 'C',
      octave: 0,
      gain: 0.2,
      level: ['e', 0.02, 0.4],
      params: { cutoff: [340, 640, 'b'] },
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
      sections: 'AB',
      octave: 4,
      gain: 0.03,
      level: ['d', 0.42, 0.4],
      params: { duty: 0.25, decay: 0.05, reverb: 0.14 },
    },
    {
      // Karplus–Strong pluck, the clearing's broken chord: slower and warmer
      // than the chip arp it replaces.
      name: 'strum',
      voice: 'string',
      pattern: '0 4 7 ~ 2 4 7 ~',
      sections: 'C',
      octave: 3,
      gain: 0.06,
      level: ['d', 0.2, 0.4],
      params: { decay: 1.1, bright: [0.35, 0.65, 'b'], pan: -0.25, reverb: 0.25, delay: 0.1 },
    },
    {
      // The kit. Each part has a fill for the bar before a handover lands.
      name: 'kick',
      voice: 'kick',
      pattern: 'x ~ ~ ~ ~ ~ x ~ ~ ~ ~ ~ x ~ ~ ~',
      fill: 'x ~ ~ ~ ~ ~ x ~ x ~ x ~ x ~ x x',
      sections: 'AB',
      gain: 0.34,
      level: ['e', 0.16, 0.36],
    },
    {
      name: 'snare',
      voice: 'rim',
      pattern: '~ ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~ x ~ ~ ~',
      fill: '~ ~ ~ ~ x ~ ~ x ~ x x ~ x x x x',
      sections: 'AB',
      gain: 0.085,
      level: ['e', 0.34, 0.4],
    },
    {
      name: 'hats',
      voice: 'hat',
      pattern: 'x*8',
      sections: 'AB',
      gain: 0.032,
      level: ['e', 0.28, 0.45],
      params: { decay: 0.035 },
    },
    {
      // The clearing's drum: a high tom in a Euclidean 3-in-8 (the tresillo),
      // with a shaker in 5-in-8 against it.
      name: 'tom',
      voice: 'kick',
      pattern: 'x(3,8)',
      fill: 'x(3,8) x(5,8)',
      sections: 'C',
      gain: 0.22,
      level: ['e', 0.1, 0.36],
      params: { tone: 175 },
    },
    {
      name: 'shaker',
      voice: 'shaker',
      pattern: 'x(5,8,2)',
      sections: 'C',
      gain: 0.03,
      level: ['e', 0.3, 0.4],
      params: { decay: 0.07 },
    },
  ],
};
