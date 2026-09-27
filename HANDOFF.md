# Handoff guide

How this app works, the rules that must not break, how to verify a change,
and a set of fully specified changes to build next — in the order to build
them.

This is written for whoever picks the project up cold, human or model. If you
are a model: **read sections 1–4 in full before editing anything.** Then take
one change from section 5 at a time, run its acceptance checks, and stop. Do
not refactor beyond a change's stated scope; do not "improve" code you were not
asked to touch. Where this document and a code comment disagree, the comment
is newer — trust it and fix this document.

Existing reference docs, which this guide does not repeat:

- [README.md](README.md) — user-facing: what it is, quick start, phone options, privacy.
- [THEMES.md](THEMES.md) — author-facing: spec format, mini-notation, every voice and its parameters, cues, sharing.
- `Dropbox/GPS Background Music/INSTALL.md` — the APK and the example packs.

---

## 1. What this is

A phone listens to where you are and composes background music for it. Nearby
tagged places (a café, a park, a station) are turned into a six-number *mood*,
a *theme* turns that mood into a musical plan, and a look-ahead scheduler
synthesises every note in the browser with Web Audio. Nothing is sampled,
nothing is downloaded, and nothing ever jumps: continuous qualities glide,
and anything that would clash mid-phrase waits for a boundary.

```
 GPS · simulator · saved place                          public/src/geo.js
        │  {lat, lng, speed, heading}
        ▼
 place lookup  Google Places (server-side key) │ OpenStreetMap Overpass (keyless,
               direct from browser) │ deterministic mock
                                    public/src/provider.js, server/places.js, server/osm.js
        │  places[] with canonical types
        ▼
 analyzePlaces  →  mood {e,b,d,t,w,s}  +  urbanness        public/src/tags.js, scene.js
 buildScene     →  tags / categories / named places, each with a share-of-scene weight
                                                            public/src/scenecontext.js
        │
        ▼
 cues  evaluateCues → strength 0..1 per cue (smoothed, hysteresis)
       pinnedTheme  → a cue may hold a different theme while you are somewhere
       withCues     → adds the cues' loops on top, ducks the base theme
                                                            public/src/themes/cues.js, match.js
        │  a theme: code (plan/step in JS) or spec (plain data compiled by spec.js)
        ▼
 theme.plan(mood, seed, scene)  →  plan {bpm, root, scale, progression, barsPerChord,
                                         layers, timbre, fx, trim, themeId}
 theme.step(io, plan, pos)      →  schedules the notes for one 16th
        │
        ▼
 AudioEngine  look-ahead scheduler → voices.js → dry / reverb / delay buses
              → themeTrim → compressor → makeup → master(volume) → limiter → out
                                                            public/src/audio/engine.js
```

Orchestrating all of it is `App` in `public/src/main.js`: `onPosition` →
`maybeFetchPlaces` → `fetchPlaces` → `replan` every 1.5 s.

The Android app is a bare Java `WebView` wrapper (no Capacitor, no Cordova)
whose only real job is a foreground service so audio and location survive the
screen locking. The web app inside it is a verbatim copy of `public/`.

### The mood vector

Six numbers, each 0–1. Every theme reads these and nothing else about the
world (unless it opts into the `scene`):

| key | name | low | high |
|---|---|---|---|
| `e` | energy | still | driving |
| `b` | brightness | dark, minor | sunny, major |
| `d` | density | sparse | busy |
| `t` | tension | resolved | dissonant |
| `w` | warmth | cold, hard | warm, soft |
| `s` | space | close, dry | vast, wet |

---

## 2. Map of the code

Zero dependencies, no bundler, no build step. Native ES modules in the
browser; Node built-ins on the server. ~9,600 lines total.

| File | Owns | Key exports |
|---|---|---|
| `public/src/main.js` | Orchestration, pack import/export, the replan loop | `App` (also `window.gpsMusic`) |
| `public/src/ui.js` | All DOM. Nothing else touches the DOM | `UI` |
| `public/src/geo.js` | GPS, simulated routes, derived speed/heading | `GeoTracker`, `haversine`, `bearing` |
| `public/src/provider.js` | Picks Google-via-server / Overpass-direct / mock | `fetchPlaces`, `geocode`, `usingServer` |
| `public/src/tags.js` | Place type → mood profile; categories; user overrides | `TAG_PROFILES`, `profileFor`, `categoryFor`, `setTagOverride` |
| `public/src/osm-tags.js` | OSM tag soup → canonical type | `osmType` |
| `public/src/scene.js` | Places → mood. Emphasis, peak-pull, contrast, motion | `analyzePlaces`, `contextualise`, `sceneKey`, `lerpMood` |
| `public/src/scenecontext.js` | The `scene` object cues and code themes query | `buildScene` → `{tagWeight(), categoryWeight(), nearest(), named()}` |
| `public/src/store.js` | Pack load/save/sanitise. **The security boundary** | `sanitise`, `loadPack`, `savePack`, `readPackFile` |
| `public/src/audio/engine.js` | AudioContext, master chain, transport, plan commits | `AudioEngine`, `STEPS_PER_BAR`, `BARS_PER_PHRASE` |
| `public/src/audio/voices.js` | 18 synthesised instruments | `padVoice`, `bassVoice`, `pluckVoice`, `kick`, … |
| `public/src/audio/ambience.js` | Ambience beds under the music (birds, water, traffic, murmur, rain), on `engine.ambienceGain` | `Ambience`, `AMBIENCE_KINDS` |
| `public/src/audio/worklets/ks.js` | Karplus–Strong string processor (AudioWorklet, loaded in `engine.start()`) | registers `karplus-strong` |
| `public/src/audio/theory.js` | Scales, modes, progressions, seeded RNG | `scaleNote`, `chordNotes`, `pickMode`, `mulberry32`, `hashString` |
| `public/src/themes/index.js` | Theme registry, custom spec registration | `getTheme`, `allThemes`, `registerSpecs`, `customSpecs`, `removeCustom` |
| `public/src/themes/spec.js` | Declarative theme format → theme | `VOICES`, `validateSpec`, `themeFromSpec`, `stepLayers` |
| `public/src/themes/pattern.js` | Mini-notation parser and query | `parsePattern`, `queryPattern`, `readValue` |
| `public/src/themes/cues.js` | Place-bound loops and theme pins | `compileCues`, `evaluateCues`, `pinnedTheme`, `withCues` |
| `public/src/themes/match.js` | Cue conditions → strength | `matchStrength`, `validateCondition`, `describeCondition` |
| `public/src/themes/{wanderer,fantasy,scifi,videogame,noir}.js` | Code themes | one theme object each |
| `public/src/themes/presets/overworld.js` | Built-in spec theme | `overworld` |
| `public/src/themes/util.js` | Helpers for theme authors | `gate`, `quantise`, `rnd`, `swingOffset` |
| `public/sw.js` | Service worker: app shell + place-lookup cache | — |
| `server/index.js` | Static files + `/api/config`, `/api/places`, `/api/geocode` | — |
| `server/places.js` | Google Places (New) `searchNearby`; type aliasing | `getNearbyPlaces`, `providerName` |
| `server/osm.js` | Overpass query, bounding-box distance | `overpassNearby`, `geocode` |
| `android/app/src/main/java/dev/gpsmusic/MainActivity.java` | WebView, asset interception, file picker, VIEW/SEND intents, JS bridge `AndroidHost` | — |
| `android/app/src/main/java/dev/gpsmusic/PlaybackService.java` | Foreground service (`mediaPlayback\|location`) with notification | — |
| `examples/*.json` | Shareable packs: `landmarks`, `ocarina`, `belmont-walk`, `cues-example` | — |
| `tools/render-check.js`, `tools/jump-test.js` | Verification harnesses (see §4) | — |

