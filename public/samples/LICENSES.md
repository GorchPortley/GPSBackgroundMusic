# Sample sources and licences

Every audio file in this directory comes from **VS Chamber Orchestra:
Community Edition** (VSCO 2 CE) by Versilian Studios — recorded by Sam
Gossner and Simon Dalzell, sample cutting by Elan Hickler / Soundemote.

- Repository: <https://github.com/sgossner/VSCO-2-CE> (branch `master`,
  commit `440300901dfe9275fd84e0b7763af1f8443ae62e`)
- Licence: **CC0 1.0 Universal** (public-domain dedication) —
  <https://github.com/sgossner/VSCO-2-CE/blob/master/LICENSE>,
  <https://creativecommons.org/publicdomain/zero/1.0/>
- Homepage: <http://vis.versilstudios.net/vsco-community.html>

No attribution is required. The authors ask for credit where applicable
("Versilian Studios / Sam Gossner, and/or Ivy Audio / Simon Dalzell") and a
link to the VSCO: CE homepage, and that the samples not be sold on their own.
This credit is given here and in the README.

## Processing

For each file: summed to mono; leading silence cut to 2 ms before the onset
(first sample above 2% of peak), with a 1.5 ms fade-in; cut where a 50 ms RMS
falls 60 dB under the first 200 ms, capped at 6 s (piano) / 5 s (harp); a
0.8 s cosine fade-out; the first 200 ms RMS matched across the set, then one
common gain so the loudest peak is 0.89; encoded as Ogg Vorbis, 44.1 kHz
mono, libsndfile 1.2.2 (`compression_level` 0.6, about 68 kbit/s).

## Files

Upright piano — `Keys/Upright Piano/` ("Upright Piano sampled by Simon Dalzell
of Ivy Audio, Winter 2015-16"; dynamic layer 2 of 3, round robin 1). The
set's `MappingChart.txt` maps file `NNN` to key `21 + 2·NNN`; only the even
files exist, one every 4 semitones.

| File here | Source file | MIDI note |
|---|---|---|
| `piano/piano-33.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_006.wav` | 33 (A1) |
| `piano/piano-37.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_008.wav` | 37 (C#2) |
| `piano/piano-41.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_010.wav` | 41 (F2) |
| `piano/piano-45.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_012.wav` | 45 (A2) |
| `piano/piano-49.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_014.wav` | 49 (C#3) |
| `piano/piano-53.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_016.wav` | 53 (F3) |
| `piano/piano-57.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_018.wav` | 57 (A3) |
| `piano/piano-61.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_020.wav` | 61 (C#4) |
| `piano/piano-65.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_022.wav` | 65 (F4) |
| `piano/piano-69.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_024.wav` | 69 (A4) |
| `piano/piano-73.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_026.wav` | 73 (C#5) |
| `piano/piano-77.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_028.wav` | 77 (F5) |
| `piano/piano-81.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_030.wav` | 81 (A5) |
| `piano/piano-85.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_032.wav` | 85 (C#6) |
| `piano/piano-89.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_034.wav` | 89 (F6) |
| `piano/piano-93.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_036.wav` | 93 (A6) |
| `piano/piano-97.ogg` | `Keys/Upright Piano/Player_dyn2_rr1_038.wav` | 97 (C#7) |

Concert harp — `Strings/Harp/` (mezzo-forte), every other string of the set.

| File here | Source file | MIDI note |
|---|---|---|
| `harp/harp-38.ogg` | `Strings/Harp/KSHarp_D2_mf.wav` | 38 (D2) |
| `harp/harp-41.ogg` | `Strings/Harp/KSHarp_F2_mf.wav` | 41 (F2) |
| `harp/harp-45.ogg` | `Strings/Harp/KSHarp_A2_mf.wav` | 45 (A2) |
| `harp/harp-48.ogg` | `Strings/Harp/KSHarp_C3_mf.wav` | 48 (C3) |
| `harp/harp-52.ogg` | `Strings/Harp/KSHarp_E3_mf.wav` | 52 (E3) |
| `harp/harp-55.ogg` | `Strings/Harp/KSHarp_G3_mf.wav` | 55 (G3) |
| `harp/harp-59.ogg` | `Strings/Harp/KSHarp_B3_mf.wav` | 59 (B3) |
| `harp/harp-62.ogg` | `Strings/Harp/KSHarp_D4_mf.wav` | 62 (D4) |
| `harp/harp-65.ogg` | `Strings/Harp/KSHarp_F4_mf.wav` | 65 (F4) |
| `harp/harp-69.ogg` | `Strings/Harp/KSHarp_A4_mf.wav` | 69 (A4) |
| `harp/harp-72.ogg` | `Strings/Harp/KSHarp_C5_mf.wav` | 72 (C5) |
| `harp/harp-76.ogg` | `Strings/Harp/KSHarp_E5_mf.wav` | 76 (E5) |
| `harp/harp-79.ogg` | `Strings/Harp/KSHarp_G5_mf.wav` | 79 (G5) |
| `harp/harp-83.ogg` | `Strings/Harp/KSHarp_B5_mf.wav` | 83 (B5) |
| `harp/harp-86.ogg` | `Strings/Harp/KSHarp_D6_mf.wav` | 86 (D6) |
| `harp/harp-89.ogg` | `Strings/Harp/KSHarp_F6_mf.wav` | 89 (F6) |
| `harp/harp-93.ogg` | `Strings/Harp/KSHarp_A6_mf.wav` | 93 (A6) |

Total: 34 files, 1,537,919 bytes.

## Adding or replacing samples

Only CC0 / public-domain material, or material whose licence is recorded
here with its attribution, and the whole directory within the size budget
(about 3 MB; HANDOFF §3.1). Steps, on Windows:

1. Put the new files at `public/samples/<dir>/<dir>-<midi>.ogg` — Ogg Vorbis,
   mono, 44.1 kHz, trimmed so the note starts within a few ms and fades out
   at the end (Audacity: Effect → Truncate Silence / Fade Out; File → Export
   Audio → Ogg Vorbis, quality 4–5).
2. Add or edit the instrument in `public/samples/instruments.js`: its `dir`,
   one `[midi, cents]` row per file (cents = how sharp the recording is; 0 if
   unknown), `release`, `level`, `fallback` (`'fm'` or `'string'`) and
   `fallbackLevel`.
3. Add a row per file to the tables above, with source URL and licence.
4. Bump `VERSION` in `public/sw.js`, run `tools/render-check.js` with
   `&samples=1`, then copy `public/` into the Android assets (HANDOFF §3.11).
