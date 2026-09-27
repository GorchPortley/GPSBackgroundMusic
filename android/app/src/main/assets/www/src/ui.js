/**
 * HUD: DOM wiring plus the radar canvas.
 *
 * Purely presentational — it holds no music or location logic, it just renders
 * whatever main.js hands it and reports back what the user pressed.
 */

import {
  baseProfileFor, canonicalType, CATEGORY_COLORS, DIM_LABELS, DIMS,
  hasOverride, prettyTag, profileFor,
} from './tags.js';
import { SIM_SPEEDS } from './geo.js';
import { THEMES } from './themes/index.js';
import { LOOP_PRESETS } from './themes/presets/loops.js';

const $ = (id) => document.getElementById(id);

/** Cue radius slider: log scale, so 50 m and 3 km are both easy to hit. */
const CUE_RADIUS_MIN = 50;
const CUE_RADIUS_MAX = 3000;
const CUE_SLIDER_MAX = 1000;

export class UI {
  constructor(handlers = {}) {
    this.h = handlers;

    this.el = {
      power: $('power'),
      powerLabel: $('powerLabel'),
      volume: $('volume'),
      simRow: $('simRow'),
      simSpeed: $('simSpeed'),
      placeSearch: $('placeSearch'),
      searchGo: $('searchGo'),
      searchResults: $('searchResults'),
      saveHere: $('saveHere'),
      bindHere: $('bindHere'),
      cueEditor: $('cueEditor'),
      cueEditorTitle: $('cueEditorTitle'),
      cueEditorWhere: $('cueEditorWhere'),
      cueName: $('cueName'),
      cueRadius: $('cueRadius'),
      cueRadiusOut: $('cueRadiusOut'),
      cueTheme: $('cueTheme'),
      cuePresets: $('cuePresets'),
      cueEditorHint: $('cueEditorHint'),
      cueSave: $('cueSave'),
      cueDelete: $('cueDelete'),
      cueCancel: $('cueCancel'),
      cueList: $('cueList'),
      savedList: $('savedList'),
      exportPack: $('exportPack'),
      importPack: $('importPack'),
      importFile: $('importFile'),
      examplePacks: $('examplePacks'),
      pasteToggle: $('pasteToggle'),
      pasteRow: $('pasteRow'),
      pasteArea: $('pasteArea'),
      pasteApply: $('pasteApply'),
      pasteCancel: $('pasteCancel'),
      packHint: $('packHint'),
      theme: $('theme'),
      themeNote: $('themeNote'),
      themeHeld: $('themeHeld'),
      radar: $('radar'),
      sceneName: $('sceneName'),
      sceneMeta: $('sceneMeta'),
      statusLine: $('statusLine'),
      moodBars: $('moodBars'),
      tagList: $('tagList'),
      placeCount: $('placeCount'),
      coords: $('coords'),
      speedOut: $('speedOut'),
      accuracyOut: $('accuracyOut'),
      bpmOut: $('bpmOut'),
      providerBadge: $('providerBadge'),
      bandBadge: $('bandBadge'),
      cueStrip: $('cueStrip'),
      warning: $('warning'),
    };

    this.ctx2d = this.el.radar.getContext('2d');
    this.places = [];
    this.radius = 350;
    this.center = null;
    this.heading = 0;
    this.engine = null;
    this._sweep = 0;
    this._raf = null;
    this._editing = null;   // canonical tag type currently open in the editor
    this._tags = [];
    this._cueDraft = null;  // { lat, lng, radius } while the cue editor is open
    this._cueRows = [];     // per-cue strength elements in #cueList

    this._buildMoodBars();
    this._buildSimSpeeds();
    this._buildThemes();
    this._buildCueEditor();
    this._bind();
    this._resize();

    new ResizeObserver(() => this._resize()).observe(this.el.radar);
  }

  /* ----------------------------------------------------------- construction */

  _buildMoodBars() {
    this.moodFills = {};
    this.moodVals = {};
    for (const dim of DIMS) {
      const row = document.createElement('div');
      row.className = 'mood-row';

      const name = document.createElement('span');
      name.textContent = DIM_LABELS[dim];

      const track = document.createElement('div');
      track.className = 'mood-track';
      const fill = document.createElement('div');
      fill.className = 'mood-fill';
      fill.style.width = '50%';
      track.append(fill);

      const val = document.createElement('span');
      val.className = 'mood-val';
      val.textContent = '—';

      row.append(name, track, val);
      this.el.moodBars.append(row);
      this.moodFills[dim] = fill;
      this.moodVals[dim] = val;
    }
  }