A **pack** is one JSON file: `{ version, _about, tagOverrides, theme,
locations, themes, cues }`. It is the unit of sharing and the only thing a
user ever imports.

---

## 3. Invariants — the rules that are easy to break

Each rule says *what*, *why*, and *how you would notice it broke*. Several of
these were learned by breaking them.

### 3.1 Zero dependencies, no build
No npm packages, no bundler, no transpiler. `package.json` has scripts only.
*Why:* the whole app is copied verbatim into the APK and served from a
service worker; a build step would make every phone deploy a two-stage job,
and Strudel-style runtime dependencies bring their own audio engine (~825 KB)
and arbitrary code execution. *Noticed by:* `node_modules/` appearing.

### 3.2 Packs are data, never code
Patterns are **parsed**, not evaluated. Never `eval`, `new Function`, dynamic
`import()` of pack content, or reading a pack field as a property path.
Everything a pack carries goes through `sanitise()` in `store.js` (clamps
ranges, drops unknown/oversized fields, rejects `__proto__` / `constructor` /
`prototype`), then `validateSpec` / `validateCue`. Limits: 40 themes, 100
cues, 64 KB per theme. *Why:* the stated goal is that packs from strangers are
safe. *Noticed by:* a pack field reaching a voice or the DOM without passing
through those functions.

### 3.3 Plan and step travel as a pair
Call `engine.applyPlan(plan, stepFn)`. Never assign `engine.plan` or
`engine.stepFn` separately, and always set `plan.themeId` (main.js `replan`
does). *Why:* the worst bug in this project's history was a step function from
the *new* theme running against the *old* plan → `plan.swing` undefined → NaN
note times → silence. `_commit(plan, stepFn)` exists so that cannot recur.
*Noticed by:* NaN in `tools/render-check.js`, or "Failed to execute 'start'"
in the console.

### 3.4 Continuous vs discrete plan fields
Continuous fields (bpm, fx, timbre, trim, layer levels) take effect at once
via `setTargetAtTime` in `_applyContinuous`; `ambience` is continuous too,
folded into the ambience levels by main.js (`updateAmbience` → `setAmbience`);
so is `cuePans` (spatial cues, C3.5), glided on per-cue panners by `_applyCuePans`. Discrete fields (`themeId`,
`root`, `scale`, `progression`, `barsPerChord`) wait for a phrase boundary —
see `isDiscreteChange` at the bottom of engine.js. `form` (C3.7 breath) is a
theme constant: it only changes with `themeId`, so it rides that discrete
change and needs no entry of its own; `step` reads it from the sounding plan. **If you add a plan field,
decide which bucket it is in and wire it accordingly.** Cue membership is
deliberately *not* discrete (the comment in `replan` explains why: it would
hold the cue until the boundary and then drop it in at full volume).
*Noticed by:* a click or key clash on change (should have been discrete), or a
change that takes 15 s to be heard (should have been continuous).

### 3.5 Urgency is sticky
`applyPlan(plan, step, { urgent: true })` commits at the next **bar** instead
of the next 4-bar **phrase**. It is set only on the jump path: `goTo()` arms
`pendingJump`; `fetchPlaces` converts it to `snapCues` once the new scene has
actually arrived; `replan` consumes it. In the engine, urgency persists in
`_pending` until the change commits, because position ticks re-call
`applyPlan` every second with `urgent: false`. A pending change is dropped
if a later `applyPlan` matches what is already playing (you went back), and
so is the handover riser scheduled for it (C3.6; `reverbReturn` is only ever
automated through `_setReverbReturn`). *Noticed by:* the jump test
showing 12–16 s instead of 1–3 s.

### 3.6 Cues are strengths, not booleans
`matchStrength` returns 0–1 and `evaluateCues` smooths it (`CUE_SMOOTHING`
0.25 per tick, or snapped on a jump). Theme pins latch with hysteresis:
`PIN_ON` 0.55 to take over, `PIN_OFF` 0.32 to release. Do not add an
`active: true/false` flag anywhere. *Why:* pin/release both at 0.5 produced
four theme flips in 500 m of walking. *Noticed by:* thrashing between themes
at a boundary.

### 3.7 Spec `params` pass through untouched unless numeric
In `spec.js`, `extras[k] = (typeof v === 'number' || Array.isArray(v)) ?
num(v, mood, 0) : v`. Strings such as `wave: 'sawtooth'` and booleans such as
`swirl: true` must survive. *Why:* coercing `'sawtooth'` to `0` made Chrome
silently leave the oscillator on `sine` — the overworld pad was the wrong
waveform for weeks and nobody could tell why. *Noticed by:* a voice sounding
"default" no matter what the spec says.

### 3.8 Voice contract
Every voice is `voice(io, { time, ... })`. It schedules at `time` (never at
`ctx.currentTime`), connects to `io.dry` and optionally sends to `io.reverb` /
`io.delay`, and **stops every oscillator and disconnects** after the note
(`osc.stop(time + dur + tail)`). Adding a voice means: the function in
`voices.js`, a row in `VOICES` in `spec.js` (`kind` = chordal / pitched /
unpitched, default `gain`), and a row in THEMES.md §4 listing its params.
*Noticed by:* CPU climbing over minutes (leaked nodes), or notes landing late.

### 3.9 Level discipline
Each theme declares `trim` so all themes reach the compressor at roughly the
same level; target ≈ −3 dBFS peak in `tools/render-check.js`, spread across
themes ≤ ~4 dB. Fix a loud or quiet theme with **its** `trim`, never by
touching makeup (1.65), the compressor, or the limiter (−1.5 dB, 20:1). A
theme pinned at −0.4 dB is riding the limiter and will pump.

