# GPS Background Music — working rules

Generative background music driven by GPS and nearby place tags. Zero
dependencies, no build step, native ES modules; a bare-WebView Android wrapper.

**Read [HANDOFF.md](HANDOFF.md) before changing anything.** It has the
architecture, the invariants, the verification recipes, and the ordered list
of changes to build next. Take one change at a time; run its Accept lines.

## Never

- Add an npm dependency, a bundler, or a build step. Allowed: audio assets in
  `public/samples/` (CC0 or attributed in `public/samples/LICENSES.md`, total
  ≤ ~3 MB, the voice falls back to a synth); Android Gradle dependencies with
  the user's OK (Play Services is in, for C1.3).
- Evaluate anything from a pack (`eval`, `new Function`, dynamic import). Packs
  are data and go through `sanitise()` + `validateSpec`/`validateCue`;
  `sanitise()` strips `__proto__`/`constructor`/`prototype` at any depth. A pack
  picks a sampled instrument by id only (`INSTRUMENTS` in
  `public/samples/instruments.js`), never a URL or path.
- Set `engine.plan` or `engine.stepFn` separately — always `applyPlan(plan, stepFn)`.
- Fix one theme's level by touching the compressor, makeup or limiter — use the theme's `trim`.
- Coerce spec `params` strings/booleans to numbers.
- Write big files with a bash heredoc (it truncates here) — use the Write tool.
- Print the Google key, or any coordinate. Never copy `examples/belmont-walk.json`,
  or any coordinate from it, into another pack, `public/`, a doc or a test; open
  it only to confirm its cue list.
- Leave `dev-*` files, or any `.json` outside `public/packs/`, in `public/` when
  building the APK.

## Always

- New file in `public/` → add to `SHELL_FILES` in `public/sw.js`, bump `VERSION`
  (`public/samples/*/*.ogg` are cached on first use and not listed — still bump).
  Re-copy `public/` to `android/app/src/main/assets/www/` after any change
  (`diff -r` clean).
- New plan field → decide continuous (`_applyContinuous`) or discrete (`isDiscreteChange`).
- New voice → `voices.js` + `VOICES` in `spec.js` + THEMES.md §4 + HANDOFF
  Appendix B. A sampled instrument also needs a manifest entry and
  `LICENSES.md` rows.
- After audio/theme changes → run `tools/render-check.js` (`&samples=1` decodes
  the instruments). After cue/scene/main/engine changes → run
  `tools/jump-test.js`. Both headers say how: they load at `/tools/…` with
  `DEV_TOOLS=1`, nothing copied into `public/`. In the cloud container Overpass
  and Open-Meteo are blocked, so use `PLACES_PROVIDER=mock`; there the ocarina
  jump test misses 3/4 (known, not a regression).
- Python on this machine wants `r'C:\…'` paths. Build the APK with `.\gradlew.bat --no-daemon assembleDebug` in `android/` (PowerShell).
- Deliverables go to `C:\Users\Adrian\Dropbox\GPS Background Music\` and `INSTALL.md` there gets updated.
