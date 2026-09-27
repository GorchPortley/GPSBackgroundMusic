/**
 * Wiring.
 *
 * position -> nearby place tags -> mood vector -> arrangement -> sound
 *
 * The two rates that matter:
 *   - places are re-fetched only when you have actually moved (or after a
 *     while), because each lookup is a billed request
 *   - the mood is re-smoothed and the arrangement re-planned every 1.5 s, so
 *     the music tracks you continuously between lookups
 */

import { AudioEngine } from './audio/engine.js';
import { GeoTracker, DEFAULT_ORIGIN, haversine } from './geo.js';
import {
  analyzePlaces, contextualise, lerpMood, sceneKey, sceneName, whyLine,
} from './scene.js';
import {
  categoryFor, clearTagOverride, getTagOverrides, setTagOverride, setTagOverrides,
} from './tags.js';
import {
  clearStore, downloadPack, emptyPack, firstRunDismissed, loadPack, readPackFile, sanitise,
  savePack, setFirstRunDismissed,
} from './store.js';
import * as provider from './provider.js';
import { buildScene, emptyScene } from './scenecontext.js';
import {
  compileCues, evaluateCues, pinnedTheme, validateCue, withCues,
} from './themes/cues.js';
import { describeCondition } from './themes/match.js';
import { LOOP_PRESETS } from './themes/presets/loops.js';
import { hashString } from './audio/theory.js';
import {
  allThemes, customSpecs, DEFAULT_THEME_ID, getTheme, registerSpecs, removeCustom,
} from './themes/index.js';
import { UI } from './ui.js';
import { WeatherSource, weatherFactors } from './weather.js';
import { ElevationSource } from './elevation.js';
import {
  decodePayload, encodePack, extractPayload, SHARE_LINK_MAX, shareBase, ShareError,
  shareSupported, summarisePack, UNSUPPORTED_MESSAGE,
} from './share.js';

const REPLAN_MS = 1500;
/** Fraction of a step the smoothed mood takes toward the target each replan. */
const MOOD_ALPHA = 0.16;
const FETCH_MIN_INTERVAL_MS = 8000;
const FETCH_MAX_INTERVAL_MS = 75000;
/** Refresh interval once GPS has dropped to coarse (standing still, geo.js). */
const FETCH_STATIONARY_INTERVAL_MS = 300000;
/** Opening the cue editor on a spot this close counts as "from here". */
const HERE_METRES = 10;
/** Volume under another app's transient sound (Android LOSS_TRANSIENT_CAN_DUCK). */
const HOST_DUCK = 0.25;
/**
 * Ambience (C3.4): a category's share of the scene times this is its bed's
 * level, so a place that is ~60 % park gets full birds.
 */
const AMBIENCE_WEIGHT = 1.6;
/** Above this urbanness a built-up scene hums with traffic whatever is tagged. */
const AMBIENCE_URBAN = 0.6;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Pace lock (C3.9). Steps per minute per m/s of walking speed: 1.4 m/s is
 * about 110 steps/min.
 */
const PACE_SPM_PER_MPS = 78;
const PACE_MIN_SPM = 80;
const PACE_MAX_SPM = 130;
/** Below this (m/s) there are no footsteps worth following. */
const PACE_MIN_SPEED = 0.6;
/** How far the theme's tempo is pulled toward the cadence. */
const PACE_PULL = 0.7;

/**
 * The tempo a theme should play at while you walk: your cadence, or half or
 * double it — whichever is nearest the theme's own `bpm` — pulled 70 % of the
 * way from that natural tempo. Always computed from the theme's bpm (never
 * from last tick's result), so the same place and pace give the same tempo.
 * The engine glides to it like any other bpm change.
 */
function paceLockedBpm(bpm, speed) {
  const cadence = Math.min(PACE_MAX_SPM, Math.max(PACE_MIN_SPM, speed * PACE_SPM_PER_MPS));
  let candidate = cadence;
  for (const c of [cadence / 2, cadence * 2]) {
    if (Math.abs(c - bpm) < Math.abs(candidate - bpm)) candidate = c;
  }
  return bpm + (candidate - bpm) * PACE_PULL;
}