### 3.10 Secure context
`getUserMedia`-class APIs — geolocation, service worker, and AudioWorklet —
need HTTPS or `localhost`. The dev server serves HTTPS when `certs/` exists;
the APK serves assets through the intercepted origin
`https://appassets.androidplatform.net`. The server binds all interfaces;
do **not** add a `0.0.0.0` host argument (it is IPv4-only and `localhost`
resolves to `::1` on Windows). If `.env` contains `HTTPS=0` the server serves
plain HTTP and phone GPS silently fails — the server warns at startup.

### 3.11 Ship list
Anything new under `public/` must be added to `SHELL_FILES` in `public/sw.js`
and `VERSION` bumped, or the installed PWA/APK keeps serving the old shell.
The Android assets are a verbatim copy:
`rm -rf android/app/src/main/assets/www && mkdir -p … && cp -r public/* android/app/src/main/assets/www/`
then rebuild. Nothing named `dev-*.js` or any `.json` belongs in `public/`
when you build.

### 3.12 Windows tooling
This project lives on Windows 10 and is driven from Git Bash + PowerShell.
- Python wants Windows paths: `r'C:\Users\…'`, never `/c/Users/…`.
- Do **not** write large JS via `cat > file <<'EOF'` — it has silently
  truncated files. Use the Write tool or a small Python patch script.
- `android/local.properties` must use forward slashes (`\U` is an invalid
  properties escape).
- Build with `.\gradlew.bat --no-daemon assembleDebug` from `android/`
  (PowerShell). There is no global `gradle`.
- The tablet used for device testing is a Galaxy Tab A at `192.168.1.16:5555`
  over ADB Wi-Fi. Always `adb uninstall dev.gpsmusic` and remove pushed files
  afterwards.

### 3.13 Secrets and private data
The Google key lives only in `.env` and is read server-side; the browser gets
`/api/config` without it. Never print its value (print its length if you must
check it). `examples/belmont-walk.json` contains the author's **home
coordinate** in its "Home" cue — never copy that coordinate into another pack,
a doc, or a test.

### 3.14 Async lookups must be guarded
`fetchPlaces` increments `fetchSeq` and discards any response that has been
overtaken. Any new async data source (weather, elevation, …) must follow the
same pattern or a stale response will clobber a newer one — that is exactly
how "Sweet Retreat never fires" happened.

### 3.15 Nothing pops
The product promise. Any new sound-affecting feature either glides
(`setTargetAtTime`, ~0.5–3 s) or waits for a bar/phrase boundary. Test by
jumping between two saved places with headphones on.

---

## 4. Workflow and verification

### Servers

```bash
npm start                      # HTTPS on 8787 when certs/ exists; Google if key in .env
PORT=8788 HTTPS=0 PLACES_PROVIDER=osm node --env-file-if-exists=.env server/index.js   # plain HTTP test server
npm run stop                   # kills whatever is on the port
```

Open `http://localhost:8788` in the built-in browser for automated checks;
`https://<desktop>:8787` from the phone.

### After every code change

```bash
for f in public/src/main.js public/src/audio/engine.js public/src/ui.js public/src/themes/*.js; do node --check "$f" || echo "FAIL $f"; done
node -e "for (const f of require('fs').readdirSync('examples')) JSON.parse(require('fs').readFileSync('examples/'+f,'utf8'))" && echo packs parse
```

### Render check — after touching `public/src/audio/*` or any theme

Follow the header of [tools/render-check.js](tools/render-check.js). Pass
means `window.__R.pass === true` and `spreadDb` ≲ 4. This is the check that
catches NaN note times, leaked gain, and level mismatches. Run it against
`allThemes()` (no `?pack=`) **and** against `examples/landmarks.json`.

### Jump test — after touching cues, match, scene, main.js, or engine commits

Follow the header of [tools/jump-test.js](tools/jump-test.js). Known-good
expectations:

```
landmarks.json: Eiffel=paris;Broadway=broadway;Shibuya=neon;Colosseum=ancient;Grand Canyon=vast;White House=stately;Golden Gate=vast;Sydney=stately;Machu=ancient;Abbey=wanderer
ocarina.json:   Dot=market-town;Church=temple;Sweet Retreat=market-town;Belmont Park=hyrule-field
```

All rows should land in 1.2–3.3 s. Run it on a **clean page** —
`localStorage.clear()` then reload — or cues from the previous pack leak in.

### Listening — before shipping anything audible

Automated checks cannot hear. Put headphones on, load `landmarks.json`, and
tap Eiffel Tower → Colosseum → Abbey Road. You should hear a waltz, then a
handover within a few seconds to low drums with no click, then a backbeat
appear over the base theme without the theme changing.

### APK

```powershell
Set-Location android; .\gradlew.bat --no-daemon assembleDebug
```

Then prove the new code is *inside* the APK, not just in the tree:

```bash
python -c "import zipfile;z=zipfile.ZipFile(r'android\app\build\outputs\apk\debug\app-debug.apk');print(b'YOUR_NEW_IDENTIFIER' in z.read('assets/www/src/main.js'))"
```

Deliver as `Dropbox/GPS Background Music/GPSMusic-<ver>-debug.apk`, remove
the previous version, update `INSTALL.md`'s install line and changelog.

### On-device (when the change touches Android or background behaviour)

```bash
adb connect 192.168.1.16:5555 && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell dumpsys activity services dev.gpsmusic | grep -i foreground     # expect isForeground=true while playing
adb shell dumpsys audio | grep -A2 "dev.gpsmusic"                         # expect state:started 60 s after screen off
adb shell dumpsys power | grep -i "dev.gpsmusic"                           # expect no wake lock held by the app
adb uninstall dev.gpsmusic
```

---

## 5. Specified changes

Ordered by dependency and by value to the person using the app. Within a
tier, order is a recommendation. Each has **Goal / Why / Where / Steps /
Accept / Don't**. Estimates are rough sizes, not promises.

Format for a model: do the Steps literally, then run every line under Accept.
If an Accept line fails, fix it before moving on; do not start the next change
with a failing one behind you.

---

### Tier 0 — Foundation (do these first; they make everything else safe)

#### C0.1 Put the project under git
**Goal.** A rollback point before any further change.
**Why.** There is no repository. Every later change should be one commit.
**Steps.**
1. `.gitignore` currently covers only `.env`, `node_modules/`, `*.log`,
   `.DS_Store`, `certs/`. Append these lines first — the Android build tree is
   large and `local.properties` holds a machine-specific SDK path:
   ```
   android/.gradle/
   android/build/
   android/app/build/
   android/local.properties
   ```