  _buildSimSpeeds() {
    SIM_SPEEDS.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s.label;
      b.dataset.mps = String(s.mps);
      if (s.id === 'walk') b.classList.add('active');
      b.addEventListener('click', () => {
        [...this.el.simSpeed.children].forEach((c) => c.classList.remove('active'));
        b.classList.add('active');
        this.h.onSimSpeed?.(s.mps);
      });
      this.el.simSpeed.append(b);
    });
  }

  /** Rebuild the theme <select>; called again when a pack adds themes. */
  refreshThemes(selectedId) {
    this.el.theme.replaceChildren();
    this._buildThemeOptions();
    if (selectedId) this.setTheme(selectedId);
  }

  _buildThemeOptions() {
    for (const theme of THEMES) {
      const opt = document.createElement('option');
      opt.value = theme.id;
      const suffix = theme.source === 'spec' && !theme.builtIn ? '' : '';
      opt.textContent = theme.available
        ? `${theme.name}${suffix}`
        : `${theme.name} — coming soon`;
      opt.disabled = !theme.available;
      this.el.theme.append(opt);
    }
  }

  _buildThemes() {
    this._buildThemeOptions();
    this.el.theme.addEventListener('change', () => {
      this.h.onTheme?.(this.el.theme.value);
      this._showThemeNote(this.el.theme.value);
    });
  }

  _showThemeNote(id) {
    this.el.themeNote.textContent = THEMES.find((t) => t.id === id)?.description || '';
  }

  /** One checkbox per loop preset; the fields themselves are in index.html. */
  _buildCueEditor() {
    for (const preset of LOOP_PRESETS) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = preset.id;
      const text = document.createElement('span');
      text.textContent = preset.name;
      label.append(box, text);
      this.el.cuePresets.append(label);
    }

    this.el.cueRadius.addEventListener('input', () => {
      const r = sliderToRadius(Number(this.el.cueRadius.value));
      this.el.cueRadiusOut.textContent = formatMetres(r);
      if (this._cueDraft) this._cueDraft.radius = r;
    });

    this.el.cueSave.addEventListener('click', () => {
      const presets = [...this.el.cuePresets.querySelectorAll('input:checked')]
        .map((b) => b.value);
      this.h.onCueSave?.({
        name: this.el.cueName.value.trim(),
        radius: this._cueDraft?.radius ?? sliderToRadius(Number(this.el.cueRadius.value)),
        theme: this.el.cueTheme.value || null,
        presets,
      });
    });
    this.el.cueDelete.addEventListener('click', () => this.h.onCueDelete?.(null));
    this.el.cueCancel.addEventListener('click', () => {
      this.closeCueEditor();
      this.h.onCueCancel?.();
    });
  }

  /** "— none —" plus every playable theme, rebuilt on open so pack themes show. */
  _fillCueThemes(selected) {
    const sel = this.el.cueTheme;
    sel.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '\u2014 none \u2014';
    sel.append(none);
    for (const theme of THEMES) {
      if (!theme.available) continue;
      const opt = document.createElement('option');
      opt.value = theme.id;
      opt.textContent = theme.name;
      sel.append(opt);
    }
    sel.value = selected && THEMES.some((t) => t.id === selected) ? selected : '';
  }

  _bind() {
    this.el.power.addEventListener('click', () => this.h.onPower?.());

    this.el.volume.addEventListener('input', () => {
      this.h.onVolume?.(Number(this.el.volume.value) / 100);
    });

    for (const btn of document.querySelectorAll('.segmented [data-mode]')) {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.segmented [data-mode]')
          .forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.setModeUI(btn.dataset.mode);
        this.h.onMode?.(btn.dataset.mode);
      });
    }

    const search = () => this.h.onSearch?.(this.el.placeSearch.value.trim());
    this.el.searchGo.addEventListener('click', search);
    this.el.placeSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); search(); }
    });

    this.el.saveHere.addEventListener('click', () => this.h.onSaveHere?.());
    this.el.bindHere.addEventListener('click', () => this.h.onBindHere?.());
    this.el.exportPack.addEventListener('click', () => this.h.onExportPack?.());
    this.el.importPack.addEventListener('click', () => this.el.importFile.click());
    this.el.importFile.addEventListener('change', () => {
      const file = this.el.importFile.files?.[0];
      if (file) this.h.onImportPack?.(file);
      this.el.importFile.value = '';
    });

    this.el.examplePacks.addEventListener('change', () => {
      const sel = this.el.examplePacks;
      const opt = sel.selectedOptions[0];
      if (opt?.value) this.h.onExamplePack?.(opt.value, opt.textContent);
      sel.selectedIndex = 0;
    });

    this.el.pasteToggle.addEventListener('click', () => {
      const showing = !this.el.pasteRow.hidden;
      this.el.pasteRow.hidden = showing;
      if (!showing) this.el.pasteArea.focus();
    });
    this.el.pasteCancel.addEventListener('click', () => this.hidePaste());
    this.el.pasteApply.addEventListener('click', () => {
      this.h.onPastePack?.(this.el.pasteArea.value);
    });
  }

  hidePaste() {
    this.el.pasteRow.hidden = true;
    this.el.pasteArea.value = '';
  }

  /* --------------------------------------------------------------- explore */

  showSearchResults(results, message = null) {
    const list = this.el.searchResults;
    list.replaceChildren();
    list.hidden = false;

    if (message) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = message;
      list.append(li);
      return;
    }
    if (!results.length) {
      list.hidden = true;
      return;
    }

    for (const r of results.slice(0, 6)) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';

      const title = document.createElement('span');
      title.textContent = r.short || r.name;
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = r.name;

      btn.append(title, where);
      btn.addEventListener('click', () => {
        list.hidden = true;
        this.el.placeSearch.value = r.short || r.name;
        this.h.onGoTo?.(r);
      });
      li.append(btn);
      list.append(li);
    }
  }

  hideSearchResults() {
    this.el.searchResults.hidden = true;
  }

  renderSaved(locations) {
    const list = this.el.savedList;
    list.replaceChildren();

    if (!locations.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing saved yet.';
      list.append(li);
      return;
    }

    locations.forEach((loc, i) => {
      const li = document.createElement('li');

      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'go';
      const title = document.createElement('span');
      title.textContent = loc.name;
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`;
      go.append(title, where);
      go.addEventListener('click', () => this.h.onGoTo?.(loc));

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'drop';
      drop.textContent = '×';
      drop.title = `Remove ${loc.name}`;
      drop.setAttribute('aria-label', `Remove ${loc.name}`);
      drop.addEventListener('click', () => this.h.onRemoveSaved?.(i));

      const bind = document.createElement('button');
      bind.type = 'button';
      bind.className = 'mini bind';
      bind.textContent = 'Bind\u2026';
      bind.title = `Bind a theme or loops to ${loc.name}`;
      bind.addEventListener('click', () => this.h.onBindSaved?.(i));

      li.append(go, bind, drop);
      list.append(li);
    });
  }

  setPackHint(text) {
    this.el.packHint.textContent = text;
  }

  /** Fill the "Load an example…" selector from public/packs/index.json. */
  setExamplePacks(list) {
    const sel = this.el.examplePacks;
    const placeholder = sel.options[0];
    sel.replaceChildren(placeholder);
    for (const p of list) {
      const opt = document.createElement('option');
      opt.value = p.file;
      opt.textContent = p.name;
      if (p.blurb) opt.title = p.blurb;
      sel.append(opt);
    }
    sel.selectedIndex = 0;
  }

  /* ------------------------------------------------------------ cue editor */

  /**
   * Show the editor for one place. `draft` is { name, lat, lng, radius,
   * theme, presets, editing, where }. The coordinates stay here, for the radar
   * circle, until main.js is told to save.
   */
  openCueEditor(draft) {
    const el = this.el;
    el.cueEditorTitle.textContent = draft.editing
      ? `Edit \u201c${draft.editing}\u201d`
      : 'Bind something to this place';
    el.cueEditorWhere.textContent = draft.where || '';
    el.cueName.value = draft.name || '';

    const radius = Math.min(CUE_RADIUS_MAX, Math.max(CUE_RADIUS_MIN, draft.radius || 150));
    el.cueRadius.value = String(radiusToSlider(radius));
    el.cueRadiusOut.textContent = formatMetres(radius);

    this._fillCueThemes(draft.theme);
    const on = new Set(draft.presets || []);
    for (const box of el.cuePresets.querySelectorAll('input')) box.checked = on.has(box.value);

    el.cueDelete.hidden = !draft.editing;
    this.setCueEditorHint('');
    this._cueDraft = { lat: draft.lat, lng: draft.lng, radius };
    el.cueEditor.hidden = false;
    el.cueEditor.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    el.cueName.focus({ preventScroll: true });
  }

  closeCueEditor() {
    this.el.cueEditor.hidden = true;
    this._cueDraft = null;
    this.setCueEditorHint('');
  }

  setCueEditorHint(text) {
    this.el.cueEditorHint.textContent = text || '';
  }

  /**
   * Every cue in the pack: name, strength, its condition in words, and
   * Edit/Delete for the ones made here. Cues from a pack are read-only.
   * Rebuilt only when the list changes; strengths go through setCueStrengths.
   */
  renderCueList(cues) {
    const list = this.el.cueList;
    list.replaceChildren();
    this._cueRows = [];

    if (!cues.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No cues yet. Bind something to a saved place.';
      list.append(li);
      return;
    }

    for (const cue of cues) {
      const li = document.createElement('li');
      li.className = 'cue-row';

      const head = document.createElement('span');
      head.className = 'cue-head';
      const chip = document.createElement('span');
      chip.className = 'cue-chip';
      chip.textContent = cue.name;
      const pct = document.createElement('span');
      pct.className = 'cue-pct';
      head.append(chip, pct);

      const side = document.createElement('span');
      side.className = 'cue-actions';
      if (cue.editable) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'mini';
        edit.textContent = 'Edit';
        edit.addEventListener('click', () => this.h.onEditCue?.(cue.name));
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'mini';
        del.textContent = 'Delete';
        del.setAttribute('aria-label', `Delete cue ${cue.name}`);
        del.addEventListener('click', () => this.h.onCueDelete?.(cue.name));
        side.append(edit, del);
      } else {
        const tag = document.createElement('span');
        tag.className = 'from-pack';
        tag.textContent = 'from pack';
        side.append(tag);
      }

      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = [cue.description, cue.does].filter(Boolean).join(' \u00b7 ');

      li.append(head, side, where);
      list.append(li);
      this._cueRows.push({ chip, pct });
      this._setCueStrength(this._cueRows.length - 1, cue.strength ?? 0);
    }
  }

  /** Strengths in the same order as the last renderCueList call. */
  setCueStrengths(strengths) {
    strengths.forEach((s, i) => this._setCueStrength(i, s));
  }

  _setCueStrength(i, strength) {
    const row = this._cueRows[i];
    if (!row) return;
    const s = Math.min(1, Math.max(0, strength || 0));
    row.chip.style.setProperty('--strength', s.toFixed(2));
    row.pct.textContent = `${Math.round(s * 100)}%`;
  }

  /* -------------------------------------------------------------- setters */

  setModeUI(mode) {
    this.el.simRow.hidden = mode !== 'sim';
  }

  setPlaying(on) {
    this.el.power.setAttribute('aria-pressed', String(on));
    this.el.powerLabel.textContent = on ? 'Stop' : 'Play';
  }

  setProvider(name) {
    this.el.providerBadge.textContent = {
      google: 'Google Places',
      osm: 'OpenStreetMap',
      'osm-direct': 'OpenStreetMap · standalone',
      mock: 'Mock data',
    }[name] || name;
    this.el.providerBadge.dataset.provider = name;
  }

  setWarning(text) {
    this.el.warning.hidden = !text;
    this.el.warning.textContent = text || '';
  }

  setStatus(text, kind = '') {
    this.el.statusLine.textContent = text || '';
    if (kind) this.el.statusLine.dataset.kind = kind;
    else delete this.el.statusLine.dataset.kind;
  }

  setTheme(id) {
    this.el.theme.value = id;
    this._showThemeNote(id);
  }

  /**
   * Show which theme is actually sounding.
   *
   * The selector holds your choice, but a cue can take the theme over while
   * you are somewhere particular. Without saying so, that reads as the
   * selector being ignored — or as nothing happening at all.
   */
  setActiveTheme(theme, pin) {
    const el = this.el.themeHeld;
    if (!el) return;

    if (!pin || !theme || theme.id === this.el.theme.value) {
      el.hidden = true;
      this.el.theme.classList.remove('overridden');
      return;
    }

    el.hidden = false;
    el.textContent = `Now playing ${theme.name} \u2014 held by the "${pin.cue}" cue`;
    this.el.theme.classList.add('overridden');
  }

  setPosition(pos) {
    this.center = pos;
    this.heading = pos.heading ?? 0;
    this.el.coords.textContent = `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
    this.el.speedOut.textContent = formatSpeed(pos.speed);
    // Live and sim say whether GPS is fine or has dropped to coarse after
    // standing still (geo.js); explore has no mode.
    const acc = pos.accuracy == null ? '—' : `±${Math.round(pos.accuracy)} m`;
    this.el.accuracyOut.textContent = pos.mode ? `${acc} · ${pos.mode}` : acc;
    this.el.accuracyOut.dataset.mode = pos.mode || '';
  }

  setPlaces(places, radius) {
    this.places = places || [];
    this.radius = radius || this.radius;
  }

  setScene({ name, meta, mood, tags, placeCount, band, cues }) {
    if (name) this.el.sceneName.textContent = name;
    if (meta) this.el.sceneMeta.textContent = meta;
    if (band) this.el.bandBadge.textContent = band;

    if (mood) {
      for (const dim of DIMS) {
        this.moodFills[dim].style.width = `${(mood[dim] * 100).toFixed(1)}%`;
        this.moodVals[dim].textContent = mood[dim].toFixed(2);
      }
    }

    if (placeCount !== undefined) {
      this.el.placeCount.textContent = placeCount ? `· ${placeCount} places` : '';
    }

    if (cues) this._renderCues(cues);
    if (tags) this._renderTags(tags);
  }

  /** Show which place-bound loops are currently sounding, and how strongly. */
  _renderCues(cues) {
    const host = this.el.cueStrip;
    if (!host) return;
    host.replaceChildren();
    host.hidden = !cues.length;

    for (const cue of cues) {
      const chip = document.createElement('span');
      chip.className = 'cue-chip';
      chip.style.setProperty('--strength', cue.strength.toFixed(2));
      chip.textContent = cue.name;
      chip.title = `${cue.name} — ${Math.round(cue.strength * 100)}%`;
      host.append(chip);
    }
  }

  setBpm(bpm) {
    this.el.bpmOut.textContent = `${Math.round(bpm)} bpm`;
  }

  _renderTags(tags) {
    this._tags = tags;
    const list = this.el.tagList;
    list.replaceChildren();

    if (!tags.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No recognised tags here — open ground.';
      list.append(li);
      return;
    }

    const max = tags[0].weight || 1;
    for (const tag of tags.slice(0, 14)) {
      const color = CATEGORY_COLORS[tag.cat] || '#8fa1b8';
      const canonical = canonicalType(tag.type) || tag.type;

      const li = document.createElement('li');
      li.className = 'tag-row';
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-label', `Edit how ${prettyTag(canonical)} sounds`);
      if (this._editing === canonical) li.classList.add('editing');

      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.background = color;

      const name = document.createElement('span');
      name.className = 'tag-name';
      name.textContent = prettyTag(tag.type);

      const bar = document.createElement('span');
      bar.className = 'tag-bar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.max(6, (tag.weight / max) * 100)}%`;
      fill.style.background = color;
      bar.append(fill);

      li.append(dot, name);
      if (hasOverride(tag.type)) {
        const badge = document.createElement('span');
        badge.className = 'edited';
        badge.textContent = 'edited';
        li.append(badge);
        li.style.gridTemplateColumns = '9px 1fr auto auto';
      }
      li.append(bar);

      const toggle = () => this._toggleEditor(canonical, li);
      li.addEventListener('click', toggle);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });

      list.append(li);
      if (this._editing === canonical) list.append(this._buildEditor(canonical));
    }
  }

  _toggleEditor(canonical) {
    this._editing = this._editing === canonical ? null : canonical;
    this._renderTags(this._tags);
  }

  /**
   * Six sliders over the mood dimensions. Changes are pushed out live rather
   * than on a Save button — the whole point is to hear the effect while you
   * are dragging.
   */
  _buildEditor(canonical) {
    const li = document.createElement('li');
    li.className = 'tag-editor';

    const head = document.createElement('div');
    head.className = 'tag-editor-head';
    const title = document.createElement('strong');
    title.textContent = prettyTag(canonical);
    const scope = document.createElement('span');
    scope.className = 'scope';
    scope.textContent = 'applies to every place of this kind';
    head.append(title, scope);
    li.append(head);

    const current = profileFor(canonical) || {};
    const base = baseProfileFor(canonical) || {};

    for (const dim of DIMS) {
      const row = document.createElement('div');
      row.className = 'editor-row';

      const label = document.createElement('span');
      label.textContent = DIM_LABELS[dim];

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.step = '1';
      slider.value = String(Math.round((current[dim] ?? 0.5) * 100));
      slider.setAttribute('aria-label', `${DIM_LABELS[dim]} for ${prettyTag(canonical)}`);

      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = (Number(slider.value) / 100).toFixed(2);

      slider.addEventListener('input', () => {
        const v = Number(slider.value) / 100;
        val.textContent = v.toFixed(2);
        this.h.onTagEdit?.(canonical, dim, v);
      });

      row.append(label, slider, val);
      li.append(row);
    }

    const actions = document.createElement('div');
    actions.className = 'editor-actions';

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'mini';
    reset.textContent = 'Reset to default';
    reset.addEventListener('click', () => {
      this.h.onTagReset?.(canonical);
      this._renderTags(this._tags);
    });

    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'mini';
    done.textContent = 'Done';
    done.addEventListener('click', () => this._toggleEditor(canonical));

    actions.append(reset, done);
    li.append(actions);

    // Stop clicks inside the editor from toggling the row above it.
    li.addEventListener('click', (e) => e.stopPropagation());
    return li;
  }

  /* ---------------------------------------------------------------- radar */

  attachEngine(engine) {
    this.engine = engine;
  }

  startRadar() {
    if (this._raf) return;
    const loop = () => {
      this._drawRadar();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _resize() {
    const canvas = this.el.radar;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = Math.max(240, canvas.clientWidth || 480);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cssSize = size;
    this._drawRadar();
  }

  _drawRadar() {
    const ctx = this.ctx2d;
    const size = this._cssSize || 480;
    const cx = size / 2;
    // Nudge the centre up so the scene name below has room.
    const cy = size / 2 - size * 0.045;
    const R = size * 0.36;

    ctx.clearRect(0, 0, size, size);

    const level = this.engine?.level?.() ?? 0;

    // Backdrop glow that breathes with the music.
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.9);
    glow.addColorStop(0, `rgba(110, 231, 208, ${0.05 + level * 0.11})`);
    glow.addColorStop(0.55, 'rgba(138, 164, 255, 0.035)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    // Range rings.
    ctx.strokeStyle = 'rgba(120, 150, 190, 0.14)';
    ctx.lineWidth = 1;
    for (const f of [0.33, 0.66, 1]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Crosshairs.
    ctx.strokeStyle = 'rgba(120, 150, 190, 0.08)';
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();

    this._drawSpectrum(ctx, cx, cy, R);

    // Slow sweep, so the display reads as live even when standing still.
    this._sweep = (this._sweep + 0.004) % (Math.PI * 2);
    const sweepGrad = ctx.createLinearGradient(
      cx, cy, cx + Math.cos(this._sweep) * R, cy + Math.sin(this._sweep) * R);
    sweepGrad.addColorStop(0, 'rgba(110, 231, 208, 0.16)');
    sweepGrad.addColorStop(1, 'rgba(110, 231, 208, 0)');
    ctx.strokeStyle = sweepGrad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(this._sweep) * R, cy + Math.sin(this._sweep) * R);
    ctx.stroke();

    this._drawPlaces(ctx, cx, cy, R);
    this._drawCueRadius(ctx, cx, cy, R);
    this._drawSelf(ctx, cx, cy, level);

    // Range label.
    ctx.fillStyle = 'rgba(143, 161, 184, 0.55)';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(this.radius)} m`, cx, cy - R - 9);
  }

  _drawSpectrum(ctx, cx, cy, R) {
    const spec = this.engine?.spectrum?.();
    if (!spec) return;

    const bars = 96;
    // Only the lower half of the FFT carries anything musical here.
    const usable = Math.floor(spec.length * 0.5);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    for (let i = 0; i < bars; i++) {
      // Log spacing so bass does not eat the whole ring.
      const t = i / bars;
      const bin = Math.min(usable - 1, Math.floor((t ** 1.9) * usable));
      const mag = spec[bin] / 255;
      if (mag < 0.02) continue;

      const angle = t * Math.PI * 2 - Math.PI / 2;
      const inner = R * 1.06;
      const outer = inner + mag * R * 0.3;
      ctx.strokeStyle = `rgba(138, 164, 255, ${0.12 + mag * 0.5})`;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.stroke();
    }
  }

  _drawPlaces(ctx, cx, cy, R) {
    if (!this.center || !this.places.length) return;

    const mPerDegLat = 111320;
    const mPerDegLng = Math.max(1, 111320 * Math.cos((this.center.lat * Math.PI) / 180));
    const scale = R / this.radius;

    for (const place of this.places) {
      const east = (place.lng - this.center.lng) * mPerDegLng;
      const north = (place.lat - this.center.lat) * mPerDegLat;
      const x = cx + east * scale;
      const y = cy - north * scale; // screen y grows downward
      if (Math.hypot(x - cx, y - cy) > R * 1.02) continue;

      const cat = place.cat || 'service';
      const color = CATEGORY_COLORS[cat] || '#8fa1b8';
      // Nearer places drive the music more, so draw them larger.
      const near = 1 - Math.min(1, place.distance / this.radius);
      const r = 2.4 + near * 3.4;

      ctx.beginPath();
      ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(color, 0.10 + near * 0.10);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(color, 0.5 + near * 0.45);
      ctx.fill();
    }
  }

  /**
   * While the cue editor is open, the cue's radius on the same scale as the
   * places: solid where it plays in full, dashed where it has faded out.
   */
  _drawCueRadius(ctx, cx, cy, R) {
    const draft = this._cueDraft;
    if (!draft || !this.center) return;

    const mPerDegLat = 111320;
    const mPerDegLng = Math.max(1, 111320 * Math.cos((this.center.lat * Math.PI) / 180));
    const scale = R / this.radius;
    const x = cx + (draft.lng - this.center.lng) * mPerDegLng * scale;
    const y = cy - (draft.lat - this.center.lat) * mPerDegLat * scale;
    const r = draft.radius * scale;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 178, 107, 0.07)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 178, 107, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.arc(x, y, r * 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 178, 107, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 178, 107, 0.9)';
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 178, 107, 0.85)';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(formatMetres(draft.radius), x, y - Math.min(r, R) - 6);
    ctx.restore();
  }

  _drawSelf(ctx, cx, cy, level) {
    const pulse = 7 + level * 9;

    ctx.beginPath();
    ctx.arc(cx, cy, pulse * 2.1, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(110, 231, 208, ${0.07 + level * 0.13})`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#6ee7d0';
    ctx.fill();

    // Heading arrow, only meaningful when we actually have a bearing.
    if (this.center && Number.isFinite(this.heading)) {
      const a = ((this.heading - 90) * Math.PI) / 180;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(16, 0);
      ctx.lineTo(7, -5);
      ctx.lineTo(7, 5);
      ctx.closePath();
      ctx.fillStyle = 'rgba(110, 231, 208, 0.85)';
      ctx.fill();
      ctx.restore();
    }
  }
}

/* ------------------------------------------------------------------ utils */

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function sliderToRadius(v) {
  const t = Math.min(1, Math.max(0, v / CUE_SLIDER_MAX));
  const r = CUE_RADIUS_MIN * (CUE_RADIUS_MAX / CUE_RADIUS_MIN) ** t;
  const step = r < 200 ? 5 : r < 1000 ? 10 : 50;
  return Math.min(CUE_RADIUS_MAX, Math.max(CUE_RADIUS_MIN, Math.round(r / step) * step));
}

function radiusToSlider(r) {
  const t = Math.log(r / CUE_RADIUS_MIN) / Math.log(CUE_RADIUS_MAX / CUE_RADIUS_MIN);
  return Math.round(Math.min(1, Math.max(0, t)) * CUE_SLIDER_MAX);
}

function formatMetres(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 2000 ? 1 : 2)} km` : `${Math.round(m)} m`;
}

function formatSpeed(mps) {
  if (!Number.isFinite(mps)) return '—';
  const kmh = mps * 3.6;
  return kmh < 1 ? 'still' : `${kmh.toFixed(1)} km/h`;
}
