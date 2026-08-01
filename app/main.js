// Off Grid player page — entry point: router, manifest load, and global
// wiring (split out of index.html, #58).

import { MANIFEST_URL, _mixId } from './config.js';
import { state, buildIndexes, populateChips, sortMixes, sortPlaylists, runActiveFilter } from './state.js';
import {
  view, applySiteHeader, renderHome, renderMixDetail, renderPlaylistsView,
  renderPlaylistView, renderTag, renderArtist, renderTracks, renderTrackDetail,
  renderSingleMix,
} from './views.js';
import { updateSEO } from './seo.js';


// ---- Router ---------------------------------------------------------
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return { view: 'home' };
  const slash = raw.indexOf('/');
  const seg = slash === -1 ? raw : raw.slice(0, slash);
  const rest = slash === -1 ? '' : raw.slice(slash + 1);
  const arg = decodeURIComponent(rest);
  // Filter sub-routes nest under their list view, e.g. #/playlists/tag/<x>;
  // split the raw remainder first so a '/' inside the encoded value survives.
  const sub = () => {
    const i = rest.indexOf('/');
    return i === -1 ? null : { kind: rest.slice(0, i), value: decodeURIComponent(rest.slice(i + 1)) };
  };
  if (seg === 'playlists') {
    const s = sub();
    if (s && s.kind === 'tag') return { view: 'playlists', tag: s.value };
    if (s && s.kind === 'creator') return { view: 'playlists', creator: s.value };
    return { view: 'playlists' };
  }
  if (seg === 'playlist') return { view: 'playlist', arg };
  if (seg === 'mix') return { view: 'mix', arg };
  if (seg === 'tracks') {
    const s = sub();
    if (s && s.kind === 'letter') return { view: 'tracks', letter: s.value.toLowerCase() };
    return { view: 'tracks' };
  }
  if (seg === 'track') return { view: 'track', arg };
  if (seg === 'tag') return { view: 'tag', arg };
  if (seg === 'artist') return { view: 'artist', arg };
  return { view: 'home' };
}

function render() {
  if (state.singleMix) {
    renderSingleMix();
    updateSEO({ view: 'mix', arg: (state.mixes[0] || {}).id });
    return;
  }
  const r = parseHash();
  if (r.view === 'playlists') renderPlaylistsView({ tag: r.tag, creator: r.creator });
  else if (r.view === 'playlist') renderPlaylistView(r.arg);
  else if (r.view === 'mix') renderMixDetail(r.arg);
  else if (r.view === 'tracks') renderTracks(r.letter);
  else if (r.view === 'track') renderTrackDetail(r.arg);
  else if (r.view === 'tag') renderTag(r.arg);
  else if (r.view === 'artist') renderArtist(r.arg);
  else renderHome();
  updateSEO(r);
}

// ---- Manifest load --------------------------------------------------
(async function loadManifest() {
  const loadingEl = document.getElementById('manifest-loading');
  try {
    const resp = await fetch(MANIFEST_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    state.site = data.site || {};
    state.mixes = data.mixes || [];
    state.playlists = data.playlists || [];

    // Single-mix mode (?mix=<id>): show just that mix, no chrome.
    if (_mixId) {
      const one = state.mixes.find(m => m.id === _mixId);
      if (!one) {
        if (loadingEl) { loadingEl.className = 'manifest-status error'; loadingEl.textContent = 'Mix not found.'; }
        return;
      }
      state.mixes = [one];
      state.playlists = [];
      state.singleMix = true;
    }

    window._mixes = state.mixes; // back-compat for any external probes
    applySiteHeader();
    buildIndexes();
    if (!state.singleMix) populateChips();
    render();
  } catch (err) {
    console.error('Failed to load manifest:', err);
    if (loadingEl) {
      loadingEl.className = 'manifest-status error';
      loadingEl.textContent = 'Failed to load mix data.';
    }
    // Manifest never applied — reveal the fallback header so it isn't
    // left permanently hidden by the fade-in guard.
    const header = document.querySelector('.site-header');
    if (header) header.classList.add('ready');
  }
})();

// ---- Global wiring --------------------------------------------------
window.addEventListener('hashchange', render);

// Single search box drives the active view's filter
(function initSearchBox() {
  const input = document.getElementById('mix-search');
  const sb = document.getElementById('search-bar');
  const clr = document.getElementById('search-clear');
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    sb.classList.toggle('has-value', q.length > 0);
    runActiveFilter(q);
  });
  clr.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input'));
    input.focus();
  });
})();