2. `git init && git add -A && git commit -m "Baseline: GPS Background Music 0.3"`.
**Accept.** `git status` clean; `git ls-files | grep -cE "^\.env$|^certs/|local\.properties|/build/"` prints 0;
`git ls-files | grep -c "assets/www/src/main.js"` prints 1 (the asset copy *is* tracked — it is what ships).

#### C0.2 Serve the dev tools without staging them into `public/`
**Goal.** `tools/*.js` reachable at `/tools/…` when the server is started with
`DEV_TOOLS=1`, never otherwise.
**Why.** Today a check means copying into `public/`, which risks shipping the
harness in the APK (§3.11). One env flag removes that risk.
**Where.** `server/index.js` (`serveStatic`), `README.md` §Layout, headers of both tools.
**Steps.**
1. In `server/index.js`, before `serveStatic`, add: if `process.env.DEV_TOOLS === '1'` and `url.pathname.startsWith('/tools/')`, serve from `tools/` (same path-traversal guard as `serveStatic`, `Content-Type: text/javascript`), and also serve `/examples/*.json` from `examples/`.
2. Add `DEV_TOOLS=` to `.env.example` with a one-line comment.
3. Update both tool headers: load as `/tools/render-check.js?pack=/examples/landmarks.json`; delete the "cp into public/" steps.
**Accept.** With the flag: `curl -s localhost:8788/tools/jump-test.js | head -1` is the comment line; without the flag: 404. `curl localhost:8788/tools/../server/index.js` is 404 either way.
**Don't.** Don't serve `tools/` from the same handler as `public/` by default.

#### C0.3 Bundle the example packs in the app
**Goal.** A "Load an example…" `<select>` in the Anywhere panel that imports
`landmarks`, `ocarina`, `cues-example` without any file picker.
**Why.** The user has hit import friction three times (file picker, EACCES,
paste). New users will hit it on minute one. The packs are ours; they are
already vetted; they should be one tap.
**Where.** `public/index.html` (near `#importPack`), `public/src/ui.js`,
`public/src/main.js` (`importPackText` already exists), `public/sw.js`,
a new `public/packs/` directory, `README.md` §Example packs.
**Steps.**
1. Copy `examples/landmarks.json`, `examples/ocarina.json`,
   `examples/cues-example.json` to `public/packs/`. **Not** `belmont-walk.json` (§3.13).
2. Add a tiny `public/packs/index.json`: `[{ "file": "landmarks.json", "name": "World landmarks", "blurb": "Ten famous places, six themes" }, …]`.
3. UI: a `<select id="examplePacks">` with a disabled first option "Load an example…"; on change → `fetch('/packs/' + file)` → `app.importPackText(text)` → reset the select → status line "Imported <name> — N places added under Anywhere".
4. Add `/packs/index.json` and the three pack files to `SHELL_FILES`; bump `VERSION` to `v2`.
5. Copy to Android assets (§3.11) when you next build.
**Accept.** Fresh page (`localStorage.clear()`, reload): pick "World landmarks"; `#savedList` shows 10 entries; theme selector lists the 6 new themes; jump test still passes. `belmont-walk` is not in `public/packs/`.

---

### Tier 1 — Custom geofencing (the user's explicitly requested next sprint)

The engine already supports geofences: a cue with `when.near = { lat, lng,
radius }` fires with strength that rises as you approach the centre. What is
missing is (a) a way to *make* one in the app instead of by hand in JSON, and
(b) optionally, waking the app when you cross one while it is idle. Build (a)
first; it is the whole feature for someone who presses Play before walking.

#### C1.1 In-app cue editor — "Bind something to this place"
**Goal.** From a saved place (or the current position), create, edit and
delete a cue: name, radius, and what it does — pin a theme, add a loop preset,
or both.
**Why.** This is what the user means by custom geofencing. Everything
downstream already exists.
**Where.** `public/index.html`, `public/styles.css`, `public/src/ui.js`,
`public/src/main.js`, new `public/src/themes/presets/loops.js`, `README.md`
§Loops bound to places, `THEMES.md` §6 (one paragraph pointing to the UI).
**Steps.**
1. **Loop presets.** Create `public/src/themes/presets/loops.js` exporting
   `LOOP_PRESETS`: an array of `{ id, name, layers }` where `layers` are
   ordinary spec layers. Ship six: `backbeat` (rim on 2 and 4), `jangle`
   (pluck arpeggio, from Abbey Road in landmarks.json), `chime` (bell `<0 4 7>`
   every 2 bars), `pulse` (pulse voice 8ths, `level: ["e", 0.2, 0.5]`),
   `foghorn` (strings `f1@3 ~`, fixed pitch, from Golden Gate), `heartbeat`
   (kick `x ~ ~ ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~ ~ ~` quiet). Validate each through
   `validateSpec` by wrapping in a throwaway theme in a test; they must all pass.
2. **Data.** A cue made in the UI is an ordinary pack cue:
   `{ name, when: { near: { lat, lng, radius } }, theme?, layers?, _ui: true }`.
   `_ui` lets the editor show it as editable; hand-written cues are read-only
   in the UI (show a "from pack" tag). Add `_ui` to the allow-list in
   `sanitise()`.
3. **Entry points.** Each row in `#savedList` gets a "Bind…" mini button; the
   "+ Save this spot" area gets "Bind here…" that saves the spot first.
4. **Editor panel** (a `<details>`/dialog under the saved list): name (default
   the place name), radius slider 50–3000 m (log scale, show metres),
   "Theme while here" select (— none — plus every theme), loop preset
   checkboxes (multi), Save / Delete / Cancel. While the editor is open, draw
   the radius as a circle on `#radar` (the canvas already scales places by
   distance; reuse that scale) so the size is visible.
5. **Save** → push/replace in `this.pack.cues`, `savePack`, `this.cues =
   compileCues(this.pack.cues)`, `replan(true)`. Snap the cue if the editor
   was opened from the current position (`this.snapCues = true` before replan)
   so the user hears the result immediately.
6. **Cue list.** Under the editor, list every cue with its strength bar
   (reuse the `#cueStrip` styling), the describeCondition text, and Edit/Delete
   for `_ui` cues.
7. Docs: README §Loops bound to places gets the UI path first, JSON second.
**Accept.** Save "Gym" at a saved place with radius 150 m, theme `scifi`,
preset `pulse`; the theme-held line appears within 3 s; leave (jump elsewhere)
and it releases; export pack → the cue is present and re-imports; jump test
and render check still pass; `describeCondition` renders the new cue.
**Don't.** Don't invent a new cue format — it must round-trip through the
existing `validateCue`/`sanitise` unchanged. Don't let the editor write
lat/lng of the *device* into a cue without the user pressing Save.

