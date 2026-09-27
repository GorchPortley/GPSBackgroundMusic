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
  analyzePlaces, contextualise, lerpMood, sceneKey, sceneName,
} from './scene.js';
import {
  categoryFor, clearTagOverride, getTagOverrides, setTagOverride, setTagOverrides,
} from './tags.js';
import { downloadPack, loadPack, readPackFile, sanitise, savePack } from './store.js';
import * as provider from './provider.js';
import { buildScene, emptyScene } from './scenecontext.js';
import {
  compileCues, evaluateCues, pinnedTheme, validateCue, withCues,
} from './themes/cues.js';
import { describeCondition } from './themes/match.js';
import { LOOP_PRESETS } from './themes/presets/loops.js';
import { hashString } from './audio/theory.js';
import {
  customSpecs, DEFAULT_THEME_ID, getTheme, registerSpecs,
} from './themes/index.js';
import { UI } from './ui.js';

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

    this.ui = new UI({
      onPower: () => this.togglePower(),
      onVolume: () => this.applyVolume(),
      onAmbience: () => this.applyAmbience(),
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
      onCueCancel: () => { this.cueDraft = null; },
      onExportPack: () => this.exportPack(),
      onImportPack: (file) => this.importPack(file),
      onPastePack: (text) => this.importPackText(text),
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
    this.applyVolume();

    this.loadConfig();
    this.loadExampleList();

    // Android: re-register the wake-up fences from the stored pack (the OS
    // drops them on reboot), and honour a launch that came from crossing one.
    this.syncHostFences();
    this.checkHostAutoplay();
    this.setupMediaSession();

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
    this.ui.setStatus(`Saved ${name}.`);
  }

  removeSaved(index) {
    this.pack.locations.splice(index, 1);
    savePack(this.pack);
    this.ui.renderSaved(this.pack.locations);
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
    try {
      this.applyPack(sanitise(JSON.parse(trimmed)));
      this.ui.hidePaste();
      return true;
    } catch (err) {
      this.ui.setPackHint(`That is not a valid pack: ${err.message}`);
      return false;
    }
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
        this.syncHostFences();
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
      // After the themes are installed, so a pinned pack theme shows its name.
      this.renderCueList();
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
    this.cueDraft = null;
    this.ui.closeCueEditor();
    this.ui.setStatus(`Saved cue \u201c${name}\u201d.`);

    // Standing on it: be heard now rather than easing in over several ticks.
    if (draft.fromHere) this.snapCues = true;
    this.replan(true);
  }

  deleteCue(name) {
    const at = this.pack.cues.findIndex((c) => c.name === name && isEditableCue(c));
    if (at < 0) return;
    this.pack.cues.splice(at, 1);
    savePack(this.pack);
    this.rebuildCues();
    this.syncHostFences();
    if (this.cueDraft?.editing === name) {
      this.cueDraft = null;
      this.ui.closeCueEditor();
    }
    this.ui.setStatus(`Deleted cue \u201c${name}\u201d.`);
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
      description: describeCondition(c.when),
      does: [
        c.theme ? `plays ${getTheme(c.theme).id === c.theme ? getTheme(c.theme).name : c.theme}` : null,
        c.layers.length ? `adds ${c.layers.map((l) => l.name || l.voice).join(', ')}` : null,
      ].filter(Boolean).join(', '),
      editable: isEditableCue(c.spec),
      strength: c.strength,
    })));
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
    this.reanalyse();
  }

  resetTag(type) {
    clearTagOverride(type);
    this.pack.tagOverrides = getTagOverrides();
    savePack(this.pack);
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

  /* --------------------------------------------------------------- position */

  onPosition(pos) {
    this.position = pos;
    this.scene.position = pos;   // `near` cues track you between lookups
    this.ui.setPosition(pos);
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
    const pin = pinnedTheme(this.activeCues);
    const base = pin ? getTheme(pin.id) : this.theme;
    const composed = withCues(base, this.activeCues);

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

    this.ui.setActiveTheme(base, pin);
    if (this.playing) this.setHostScene(name);

    this.ui.setScene({
      name,
      meta: `${plan.meta.key} ${plan.meta.mode} · ${plan.meta.progression} · ${Math.round(plan.bpm)} bpm`,
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
   * The place, literally: one level per ambience bed from what is around you.
   * `plan.ambience` (0..1, default 1) is the theme's say in it and is
   * continuous — it only scales levels that glide anyway, so it never waits
   * for a phrase. Rain is not set here: C3.10 (weather) will drive it.
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
   * a `near` circle AND a theme to pin (a loop on its own is not worth
   * starting playback for), at most 100 — the Play Services per-app limit.
   * The host re-validates all of it; this is only the shortlist.
   */
  syncHostFences() {
    if (typeof window.AndroidHost?.setFences !== 'function') return;
    const fences = [];
    for (const cue of this.pack.cues || []) {
      const near = cue?.when?.near;
      if (!near || !cue.theme) continue;
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
