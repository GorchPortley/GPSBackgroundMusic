/**
 * Bundled sampled instruments (P5) — the manifest.
 *
 * Data only: which instruments ship, which note each file is, and how far
 * that recording sits from equal temperament. A pack names an instrument by
 * its **id** (`params.instrument: "piano"`); it can never name a file, a path
 * or a URL — spec.js `validateSpec` rejects anything that is not a key here,
 * and the URL is built from this table alone (`sampleUrl`).
 *
 * A JS module rather than JSON so it ships under the ".json never in public/"
 * rule and imports like the rest of the app.
 *
 * Every file is from VSCO 2 Community Edition (CC0 1.0), trimmed, summed to
 * mono, loudness-matched and encoded as Ogg Vorbis. Sources and licence:
 * LICENSES.md next to this file.
 *
 * zones: [midi, cents] — the note the file was recorded at, and its measured
 * pitch against that note (the voice detunes by −cents, so the instrument
 * sits in tune with the synths). Measured on the fundamental; below C3 the
 * piano's partials run sharp of its fundamental (stretch), so there it is
 * the mean of the first three partials. Sparse on purpose: the voice picks the
 * nearest zone and shifts by playbackRate, at most ±2 semitones here.
 *
 * fallback: the synth that plays until the buffers are decoded, and for good
 * if they cannot be (see voices.js `sampleVoice`). `level` and
 * `fallbackLevel` scale the sampled note and its fallback so both land at
 * about a `pluck` of the same gain (measured: the first 0.5 s of each note,
 * C3–E5) — the switch is not heard as a jump. `release`: default seconds from
 * the end of the note to silence.
 */

export const INSTRUMENTS = Object.freeze({
  piano: Object.freeze({
    name: 'Upright piano',
    dir: 'piano',
    release: 0.8,
    level: 1.6,
    fallback: 'fm',
    fallbackLevel: 0.28,
    zones: Object.freeze([
      [33, -12.1], [37, -17.5], [41, -7.6], [45, -9.8], [49, -7.0], [53, -2.6],
      [57, -0.7], [61, -0.1], [65, 0.4], [69, 2.5], [73, 4.3], [77, 3.1],
      [81, 4.2], [85, 13.3], [89, 13.7], [93, 17.1], [97, 11.7],
    ]),
  }),
  harp: Object.freeze({
    name: 'Concert harp',
    dir: 'harp',
    release: 1.6,
    level: 1.1,
    fallback: 'string',
    fallbackLevel: 1.0,
    zones: Object.freeze([
      [38, -6.8], [41, -7.6], [45, -6.1], [48, -2.9], [52, -5.2], [55, -9.6],
      [59, -13.5], [62, -12.7], [65, -1.1], [69, -10.7], [72, -11.1], [76, -12.9],
      [79, -3.9], [83, -8.4], [86, -6.9], [89, -6.3], [93, -18.9],
    ]),
  }),
});

export const INSTRUMENT_IDS = Object.freeze(Object.keys(INSTRUMENTS));

/** Is `id` one of the bundled instruments? Own keys only — never a path. */
export function isInstrument(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(INSTRUMENTS, id);
}

/** URL of one zone's file, resolved against this module (dev server and APK alike). */
export function sampleUrl(id, midi) {
  const inst = INSTRUMENTS[id];
  return new URL(`./${inst.dir}/${inst.dir}-${midi}.ogg`, import.meta.url).href;
}