#### C1.2 Polygon fences (optional, after C1.1)
**Goal.** `when.inside = { polygon: [[lat,lng], …] }` — for a campus, a park
with an odd shape, a whole neighbourhood.
**Where.** `match.js` (`matchStrength`, `validateCondition`,
`describeCondition`), `store.js` (`sanitise` allow-list, cap 64 vertices),
`THEMES.md` §6 "Four ways to say where" → five.
**Steps.** Ray-casting point-in-polygon on lat/lng treated as planar (fine at
neighbourhood scale). Strength = 1 inside, falling to 0 over an `edge`
distance (default 60 m) outside, using minimum distance to any edge in metres
(`haversine` on the projected foot of the perpendicular; or simply the nearest
vertex/edge-midpoint if you want to stay simple — say which in a comment).
Editor (C1.1) gets a "Draw polygon" mode later; JSON only for now.
**Accept.** Unit-style checks in the console: a square around a point returns
1 inside, ~0.5 at 30 m outside an edge, 0 at 200 m. Jump test unchanged.

#### C1.3 Wake the app when a fence is crossed (optional; needs Play Services)
**Goal.** With the app closed, walking into a `near` cue that pins a theme
starts playback.
**Why it is optional.** While playing, the foreground service already keeps
location flowing and the polling path handles fences fine. This only adds
"auto-start", and it costs a Google dependency (`com.google.android.gms:
play-services-location`) in a project that has none. Ask the user before
doing it.
**Where.** `android/app/build.gradle.kts`, `AndroidManifest.xml`, new
`GeofenceReceiver.java`, `MainActivity.java` (register on pack change via a
new bridge method `AndroidHost.setFences(json)`), `main.js` (call it from
`applyPack` with every cue that has `near` **and** `theme`, max 100).
**Steps.** `GeofencingClient.addGeofences` with `ENTER` transitions,
`loiteringDelay` 0; receiver starts `PlaybackService` and launches
`MainActivity` with an extra `autoplay=true`; main.js reads that flag from
the bridge and calls `togglePower()` after the first position. Background
location permission is already requested.
**Accept.** On the tablet: force-stop app, `adb emu geo fix` is unavailable on
a real device — instead use "Anywhere → Go" is not applicable either; test by
walking or by a mock-location app. Document the result honestly if it could
not be verified.

---

### Tier 2 — Behaving like a real phone app

#### C2.1 Audio focus
**Goal.** Pause on a phone call or another app playing; duck under
notifications; resume after a transient loss.
**Where.** `PlaybackService.java` (request focus in `onStartCommand`, abandon
in `onDestroy`), `MainActivity.java` (`Bridge` → new JS calls),
`public/src/main.js` (new methods `hostPause()`, `hostResume()`,
`hostDuck(on)`).
**Steps.** `AudioManager.requestAudioFocus` with `AudioAttributes` USAGE_MEDIA
/ CONTENT_TYPE_MUSIC, `AUDIOFOCUS_GAIN`. Listener: `LOSS` → JS `hostPause()`
(calls `togglePower()` only if playing, remembers nothing); `LOSS_TRANSIENT`
→ `hostPause()` and remember `resumeOnGain = true`; `LOSS_TRANSIENT_CAN_DUCK`
→ `hostDuck(true)` which does `engine.setVolume(vol * 0.25)` with a 0.3 s glide
and restores on `GAIN`. Web side: also register `navigator.mediaSession`
handlers for `play`/`pause` (see C2.2).
**Accept.** On the tablet: start playback, play a YouTube video → music
pauses; stop the video → nothing resumes (permanent loss); set an alarm →
music ducks and returns. `dumpsys audio` shows the focus owner.

#### C2.2 Media controls
**Goal.** Play/Pause in the notification and from headset buttons; the
notification shows the scene name.
**Where.** `PlaybackService.java` (`buildNotification`: add Play/Pause action
with a `PendingIntent` to the service; a `MediaSessionCompat` is not available
without AndroidX — use `android.media.session.MediaSession` from the platform),
`MainActivity.Bridge.setScene` already carries the text, `main.js`
(`navigator.mediaSession.metadata` + action handlers).
**Accept.** Lock the tablet; the notification shows "Now playing: <scene>"
with Pause; pressing it pauses; headset play/pause toggles.

#### C2.3 Adaptive GPS and lookups when stationary
**Goal.** Cut battery when the phone is not moving.
**Where.** `public/src/geo.js` (`GeoTracker`), `main.js`
(`maybeFetchPlaces` already scales interval with speed).
**Steps.** In `GeoTracker`, track `stationarySince`. After 120 s with speed <
0.5 m/s and position within `accuracy` of the last, re-`watchPosition` with
`{ enableHighAccuracy: false, maximumAge: 15000, timeout: 30000 }`. On any
movement > 25 m, switch back to the high-accuracy options immediately. Emit
`{ …, mode: 'coarse' | 'fine' }` and show it in the accuracy readout.
**Accept.** In the simulator at pace 0 the readout flips to "coarse" after 2
min and back within one tick of moving. On device: `dumpsys batterystats`
shows fewer GPS wakeups over a 20-minute stationary run vs the current build
(record both numbers in INSTALL.md).
**Don't.** Never stop the watch entirely while playing — a cue crossing must
still be seen.

---

### Tier 3 — Sound and generation

These are the changes that make the music *better*, roughly ordered by
(value ÷ effort). C3.1 and C3.2 are small and should come first.

#### C3.1 Euclidean rhythms in the mini-notation
**Goal.** `x(3,8)`, `0(5,8)`, `x(3,8,2)` — k hits spread as evenly as possible
across n slots, optionally rotated. This is Tidal's `bd(3,8)`; it generates
the majority of the world's rhythms (tresillo, cinquillo, bossa) from two
numbers.
**Where.** `public/src/themes/pattern.js` (`tokenise`, `parseSequence`),
`THEMES.md` §3, one preset in C1.1 could use it.
**Steps.**
1. Tokeniser: add an alternative to the regex for `\((\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+))?\)`
   producing `{ type: 'euclid', k, n, rot }`. It must bind to the preceding
   word like `*n` does.
2. Expansion: replace the word with a subdivision node of `n` slots where slot
   i is the word if `bjorklund(k, n)[(i + rot) % n]` is 1 and a rest
   otherwise (rotate left by `rot`, matching Tidal). Use this exact algorithm —
   it is easy to get subtly wrong:

   ```js
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
   ```
