/**
 * Offline render check: every theme × three moods, 12 s each, through the
 * real engine. Reports peak level, NaN samples and clipped samples.
 *
 * This drives the actual AudioEngine — the only thing faked is the clock —
 * so phrase boundaries, voice allocation and the master chain are all
 * exercised. Run it after touching anything in public/src/audio/ or after
 * writing a theme.
 *
 * USAGE (browser, dev server started with DEV_TOOLS=1, which serves tools/
 * at /tools/ and examples/ at /examples/ — nothing is copied into public/):
 *   1. In the page console:
 *        const s = document.createElement('script'); s.type = 'module';
 *        s.src = '/tools/render-check.js?pack=/examples/landmarks.json';
 *        document.head.appendChild(s);
 *      Omit ?pack= to render the built-in code themes instead.
 *   2. Poll window.__R until .state === 'done', then read .rows.
 *
 * PASS CRITERIA:  nan === 0 and clipped === 0 on every row, no row silent,
 *                 and peaks within about 4 dB of each other across themes
 *                 (fix with the theme's `trim`, never with the master chain).
 */
window.__R = { state: 'running', rows: [], errs: [] };

(async () => {
  try {
    const { AudioEngine } = await import('/src/audio/engine.js');
    const { themeFromSpec } = await import('/src/themes/spec.js');
    const { allThemes } = await import('/src/themes/index.js');

    const packUrl = new URL(import.meta.url).searchParams.get('pack');
    const themes = packUrl
      ? (await (await fetch(packUrl)).json()).themes.map(themeFromSpec)
      : allThemes();

    const MOODS = [
      ['calm', { e: .15, b: .35, d: .20, t: .10, w: .70, s: .75 }],
      ['mid',  { e: .50, b: .50, d: .50, t: .40, w: .50, s: .50 }],
      ['busy', { e: .90, b: .80, d: .90, t: .75, w: .35, s: .20 }],
    ];
    const SECONDS = 12;
    const SR = 44100;

    for (const theme of themes) {
      for (const [moodName, mood] of MOODS) {
        const off = new OfflineAudioContext(2, SR * SECONDS, SR);
        let fake = 0;
        Object.defineProperty(off, 'currentTime', { get: () => fake, configurable: true });
        // An offline context reports 'suspended' and refuses resume() until
        // rendering starts; the engine only resumes to beat autoplay blocking.
        Object.defineProperty(off, 'state', { get: () => 'running', configurable: true });

        const real = window.AudioContext;
        window.AudioContext = function () { return off; };
        const eng = new AudioEngine();
        await eng.start();
        window.AudioContext = real;
        clearInterval(eng._timer); eng._timer = null;
        eng.setVolume(1);

        const plan = { ...theme.plan(mood, 12345), themeId: theme.id };
        eng.applyPlan(plan, theme.step.bind(theme));

        // Advance the clock in 25 ms slices, ticking as the real transport does.
        for (let i = 0; i * 0.025 < SECONDS; i++) { fake = i * 0.025; eng._tick(); }

        const buf = await off.startRendering();
        let peak = 0, nan = 0, clipped = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) {
            const v = d[i];
            if (!Number.isFinite(v)) { nan++; continue; }
            const a = Math.abs(v);
            if (a > peak) peak = a;
            if (a >= 1) clipped++;
          }
        }
        window.__R.rows.push({
          theme: theme.id, mood: moodName, bpm: Math.round(plan.bpm),
          peakDb: +(20 * Math.log10(peak || 1e-9)).toFixed(2),
          nan, clipped, silent: peak < 1e-4,
        });
      }
    }
    const peaks = window.__R.rows.map((r) => r.peakDb);
    window.__R.spreadDb = +(Math.max(...peaks) - Math.min(...peaks)).toFixed(2);
    window.__R.pass = window.__R.rows.every((r) => !r.nan && !r.clipped && !r.silent);
    window.__R.state = 'done';
  } catch (e) {
    window.__R.state = 'error';
    window.__R.message = String((e && e.stack) || e);
  }
})();
