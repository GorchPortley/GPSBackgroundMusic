/**
 * Jump test: import a pack, press play, tap each saved place, and measure how
 * long the engine takes to commit the theme that place is supposed to pin.
 *
 * This is the end-to-end check for cues. It exercises the real place lookup
 * (whatever provider the server is using), scene building, cue evaluation,
 * hysteresis, the urgent commit path and the theme-held label.
 *
 * USAGE (browser, dev server started with DEV_TOOLS=1, which serves tools/
 * at /tools/ and examples/ at /examples/ — nothing is copied into public/):
 *   1. In the page console (a clean page — run localStorage.clear() and
 *      reload first, or cues from a previous pack will leak in):
 *        const s = document.createElement('script'); s.type = 'module';
 *        s.src = '/tools/jump-test.js?pack=/examples/landmarks.json'
 *              + '&expect=Eiffel=paris;Broadway=broadway;Abbey=wanderer';
 *        document.head.appendChild(s);
 *      Each expectation is  <substring of the saved place's name>=<themeId>.
 *      Use the pack's default theme id for places that should only add layers.
 *   2. Poll window.__J until .state === 'done', then read .rows.
 *
 * PASS CRITERIA:  every row has got === want and secs <= 4 (one bar at the
 *                 slowest tempo plus lookup time). A MISS means the pin never
 *                 committed within 16 s.
 */
window.__J = { state: 'running', rows: [], errs: [] };
window.addEventListener('error', (e) => window.__J.errs.push(String(e.message).slice(0, 120)));

(async () => {
  try {
    const params = new URL(import.meta.url).searchParams;
    const packUrl = params.get('pack');
    const expect = (params.get('expect') || '').split(';').filter(Boolean)
      .map((pair) => pair.split('='))
      .map(([name, theme]) => ({ name, want: theme }));
    if (!packUrl || !expect.length) throw new Error('need ?pack= and ?expect=');

    const app = window.gpsMusic;
    if (!app) throw new Error('window.gpsMusic missing — is the page loaded?');

    app.importPackText(await (await fetch(packUrl)).text());
    await sleep(800);
    await app.togglePower();
    await sleep(1500);

    const tap = (name) => {
      const btn = [...document.querySelectorAll('#savedList .go')]
        .find((b) => b.textContent.includes(name));
      if (!btn) throw new Error(`no saved place containing "${name}"`);
      btn.click();
    };
    const waitFor = async (want) => {
      const t0 = Date.now();
      for (let i = 0; i < 80; i++) {
        await sleep(200);
        if (app.engine.plan?.themeId === want) return +((Date.now() - t0) / 1000).toFixed(1);
      }
      return null;
    };

    for (const { name, want } of expect) {
      tap(name);
      const secs = await waitFor(want);
      const held = document.getElementById('themeHeld');
      window.__J.rows.push({
        place: name, want, got: app.engine.plan?.themeId, secs,
        bpm: Math.round(app.engine.bpm),
        cues: app.activeCues.filter((c) => c.strength > 0.05)
          .map((c) => `${c.name}:${c.strength.toFixed(2)}`).join(' '),
        held: held?.hidden ? '-' : held?.textContent.replace('Now playing ', ''),
      });
    }
    await app.togglePower();
    window.__J.pass = window.__J.rows.every((r) => r.got === r.want && r.secs !== null && r.secs <= 4);
    window.__J.state = 'done';
  } catch (e) {
    window.__J.state = 'error';
    window.__J.message = String((e && e.stack) || e);
  }
})();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
