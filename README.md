# GPS Background Music

Generative background music that scores wherever you happen to be standing.

The app reads your position, asks Google Maps what is around you, turns those
place tags into a **mood vector**, and synthesises a continuous piece of music
from it in the browser. Walk from a park into a station and the score does not
crossfade between two tracks — the same piece darkens, speeds up, loses its
reverb and grows a pulse.

No audio files, no bundler, no npm dependencies.

---

## Quick start

```bash
npm start
```

Stop it with Ctrl+C, or from any terminal:

```bash
npm run stop
```

`npm run restart` does both. `npm run dev` restarts automatically whenever you
edit a file, which is usually what you want while working on a theme.

Open <http://localhost:8787> and press **Play**. No API key, no account, no
signup — place data comes from OpenStreetMap by default.

Search for anywhere in the **Anywhere** panel and you are standing there. That
is the fastest way to hear what this does: try a nightclub strip, then a
cemetery, then a national park.

### Optional: Google Places instead

OpenStreetMap has no popularity signal and thinner coverage outside cities.
Google knows which places people actually go to, which makes busy areas read as
busier. If you want that:

```bash
cp .env.example .env
```

Put a Google Maps Platform key with **Places API (New)** enabled into
`GOOGLE_MAPS_API_KEY` and restart. Enable the *New* one — the legacy "Places
API" is a different product and will not work. Billing must be on, and the key
never reaches the browser.

`PLACES_PROVIDER` forces a source (`osm`, `google`, `mock`); the default picks
Google when a key is present and OpenStreetMap otherwise.

---

## How it works

```
 position ──► nearby places ──► tag profiles ──► mood vector ──► arrangement ──► sound
 geo.js       server/places.js   tags.js          scene.js        themes/         audio/
```

**1. Position** — `navigator.geolocation.watchPosition`, or a simulated loop so
the pipeline can be exercised at a desk.

**2. Places** — the local server proxies Places API *Nearby Search*, caching on a
~110 m grid for 10 minutes so a slow walk does not bill a request per second.

**3. Tags → mood** — every place type maps to a point in six dimensions:

| | meaning | affects |
|---|---|---|
| **energy** | motion and pulse | tempo, percussion, layer count |
| **brightness** | light vs. dark | mode, filter cutoff, register |
| **density** | how much is happening | note density, arpeggio rate |
| **tension** | unease | detuning, chord extensions, mode darkening |
| **warmth** | round vs. cold | waveform choice, filter character |
| **space** | distance and air | reverb size, note length, chord duration |

A plain average washes every neighbourhood back to the middle, so three
correctives run in `scene.js`: opinionated place types are weighted more
heavily than bland ones, the average is pulled toward its most extreme nearby
contributor, and what remains is widened by a logistic contrast curve. Your
speed, how built-up it is, and the time of day are folded in last.

**4. Mood → arrangement** — a *theme* turns the mood vector into a concrete plan:
tempo, key, mode, chord progression, which layers are audible, timbre and
effects. The plan is seeded from a coarse fingerprint of the scene, so the same
kind of place always composes the same way and GPS jitter cannot reshuffle it.

**5. Arrangement → sound** — a look-ahead scheduler drives the theme one 16th
note at a time. Everything is synthesised from oscillators and noise: pads,
bass, plucks, FM bells, percussion, a drone, a noise bed, a procedurally
generated convolution reverb and a tempo-synced delay.

### Nothing jumps

The point is continuity, so changes are split in two:

- **Continuous** qualities (tempo, filter cutoffs, reverb size and mix, layer
  levels) glide toward their targets over seconds. Room size crossfades between
  two convolvers so it can change without a click.
- **Discrete** decisions (key, mode, chord sequence) are held until the next
  4-bar phrase boundary, and the drone glides into the new key rather than
  jumping.

The mood itself is also smoothed toward its target, so a single odd place you
walk past does not yank the music sideways.

---

## Where the places come from

