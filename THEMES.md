# Writing themes

A **theme** decides what the app plays. It receives a *mood vector* describing
where you are and returns music. Everything else — the places lookup, the mood
analysis, the audio engine, the smooth transitions — is already handled.

There are two ways to write one.

| | **Spec theme** | **Code theme** |
|---|---|---|
| What it is | A plain object with loops in mini-notation | Two JavaScript functions |
| Good for | Written melodies, drum patterns, fixed arrangements | Anything algorithmic |
| Needs JS? | No | Yes |
| Shareable? | Yes — it is data, and travels in a pack | Not safely; it is code |

**Start with a spec theme.** Reach for a code theme only when you need
behaviour a pattern cannot express — a walking bassline that resolves into the
next chord, a motif generated from the location seed.

If what you actually want is "a loop at the gym" rather than a whole theme,
skip to [section 6, cues](#6-binding-loops-to-places).

---

## 1. The mood vector

Everything a theme reacts to arrives as six numbers, each `0..1`:

| | Meaning | Low | High |
|---|---|---|---|
| `e` | **energy** | a cemetery at dawn | a nightclub strip |
| `b` | **brightness** | a subway platform | a garden in sun |
| `d` | **density** | one farmhouse | a shopping street |
| `t` | **tension** | a bakery | a hospital, a courthouse |
| `w` | **warmth** | a car park | a café |
| `s` | **space** | a corridor of shops | open water, a cathedral |

These come from the place types around you (see `public/src/tags.js`), then get
nudged by how built-up it is, how fast you are moving, and the time of day.

You never compute these. You *respond* to them.

---

## 2. Spec themes

A spec is an object. Here is a complete, working one:

```js
export const minimal = {
  id: 'minimal',
  name: 'Minimal',
  description: 'Two chords and a heartbeat.',

  bpm: [70, 110, 'e'],          // 70 when still, 110 when everything is busy
  progressions: [
    { name: 'i — VI', degrees: [0, 5], brightness: 0.4 },
  ],

  layers: [
    { name: 'pad',  voice: 'pad',  pattern: '0', octave: 2, gain: 0.07 },
    { name: 'bass', voice: 'bass', pattern: '0 ~ 0 ~', octave: 0 },
    { name: 'kick', voice: 'kick', pattern: 'x ~ ~ ~ x ~ ~ ~',
      level: ['e', 0.3, 0.4] },  // fades in as energy passes 0.3
  ],
};
```

Register it in `public/src/themes/index.js`, or ship it in a pack.

`public/src/themes/presets/overworld.js` is a fuller worked example — copy that
one to start from something that already sounds like a piece of music.

### Numbers that follow the mood

Anywhere a spec wants a number you may write either a constant, or
`[min, max, dimension]` to interpolate across a mood dimension:

```js
bpm: 120                     // always 120
bpm: [96, 140, 'e']          // 96 when dead quiet, 140 when frantic
cutoff: [800, 6000, 'b']     // opens up in bright places
```

### Layer levels

`level` decides whether a layer is heard at all:

```js
level: 1                     // always at full
level: 0.5                   // always at half
level: ['d', 0.3, 0.4]       // silent below density 0.3, full by 0.7
```

That third form is the one you will use most: it is how a theme grows from a
pad and a bass in a quiet lane to a full arrangement on a busy junction.

### Top-level fields

| Field | Default | Notes |
|---|---|---|
| `id`, `name` | — | Required. `id` must be unique. |
| `description` | | One line, shown in the selector |
| `bpm` | 90 | Tempo |
| `barsPerChord` | 1 | How long each chord lasts |
| `trim` | 1 | Output level vs. other themes. Tune this last |
| `ambience` | 1 | How much of the place's own sound this theme lets through, 0–1 (a plain number). `0` = none. See §9 |
| `rootRange` | `[36, 47]` | MIDI range the tonic is picked from |
| `modes` | all eight | Dark → bright ladder; brightness picks a position |
| `progressions` | one minor loop | See below |
| `drone`, `air` | 0.04, 0.012 | The engine's two continuous beds |
| `droneCutoff`, `airCutoff`, `airQ` | | Tone of those beds |
| `fx` | | `reverbMix`, `reverbSeconds`, `delayMix`, `delayFeedback`, `delayTone` |
| `layers` | — | Required, at least one |

### Progressions

```js
progressions: [
  { name: 'i — VII — VI — VII', degrees: [0, 6, 5, 6], brightness: 0.25 },
  { name: 'I — V — vi — IV',    degrees: [0, 4, 5, 3], brightness: 0.7  },
]
```

`degrees` are scale degrees, `0` being the tonic. The one whose `brightness` is
nearest the scene's gets picked, so list a dark option and a bright option and
the theme will follow the place.

### Modes

Order them dark to bright. Available: `phrygian`, `aeolian`, `harmonicMinor`,
`phrygianDominant`, `minorPentatonic`, `hirajoshi`, `insen`, `dorian`,
`wholeTone`, `octatonic`, `mixolydian`, `lydianDominant`, `ionian`,
`majorPentatonic`, `lydian`, `locrian`.

A narrow list keeps a theme in character — `overworld` deliberately excludes the
dark modes so an overworld tune never turns funereal.

### Layer fields

| Field | Notes |
|---|---|
| `name` | Used for the level; must be unique. `drone` and `air` are reserved |
| `voice` | See the voice table below |
| `pattern` | The loop, in mini-notation |
| `octave` | Octaves above the tonic. `0` is bass, `2` mid, `3–4` melody |
| `gain` | Loudness of this layer. Defaults per voice |
| `level` | When it is audible (above) |
| `dur` | Note length **in steps**, for sustained voices. Defaults to the pattern slot |
| `chordSize` | For `pad`/`strings`: 3 for triads, 4 for sevenths |
| `params` | Extra voice parameters (below), each a constant or `[min,max,dim]` |
| `humanise` | Timing scatter in seconds. Default `0.004`; `0` for machine-tight |

---

## 3. Mini-notation

The loop language is a subset of [TidalCycles](https://tidalcycles.org) /
[Strudel](https://strudel.cc) notation, so their tutorials apply here. The
difference is that patterns are **parsed, not evaluated** — a pattern is a
string, never code, which is what makes a theme safe to accept from a stranger.

**One cycle is one bar of 4/4.** Whatever you write is spread evenly across it.

```
"0 2 4 7"       four notes, one per beat
"0 ~ 4 ~"       ~ is a rest
"[0 2] 4 ~ ~"   brackets subdivide a slot: two notes in the first beat
"<0 4>"         angle brackets alternate — 0 this bar, 4 the next
"0*4"           repeat four times inside the slot
"0@3 7"         @ stretches: 0 lasts three quarters, 7 the last
"0!3 7"         ! repeats across slots: 0 0 0 7
"x ~ x x"       x is a hit, for percussion
"c4 e4 g4"      note names are absolute pitches
```

These nest: `"<[0 2] 4>*2 7"` is valid.

### Euclidean rhythms

`x(k,n)` spreads **k** hits as evenly as possible over **n** slots; a third
number rotates the result left, as in Tidal. Two numbers give you most of the
world's rhythms:

```
"x(3,8)"        x ~ ~ x ~ ~ x ~     tresillo
"x(5,8)"        x ~ x x ~ x x ~     cinquillo
"x(3,8,2)"      ~ x ~ ~ x ~ x ~     tresillo, rotated left by 2
"0(3,8)"        0 ~ ~ 0 ~ ~ 0 ~     works on notes too
"[x(3,8)]*2"    the same rhythm twice per bar
```

It binds to the term just before it, like `*n`, so `"<0 4>(3,8)"` and
`"[0 2](3,8)"` work too. It is expanded when the pattern is parsed — nothing is
evaluated. `n` is capped at 64; `k` of 0 is all rests and `k` ≥ `n` is every
slot. Anything else in parentheses, such as `x(3)`, is reported as an error.

### Numbers are scale degrees, not pitches

`0` is the root of the **current chord**, `2` the third above it, `4` the fifth,
`7` the octave. Negative works: `-2` is a third below.

This is the important idea. Because degrees are relative, one melody follows
the chord progression automatically — write it once and it works over every
chord, in every key, in whatever mode the scene chose.

Use note names (`c4`, `f#3`, `bb2`) only when you want a pitch that ignores the
harmony — a fixed drone, a siren.

### Patterns finer than a sixteenth

The engine ticks in sixteenth notes. Events landing between ticks are offset
within the step rather than stacking, so `"0*32"` articulates properly.

---

## 4. Voices

| Voice | Kind | `params` |
|---|---|---|
| `pad` | chord | `wave` ('sawtooth'/'triangle'), `detune`, `cutoff`, `resonance`, `reverb` |
| `strings` | chord | `cutoff`, `detune`, `vibrato`, `reverb` |
| `bass` | pitched | `cutoff`, `reverb` |
| `pizz` | pitched | `decay`, `cutoff`, `reverb` — plucked upright |
| `pluck` | pitched | `decay`, `bright`, `reverb`, `delay`, `pan` |
| `bell` | pitched | `decay`, `ratio`, `index` — FM. `ratio: 1` is a Rhodes, `2.01` a bell, `1.414` a clang |
| `flute` | pitched | `breath`, `vibrato`, `reverb` |
| `pulse` | pitched | `duty` (0.5 hollow, 0.25 nasal, 0.125 thin), `cutoff`, `resonance`, `glideFrom`, `vibrato`, `pan` |
| `blip` | pitched | `decay`, `duty`, `bend` — short chirps |
| `fm` | pitched | `ratio` (0.25–12, default 2), `index` (0–12, default 2), `decay` (index envelope, s), `release`, `reverb`, `pan` — two-operator FM that holds for `dur`. `ratio: 1` electric piano, `3.5` with `index: 3, decay: 0.4` a bell, `7` glassy |
| `string` | pitched | `decay` (s to fade ~60 dB, 0.05–10, default 1.5), `bright` (0 dull thumb – 1 bright pick, default 0.5), `reverb`, `delay`, `pan` — Karplus–Strong plucked string (an AudioWorklet): guitar, harp, koto, banjo. A one-shot like `pluck`; where AudioWorklet is unavailable it plays `pluck` instead |
| `kick` | drum | `tone` |
| `hat` | drum | `decay` |
| `shaker` | drum | `decay` |
| `rim` | drum | — |
| `clank` | drum | `tone`, `decay` — inharmonic metal |
| `brush` | drum | `decay`, `swirl` |
| `sweep` | drum | `dur`, `from`, `to`, `q` — noise riser |

All are synthesised at runtime; there are no samples. Every voice also accepts
`reverb` and `delay` as send amounts (`0..1`).

---

## 5. Code themes

When a pattern is not enough, write the two functions directly. See
`wanderer.js` (generative), `noir.js` (swing and a walking bass) and
`videogame.js` (motifs generated from the location seed).

```js
export const myTheme = {
  id: 'mine', name: 'Mine', available: true, description: '...',

  // Called every 1.5 s. Turn a mood into a concrete arrangement.
  plan(mood, seed) { return { /* ...plan shape... */ }; },

  // Called once per sixteenth note. Schedule voices.
  step(io, plan, pos) { /* ... */ },
};
```

`pos` gives you `{ step, time, stepDur, barDur, stepInBar, bar, barInPhrase,
phrase }`. `io` is the bundle every voice function takes.

### Three rules the engine relies on

**1. `plan()` must be pure.** Same `(mood, seed)`, same result. It runs every
1.5 seconds; anything drawn from `Math.random` would shimmer. Use the seeded
`rnd(...)` helper from `themes/util.js`.

**2. `step()` may only read fields your own `plan()` wrote.** The engine keeps a
theme and its plan together as a unit — hand one theme's `step` another's plan
and you get NaN note times.

**3. Schedule at `pos.time`, never `ctx.currentTime`.** The scheduler runs
ahead of the clock. Using the current time makes everything late and jittery.

### What the engine does for you

Anything continuous — tempo, filter cutoffs, reverb size, layer levels — glides
to its new value over seconds. Anything discrete — key, mode, chord sequence —
is held until the next four-bar phrase boundary. You return a static
description; the engine handles getting there smoothly.

Return `trim` to balance your theme's loudness against the others. Check it by
rendering offline and comparing RMS, rather than by ear at one volume.

Return `ambience` (0–1, default 1) to scale the place's ambience under your
theme — §9. It glides like any other continuous field.

---

## 6. Binding loops to places

A theme decides how *everywhere* sounds. A **cue** decides how *somewhere*
sounds — extra loops that appear when you are near a particular kind of place,
or a particular one.

This is the answer to "I want a riff at the gym".

```json
{
  "name": "Gym",
  "when": { "tag": ["gym", "fitness_center"] },
  "layers": [
    { "name": "riff",  "voice": "pulse", "pattern": "0 ~ 0 3 ~ 5 ~ 3", "octave": 3 },
    { "name": "stomp", "voice": "kick",  "pattern": "x ~ ~ ~ x ~ ~ ~" }
  ]
}
```

Cues live in a pack, alongside your tag edits and saved places, so they are
shared the same way. `examples/cues-example.json` is a working one — import it
from the Anywhere panel.

You do not have to write cues by hand for the common case. In the Anywhere
panel, **Bind…** on a saved place opens an editor for a `near` cue — name,
radius, a theme to hold while you are there, and any of the loop presets in
`public/src/themes/presets/loops.js` (ordinary spec layers, copied into the
cue). What it saves is exactly the format below plus `"_ui": true`, which only
tells the editor it may offer Edit and Delete; cues without it are shown as
*from pack* and left alone.

### Five ways to say where

| Condition | Matches | Use for |
|---|---|---|
| `{ "tag": "gym" }` | any gym nearby | a kind of place |
| `{ "category": "sport" }` | anything sporty | a broad family |
| `{ "place": "Omega Music" }` | a place whose **name** contains that | a named business |
| `{ "near": { "lat": …, "lng": …, "radius": 120 } }` | that **specific building** | *your* gym |
| `{ "inside": { "polygon": [[lat, lng], …], "edge": 60 } }` | anywhere **inside that shape** | a campus, an odd-shaped park, a neighbourhood |

`{ "any": [ … ] }` ORs a list. Several keys in one condition are ANDed.

`inside` takes 3 to 64 `[lat, lng]` points in order around the shape (don't
repeat the first at the end). It is full strength anywhere inside and fades
to nothing `edge` metres outside the nearest side (default 60). There is no
way to draw one in the app yet — write it in the pack's JSON; the cue list
shows it as *from pack*.

**Conditions return a strength, not a yes/no.** A gym half a street away brings
its riff in quietly; standing outside brings it up full; walking away fades it
out. Nothing snaps on. Tune the ramp with `min` and `full`:

```json
{ "tag": "gym", "min": 0.2, "full": 0.6 }
```

`min` is the weight below which the cue is silent, `full` where it reaches
maximum. Weights are distance- and prominence-weighted and normalised against
the strongest thing present, so `1.0` means "this defines where you are".

### What a cue can do

- **`layers`** — extra loops stacked on top of the current theme. Because
  pattern degrees are relative to the current chord, a cue riff stays in key
  and in tempo under *every* theme. Write it once.
- **`theme`** — pin a theme while you are here, for a place that deserves its
  own genre. Takes over once the cue passes half strength, and releases as you
  leave.

Both together is fine: pin Noir at the record shop *and* add a bell.

### Which cues are firing

Active cues appear as chips under the scene name on the radar, their opacity
tracking strength — so you can watch a loop swell as you approach before you
can clearly hear it.

### Notes

- While cues play, the underlying theme is ducked slightly to make room. A riff
  landing on a full arrangement would otherwise just push the limiter.
- Adding or removing a cue changes what is being played, so it takes effect at
  the next four-bar phrase boundary like any other structural change.
- A `near` cue is checked against your live position, so it keeps tracking you
  between place lookups.
- A broken cue is reported and skipped, never allowed to silence the app. Bad
  voices, malformed patterns and conditions with no test are all caught, and
  the message names the cue and the layer.

### Reacting to places from a code theme

Code themes get the same information. `plan(mood, seed, scene)` receives a
third argument:

```js
plan(mood, seed, scene) {
  const gym = scene.tagWeight('gym');          // 0..1
  const shop = scene.nearest('book_store');    // { name, distance, ... } | null
  const named = scene.named('Omega');          // matching places
  ...
}
```

`scene` also carries `tags`, `categories`, `places` (nearest first) and
`position`. Spec themes get it too — a layer's `when` is exactly this,
evaluated for you.

---

## 7. Sharing

Spec themes and cues travel in a **pack** — the same JSON file that carries
your tag edits and saved places. Export from the Anywhere panel, send the file, they
import it.

Imported themes are validated before use: unknown voices, malformed patterns,
reserved names and id collisions with built-ins are all rejected with a message
naming the layer at fault. A broken theme is skipped, never allowed to take the
audio down with it.

Because a spec is data, importing one cannot execute anything. That is the
whole reason the pattern language is parsed rather than `eval`'d, and the
reason code themes are not shareable this way — if you want someone's code
theme, read it first and add the file yourself.

---

## 8. Where to look

```
public/src/themes/
  index.js              registry; register your theme here
  spec.js               the spec format, its validator, the voice table
  pattern.js            mini-notation parser
  util.js               gate(), quantise(), rnd(), swingOffset()
  cues.js               place-bound loops
  match.js              the condition language (tag / category / place / near)
  presets/overworld.js  worked spec example — copy this one
  wanderer.js           worked code example, the simplest of the five
public/src/
  scenecontext.js       what is actually around you, for `when` and cues
public/src/audio/
  voices.js             every synth voice, with its parameters
  theory.js             scales, chords, progressions, seeded RNG
  engine.js             transport and effects; you rarely need to read this
  ambience.js           the place's own sound (§9)
```

---

## 9. Ambience

Under the music sits a quiet synthesised soundscape that mirrors what is
around you *literally*, where the music expresses its mood. Nothing is
sampled.

| Bed | Comes from | Sound |
|---|---|---|
| birds | category `nature` | short sine chirps, 2.8 ↔ 4.5 kHz, every 0.4–3 s; silent 22:00–05:00 |
| water | category `water` | noise through a slowly wandering 500 Hz band |
| traffic | `transit` + `service`, or a built-up scene (urbanness > 0.6) | low rumble, with a car passing every 6–20 s |
| murmur | `food` + `nightlife` + `retail` | six drifting voice-band noises: a distant crowd |
| rain | weather (not yet wired) | high hiss with sparse drips |

Each bed's level is `category share × 1.6` (capped at 1) × the **Ambience**
slider (next to volume, default 60 %) × the theme's `ambience`. Levels glide
over about 2 s; the whole layer is held more than 18 dB under the music's
peak, so it never changes a theme's balance.

A theme sets how much of this it wants: `"ambience": 0.5` for half,
`"ambience": 0` for none at all — a spec field, or a `plan()` field in a code
theme.