class App {
  constructor() {
    this.radius = 350;
    this.provider = 'mock';
    this.theme = getTheme(DEFAULT_THEME_ID);

    this.playing = false;
    /** Ducked by the Android host under a notification or alarm. */
    this.hostDucked = false;
    this.position = null;
    this.analysis = null;
    this.currentMood = null;
    this.targetMood = null;
    this.lastPlanKey = null;

    this.lastFetchAt = 0;
    this.lastFetchPos = null;
    this.fetching = false;
    this.wakeLock = null;
    this.snapCues = false;
    this.pendingJump = false;
    // Lookups are async and can overlap — jumping between saved places fires
    // one per jump. Only the newest may write the scene, or a slow earlier
    // response lands last and puts you back where you were.
    this.fetchSeq = 0;
    this.places = null;    // raw places, kept so tag edits can re-analyse
    this.scene = emptyScene();
    this.cues = [];
    this.activeCues = [];
    this.lookups = 0;      // upstream lookups this session
    this.cacheHits = 0;
    // The cue being edited. Its coordinates live only here until Save.
    this.cueDraft = null;
    // Set when a fence crossing launched the app; Play is pressed on first fix.
    this.autoplayPending = false;

    this.engine = new AudioEngine();
    // The accent follows what is sounding (C4.3), so it turns at the seam
    // where the engine takes the new theme — not when it is first asked for.
    this.engine.onCommit = () => this.showPlayingTheme();

    // Weather (C3.10), off by default. The source never blocks anything: it
    // fetches in the background and replan reads `weather.current` each tick.
    this.weather = new WeatherSource({
      onChange: (w) => this.ui?.setWeather(w),
    });
    // Hills (P3), off by default: fed every fix, read every replan. Uses GPS
    // altitude when the fix has it, else Open-Meteo elevation (guarded,
    // cached per 2-dp grid point, silent offline). Never awaited.
    this.elevation = new ElevationSource();

    this.ui = new UI({
      onPower: () => this.togglePower(),
      onVolume: () => this.applyVolume(),
      onAmbience: () => this.applyAmbience(),
      // Read by replan on its next tick (≤ 1.5 s); the engine glides the bpm.
      onPaceLock: (on) => this.ui.setStatus(on
        ? 'Tempo follows your pace while you walk.'
        : 'Tempo back to the theme\u2019s own.'),
      onWeather: (on) => this.setWeather(on),
      onHills: (on) => this.setHills(on),
      onMode: (mode) => this.setMode(mode),
      onSimSpeed: (mps) => this.geo.setSimSpeed(mps),
      onTheme: (id) => this.setTheme(id),
      onSearch: (q) => this.search(q),
      onGoTo: (loc) => this.goTo(loc),
      onSaveHere: () => this.saveHere(),
      onRemoveSaved: (i) => this.removeSaved(i),
      onBindSaved: (i) => this.openBind(this.pack.locations[i]),
      onBindHere: () => this.bindHere(),
      onEditCue: (name) => this.editCue(name),
      onCueSave: (values) => this.saveCue(values),
      onCueDelete: (name) => this.deleteCue(name ?? this.cueDraft?.editing),
      onCueRemove: (index) => this.removeCue(index),
      onThemeRemove: (id) => this.removeTheme(id),
      onTagResetAll: () => this.resetAllTags(),
      onResetEverything: () => this.resetEverything(),
      onFirstRunDismiss: () => {
        setFirstRunDismissed(true);
        this.ui.hideFirstRun();
      },
      onFirstRunShow: () => {
        setFirstRunDismissed(false);
        this.ui.showFirstRun({ focus: true });
      },
      onCueCancel: () => { this.cueDraft = null; },
      onExportPack: () => this.exportPack(),
      onImportPack: (file) => this.importPack(file),
      onPastePack: (text) => this.importPackText(text),
      onShareOpen: () => this.openShare(),
      onShareChange: (opts) => this.previewShare(opts),
      onShareCopy: (opts) => this.copyShareLink(opts),
      onExamplePack: (file, name) => this.importExample(file, name),
      onTagEdit: (type, dim, value) => this.editTag(type, dim, value),
      onTagReset: (type) => this.resetTag(type),
    });

    this.geo = new GeoTracker({
      onUpdate: (pos) => this.onPosition(pos),
      onError: (err) => this.ui.setStatus(err.message, 'error'),
      onStatus: (msg) => msg && this.ui.setStatus(msg, 'busy'),
    });

    // Restore whatever this person customised last time, before first paint.
    this.pack = loadPack();
    setTagOverrides(this.pack.tagOverrides);

    // Custom themes must be installed before the selector is built.
    const report = registerSpecs(this.pack.themes);
    this.reportThemes(report);

    const cueBuild = compileCues(this.pack.cues);
    this.cues = cueBuild.cues;
    this.reportCues(cueBuild.report);

    if (this.pack.theme) this.theme = getTheme(this.pack.theme);

    this.geo.setMode('explore');
    this.geo.setPin(DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lng, 'London');

    this.ui.attachEngine(this.engine);
    this.ui.setModeUI('explore');
    this.ui.setTheme(this.theme.id);
    this.ui.setPlaying(false);
    this.ui.startRadar();
    this.ui.renderSaved(this.pack.locations);
    this.renderCueList();
    this.ui.refreshThemes(this.theme.id);
    this.renderPackManager();
    if (!firstRunDismissed()) this.ui.showFirstRun();
    this.applyVolume();

    this.loadConfig();
    this.loadExampleList();

    // Android: re-register the wake-up fences from the stored pack (the OS
    // drops them on reboot), and honour a launch that came from crossing one.
    this.syncHostFences();
    this.checkHostAutoplay();
    this.setupMediaSession();

    // A pack link (P4): on load, and when a link is opened in this tab.
    this.checkShareHash();
    window.addEventListener('hashchange', () => this.checkShareHash());

    setInterval(() => this.replan(), REPLAN_MS);
    setInterval(() => {
      if (this.playing) this.ui.setBpm(this.engine.bpm);
    }, 1000);

    // Browsers suspend audio when a tab is hidden; pick the pulse back up.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.playing && this.engine.ctx?.state === 'suspended') {
        this.engine.ctx.resume();
      }
    });
  }

  async loadConfig() {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error('no server');
      const cfg = await res.json();
      this.provider = cfg.provider;
      this.radius = cfg.radius;
      this.ui.setProvider(cfg.provider);
      if (cfg.provider === 'mock') {
        this.ui.setWarning(
          'Running on generated mock places. Set PLACES_PROVIDER=osm in .env ' +
          'for real surroundings with no account, or add GOOGLE_MAPS_API_KEY.');
      } else {
        this.ui.setWarning(null);
      }
    } catch {
      // No server: the provider talks to OpenStreetMap directly. That is a
      // supported way to run — an installed copy on a phone — not a failure.
      this.provider = 'osm-direct';
      this.ui.setProvider('osm-direct');
      this.ui.setStatus('Running standalone \u2014 place data from OpenStreetMap.');
    }
  }

  /* --------------------------------------------------------------- controls */

  async togglePower() {
    // A press (or the autoplay itself) supersedes a waiting fence wake-up.
    this.autoplayPending = false;
    if (this.playing) {
      this.playing = false;
      this.engine.stop();
      this.geo.stop();
      this.setHostPlaying(false);
      // A later start may be a fresh service: send it the scene again.
      this._hostScene = null;
      this.setMediaPlaybackState();
      this.releaseWakeLock();
      this.ui.setPlaying(false);
      this.ui.setStatus('Stopped.');
      return;
    }

    try {
      await this.engine.start();
    } catch (err) {
      this.ui.setStatus(err.message, 'error');
      return;
    }

    this.playing = true;
    this.ui.setPlaying(true);
    this.ui.setStatus('Listening for your surroundings…', 'busy');
    this.geo.start();
    this.setHostPlaying(true);
    this.setMediaPlaybackState();
    this.requestWakeLock();
  }

  setMode(mode) {
    this.geo.setMode(mode);
    this.ui.setStatus({
      live: 'Switched to live GPS.',
      sim: 'Simulating a route.',
      explore: 'Standing still \u2014 search anywhere.',
    }[mode] || '');
  }

  setTheme(id) {
    this.theme = getTheme(id);
    this.lastPlanKey = null; // rebuild the arrangement under the new theme
    this.pack.theme = this.theme.id;
    savePack(this.pack);
    this.replan(true);
  }

  /* ---------------------------------------------------------------- explore */

  /** Accepts either "lat, lng" or a place name to geocode. */
  async search(query) {
    if (!query) return;

    const coords = query.split(/[,\s]+/).filter(Boolean).map(Number);
    if (coords.length === 2 && coords.every(Number.isFinite) &&
        Math.abs(coords[0]) <= 90 && Math.abs(coords[1]) <= 180) {
      this.ui.hideSearchResults();
      this.goTo({ lat: coords[0], lng: coords[1], name: null });
      return;
    }

    this.ui.showSearchResults([], 'Searching\u2026');
    try {
      const results = await provider.geocode(query);
      this.ui.showSearchResults(results,
        results.length ? null : 'Nothing found for that.');
    } catch (err) {
      this.ui.showSearchResults([], err.message);
    }
  }

  goTo(loc) {
    const name = loc.short || loc.name || null;
    this.geo.setPin(loc.lat, loc.lng, name);

    if (this.geo.mode !== 'explore') {
      this.geo.setMode('explore');
      this.ui.setModeUI('explore');
      document.querySelectorAll('.segmented [data-mode]').forEach((b) =>
        b.classList.toggle('active', b.dataset.mode === 'explore'));
    }

    // A new place must not inherit the previous lookup's staleness window.
    this.lastFetchPos = null;
    this.lastFetchAt = 0;
    this.ui.setStatus(name ? `Listening from ${name}.` : 'Moved.', 'busy');

    // You did not walk here, so nothing should ease in. Arm the snap rather
    // than setting it directly: the lookup is async, and a replan can easily
    // fire before it lands. Consuming the flag against the *old* scene would
    // waste it, and the real change would then creep in over a full phrase.
    this.pendingJump = true;

    // Fetch now rather than waiting for the next position tick — otherwise
    // arriving somewhere takes several seconds to be heard.
    this.fetchPlaces({ lat: loc.lat, lng: loc.lng, speed: 0 });
  }

  saveHere() {
    if (!this.position) return;
    const { lat, lng } = this.position;
    const name = this.geo.pin.name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const same = (l) =>
      Math.abs(l.lat - lat) < 1e-5 && Math.abs(l.lng - lng) < 1e-5;

    this.pack.locations = [{ name, lat, lng },
      ...this.pack.locations.filter((l) => !same(l))].slice(0, 50);
    savePack(this.pack);
    this.ui.renderSaved(this.pack.locations);
    this.renderPackManager();
    this.ui.setStatus(`Saved ${name}.`);
  }

  removeSaved(index) {
    this.pack.locations.splice(index, 1);
    savePack(this.pack);
    this.ui.renderSaved(this.pack.locations);
    this.renderPackManager();
  }

  /* ------------------------------------------------------------------ pack */

  exportPack() {
    // Pick up any themes registered this session.
    this.pack.themes = customSpecs();
    this.pack.cues = this.cues.map((c) => c.spec);
    savePack(this.pack);
    downloadPack(this.pack);
    const edits = Object.keys(this.pack.tagOverrides).length;
    this.ui.setPackHint(
      `Exported ${edits} tag edit${edits === 1 ? '' : 's'}, ` +
      `${this.pack.locations.length} place${this.pack.locations.length === 1 ? '' : 's'}` +
      `${this.pack.themes.length ? `, ${this.pack.themes.length} themes` : ''}.`);
  }

  /** Same treatment for cues: say what was wrong rather than going quiet. */
  reportCues(report) {
    const bad = (report || []).filter((r) => !r.ok);
    if (!bad.length) return;
    for (const r of bad) console.warn(`Cue "${r.name}" rejected:`, r.errors);
    this.ui.setWarning(
      `${bad.length} cue${bad.length === 1 ? '' : 's'} could not be loaded ` +
      `(${bad[0].name}: ${bad[0].errors?.[0] ?? 'invalid'}). See the console.`);
  }

  /** Surface why a shared theme was rejected instead of dropping it silently. */
  reportThemes(report) {
    const bad = (report || []).filter((r) => !r.ok);
    if (!bad.length) return;
    for (const r of bad) console.warn(`Theme "${r.id}" rejected:`, r.errors);
    this.ui.setWarning(
      `${bad.length} custom theme${bad.length === 1 ? '' : 's'} could not be loaded ` +
      `(${bad[0].id}: ${bad[0].errors?.[0] ?? 'invalid'}). See the console for details.`);
  }

  async importPack(file) {
    try {
      this.applyPack(await readPackFile(file));
    } catch (err) {
      this.ui.setPackHint(`Could not read that file: ${err.message}`);
    }
  }

  /**
   * Import from pasted text.
   *
   * Kept as a first-class path rather than a curiosity: Android file pickers
   * vary a great deal between makers, and a paste box works on every platform
   * without depending on one.
   */
  importPackText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      this.ui.setPackHint('Nothing pasted.');
      return;
    }
    // A share link, `#pack=…` or a bare `pack=…` code (P4) rather than
    // JSON: decode it, confirm, then come back here with the JSON.
    if (!/^[{[]/.test(trimmed) && extractPayload(trimmed) !== null) {
      this.importShared(trimmed);
      return true;
    }
    try {
      this.applyPack(sanitise(JSON.parse(trimmed)));
      this.ui.hidePaste();
      return true;
    } catch (err) {
      this.ui.setPackHint(`That is not a valid pack: ${err.message}`);
      return false;
    }
  }

  /* ------------------------------------------------------- share by link */

  /** Choices for "What to share", each with a default name for the link. */
  shareScopes() {
    const cues = this.cues.map((c) => c.spec);
    const themes = customSpecs();
    const tagEdits = Object.keys(this.pack.tagOverrides || {}).length;
    const scopes = [{ value: 'all', label: 'Everything (themes, cues, tag edits, theme)', name: 'My GPS Music pack' }];
    const mine = cues.filter((c) => c._ui === true).length;
    if (mine || tagEdits) {
      scopes.push({ value: 'mine', label: `Only what I made here (${mine} cue${mine === 1 ? '' : 's'}, ${tagEdits} tag edit${tagEdits === 1 ? '' : 's'})`, name: 'My cues and tag edits' });
    }
    if (themes.length) {
      scopes.push({ value: 'themes', label: `Themes only (${themes.length})`, name: themes.length === 1 ? themes[0].name : `${themes.length} themes` });
    }
    cues.forEach((c, i) => scopes.push({ value: `cue:${i}`, label: `One cue: ${c.name}`, name: c.name }));
    return scopes;
  }

  openShare() {
    if (!shareSupported()) {
      this.ui.setPackHint(UNSUPPORTED_MESSAGE);
      return;
    }
    this.ui.openShare({ scopes: this.shareScopes(), places: this.pack.locations.length });
  }

  /**
   * The pack a link will carry, sanitised. Saved places only when asked for.
   * A cue that holds a custom theme brings that theme with it, or the pin
   * would hold nothing on the other side.
   */
  buildSharePack({ scope = 'all', locations = false, name = '' } = {}) {
    const cues = this.cues.map((c) => c.spec);
    const themes = customSpecs();
    let pickCues = [];
    let pickThemes = [];
    let tagOverrides = {};
    let theme = null;
    if (scope === 'all') {
      pickCues = cues;
      pickThemes = [...themes];
      tagOverrides = this.pack.tagOverrides;
      theme = this.pack.theme;
    } else if (scope === 'mine') {
      pickCues = cues.filter((c) => c._ui === true);
      tagOverrides = this.pack.tagOverrides;
    } else if (scope === 'themes') {
      pickThemes = [...themes];
    } else if (/^cue:\d+$/.test(scope)) {
      const cue = cues[Number(scope.slice(4))];
      if (cue) pickCues = [cue];
    }
    for (const c of pickCues) {
      const t = c.theme && themes.find((s) => s.id === c.theme);
      if (t && !pickThemes.includes(t)) pickThemes.push(t);
    }
    const pack = sanitise({
      version: 1,
      name: name || undefined,
      tagOverrides,
      locations: locations ? this.pack.locations : [],
      themes: pickThemes,
      cues: pickCues,
      theme,
    });
    // Leave out what is empty: every byte is a byte of URL.
    for (const k of Object.keys(pack)) {
      const v = pack[k];
      if (v === null || (Array.isArray(v) && !v.length) ||
          (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete pack[k];
    }
    return pack;
  }

  /** Pack → { text, bare }: a link, or a bare `pack=` code where no link can work. */
  async makeShareLink(opts) {
    const pack = this.buildSharePack(opts);
    const payload = await encodePack(pack);
    const base = shareBase();
    return { pack, text: base ? `${base}#pack=${payload}` : `pack=${payload}`, bare: !base };
  }

  /** Summary and size for the share panel, before anything is copied. */
  async previewShare(opts) {
    const seq = (this._shareSeq = (this._shareSeq || 0) + 1);
    let made;
    try {
      made = await this.makeShareLink(opts);
    } catch (err) {
      this.ui.setShareSummary({ note: `Could not build the link: ${err.message}`, warn: true });
      return;
    }
    if (seq !== this._shareSeq) return;
    const { lines, total } = summarisePack(made.pack);
    if (!total) {
      this.ui.setShareSummary({ note: 'Nothing to share in that selection.', warn: true });
      return;
    }
    if (!opts.locations && this.pack.locations.length) {
      lines.push({ text: `Not included: ${this.pack.locations.length} saved place${this.pack.locations.length === 1 ? '' : 's'}` });
    }
    const size = made.text.length;
    const over = size > SHARE_LINK_MAX;
    this.ui.setShareSummary({
      lines,
      warn: over,
      note: over
        ? `This link would be ${formatKb(size)} \u2014 more than the ${formatKb(SHARE_LINK_MAX)} that travels reliably through chat apps. Share less, or use Export pack and send the file.`
        : `Link: ${formatKb(size)}.`,
    });
  }

  /**
   * Copy the link. Over SHARE_LINK_MAX it is not produced at all: a link that
   * arrives cut short is worse than no link. In the Android app it also opens
   * the system share sheet (AndroidHost.shareText) where the host has one.
   */
  async copyShareLink(opts) {
    if (!shareSupported()) {
      this.ui.setShareSummary({ note: UNSUPPORTED_MESSAGE, warn: true });
      return;
    }
    let made;
    try {
      made = await this.makeShareLink(opts);
    } catch (err) {
      this.ui.setShareSummary({ note: `Could not build the link: ${err.message}`, warn: true });
      return;
    }
    const { lines, total } = summarisePack(made.pack);
    if (!total) {
      this.ui.setShareSummary({ note: 'Nothing to share in that selection.', warn: true });
      return;
    }
    if (made.text.length > SHARE_LINK_MAX) {
      this.ui.showShareOutput('');
      this.ui.setShareSummary({
        lines,
        warn: true,
        note: `Not copied: this link would be ${formatKb(made.text.length)}, over the ${formatKb(SHARE_LINK_MAX)} limit. Share less, or use Export pack and send the file.`,
      });
      return;
    }
    this.ui.showShareOutput(made.text);
    const copied = await this.ui.copyText(made.text);
    let note = copied
      ? `Copied (${formatKb(made.text.length)}).`
      : 'Could not copy automatically \u2014 select the link below and copy it.';
    if (made.bare) {
      note += ' This app has no public web address to link to, so this is a pack code: ' +
        'they paste it into Anywhere \u2192 Paste, or share it to GPS Music.';
    } else if (/^(localhost|127\.|\[::1\])/.test(location.hostname)) {
      note += ' Note: it points at this computer (localhost), so it only opens here.';
    }
    this.ui.setShareSummary({ lines, note });
    try {
      window.AndroidHost?.shareText?.(made.text);
    } catch {
      /* not in the wrapper, or an older one without shareText */
    }
  }

  /**
   * `#pack=…` in the address: take it out of the address first, so a reload
   * (or the back button) cannot import it again, then decode and confirm.
   */
  checkShareHash() {
    const hash = location.hash;
    if (!hash.startsWith('#pack=')) return;
    history.replaceState(null, '', location.pathname + location.search);
    this.importShared(hash);
  }

  /**
   * A pack from a link (or a pasted link / code). Decoded with a size cap,
   * shown to the person, and only on Import handed to importPackText — the
   * same sanitise + validate path as a pasted file.
   */
  async importShared(text) {
    const payload = extractPayload(text);
    if (payload === null) return false;
    const fail = (msg) => {
      this.ui.setPackHint(msg);
      this.ui.setStatus(msg, 'error');
      return true;
    };
    if (!shareSupported()) return fail(UNSUPPORTED_MESSAGE);
    let json;
    let preview;
    try {
      json = await decodePayload(payload);
      preview = sanitise(JSON.parse(json));
    } catch (err) {
      return fail(err instanceof ShareError
        ? err.message : 'That pack link is damaged (what it holds is not a pack).');
    }
    const { lines, total } = summarisePack(preview);
    if (!total) return fail('That pack link holds nothing this app can use.');
    const name = preview.name || 'Unnamed pack';
    const ok = await this.ui.confirmSharedPack({ name, lines });
    if (!ok) {
      this.ui.setPackHint('Shared pack not imported.');
      this.ui.setStatus('Shared pack not imported.');
      return true;
    }
    if (this.importPackText(json)) this.ui.setStatus(`Imported \u201c${name}\u201d.`);
    return true;
  }

  /** The bundled example packs (public/packs/), listed in the Anywhere panel. */
  async loadExampleList() {
    try {
      const res = await fetch('/packs/index.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      this.ui.setExamplePacks((Array.isArray(list) ? list : []).filter((p) =>
        typeof p?.file === 'string' && /^[\w-]+\.json$/.test(p.file) &&
        typeof p.name === 'string'));
    } catch (err) {
      console.warn('[packs] no example list:', err.message);
    }
  }

  /** One-tap import of a bundled example — same path as a pasted pack. */
  async importExample(file, name) {
    try {
      const res = await fetch('/packs/' + file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const before = this.pack.locations.length;
      if (!this.importPackText(text)) return;
      const added = this.pack.locations.length - before;
      this.ui.setPackHint(
        `Imported ${name} \u2014 ${added} place${added === 1 ? '' : 's'} added under Anywhere.`);
    } catch (err) {
      this.ui.setPackHint(`Could not load ${name}: ${err.message}`);
    }
  }

  applyPack(incoming) {
    {

      // Merge rather than replace: importing someone else's tuning should not
      // silently delete the places you saved.
      this.pack.tagOverrides = { ...this.pack.tagOverrides, ...incoming.tagOverrides };

      const key = (l) => `${l.lat.toFixed(4)},${l.lng.toFixed(4)}`;
      const seen = new Set(this.pack.locations.map(key));
      for (const loc of incoming.locations) {
        if (seen.has(key(loc))) continue;
        this.pack.locations.push(loc);
        seen.add(key(loc));
      }

      if (incoming.cues?.length) {
        const merged = [
          ...this.pack.cues.filter((c) =>
            !incoming.cues.some((n) => n.name === c.name)),
          ...incoming.cues,
        ];
        const built = compileCues(merged);
        this.pack.cues = merged;
        this.cues = built.cues;
        this.reportCues(built.report);
      }

      // Themes: install, then keep only the ones that actually compiled.
      let themeNote = '';
      if (incoming.themes?.length) {
        const report = registerSpecs(incoming.themes);
        this.reportThemes(report);
        const accepted = new Set(report.filter((r) => r.ok).map((r) => r.id));
        for (const spec of incoming.themes) {
          if (!accepted.has(spec.id)) continue;
          this.pack.themes = this.pack.themes.filter((t) => t.id !== spec.id);
          this.pack.themes.push(spec);
        }
        const rejected = report.length - accepted.size;
        themeNote = `, ${accepted.size} theme${accepted.size === 1 ? '' : 's'}` +
          (rejected ? ` (${rejected} rejected)` : '');
        this.ui.refreshThemes(this.theme.id);
      }

      if (incoming.theme) {
        this.pack.theme = incoming.theme;
        this.theme = getTheme(incoming.theme);
        this.ui.setTheme(this.theme.id);
      }

      this.themeNote = themeNote;
      setTagOverrides(this.pack.tagOverrides);
      savePack(this.pack);
      this.ui.renderSaved(this.pack.locations);
      this.reanalyse();
      this.ui.setPackHint(
        `Imported ${Object.keys(incoming.tagOverrides).length} tag edits, ` +
        `${incoming.locations.length} places${this.themeNote || ''}.`);
      this.ui.renderSaved(this.pack.locations);
      // After the themes are installed, so a pinned pack theme shows its name
      // and its fence is not skipped as pinning a missing theme.
      this.renderCueList();
      this.renderPackManager();
      if (incoming.cues?.length) this.syncHostFences();
    }
  }

  /* ------------------------------------------------------------ cue editor */

  /**
   * Open the cue editor on a saved place — or on the cue already bound there.
   * Nothing is written to the pack until Save: the coordinates wait in
   * `cueDraft`, so the device position never lands in a cue by accident.
   */
  openBind(loc, fromHere = this.isHere(loc)) {
    if (!loc) return;
    const existing = this.pack.cues.find((c) => isEditableCue(c) &&
      Math.abs(c.when.near.lat - loc.lat) < 1e-5 && Math.abs(c.when.near.lng - loc.lng) < 1e-5);
    if (existing) {
      this.editCue(existing.name, fromHere);
      return;
    }
    this.cueDraft = { editing: null, lat: loc.lat, lng: loc.lng, fromHere, keepLayers: [] };
    this.ui.openCueEditor({
      name: loc.name,
      lat: loc.lat,
      lng: loc.lng,
      radius: 150,
      theme: null,
      presets: [],
      editing: null,
      where: `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`,
    });
  }

  /** "Bind here…": save the spot first, then bind to it. */
  bindHere() {
    if (!this.position) {
      this.ui.setStatus('No position yet \u2014 search somewhere or start GPS first.');
      return;
    }
    this.saveHere();
    this.openBind(this.pack.locations[0], true);
  }

  editCue(name, fromHere = null) {
    const cue = this.pack.cues.find((c) => c.name === name && isEditableCue(c));
    if (!cue) return;
    const { lat, lng, radius } = cue.when.near;
    const presetIds = new Set(LOOP_PRESETS.map((p) => p.id));
    const layers = cue.layers || [];
    this.cueDraft = {
      editing: cue.name,
      lat,
      lng,
      fromHere: fromHere ?? this.isHere({ lat, lng }),
      // Layers that are not one of the presets are kept as they are.
      keepLayers: layers.filter((l) => !presetIds.has(l?.name)),
    };
    this.ui.openCueEditor({
      name: cue.name,
      lat,
      lng,
      radius,
      theme: cue.theme || null,
      presets: LOOP_PRESETS.filter((p) => layers.some((l) => l?.name === p.id)).map((p) => p.id),
      editing: cue.name,
      where: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
    });
  }

  /** Build an ordinary pack cue from the editor, validate it, and use it. */
  saveCue({ name, radius, theme, presets }) {
    const draft = this.cueDraft;
    if (!draft) return;

    name = String(name || '').trim().slice(0, 80);
    if (!name) {
      this.ui.setCueEditorHint('Give it a name.');
      return;
    }
    if (this.pack.cues.some((c) => c.name === name && c.name !== draft.editing)) {
      this.ui.setCueEditorHint(`There is already a cue called \u201c${name}\u201d.`);
      return;
    }

    const layers = [
      ...LOOP_PRESETS.filter((p) => presets.includes(p.id))
        .flatMap((p) => p.layers.map((l) => structuredClone(l))),
      ...draft.keepLayers,
    ];
    if (!theme && !layers.length) {
      this.ui.setCueEditorHint('Pick a theme, a loop, or both.');
      return;
    }

    const cue = { name, when: { near: { lat: draft.lat, lng: draft.lng, radius: Math.round(radius) } } };
    if (theme) cue.theme = theme;
    if (layers.length) cue.layers = layers;
    cue._ui = true;

    const errors = validateCue(cue);
    if (errors.length) {
      this.ui.setCueEditorHint(errors[0]);
      return;
    }

    const at = draft.editing ? this.pack.cues.findIndex((c) => c.name === draft.editing) : -1;
    if (at >= 0) {
      this.pack.cues[at] = cue;
    } else {
      if (this.pack.cues.length >= 100) {
        this.ui.setCueEditorHint('A pack holds at most 100 cues.');
        return;
      }
      this.pack.cues.push(cue);
    }

    savePack(this.pack);
    this.rebuildCues(draft.editing && draft.editing !== name
      ? { from: draft.editing, to: name } : null);
    this.syncHostFences();
    this.renderPackManager();
    this.cueDraft = null;
    this.ui.closeCueEditor();
    this.ui.setStatus(`Saved cue \u201c${name}\u201d.`);

    // Standing on it: be heard now rather than easing in over several ticks.
    if (draft.fromHere) this.snapCues = true;
    this.replan(true);
  }

  /** The editor's Delete: an editable cue, by name. */
  deleteCue(name) {
    const at = this.pack.cues.findIndex((c) => c.name === name && isEditableCue(c));
    if (at >= 0) this.removeCue(at);
  }

  /**
   * Remove any cue \u2014 made here or from a pack \u2014 by its index in
   * `this.pack.cues`. Persists, recompiles (survivors keep their strength and
   * latch), re-syncs the Android fences, and replans; a loop that was sounding
   * fades out through the usual cue smoothing.
   */
  removeCue(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.pack.cues.length) return;
    const [cue] = this.pack.cues.splice(index, 1);
    savePack(this.pack);
    this.rebuildCues();
    this.syncHostFences();
    if (this.cueDraft?.editing === cue.name) {
      this.cueDraft = null;
      this.ui.closeCueEditor();
    }
    this.renderPackManager();
    this.ui.setStatus(`Removed cue \u201c${cue.name}\u201d.`);
    this.replan(true);
  }

  /**
   * Recompile after an edit. Every surviving cue keeps its strength and latch,
   * so a loop that is already sounding does not dip, and a held theme does
   * not drop, just because a different cue changed.
   */
  rebuildCues(renamed = null) {
    const before = new Map(this.cues.map((c) => [c.name, c]));
    const built = compileCues(this.pack.cues);
    for (const cue of built.cues) {
      const old = before.get(renamed && cue.name === renamed.to ? renamed.from : cue.name);
      if (old) {
        cue.strength = old.strength;
        cue.pinned = old.pinned;
      }
    }
    this.cues = built.cues;
    this.reportCues(built.report);
    this.renderCueList();
  }

  renderCueList() {
    this.ui.renderCueList(this.cues.map((c) => ({
      name: c.name,
      // Where it sits in the pack, for Remove (rejected cues are not listed).
      index: this.pack.cues.indexOf(c.spec),
      description: describeCondition(c.when),
      does: [
        c.theme ? (this.hasTheme(c.theme)
          ? `plays ${getTheme(c.theme).name}`
          : `would play ${c.theme} (theme not installed)`) : null,
        c.layers.length ? `adds ${c.layers.map((l) => l.name || l.voice).join(', ')}` : null,
      ].filter(Boolean).join(', '),
      editable: isEditableCue(c.spec),
      strength: c.strength,
    })));
  }

  /** Is a theme with this id installed and playable right now? */
  hasTheme(id) {
    return allThemes().some((t) => t.id === id && t.available);
  }

  /* ---------------------------------------------------------- pack manager */

  /** What has been imported or edited, for the "Manage" panel. */
  renderPackManager() {
    const specs = customSpecs();
    this.ui.renderPackManager({
      themes: specs.map((s) => ({
        id: s.id,
        name: s.name,
        // Cues that pin it: they stay, but go quiet on the theme once it is gone.
        pinnedBy: this.pack.cues.filter((c) => c.theme === s.id).length,
      })),
      tagEdits: Object.keys(this.pack.tagOverrides || {}).length,
      cues: this.pack.cues.length,
      places: this.pack.locations.length,
    });
  }

  /**
   * Remove an imported theme. If it was the chosen (or saved default) theme,
   * fall back to the built-in default. Cues that pin it are kept — their
   * `theme` still names it, so re-importing the theme brings them back — but
   * a pin to a theme that is not installed is ignored (see replan), and its
   * wake-up fence is withdrawn. The engine keeps the old theme object until
   * the next phrase boundary, like any other theme change.
   */
  removeTheme(id) {
    if (!customSpecs().some((s) => s.id === id)) return;
    const name = getTheme(id).name;
    removeCustom(id);
    this.pack.themes = this.pack.themes.filter((t) => t.id !== id);
    if (this.pack.theme === id) this.pack.theme = null;
    if (this.theme.id === id) this.theme = getTheme(DEFAULT_THEME_ID);
    savePack(this.pack);
    this.lastPlanKey = null;
    this.ui.refreshThemes(this.theme.id);
    this.renderCueList();
    this.renderPackManager();
    this.syncHostFences();
    this.ui.setStatus(`Removed theme “${name}”.`);
    this.replan(true);
  }

  /** Every tag edit, at once — the per-tag Reset, for all of them. */
  resetAllTags() {
    const n = Object.keys(this.pack.tagOverrides || {}).length;
    setTagOverrides({});
    this.pack.tagOverrides = {};
    savePack(this.pack);
    this.renderPackManager();
    this.ui.setStatus(`Reset ${n} tag edit${n === 1 ? '' : 's'}.`);
    this.reanalyse();
  }

  /**
   * Factory state: forget the pack and every localStorage key the app owns,
   * uninstall imported themes, drop all cues (and the Android fences), and go
   * back to the default theme. The volume and ambience sliders return to their
   * defaults. Session-only settings — pace lock, weather, hills, where you are
   * standing — are not stored and are left as they are.
   */
  resetEverything() {
    for (const spec of customSpecs()) removeCustom(spec.id);
    clearStore();
    this.ui.resetSliders();
    this.applyVolume();
    this.applyAmbience();
    this.pack = emptyPack();
    setTagOverrides({});
    this.theme = getTheme(DEFAULT_THEME_ID);
    this.lastPlanKey = null;
    this.cueDraft = null;
    this.ui.closeCueEditor();
    this.cues = compileCues(this.pack.cues).cues;
    this.syncHostFences();
    this.ui.refreshThemes(this.theme.id);
    this.ui.renderSaved(this.pack.locations);
    this.renderCueList();
    this.renderPackManager();
    this.ui.setPackHint('Everything reset — back to how the app was installed.');
    this.ui.setStatus('Reset everything.');
    // Re-derive the scene without the tag edits; replans even with no places yet.
    if (this.places) this.reanalyse();
    else this.replan(true);
  }

  isHere(loc) {
    if (!loc || !this.position) return false;
    return haversine(this.position.lat, this.position.lng, loc.lat, loc.lng) < HERE_METRES;
  }

  /* ------------------------------------------------------------ tag editing */

  editTag(type, dim, value) {
    setTagOverride(type, { [dim]: value });
    this.pack.tagOverrides = getTagOverrides();
    savePack(this.pack);
    this.renderPackManager();
    this.reanalyse();
  }

  resetTag(type) {
    clearTagOverride(type);
    this.pack.tagOverrides = getTagOverrides();
    savePack(this.pack);
    this.renderPackManager();
    this.reanalyse();
  }

  /**
   * Re-derive the scene from the places already fetched.
   *
   * The analysis is cached between lookups, so without this an edited tag
   * profile would not be heard until you moved — which would make the sliders
   * feel broken.
   */
  reanalyse() {
    if (!this.places) return;
    this.analysis = analyzePlaces(this.places, this.radius);
    this.scene = buildScene(this.analysis, this.places, this.position);
    this.updateTargetMood();
    // Converge faster than the usual drift so a slider feels responsive.
    if (this.currentMood && this.targetMood) {
      this.currentMood = lerpMood(this.currentMood, this.targetMood, 0.5);
    }
    this.replan(true);
  }

  /* ---------------------------------------------------------------- weather */

  /**
   * The weather toggle (C3.10). On: ask now if we know where we are (replan
   * keeps it fresh after that). Off: drop the reading and discard anything in
   * flight, so no request is made and the mood and rain bed return to normal
   * on the next replan (both glide).
   */
  setWeather(on) {
    if (on) {
      this.weather.refresh(this.position);
      this.ui.setStatus('Weather on \u2014 your position, rounded to about 1 km, goes to Open-Meteo.');
    } else {
      this.weather.disable();
      this.ui.setStatus('Weather off.');
    }
  }

  /**
   * The hills toggle (P3). On: start measuring from here. Off: forget the
   * history and discard anything in flight; the tension glides back.
   */
  setHills(on) {
    if (on) {
      this.elevation.update(this.position);
      this.ui.setStatus('Hills on \u2014 climbing adds tension. Without GPS altitude, grid points about 1 km apart go to Open-Meteo.');
    } else {
      this.elevation.disable();
      this.ui.setTerrain(null);
      this.ui.setStatus('Hills off.');
    }
  }

  /** The terrain reading in use (elevation.js), or null with the toggle off. */
  terrain() {
    return this.ui.hillsOn() ? this.elevation.terrain() : null;
  }

  /* --------------------------------------------------------------- position */

  onPosition(pos) {
    this.position = pos;
    this.scene.position = pos;   // `near` cues track you between lookups
    this.ui.setPosition(pos);
    if (this.ui.hillsOn()) this.elevation.update(pos);   // fire-and-forget
    this.maybeFetchPlaces(pos);
    if (this.autoplayPending) {
      this.autoplayPending = false;
      if (!this.playing) this.togglePower();
    }
  }

  /** Only spend a lookup when the surroundings could plausibly have changed. */
  maybeFetchPlaces(pos) {
    if (this.fetching) return;

    const now = Date.now();
    const sinceLast = now - this.lastFetchAt;
    if (sinceLast < FETCH_MIN_INTERVAL_MS) return;

    // At walking pace a third of the radius is the right granularity. At
    // driving speed that threshold is crossed every few seconds, and every
    // crossing is a billed request — so scale it up with speed until you are
    // fetching roughly once per radius travelled, which is the point at which
    // consecutive lookups stop overlapping anyway.
    const motion = Math.min(1, Math.max(0, (pos.speed || 0) / 14));
    const moveThreshold = Math.max(80, this.radius * (0.3 + 0.7 * motion));
    const moved = this.lastFetchPos
      ? haversine(this.lastFetchPos.lat, this.lastFetchPos.lng, pos.lat, pos.lng)
      : Infinity;

    // Standing still (GPS gone coarse): the surroundings are not changing, so
    // refresh far less often. Moving past the threshold still fetches at once.
    const maxInterval = pos.mode === 'coarse' ? FETCH_STATIONARY_INTERVAL_MS : FETCH_MAX_INTERVAL_MS;
    if (moved < moveThreshold && sinceLast < maxInterval) return;

    this.fetchPlaces(pos);
  }

  async fetchPlaces(pos) {
    const seq = ++this.fetchSeq;
    this.fetching = true;
    this.lastFetchAt = Date.now();
    this.lastFetchPos = { lat: pos.lat, lng: pos.lng };

    try {
      const data = await provider.fetchPlaces(pos.lat, pos.lng, this.radius);

      // Someone asked for somewhere else while this was in flight.
      if (seq !== this.fetchSeq) return;

      // Tag each place with a category so the radar can colour it.
      for (const place of data.places) {
        place.cat = categoryFor(place.primaryType) ||
          (place.types || []).map(categoryFor).find(Boolean) || null;
      }

      this.places = data.places;
      this.analysis = analyzePlaces(data.places, data.radius);
      this.scene = buildScene(this.analysis, data.places, pos);

      // The new surroundings are in place, so a jump can now take effect at once.
      if (this.pendingJump) {
        this.pendingJump = false;
        this.snapCues = true;
      }
      this.ui.setPlaces(data.places.filter((p) => p.cat), data.radius);

      if (data.cached) this.cacheHits++;
      else this.lookups++;

      const bits = [];
      if (data.district) bits.push(data.district);
      bits.push(`${data.places.length} places`);
      if (data.cached) bits.push('cached');
      if (data.offline) bits.push('offline \u2014 last known');
      if (data.direct) bits.push('direct');
      bits.push(`${this.lookups} lookups`);
      this.ui.setStatus(bits.join(' \u00b7 '));

      // Running with no server at all: correct the badge, and do not keep
      // showing the "configure a key" warning, because nothing is wrong.
      if (data.direct && this.provider !== 'osm-direct') {
        this.provider = 'osm-direct';
        this.ui.setProvider('osm-direct');
        this.ui.setWarning(null);
      }

      if (data.warning) this.ui.setWarning(`Google Places unavailable — ${data.warning}`);

      this.updateTargetMood();
    } catch (err) {
      if (seq === this.fetchSeq) this.ui.setStatus(err.message, 'error');
    } finally {
      // Only the newest request may clear the flag, or an overtaken one
      // reopens the gate early.
      if (seq === this.fetchSeq) this.fetching = false;
    }
  }

  /* ------------------------------------------------------------------ music */

  updateTargetMood() {
    if (!this.analysis) return;
    const { mood, band } = contextualise(this.analysis, {
      speed: this.position?.speed ?? 0,
      hour: new Date().getHours(),
      weather: this.ui.weatherOn() ? this.weather.current : null,
      terrain: this.terrain(),
    });
    this.targetMood = mood;
    this.band = band;
    if (!this.currentMood) this.currentMood = { ...mood };
  }

  /**
   * Ease the sounding mood toward the target and hand the engine a fresh plan.
   * Continuous qualities track the mood every tick; the seed is derived from a
   * coarse fingerprint of the scene, so key, mode and chord sequence stay put
   * until you are somewhere meaningfully different.
   */
  replan(force = false) {
    // Fire-and-forget: at most one request per 15 min or per few km moved.
    if (this.ui.weatherOn()) this.weather.refresh(this.position);
    if (!this.analysis) return;

    this.updateTargetMood();
    this.currentMood = lerpMood(this.currentMood, this.targetMood, MOOD_ALPHA);

    const key = sceneKey(this.currentMood, this.analysis.categories);
    const name = sceneName(this.currentMood, this.analysis.categories);

    // Cues first: one may pin a different theme for this place.
    const jumped = this.snapCues;
    this.activeCues = evaluateCues(this.cues, this.scene, { snap: jumped });
    this.snapCues = false;
    this.ui.setCueStrengths(this.cues.map((c) => c.strength));
    // A cue pinning a theme that is not installed (removed in the pack
    // manager, or never shipped) holds nothing: the chosen theme plays on.
    const pin = pinnedTheme(this.activeCues.filter((c) => !c.theme || this.hasTheme(c.theme)));
    const base = pin ? getTheme(pin.id) : this.theme;
    // Position (with speed and heading) lets `spatial` cues pan toward their place.
    const composed = withCues(base, this.activeCues, this.position);

    const seed = hashString(`${base.id}:${key}`);
    // themeId travels with the plan so the engine can keep the two in step.
    //
    // Cue membership is deliberately NOT part of it. A cue arriving does change
    // what step() does, but withCues() builds the plan and the step function as
    // a pair and applyPlan swaps them together, so they cannot desync. Making
    // it discrete would hold the cue at the phrase boundary and then drop it in
    // at whatever strength it had reached — which is to say, at full volume,
    // defeating the whole point of fading it in.
    const plan = {
      ...composed.plan(this.currentMood, seed, this.scene),
      themeId: base.id,
    };

    // Pace lock (C3.9): bpm is continuous, so this only moves the engine's
    // target and it glides there. Not while GPS has dropped to coarse (C2.3):
    // that means you are standing still, and a speed derived from coarse fixes
    // is jitter, not footsteps.
    const speed = this.position?.speed ?? 0;
    if (this.ui.paceLock() && speed > PACE_MIN_SPEED && this.position?.mode !== 'coarse') {
      plan.bpm = paceLockedBpm(plan.bpm, speed);
    }

    this.lastBase = base;
    this.lastPin = pin;
    this.showPlayingTheme();
    if (this.playing) this.setHostScene(name);

    this.ui.setTerrain(this.terrain());
    this.ui.setScene({
      name,
      meta: `${plan.meta.key} ${plan.meta.mode} · ${plan.meta.progression} · ${Math.round(plan.bpm)} bpm`,
      // The target mood, not the gliding one, so the words settle at once.
      why: whyLine(this.targetMood, this.analysis,
        this.ui.weatherOn() ? this.weather.current : null, this.terrain()),
      cues: this.activeCues
        .filter((c) => c.strength > 0.05)
        .map((c) => ({ name: c.name, strength: c.strength })),
      mood: this.currentMood,
      tags: this.analysis.tags,
      placeCount: this.analysis.placeCount,
      band: this.band?.label,
    });

    if (!this.playing) return;

    // Applied every tick on purpose: the engine takes continuous changes
    // immediately and defers anything that would break the current phrase.
    this.engine.applyPlan(plan, composed.step.bind(composed), { urgent: jumped });
    this.updateAmbience(plan);

    if (force || key !== this.lastPlanKey) {
      this.lastPlanKey = key;
    }
  }

  /**
   * Tell the UI which theme is actually sounding: the one the engine last
   * committed while playing, otherwise the one that would play. The "held by"
   * line names the pin only once its theme is the one sounding.
   */
  showPlayingTheme() {
    const id = this.playing ? this.engine.plan?.themeId : null;
    const theme = id ? getTheme(id) : (this.lastBase || this.theme);
    const pin = this.lastPin?.id === theme.id ? this.lastPin : null;
    this.ui.setActiveTheme(theme, pin);
  }

  /**
   * The place, literally: one level per ambience bed from what is around you.
   * `plan.ambience` (0..1, default 1) is the theme's say in it and is
   * continuous — it only scales levels that glide anyway, so it never waits
   * for a phrase. Rain comes from the weather (C3.10), not the map:
   * `rain01` (mm/h ÷ 4, see weather.js) — zero with weather off.
   */
  updateAmbience(plan) {
    const w = (...cats) => clamp01(
      cats.reduce((sum, c) => sum + this.scene.categoryWeight(c), 0) * AMBIENCE_WEIGHT);
    const urban = this.analysis?.urbanness ?? 0;
    // Birds keep the hours birds keep: silent in the night band (22:00–05:00).
    const night = this.band?.id === 'night';
    this.ambienceBase = {
      birds: night ? 0 : w('nature'),
      water: w('water'),
      traffic: Math.max(w('transit', 'service'),
        clamp01((urban - AMBIENCE_URBAN) / (1 - AMBIENCE_URBAN))),
      murmur: w('food', 'nightlife', 'retail'),
      rain: this.ui.weatherOn() ? weatherFactors(this.weather.current).rain01 : 0,
    };
    this.themeAmbience = typeof plan.ambience === 'number' && Number.isFinite(plan.ambience)
      ? clamp01(plan.ambience) : 1;
    this.applyAmbience();
  }

  /** Scene levels × the Ambience slider × the theme's `ambience`. */
  applyAmbience() {
    if (!this.playing || !this.ambienceBase) return;
    const k = this.ui.ambienceLevel() * this.themeAmbience;
    const levels = {};
    for (const [name, v] of Object.entries(this.ambienceBase)) levels[name] = v * k;
    this.ambienceLevels = levels;
    this.engine.setAmbience(levels);
  }

  /* ------------------------------------------------------------------ host */

  /**
   * When running inside the Android wrapper, hand playback state to the
   * foreground service. That service is what keeps the audio graph and the
   * location updates alive once the screen goes off.
   */
  setHostPlaying(playing) {
    try {
      window.AndroidHost?.setPlaying?.(playing);
    } catch {
      /* not running in the wrapper */
    }
  }

  /**
   * The slider, times the duck while another app holds transient focus.
   * The engine's setVolume glides with setTargetAtTime (τ 0.1 s, so ~0.3 s
   * to settle): ducking and un-ducking never pop.
   */
  applyVolume() {
    const slider = Number(this.ui.el.volume.value) / 100;
    this.engine.setVolume(this.hostDucked ? slider * HOST_DUCK : slider);
  }

  /*
   * Audio focus (Android): PlaybackService calls these from its focus
   * listener. The host decides what is transient; the page only obeys.
   * Media controls (C2.2) use hostPause/hostResume too: the notification's
   * Play/Pause and headset buttons in the APK, navigator.mediaSession in a
   * browser.
   */

  /** Focus lost, or the user paused from media controls: stop, if playing. */
  hostPause() {
    // A pause also ends any duck, so the next Play is at the slider level.
    if (this.hostDucked) {
      this.hostDucked = false;
      this.applyVolume();
    }
    if (this.playing) this.togglePower();
  }

  /** Focus back after a transient loss, or Play pressed: play again, if stopped. */
  hostResume() {
    if (!this.playing) this.togglePower();
  }

  /** Another sound wants to be heard over us (a notification): duck under it. */
  hostDuck(on) {
    this.hostDucked = !!on;
    this.applyVolume();
  }

  /** Show the current scene on the notification, so the lock screen says something. */
  setHostScene(text) {
    if (text === this._hostScene) return;
    this._hostScene = text;
    try {
      window.AndroidHost?.setScene?.(text);
    } catch {
      /* not running in the wrapper */
    }
    this.setMediaMetadata(text);
  }

  /*
   * Media controls (C2.2). In the APK, the notification's Play/Pause and
   * headset buttons go through PlaybackService's MediaSession, which calls
   * hostPause()/hostResume(). A browser's own media controls, where it has
   * them, call the very same two methods, so either way the page's `playing`
   * stays the one source of truth. All of it is feature-detected: without
   * navigator.mediaSession these do nothing.
   */

  setupMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms || typeof ms.setActionHandler !== 'function') return;
    const handlers = { play: () => this.hostResume(), pause: () => this.hostPause() };
    for (const [action, fn] of Object.entries(handlers)) {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* this browser does not support that action */
      }
    }
    this.setMediaPlaybackState();
  }

  setMediaPlaybackState() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      ms.playbackState = this.playing ? 'playing' : 'paused';
    } catch {
      /* read-only in some engines */
    }
  }

  /** The scene name as the track title, as the notification shows it. */
  setMediaMetadata(scene) {
    const ms = navigator.mediaSession;
    if (!ms || typeof window.MediaMetadata !== 'function') return;
    try {
      ms.metadata = new window.MediaMetadata({ title: scene || 'GPS Music', artist: 'GPS Music' });
    } catch {
      /* ignore: metadata is a nicety */
    }
  }

  /**
   * Hand the Android wrapper the fences that may wake the app: every cue with
   * a `near` circle AND an installed theme to pin (a loop on its own is not
   * worth starting playback for, nor is a pin that would hold nothing), at most 100 — the Play Services per-app limit.
   * The host re-validates all of it; this is only the shortlist.
   */
  syncHostFences() {
    if (typeof window.AndroidHost?.setFences !== 'function') return;
    const fences = [];
    for (const cue of this.pack.cues || []) {
      const near = cue?.when?.near;
      if (!near || !cue.theme || !this.hasTheme(cue.theme)) continue;
      const { lat, lng, radius } = near;
      if (![lat, lng, radius].every(Number.isFinite)) continue;
      fences.push({ name: String(cue.name || ''), lat, lng, radius });
      if (fences.length >= 100) break;
    }
    try {
      window.AndroidHost.setFences(JSON.stringify(fences));
    } catch {
      /* not running in the wrapper, or the host refused — polling still works */
    }
  }

  /**
   * Launched by crossing a fence (GeofenceReceiver → MainActivity with
   * autoplay=true). The flag is one-shot on the host side, so a reload does
   * not start playback again. Switch to live GPS — the person is physically
   * there — and press Play once the first position has arrived, so the first
   * plan is built for where they are rather than for the default origin.
   */
  checkHostAutoplay() {
    let autoplay = false;
    try {
      autoplay = window.AndroidHost?.takeAutoplay?.() === true;
    } catch {
      /* not running in the wrapper */
    }
    if (!autoplay || this.playing) return;
    this.autoplayPending = true;
    if (this.geo.mode !== 'live') {
      this.geo.setMode('live');
      this.ui.setModeUI('live');
      document.querySelectorAll('.segmented [data-mode]').forEach((b) =>
        b.classList.toggle('active', b.dataset.mode === 'live'));
    }
    this.geo.start();
    this.ui.setStatus('Woken by a place you bound — waiting for a fix…', 'busy');
  }

  /* -------------------------------------------------------------- wake lock */

  async requestWakeLock() {
    // Inside the Android wrapper the foreground service keeps us running, so
    // holding the screen on would only flatten the battery for nothing.
    try {
      if (window.AndroidHost?.hasBackgroundAudio?.()) return;
    } catch {
      /* fall through to the browser behaviour */
    }
    if (!('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      /* denied or unsupported — not important enough to surface */
    }
  }

  releaseWakeLock() {
    this.wakeLock?.release?.().catch(() => {});
    this.wakeLock = null;
  }
}

/**
 * Made in the cue editor, and shaped so the editor can open it again. The
 * editor only writes `when.near`; a cue whose condition says anything else
 * (an `inside` polygon, say) is shown read-only, or saving would drop it.
 */
function isEditableCue(cue) {
  const near = cue?.when?.near;
  return cue?._ui === true && !!near &&
    Number.isFinite(near.lat) && Number.isFinite(near.lng) &&
    Object.keys(cue.when).every((k) => k === 'near');
}

/** 5321 → "5.2 KB"; under 1 KB in bytes. */
function formatKb(n) {
  return n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`;
}

/**
 * Exposed for debugging from the console — inspect `gpsMusic.currentMood`,
 * force a scene with `gpsMusic.analysis`, or read `gpsMusic.engine.level()`.
 */
window.gpsMusic = new App();

/*
 * Register the service worker: caches the app shell so an installed copy opens
 * offline, and remembers place lookups so a route you have walked replays
 * without a signal. Failing here only costs offline support.
 */
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err.message);
    });
  });
}