| | Key needed | Coverage | Popularity signal | Cost |
|---|---|---|---|---|
| **OpenStreetMap** (default) | none | excellent in cities, patchy rurally | none | free |
| **Google Places (New)** | yes, plus billing | broad and consistent | review counts | per request |
| **mock** | none | a generated fictional world | synthetic | free |

Both real providers are normalised to the same shape, and every place type —
Google's `italian_restaurant`, OSM's `amenity=restaurant` — is resolved onto one
canonical set of profiles.

Two calibrations exist because the providers differ:

- Google caps a search at 20 results; Overpass returns 100+. The OSM provider
  keeps the nearest 30 so both feed the analysis comparable magnitudes.
- Repeated instances of one type accumulate sub-linearly. Without that, the
  Great Lawn in Central Park — mapped as fourteen separate ball pitches —
  scored as a sports arena rather than a park.

Overpass is a volunteer service. Requests are serialised, spaced, cached for an
hour, and failed over across three mirrors. If it is unavailable the app says
so and reuses a recent nearby lookup rather than inventing places.

---

## Making it yours

### Anywhere

Search a place by name (or paste `lat, lng`) and you are immediately standing
there, whether or not you are playing. Save spots you care about and jump
between them — hearing a churchyard and a nightclub within ten seconds of each
other is the only practical way to judge whether the mapping is any good.

### Tag editor

Tap any tag in **What is around you** to open six sliders — the mood dimensions
for that kind of place. Changes are audible within a second or two, because the
scene is re-analysed on every edit rather than waiting for you to move.

Edits are keyed to the *canonical* type, so tuning `restaurant` moves every kind
of restaurant at once. **Reset to default** restores the shipped value.

### Loops bound to places

A theme decides how everywhere sounds. A **cue** decides how *somewhere*
sounds — extra loops that appear when you are near a kind of place, or a
specific one.

**In the app.** Press **Bind…** on any saved place (or **Bind here…**, which
saves where you are standing first). Give it a name, drag the radius
(50 m – 3 km; the circle is drawn on the radar while the editor is open),
pick a **Theme while here**, tick any loops to lay on top — backbeat, jangle,
chime, pulse, foghorn, heartbeat — and press **Save**. Nothing is written
until you do. If you are standing on the place, you hear it at once.
**Place cues** lists every cue with its live strength and what it does; the
ones you made have Edit and Delete, the ones that came in a pack are marked
*from pack* and are read-only here. A cue made this way is an ordinary pack
cue with `"_ui": true`, so it exports and imports like any other.

**By hand.** A cue is a few lines of JSON in a pack:

```json
{ "name": "Gym",     "when": { "tag": "gym" },                      "layers": [ ... ] }
{ "name": "My gym",  "when": { "near": { "lat": 39.75, "lng": -84.19, "radius": 120 } } }
{ "name": "Omega",   "when": { "place": "Omega Music" }, "theme": "noir" }
```

Conditions return a *strength*, not a yes/no, so a riff swells as you approach
and fades as you leave rather than snapping on. A cue can stack loops onto the
current theme, or pin a different theme entirely. Because pattern degrees are
relative to the current chord, a cue riff stays in key under every theme.