3. `describePattern` should print the expansion.
**Accept.** In the console, `describePattern('x(3,8)')` ≡ `x ~ ~ x ~ ~ x ~`;
`x(5,8)` ≡ `x ~ x x ~ x x ~`; `x(3,8,2)` ≡ `~ x ~ ~ x ~ x ~`; `x(0,4)` is
four rests; `x(4,4)` four hits; `[x(3,8)]*2` parses. Render check unchanged.
**Don't.** Don't evaluate anything; this is pure expansion at parse time.

#### C3.2 FM voice
**Goal.** A two-operator FM voice — bells, electric piano, glassy sci-fi
tones — built from native nodes (modulator → gain → carrier.frequency).
**Where.** `voices.js` (`fmVoice`), `spec.js` `VOICES` row `fm: { kind:
'pitched', gain: 0.08 }`, THEMES.md §4.
**Steps.** Params: `note, time, dur, gain, ratio = 2 (mod/carrier freq
ratio), index = 2 (peak modulation depth, in multiples of carrier freq), decay
= 0.6 (index envelope seconds), release = 0.3, reverb = 0.3, pan = 0`. Carrier
sine → env gain → (pan) → dry; modulator sine at `f * ratio` → gain node whose
`gain` = `index * f` decaying exponentially to `index * f * 0.05` over `decay`
→ connect to `carrier.frequency`. Stop both oscillators at `time + dur +
release + 0.1`. Clamp `ratio` 0.25–12, `index` 0–12 in the voice.
**Accept.** Render check with a throwaway spec using `fm` at ratio 1, 2, 3.5,
7: no NaN; audible bell character at `ratio: 3.5, index: 3, decay: 0.4`.

#### C3.3 Karplus–Strong plucked string (AudioWorklet)
**Goal.** A physically-modelled string — the single biggest realism jump
available for guitars, harps, koto, banjo — replacing filtered-sawtooth plucks
where a theme asks for it.
**Where.** New `public/src/audio/worklets/ks.js`; `engine.js` (`start()`: `await
ctx.audioWorklet.addModule('/src/audio/worklets/ks.js')` **before** `_build`,
wrapped in try/catch; set `this.hasWorklets`); `voices.js` (`ksVoice`, which
falls back to `pluckVoice` when `!io.hasWorklets`); `spec.js` `VOICES` row
`string: { kind: 'pitched', gain: 0.10 }`; `sw.js` `SHELL_FILES`; THEMES.md §4.
**Processor sketch.** A delay line of length `sampleRate / frequency` samples
(fractional: linear-interpolate), excited by a burst of noise of `length`
samples with `brightness` low-pass applied to the burst; each sample:
`y = damping * 0.5 * (buf[i] + buf[i+1])`; write back. AudioParams:
`frequency` (k-rate is fine), `damping` 0.90–0.999, `brightness` 0–1. Accept a
`pluck` message via the port that reseeds the burst, so one node can play many
notes — **or** one node per note, stopped after `dur + 2 s`. One node per note
is simpler and matches the other voices; do that.
**Accept.** Render check: no NaN, no leak (CPU flat after 2 min in the live
page). `ksVoice` in the landmarks `paris` theme as the "pah" layer sounds like
a string, not a buzz. On the APK: works (assets over `appassets` are a secure
context) — check `console` for the addModule error, and that the fallback
plays if it fails.
**Don't.** Don't make the engine's `start()` fail if the worklet fails to
load; the pluck fallback must keep the app playable.

#### C3.4 Ambience layer — the place, literally
**Goal.** A quiet synthesised soundscape under the music that mirrors the
tags directly: birds in a park, water by the river, low traffic hum on a main
road, murmur near cafés and bars. Music expresses the *mood*; this expresses
the *place*. Optional, with its own slider.
**Where.** New `public/src/audio/ambience.js`; `engine.js` (own bus:
`ambienceGain` → `dry` and a 0.5 send → `reverbBus`; `setAmbience(levels)`);
`main.js` (`replan`: compute levels from `this.scene.categoryWeight(cat)`);
`ui.js`/`index.html` (an "Ambience" slider next to volume, default 60%);
`spec.js` (optional `ambience: 0..1` per theme, default 1, multiplies);
`sw.js`; THEMES.md (a short §9 "Ambience").
**Generators** (each a small class with `start(ctx, out)`, `setLevel(v, t)`,
`stop()`; all levels glide with `setTargetAtTime` 2 s):
- `birds` (category `nature`): a grain scheduler; every 0.4–3 s (seeded RNG),
  a 60–180 ms sine chirp gliding 2.8→4.5 kHz (or down), tiny random pan,
  gain ∝ level. Silence at night (`band` from scene.js: no birds 22:00–05:00).
- `water` (category `water`): white noise → bandpass 500 Hz Q 0.7, centre
  frequency modulated by two slow LFOs (0.07 Hz, 0.13 Hz) ±150 Hz.
- `traffic` (categories `transit` + `service` + urbanness > 0.6): brown-ish
  noise (white → lowpass 180 Hz) with an LFO on level; every 6–20 s a "pass-by":
  a bandpass sweep 300→900→300 Hz over 2.5 s at low gain.
- `murmur` (categories `food` + `nightlife` + `retail`): 6 detuned bandpassed
  noise voices at 400–1200 Hz with independent slow random gain walks; think
  distant crowd.
- `rain` (only from C3.10 weather): white noise → highpass 1.5 kHz, gentle
  level modulation, plus sparse "drips" (very short sine pings).
**Levels.** `level = clamp01(categoryWeight * 1.6) * slider * themeAmbience`,
capped so the bus never exceeds −18 dBFS relative to music peak. Glide in/out
over 3 s. Total ambience CPU must stay small: ≤ 5 noise sources alive.
**Accept.** Jump to Belmont Park (belmont-walk) → birds faintly; jump to
Golden Gate → water; slider to 0 → silence within 3 s; render check peaks
unchanged within 0.5 dB (ambience is quiet); no growth of node count over
10 minutes (count via a debug counter on the bus).
**Don't.** No samples. No ambience while the theme declares `ambience: 0`.

#### C3.5 Spatial cues — hear which way the place is
**Goal.** A cue's loops pan toward the bearing of the place relative to your
heading: the market is to your left, so its chimes are to your left.
**Where.** `cues.js` (`withCues`: for each cue with `when.near` and
`spatial: true`, compute `pan = Math.sin(toRad(bearing(pos, centre) −
heading)) * 0.7` and inject into each layer's `params.pan`, gliding through a
per-cue `StereoPannerNode` rather than re-panning per note — simplest: pass
`pan` to voices that support it; `pluck`, `bell`, `pulse` and `fm` do, extend
the others' `pan` param over time), `main.js` (pass `position` with heading
into `withCues`), `validateCue`/`sanitise` (allow `spatial`), THEMES.md §6.
**Rules.** Only when speed > 0.5 m/s (heading is meaningless standing still —
hold the last pan). Default `spatial: false`. Clamp |pan| ≤ 0.7.
**Accept.** Simulator, a route passing a `near` cue: the cue's layer pans
from one side to the other as you pass; standing still: pan freezes.

