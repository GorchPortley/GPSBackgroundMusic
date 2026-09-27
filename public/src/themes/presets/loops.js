/**
 * Loop presets — ready-made layers for the in-app cue editor.
 *
 * Each preset is a list of ordinary spec layers, exactly what a hand-written
 * cue would carry in its "layers" field. The editor copies them into the cue
 * it saves, so a cue made in the app is an ordinary pack cue: it exports,
 * imports and validates like any other, and does not depend on this file
 * still existing on whoever's phone it ends up on.
 *
 * Every layer is named after its preset's id. That is how the editor knows
 * which boxes to tick when a cue is opened again, and since cue layers are
 * namespaced by cue name, the same preset can sit on any number of cues.
 *
 * Degrees are relative to the current chord, so these stay in key under
 * every theme. `foghorn` is the exception on purpose — a fixed pitch.
 */

export const LOOP_PRESETS = [
  {
    id: 'backbeat',
    name: 'Backbeat',
    layers: [
      // Rim on 2 and 4.
      { name: 'backbeat', voice: 'rim', pattern: '~ ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~ x ~ ~ ~', gain: 0.09 },
    ],
  },
  {
    id: 'jangle',
    name: 'Jangle',
    layers: [
      // The Abbey Road arpeggio from examples/landmarks.json.
      {
        name: 'jangle',
        voice: 'pluck',
        pattern: '[0 2 4] ~ ~ ~ [4 2 0] ~ ~ ~',
        octave: 3,
        gain: 0.06,
        params: { decay: 0.7, bright: 0.85, pan: -0.2, delay: 0.3 },
      },
    ],
  },
  {
    id: 'chime',
    name: 'Chime',
    layers: [
      // <0 4 7>, one note every other bar: the rests take the odd bars.
      { name: 'chime', voice: 'bell', pattern: '<0 ~ 4 ~ 7 ~>', octave: 4, gain: 0.06 },
    ],
  },
  {
    id: 'pulse',
    name: 'Pulse',
    layers: [
      // Eighths, only once there is some energy about.
      {
        name: 'pulse',
        voice: 'pulse',
        pattern: '0*8',
        octave: 2,
        dur: 1,
        gain: 0.06,
        level: ['e', 0.2, 0.5],
        params: { duty: 0.3, cutoff: 1800 },
      },
    ],
  },
  {
    id: 'foghorn',
    name: 'Foghorn',
    layers: [
      // After Golden Gate: a fixed low pitch that ignores the harmony.
      {
        name: 'foghorn',
        voice: 'strings',
        pattern: 'f1@3 ~',
        chordSize: 2,
        gain: 0.05,
        params: { cutoff: 520, vibrato: 0 },
      },
    ],
  },
  {
    id: 'heartbeat',
    name: 'Heartbeat',
    layers: [
      // Two soft thumps a bar, well under the theme.
      { name: 'heartbeat', voice: 'kick', pattern: 'x ~ ~ ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~ ~ ~', gain: 0.16 },
    ],
  },
  {
    id: 'piano',
    name: 'Piano',
    layers: [
      // Sampled upright piano (P5): a slow broken chord, two notes a beat.
      // Until the samples are decoded — or if they cannot be — the voice's
      // FM electric-piano fallback plays the same notes.
      {
        name: 'piano',
        voice: 'sampled',
        pattern: '0 ~ 4 ~ 2 ~ 4 ~ 0 ~ 4 ~ 7 ~ 4 ~',
        octave: 2,
        dur: 2,
        gain: 0.07,
        params: { instrument: 'piano', release: 1.2, reverb: 0.4, delay: 0.1 },
      },
    ],
  },
  {
    id: 'harp',
    name: 'Harp',
    layers: [
      // Sampled concert harp (P5): a rolled chord at the top of each bar,
      // the 32nd-note roll making it read as a harp. Falls back to the
      // Karplus–Strong string (and that to the pluck).
      {
        name: 'harp',
        voice: 'sampled',
        pattern: '[0 2 4 7] ~ ~ ~ ~ ~ ~ ~',
        octave: 2,
        gain: 0.07,
        params: { instrument: 'harp', reverb: 0.5, delay: 0.15 },
      },
    ],
  },
];
