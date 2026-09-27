# GPS Background Music — working rules

Generative background music driven by GPS and nearby place tags. Zero
dependencies, no build step, native ES modules; a bare-WebView Android wrapper.

**Read [HANDOFF.md](HANDOFF.md) before changing anything.** It has the
architecture, the invariants, the verification recipes, and the ordered list
of changes to build next. Take one change at a time; run its Accept lines.

## Never

- Add an npm dependency, a bundler, or a build step.
- Evaluate anything from a pack (`eval`, `new Function`, dynamic import). Packs
  are data and go through `sanitise()` + `validateSpec`/`validateCue`.
- Set `engine.plan` or `engine.stepFn` separately — always `applyPlan(plan, stepFn)`.
- Fix one theme's level by touching the compressor, makeup or limiter — use the theme's `trim`.
- Coerce spec `params` strings/booleans to numbers.
- Write big files with a bash heredoc (it truncates here) — use the Write tool.
- Print the Google key, or copy the home coordinate out of `examples/belmont-walk.json`.
- Leave `dev-*.js` or `.json` files in `public/` when building the APK.

## Always

- New file in `public/` → add to `SHELL_FILES` in `public/sw.js`, bump `VERSION`.
- New plan field → decide continuous (`_applyContinuous`) or discrete (`isDiscreteChange`).
- New voice → `voices.js` + `VOICES` in `spec.js` + THEMES.md §4.
- After audio/theme changes → run `tools/render-check.js`. After cue/scene/main/engine changes → run `tools/jump-test.js`. Both headers say how.
- Python on this machine wants `r'C:\…'` paths. Build the APK with `.\gradlew.bat --no-daemon assembleDebug` in `android/` (PowerShell).
- Deliverables go to `C:\Users\Adrian\Dropbox\GPS Background Music\` and `INSTALL.md` there gets updated.