#### C3.6 Transitions that sound intended
**Goal.** When a theme is about to change, it sounds like a musical decision:
a noise swell into the downbeat and a brief reverb bloom, instead of a plain
cut at the bar line.
**Where.** `engine.js` (`_tick`: when `_pending` exists, pass
`pos.stepsToCommit` to `stepFn`; at `stepsToCommit === 4` (one beat before)
call `sweepVoice(io, { time, gain: 0.04, from: 400, to: 6000, dur: 4 *
stepDur })` and bump `reverbReturn` by +40% for 2.5 s with `setTargetAtTime`),
`spec.js` (`stepLayers`: if `pos.stepsToCommit <= 16` and a layer has `fill:
"pattern"`, play that pattern instead for the final bar), THEMES.md §2 layer
fields (`fill`).
**Accept.** Jump test still 1.2–3.3 s; listening: Eiffel → Colosseum has an
audible swell into the handover; render check: no clipping when the swell
lands on a busy theme.

#### C3.7 Breath — a bar of air every so often
**Goal.** Every `breathEvery` phrases (default 4), the last bar drops the
unpitched layers and any layer with `breath: true`, letting the pad ring.
Kills the loop feeling at near-zero cost.
**Where.** `spec.js` (`themeFromSpec` reads `spec.form = { breathEvery: 4 }`;
`stepLayers` skips when `pos.phrase % breathEvery === breathEvery - 1 &&
pos.barInPhrase === 3` for eligible layers), `validateSpec`, THEMES.md §2.
Code themes may read `plan.form` and do the same; update `wanderer.js` to.
**Accept.** Listening at 120 bpm for 70 s: one drum-less bar around 0:32 and
1:04. `form: { breathEvery: 0 }` disables. Render check unchanged.

#### C3.8 Generative melody layer (seeded Markov walk)
**Goal.** A spec layer can say `generate` instead of `pattern` and get a
melody that is different in every place, stable while you stand there, and
always in key: strong beats on chord tones, tension controlling leaps,
brightness controlling contour.
**Where.** `spec.js` (`validateSpec`: `pattern` XOR `generate`; `compileLayers`;
`stepLayers` calls a `generatedEvents(layer, plan, bar)` cached per `(bar)`
in the layer), new `public/src/themes/melody.js` with the algorithm, THEMES.md §2.
**Spec.** `generate: { kind: "markov", density: 0.45 | ["d", 0.3, 0.7],
range: [0, 9], leap: 0.2 | ["t", 0.1, 0.5], rest: 0.35, contour: 0 |
["b", -1, 1] }` — every number may be a mood expression like other spec numbers.
**Algorithm** (deterministic — `rng = mulberry32(plan.seed ^ (bar * 2654435761
>>> 0) ^ hashString(layer.name))`):
1. For each of 16 steps: skip with probability `rest` unless it is step 0 of
   a chord-change bar (always play there).
2. Density gate: on 8th-note positions always eligible; 16th positions
   eligible only with probability `density`.
3. Next degree: with probability `leap` jump ±3..±5 degrees, else ±1 or ±2;
   add `contour * 0.6` bias to the sign choice. Clamp to `range`; on hitting a
   bound, reflect.
4. On steps 0 and 8 snap to the nearest chord tone (`degree + {0,2,4}` of the
   current chord, mod scale length).
5. Emit `{ begin: i/16, end: (i+1)/16, value: String(degree) }` in the same
   shape `queryPattern` returns so `stepLayers` needs no other change.
Cache per bar so the melody does not change under the listener mid-bar.
**Accept.** A test theme with `generate` renders (no NaN); the same bar at the
same place is identical on reload (determinism); tension 0.9 audibly leaps
more than 0.1; density 0.2 vs 0.8 audibly differ.

#### C3.9 Pace lock — tempo follows your feet
**Goal.** Optional: the tempo settles on your walking cadence (or half/double
it), so footsteps land on the beat.
**Where.** `main.js` (`replan`, after building `plan`), `ui.js` (a toggle
"Match my pace", default off), `scene.js` (nothing).
**Steps.** `cadence = clamp(speed_mps * 78, 80, 130)` steps/min (1.4 m/s ≈
110 spm). Candidates `{cadence, cadence/2, cadence*2}`; pick the one nearest
`plan.bpm`; `plan.bpm = lerp(plan.bpm, candidate, 0.7)`. Only when speed >
0.6 m/s and the toggle is on; otherwise the theme's bpm. bpm is continuous, so
the engine glides it.
**Accept.** Simulator at walking pace: bpm readout sits within ±3 of 110 or
55 for themes whose natural tempo is near either; toggle off restores.

#### C3.10 Weather (Open-Meteo, keyless)
**Goal.** Rain darkens and adds the `rain` ambience; wind opens up the space;
overcast dims brightness slightly. Fits the keyless philosophy — Open-Meteo
needs no account and allows CORS.
**Where.** New `public/src/weather.js` (`fetchWeather(lat, lng)` → `{ rainMmH,
windKmh, cloudPct, isDay }` with a `fetchSeq`-style guard and a 15-minute
cache; **fails silently** offline), `scene.js` (`contextualise(analysis,
ctx)`: `ctx.weather` → `b -= 0.10 * rain01 + 0.05 * cloud01; w -= 0.05 *
rain01; s += 0.08 * wind01`), `main.js`, `ui.js` (a small glyph on the band
badge), `sw.js` (do not cache the API), README §Privacy (one sentence: the
coordinates go to Open-Meteo when weather is on), a toggle default **off**.
URL: `https://api.open-meteo.com/v1/forecast?latitude=…&longitude=…&current=precipitation,wind_speed_10m,cloud_cover,is_day`.
**Accept.** Toggle on → badge shows conditions within 5 s online; airplane
mode → no error surfaced, music unaffected; mood bars move by the amounts above.
**Don't.** Never send anything but rounded (2 dp) coordinates. Never block
`replan` on the fetch.

---

### Tier 4 — Feel and clarity