Active cues show as chips under the scene name, their opacity tracking
strength. `examples/cues-example.json` is a working pack to import — see
[THEMES.md](THEMES.md#6-binding-loops-to-places).

### Example packs

`examples/` holds working packs to import from the Anywhere panel.
`landmarks`, `ocarina` and `cues-example` are also bundled in the app under
`public/packs/` (listed in `public/packs/index.json`): pick one from
**Load an example…** in the Anywhere panel — no file picker needed.
`belmont-walk.json` is deliberately not bundled.

| Pack | What it shows |
|---|---|
| `landmarks.json` | Ten famous places, six themes, deliberately unsubtle |
| `cues-example.json` | The three ways to bind a loop to a place, minimal |
| `belmont-walk.json` | Every engine feature exercised on one 30-minute walk |
| `ocarina.json` | Three themes that hand over to each other by region |

`ocarina.json` is the fullest example: an adventure score where a church
becomes a temple, a park becomes woodland, and a shopping street hands over to
a market theme entirely. All music in it is original — see the note at the top
of the file about why it is written in the idiom rather than transcribed.

### Packs

Everything you customise — tag edits, saved places, custom themes, cues, chosen
theme — is one JSON object. It persists locally and **Export pack** writes it to a file you can
hand to someone else; **Import pack** merges one in without deleting what you
already had.

A pack is deliberately *data, never code*. It can retune the music but cannot
execute anything, which is what makes it safe to accept from a stranger.
Imported files are validated field by field: out-of-range values are clamped,
unknown keys dropped, oversized lists truncated.

#### Sharing by link

**Share link** (next to Export) puts the pack *in* a link:
`https://<where the app is>/#pack=<data>`, where `<data>` is the pack's JSON
compressed with raw DEFLATE and base64url-encoded. Choose what goes in —
everything, only what you made here (your cues and tag edits), themes only, or
a single cue — name it, and **Copy share link**. A cue that holds an imported
theme brings that theme along. The panel shows what is included and how long
the link is.

- **Saved places are left out unless you tick them.** They are exact
  coordinates and often include home. Cues bound to a spot are coordinates
  too; the panel names every one that is, so you can pick a narrower choice.
- **Links stop at 8 KB.** A fragment never reaches a server, but chat apps,
  e-mail and share sheets are less forgiving. Every bundled example fits in
  full (landmarks ≈ 4 KB). Past 8 KB the app says so and suggests Export pack.
- **Opening a link** asks first — a shared pack is from someone else — and
  shows its name and what it holds; Cancel imports nothing. The `#pack=` is
  removed from the address straight away, so a reload never imports twice.
  Links that are damaged, cut short, or that would unpack to more than 256 KB
  are refused with a message.
- **Paste** accepts a link, a `#pack=…` fragment or a bare `pack=…` code as
  well as JSON.
- **In the Android app** there is no public address to link to (the app runs
  from `appassets.androidplatform.net`, which exists only on the device), so
  Share link copies a `pack=…` code and opens Android's share sheet. The
  recipient pastes it into **Paste**, or shares it straight to GPS Music.
  Whoever builds the APK can set `PUBLIC_SHARE_BASE` in `public/src/share.js`
  to where `public/` is hosted to get real links instead. Tapping a link does
  not open the app — it opens the web app in the browser.
- Needs `CompressionStream` (Chrome/Edge 103+, Firefox 113+, Safari 16.4+);
  older browsers get a message saying so.

---

## Themes

Five ship, each a genuinely different band rather than the same one re-EQ'd:

| Theme | Sound | Notable machinery |
|---|---|---|
| **Wanderer** | Warm cinematic ambient. The neutral default. | Detuned pads, mallet plucks, FM bells |
| **Sci-Fi** | Cold, wide, mechanical. | Quartal voicings, pulse sequencer with portamento, inharmonic bells, noise sweeps |
| **Video Game** | Bold and driving, chiptune-adjacent. | Seed-generated motif, variable-duty pulse waves, fake third voice via fast arpeggio |
| **Fantasy** | Strings, harp and modal folk. | Bowed saw stacks with delayed vibrato, rolled harp chords, breathy flute |
| **Noir** | Brushed drums, upright bass, rain. | Swing timing, walking bass with chromatic approach notes, rootless Rhodes voicings |
| **Overworld** | Bright looping melody over a walking bass. | A *spec* theme — written as data, not code. The template for your own |

Each interprets the same mood vector, so switching theme mid-walk rescores the
same street. Levels are matched by a per-theme `trim`, so switching does not
jump the volume; the swap itself waits for a phrase boundary.

Everything is still synthesised — the extended voice set (pulse, bowed string,
flute, pizzicato, sweep, blip, metallic clank, brush) lives in
`public/src/audio/voices.js` alongside the originals.

### Writing your own

Two ways, both documented in **[THEMES.md](THEMES.md)**:

**Spec themes** are plain data — chord sequences plus layers whose loops are
written in mini-notation. No JavaScript:

```js
layers: [
  { name: 'tune', voice: 'pulse', pattern: '0 2 4 <7 9> ~ 4 2 ~', octave: 3 },
  { name: 'bass', voice: 'bass',  pattern: '0 ~ 4 ~', octave: 0 },
  { name: 'beat', voice: 'kick',  pattern: 'x ~ ~ ~ x ~ ~ ~', level: ['e', 0.3, 0.4] },
]
```

The notation is a subset of [TidalCycles](https://tidalcycles.org) /
[Strudel](https://strudel.cc), so their tutorials apply. `~` is a rest, `[]`
subdivides, `<>` alternates per bar, `*n` repeats. Numbers are scale degrees
relative to the current chord, so one melody follows the harmony everywhere.

Crucially the notation is **parsed, not evaluated** — a pattern is a string,
never code. That is what lets spec themes travel in a pack and be safe to
accept from a stranger. `presets/overworld.js` is a worked example to copy.

**Code themes** are two JavaScript functions, `plan(mood, seed)` and
`step(io, plan, pos)`. Use one when a pattern cannot express what you want —
Noir's walking bass resolving into the next chord, Video Game's motifs
generated from the location seed.

To teach the app about more places, add entries to `TAG_PROFILES` in
`public/src/tags.js` — or just use the in-app tag editor.

---

## Putting it on your phone

The app installs to a home screen and runs standalone — no desktop, no server.
Every sound is synthesised, place data can come straight from OpenStreetMap,
and a service worker caches the app shell, so an installed copy opens offline.

Whichever route you take, two things are non-negotiable: **HTTPS with a real
certificate**, and a **secure context**. Geolocation needs the first; service
workers refuse to register on an origin with a certificate error, which rules
out the self-signed option below for installing.

### Option 1 — a static host (recommended, no server at all)

`public/` is a complete application. Nothing in it requires the Node server:
when `/api/*` is unreachable, the app queries
[Overpass](https://overpass-api.de) and [Nominatim](https://nominatim.openstreetmap.org)
directly from the browser. Both allow cross-origin requests.

Deploy the folder to any static host — Cloudflare Pages, GitHub Pages, Netlify,
all free — then open the URL on your phone and **Add to Home Screen**.

You get: an app icon, no browser chrome, offline support, and no machine of
yours needs to be switched on. You give up Google's popularity data, so busy
places read a little less busy.

### Option 2 — Tailscale (keeps Google Places)

If you want the Google provider, the server has to be reachable, and Tailscale
gives it a genuinely trusted certificate on your own private network:

```bash
tailscale serve --bg 8787
```

Run the server as `HTTPS=0 npm start`, since Tailscale terminates TLS itself.
Open the `https://<machine>.<tailnet>.ts.net` URL on your phone and install it
from there. Needs *HTTPS Certificates* enabled in the tailnet admin console.

### Option 3 — self-signed on your Wi-Fi (works, but cannot be installed)

```bash
npm run cert && npm start
```

The startup banner prints the address to type on your phone. Tap through the
certificate warning and **live GPS works**. But because the certificate is not
trusted, the browser will not register a service worker, so there is no
install and no offline. Good for testing on the sofa; not the way to carry it.

### What you give up versus a native app

- **Audio stops when the screen locks or you switch apps.** Browsers do not
  reliably keep Web Audio running in the background. The app holds a screen
  wake lock while playing, which keeps it alive but costs battery — plug in for
  a long walk. Fixing this properly needs a native wrapper with a foreground
  service; a PWA cannot.
- On iPhone, Web Audio is silenced by the ringer switch unless the page asks
  for a playback session. It does (iOS 16.4+); on older iOS, take the phone off
  silent.

### Offline behaviour

- The app shell is cached on first load, so it opens with no signal.
- Place lookups are cached too: a route you have walked before replays offline,
  and a dropout mid-walk falls back to the last answer for that spot rather
  than going quiet. The status line says `offline — last known` when it does.
- Somewhere genuinely new with no signal reads as open ground, which is honest
  rather than invented.

---

## Cost

Each lookup is one billed Places *Nearby Search* request. The app is
deliberately frugal:

- it only re-queries after you have moved ~30% of the search radius, or after
  75 seconds
- responses are cached server-side for 10 minutes on a ~110 m grid
- there is a hard 8-second floor between requests

A walk therefore costs roughly one request every minute or two, not one per GPS
tick. Set `PLACES_RADIUS` in `.env` to trade detail against how far ahead the
music reacts.

---

## Layout

```
scripts/
  make-cert.mjs generates the self-signed cert for LAN testing
  stop.mjs      stops whatever is on the port (npm run stop)
server/
  index.js      static/HTTPS server + Places proxy, path-traversal guarded
  places.js     provider selection, grid cache, failure handling
  osm.js        OpenStreetMap Overpass + Nominatim geocoding (keyless)
  net.js        LAN address discovery (cert SANs + startup banner)
public/
  index.html    HUD
  manifest.webmanifest  installable-app metadata
  sw.js         service worker: offline shell + cached lookups
  styles.css
  src/
    main.js     wiring and the two update rates
    geo.js      live + simulated position
    scene.js    places -> mood vector, scene naming
    tags.js     place type -> mood profile table, aliases, user overrides
    store.js    pack persistence, validation, export/import
    share.js    pack links: #pack= encode/decode, size caps
    ui.js       DOM + radar canvas
    audio/
      engine.js   master chain, effects, continuous layers, scheduler
      voices.js   synth voices
      theory.js   scales, chords, progressions
    provider.js   server first, then Overpass/Nominatim direct
    osm-tags.js   OSM tags -> canonical types, shared with the server
    scenecontext.js what is actually nearby, for cue matching
    themes/
      index.js    registry (built-in + imported)
      spec.js     declarative theme format, validator, voice table
      cues.js     loops bound to places
      match.js    the condition language (tag / category / place / near)
      pattern.js  mini-notation parser (Tidal/Strudel subset)
      util.js     seeded rng, gates, swing
      presets/    worked spec examples
      wanderer.js warm ambient (default)
      scifi.js    quartal harmony, pulse sequencer
      videogame.js seed-generated motifs
      fantasy.js  strings, rolled harp, flute
      noir.js     swing, walking bass
      presets/overworld.js  loop-driven spec example
      presets/loops.js      loop presets for the in-app cue editor
tools/
  render-check.js  offline level/NaN check of every theme
  jump-test.js     end-to-end cue/pin timing check
                   (served at /tools/… only when the server runs with DEV_TOOLS=1,
                   along with examples/*.json at /examples/… — never copied into public/)
```

`window.gpsMusic` is exposed for debugging — inspect `currentMood`, `analysis`,
or `engine.level()` from the console.

---

## Privacy

Your coordinates go to two places: the local server, and from there to whichever
place provider is configured — OpenStreetMap's Overpass by default, Google
Places if you supplied a key. Place-name search additionally queries OSM's
Nominatim. When the Weather toggle is on (it is off by default), your
coordinates rounded to two decimal places (about 1 km) also go directly to
Open-Meteo, at most every 15 minutes or few kilometres. When the Hills toggle
is on (also off by default) and your phone's GPS gives no altitude, the
grid points around you at two decimal places (about 1 km apart) go to
Open-Meteo's elevation endpoint, once per grid cell per session. Nothing is stored,
logged to disk, or sent anywhere else, and no audio is recorded. Saved places and tag edits live in your browser's local
storage and are only shared if you export a pack yourself. A share link
carries only what you chose in the share panel — saved places only if you
tick them — and, as a `#` fragment, is never sent to any server by the browser.