// Sort control re-renders the current view — except while a mix is
// playing, where a rebuild would stop the audio; then the existing
// elements are reordered in place instead (they survive DOM moves).
document.getElementById('sort-select').addEventListener('change', (e) => {
  state.sort = e.target.value;
  if (resortInPlace()) return;
  render();
});

// Move `container`'s children into `keys` order. Bails (false) unless the
// children map 1:1 onto the keys, so any mismatch falls back to render().
function reorderByKey(container, keys, getKey) {
  const byKey = new Map([...container.children].map(el => [getKey(el), el]));
  if (byKey.size !== container.children.length) return false;
  if (keys.length !== byKey.size || keys.some(k => !byKey.has(k))) return false;
  for (const k of keys) container.appendChild(byKey.get(k));
  return true;
}

function resortInPlace() {
  if (!document.querySelector('offgrid-player[playing]')) return false;
  const root = view();
  let done = false;
  // Mix stacks: entries keyed by the inner player's mix-id.
  const stack = root.querySelector('.player-stack');
  if (stack) {
    const entryId = (el) => el.querySelector('offgrid-player')?.getAttribute('mix-id');
    const mixes = [...stack.children].map(el => state.mixMap.get(entryId(el)));
    if (!mixes.every(Boolean)) return false;
    if (!reorderByKey(stack, sortMixes(mixes).map(m => m.id), entryId)) return false;
    done = true;
  }
  // Playlist sections (keyed via data-playlist-id) re-sort among
  // themselves; appendChild keeps them after the mix section.
  const plSections = [...root.children].filter(el => el.dataset && el.dataset.playlistId);
  if (plSections.length) {
    const pls = plSections.map(el => state.playlists.find(p => p.id === el.dataset.playlistId));
    if (!pls.every(Boolean)) return done;
    for (const pl of sortPlaylists(pls)) {
      root.appendChild(plSections.find(el => el.dataset.playlistId === pl.id));
    }
    done = true;
  }
  return done;
}

// Filter toggle expands/collapses the chip panel (per-view groups) on
// narrow screens; the choice persists across loads. On wide viewports CSS
// keeps the panel visible as a rail and hides this button entirely.
const browsePanelEl = document.getElementById('browse-panel');
const browseToggleEl = document.getElementById('browse-toggle');

function setFilterOpen(open) {
  browsePanelEl.classList.toggle('open', open);
  browseToggleEl.setAttribute('aria-expanded', String(open));
  try { localStorage.setItem('filterOpen', open ? '1' : '0'); } catch (e) { /* private mode */ }
}

let savedFilterOpen = false;
try { savedFilterOpen = localStorage.getItem('filterOpen') === '1'; } catch (e) { /* private mode */ }
setFilterOpen(savedFilterOpen);
browseToggleEl.addEventListener('click', () => setFilterOpen(!browsePanelEl.classList.contains('open')));

// Color-mode toggle: cycles dark -> light -> color, themes the page chrome
// (via [data-theme] on <html>) and every embedded player/playlist (via the
// `theme` attribute, applied when render() re-creates them). Persists choice.
const THEME_ORDER = ['dark', 'light', 'color'];
const THEME_LABELS = { dark: '☾ Dark', light: '☀ Light', color: '◐ Color' };

function updateThemeToggleLabel(t) {
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = THEME_LABELS[t] || THEME_LABELS.dark;
}

function applyTheme(t) {
  state.theme = t;
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch (e) { /* private mode */ }
  updateThemeToggleLabel(t);
  // Re-theme embedded elements in place — rebuilding them would stop any
  // mix that's currently playing (they live-update on the theme attribute).
  document.querySelectorAll('offgrid-player, offgrid-playlist')
    .forEach(el => el.setAttribute('theme', t));
}

updateThemeToggleLabel(state.theme);
document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(state.theme) + 1) % THEME_ORDER.length];
  applyTheme(next);
});

// Click a tag pill inside any player → navigate to that tag view
document.addEventListener('tagclick', (e) => {
  if (e.detail && e.detail.tag) location.hash = '#/tag/' + encodeURIComponent(e.detail.tag);
});

// Global play-one-at-a-time: pause any other player when one starts
document.addEventListener('trackplay', (e) => {
  document.querySelectorAll('offgrid-player').forEach(p => {
    if (p !== e.target) p.pause();
  });
});