#### C4.1 "Why this music" line
**Goal.** Under the scene meta: "Busy and bright because: 3 cafés, a bar, a
station". Makes the tag editor discoverable and the app explainable.
**Where.** `scene.js` (export a `topContributors(analysis, 3)`: tags ranked by
`weight × |profile − NEUTRAL|₁`), `ui.js`, `index.html`.
**Accept.** At Dot's Market the line names the grocery/shops; at Belmont Park
it names the park.

#### C4.2 Pack manager
**Goal.** See and remove what has been imported: custom themes (`removeCustom`
exists), cues (add `removeCue(index)`), saved places (exists), tag overrides
(exists per tag; add "reset all"), and a "Reset everything" with confirm.
**Where.** `ui.js`, `main.js`, `index.html`.
**Accept.** Import two packs; remove one theme and one cue; export → they are
gone; reload → still gone; "Reset everything" → back to factory, theme
selector shows only built-ins.

#### C4.3 Theme colour
**Goal.** Each theme may declare `color`; the UI accent and the radar tint
follow the *playing* theme, so a handover is visible as well as audible.
**Where.** `spec.js` (`color` allowed, validated as `#rrggbb`), the five code
themes (add one each), `ui.js` (`setActiveTheme` sets `--accent` with a CSS
transition of 1.5 s), `styles.css`.
**Accept.** Landmarks: Eiffel → Colosseum visibly changes the accent along
with the sound.

#### C4.4 First-run card
**Goal.** Three lines on first launch: what it does, press Play, try an
example pack (C0.3). Dismiss stores a flag in `localStorage`.
**Accept.** Shown once; never again; "Show again" in the pack manager.

---

## 6. Parking lot — ideas considered, not specified

- **Share a pack by link** (`#pack=<base64>`): great for the sharing goal,
  but URL length caps it at ~2 KB packs after compression; needs a
  `CompressionStream` step. Do it only if people actually share.
- **Elevation → tension** (Open-Meteo elevation API): climbing a hill adds
  `t`. Cheap once C3.10 exists; fold it in there if wanted.
- **Sample-based instruments** (SoundFont/WAV): breaks §3.1 and adds
  megabytes. Only with the user's explicit say-so.
- **Section form (A A B A)**: C3.7 gets most of the anti-monotony value for
  1/10 of the work. Revisit after C3.8.
- **Voice-leading chords**: `theory.voice()` only spreads; a nearest-inversion
  `voiceLead(prev, next)` would smooth pad changes. Small; do it if pads sound
  jumpy after C3.2.
- **iOS**: PWA only; Safari suspends Web Audio when locked and there is no
  foreground-service equivalent. Not solvable without a native shell.
- **Transit realtime (GTFS-RT) chimes**: fun, but per-city feeds and keys.
- **Machine learning of any kind**: no. Determinism is a feature here — the
  same place composes the same way, and that is what makes it feel like a
  place has "its" music.

---

## 7. Appendix

### A. Pack shape

```jsonc
{
  "version": 1,
  "_about": "free text, ignored",
  "theme": "wanderer",                      // default theme id
  "tagOverrides": { "cafe": { "e": 0.6 } }, // partial mood per canonical type
  "locations": [{ "name": "…", "lat": 0, "lng": 0 }],
  "themes": [ /* spec themes — see THEMES.md §2 */ ],
  "cues": [{
    "name": "…",
    "when": { "near": { "lat": 0, "lng": 0, "radius": 300 } },  // or tag / category / place / any
    "theme": "paris",            // optional: pin a theme while strength ≥ PIN_ON
    "layers": [ /* spec layers */ ]  // optional: loops added on top
  }]
}
```

### B. Voice table (`spec.js` `VOICES`)

| voice | kind | default gain | character |
|---|---|---|---|
| `pad`, `strings` | chordal | 0.08 | sustained chords |
| `bass` | pitched | 0.24 | filtered low |
| `pizz` | pitched | 0.22 | short, woody |
| `pluck` | pitched | 0.11 | guitar-ish |
| `bell` | pitched | 0.07 | metallic ring |
| `flute` | pitched | 0.09 | breathy lead |
| `pulse` | pitched | 0.085 | chiptune / accordion (duty) |
| `blip` | pitched | 0.05 | tiny sine pip |
| `fm` | pitched | 0.08 | two-op FM: e-piano / bell / glass (`ratio`, `index`, `decay`) |
| `string` | pitched | 0.10 | Karplus–Strong plucked string, AudioWorklet (`decay`, `bright`); falls back to `pluck` |
| `kick`, `hat`, `shaker`, `rim`, `clank`, `brush`, `sweep` | unpitched | 0.38 / 0.05 / 0.035 / 0.08 / 0.09 / 0.05 / 0.06 | percussion & fx |

Parameters per voice are in THEMES.md §4. Chordal voices take `chordSize`;
pitched take `octave`; unpitched take only `x` hits.

### C. Numbers that tune behaviour

| constant | where | value | meaning |
|---|---|---|---|
| `REPLAN_MS` | main.js | 1500 | how often the plan is recomputed |
| `MOOD_ALPHA` | main.js | 0.16 | mood smoothing per replan |
| `FETCH_MIN/MAX_INTERVAL_MS` | main.js | 8000 / 75000 | lookup cadence, scaled by speed |
| `STATIONARY_MS` / `MOVE_M` | geo.js | 120000 / 25 | still this long → coarse GPS; moved this far → fine |
| `FETCH_STATIONARY_INTERVAL_MS` | main.js | 300000 | lookup refresh while GPS is coarse |
| `CUE_SMOOTHING` | cues.js | 0.25 | cue strength approach per tick |
| `PIN_ON` / `PIN_OFF` | cues.js | 0.55 / 0.32 | theme pin hysteresis |
| `PRESENCE_FLOOR` | scenecontext.js | 1.6 | stops sparse areas over-claiming |
| `URBAN_HALF_WEIGHT` | scene.js | 14 | total weight at which urbanness = 0.5 |
| `STEPS_PER_BAR` / `BARS_PER_PHRASE` | engine.js | 16 / 4 | the grid |
| makeup / limiter | engine.js | 1.65 / −1.5 dB 20:1 | do not touch to fix one theme |

### D. Things that were verified and things that were not

Verified on device (Galaxy Tab A): foreground service `isForeground=true`;
audio `state:started` 65 s after screen-off; no app-held wake lock; VIEW/SEND
intent import; the paste import. Verified in the browser: every pack's jump
test; render check across all themes; real Google and Overpass lookups for
every landmark.

**Not** verified: service-worker registration in the automated browser (it is
blocked there; a three-line SW proved it environmental); the final
file-selection tap inside Samsung's file picker; the 0.3 APK on device (the web
bundle inside it is byte-identical to what passed in the browser). Say so when
you inherit this — do not claim these.
