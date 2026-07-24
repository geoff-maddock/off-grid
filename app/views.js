import { esc, slugify } from './util.js';
import { _openTracklist } from './config.js';
import {
  state, sortMixes, sortPlaylists, sortTracks, trackLetterOf,
  setMixFilter, setTrackFilter, setPlaylistFilter, setActiveFilter,
} from './state.js';

// View renderers + page chrome for the player page (extracted from
// index.html, #58).

export const view = () => document.getElementById('main-view');

export function makePlayer(mix, startSeconds, opts) {
  opts = opts || {};
  const div = document.createElement('div');
  div.className = 'player-entry';
  div.dataset.title = (mix.title || '').toLowerCase();
  div.dataset.artist = (mix.artist || '').toLowerCase();
  div.dataset.tags = (mix.tags || []).join(',').toLowerCase();
  div.dataset.tracks = (mix.tracks || [])
    .map(t => `${t.artist || ''} ${t.title || ''}`).join(' ').toLowerCase();

  const player = document.createElement('offgrid-player');
  player.setAttribute('theme', state.theme);
  player.setAttribute('src', mix.src);
  player.setAttribute('title', mix.title);
  if (mix.artist) player.setAttribute('artist', mix.artist);
  if (mix.thumb) player.setAttribute('thumb', mix.thumb);
  if (mix.peaks) player.setAttribute('peaks', mix.peaks);
  if (mix.color) player.setAttribute('color', mix.color);
  if (mix.description) player.setAttribute('description', mix.description);
  if (mix.releaseDate) player.setAttribute('release-date', mix.releaseDate);
  if (mix.tags && mix.tags.length > 0) player.setAttribute('tags', JSON.stringify(mix.tags));
  // Enables play tracking + likes when window.OFFGRID_API_BASE is set
  // (from config.local.js); without it the player stays tracking-free.
  if (mix.id) player.setAttribute('mix-id', mix.id);
  // Meta links: title -> mix page, artist -> artist filter. Suppress the
  // title self-link on a mix's own detail page, and all links in single-mix
  // embed mode where the app's hash routes don't navigate.
  if (!opts.noLinks) {
    if (mix.id && !opts.selfMix) player.setAttribute('title-href', '#/mix/' + encodeURIComponent(mix.id));
    if (mix.artist) player.setAttribute('artist-href', '#/artist/' + encodeURIComponent(mix.artist));
  }
  if (_openTracklist) player.setAttribute('open-tracklist', '');
  if (Number.isFinite(startSeconds) && startSeconds > 0) {
    player.setAttribute('start-at', String(startSeconds));
  }
  if (mix.tracks && mix.tracks.length > 0) player.tracks = mix.tracks;

  div.appendChild(player);
  return div;
}

// ---- Chrome visibility ----------------------------------------------
// `browse` picks which Filter-panel chip groups the view offers:
// false (no Filter button) | 'mixes' | 'playlists' | 'tracks'.
const BROWSE_GROUPS = {
  mixes: ['artist-group', 'tag-group'],
  playlists: ['playlist-tag-group', 'creator-group'],
  tracks: ['track-letter-group'],
};

export function showChrome({ sort = false, browse = false, search = null, heading = null }) {
  document.getElementById('toolbar').style.display = state.singleMix ? 'none' : '';
  document.getElementById('toolbar-sort').style.display = sort ? '' : 'none';
  if (sort) document.getElementById('sort-select').value = state.sort;

  const activeGroups = BROWSE_GROUPS[browse] || [];
  let anyChips = false;
  for (const ids of Object.values(BROWSE_GROUPS)) {
    for (const id of ids) {
      const group = document.getElementById(id);
      const show = activeGroups.includes(id) && !!group.querySelector('.chip');
      group.hidden = !show;
      if (show) anyChips = true;
    }
  }
  const browseBtn = document.getElementById('browse-toggle');
  browseBtn.style.display = anyChips ? '' : 'none';
  if (!anyChips) document.getElementById('browse-panel').hidden = true;

  const sb = document.getElementById('search-bar');
  const hint = document.getElementById('search-hint');
  const input = document.getElementById('mix-search');
  if (search) {
    sb.style.display = '';
    hint.style.display = '';
    input.value = '';
    sb.classList.remove('has-value');
    if (search === 'tracks') {
      input.placeholder = 'Search tracks by artist, title, or mix...';
      hint.textContent = 'Searches track artists and titles; an exact mix title lists every track on that mix.';
    } else if (search === 'playlists') {
      input.placeholder = 'Search playlists — by mix or track inside them...';
      hint.textContent = 'Searches playlist names and the mixes and tracks they contain.';
    } else {
      input.placeholder = 'Search mixes — title, artist, tag, or track name...';
      hint.textContent = 'Searches mix titles, artists, tags, and the track names inside each mix.';
    }
  } else {
    sb.style.display = 'none';
    hint.style.display = 'none';
  }

  const hb = document.getElementById('view-heading');
  if (heading) {
    hb.hidden = false;
    const back = heading.back
      ? `<a href="${heading.back}" class="back-link">&larr; ${esc(heading.backText || 'Back')}</a>` : '';
    const title = heading.kind
      ? `<div class="view-title"><span class="view-title-kind">${esc(heading.kind)}</span>${esc(heading.title)}</div>`
      : '';
    hb.innerHTML = back + title;
  } else {
    hb.hidden = true;
  }

  const activeNav = (heading && heading.nav) || 'home';
  document.querySelectorAll('.nav-link').forEach(el => {
    el.classList.toggle('active', el.dataset.nav === activeNav);
  });
}

// ---- View renderers -------------------------------------------------
// Drive the page's --accent-hue from the manifest site accent so color
// mode's tint (and every accent element) tracks a custom accent. Falls back
// to the brand orange already set in CSS when no accent is provided.
export function applyAccentVars() {
  const accent = (state.site && state.site.accent) || '';
  if (!accent) return;
  document.documentElement.style.setProperty('--accent-hue', accent);
}

// Populate the header (logo, title, tagline) from the manifest `site`
// object. Absent fields keep the generic no-JS defaults already in the HTML.
export function applySiteHeader() {
  const s = state.site || {};
  applyAccentVars();
  if (s.logoText) {
    const logo = document.getElementById('site-logo');
    if (logo) logo.textContent = s.logoText;
  }
  if (s.title) {
    const titleEl = document.getElementById('site-title');
    if (titleEl) titleEl.textContent = s.title;
  }
  if (s.tagline) {
    const tagEl = document.getElementById('site-tagline');
    if (tagEl) tagEl.textContent = s.tagline;
  }
  // Reveal the header (fades in) now that the real values are in place.
  const header = document.querySelector('.site-header');
  if (header) header.classList.add('ready');
}

function sectionEl(label, href) {
  const section = document.createElement('section');
  section.className = 'section';
  const lbl = document.createElement('div');
  lbl.className = 'section-label';
  if (href) {
    const a = document.createElement('a');
    a.href = href;
    a.className = 'section-label-link';
    a.textContent = label;
    lbl.appendChild(a);
  } else {
    lbl.textContent = label;
  }
  section.appendChild(lbl);
  return section;
}

function noResultsEl() {
  const nr = document.createElement('div');
  nr.className = 'no-results';
  nr.textContent = 'Nothing matches your search.';
  return nr;
}

export function renderMixList(mixes, { label, withPlaylists = false }) {
  const root = view();
  root.innerHTML = '';
  const section = sectionEl(`${label} · ${mixes.length}`);
  const stack = document.createElement('div');
  stack.className = 'player-stack';
  sortMixes(mixes).forEach(m => stack.appendChild(makePlayer(m)));
  const nr = noResultsEl();
  if (mixes.length) {
    section.appendChild(stack);
    section.appendChild(nr);
  } else {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = 'No mixes here.';
    section.appendChild(note);
  }
  root.appendChild(section);
  if (withPlaylists) renderPlaylists(root);
  setMixFilter(stack, nr);
}

// Lowercased haystack for filtering a playlist: its own title/creator plus
// the titles/artists of the mixes it contains and the tracks inside them.
function playlistSearchText(pl) {
  const parts = [pl.title || '', pl.creator || ''];
  for (const id of (pl.mixIds || [])) {
    const m = state.mixMap.get(id);
    if (!m) continue;
    parts.push(m.title || '', m.artist || '');
    for (const t of (m.tracks || [])) parts.push(t.title || '', t.artist || '');
  }
  return parts.join(' ').toLowerCase();
}

// Build a <section> for one playlist. `linkTitle` makes the heading a link to
// the playlist's own route (used in list views, not on the single view).
function playlistSection(pl, { linkTitle = false } = {}) {
  const href = linkTitle && pl.id ? `#/playlist/${encodeURIComponent(pl.id)}` : null;
  const section = sectionEl(pl.title, href);
  section.dataset.playlistId = pl.id;
  section.dataset.search = playlistSearchText(pl);
  const playlist = document.createElement('offgrid-playlist');
  playlist.setAttribute('theme', state.theme);
  playlist.setAttribute('color', pl.color || state.site.accent || '#ff5500');
  if (pl.creator) playlist.setAttribute('artist', pl.creator);
  if (pl.thumb) playlist.setAttribute('thumb', pl.thumb);
  if (pl.title) playlist.setAttribute('title', pl.title);
  const tracks = (pl.mixIds || [])
    .map(id => state.mixMap.get(id))
    .filter(Boolean)
    .map(m => ({ src: m.src, title: m.title, artist: m.artist, thumb: m.thumb, peaks: m.peaks, mixId: m.id }));
  playlist.tracks = tracks;
  section.appendChild(playlist);
  return section;
}

export function renderPlaylists(root, playlists = state.playlists) {
  for (const pl of sortPlaylists(playlists)) {
    root.appendChild(playlistSection(pl, { linkTitle: true }));
  }
}

export function renderHome() {
  showChrome({ sort: true, browse: 'mixes', search: 'mixes', heading: null });
  renderMixList(state.mixes, { label: 'Mixes' });
}

export function renderMixDetail(id) {
  const mix = state.mixMap.get(id);
  showChrome({
    sort: false, browse: false, search: null,
    heading: { back: '#/', backText: 'All mixes', kind: 'Mix', title: mix ? mix.title : id, nav: 'home' },
  });
  const root = view();
  root.innerHTML = '';
  if (!mix) {
    const note = document.createElement('div');
    note.className = 'manifest-status error';
    note.textContent = 'Mix not found.';
    root.appendChild(note);
    setActiveFilter(null);
    return;
  }
  root.appendChild(makePlayer(mix, undefined, { selfMix: true }));
  setActiveFilter(null);
}

// filter: {} for all playlists, { tag } or { creator } for a chip-filtered view.
export function renderPlaylistsView(filter = {}) {
  let playlists = state.playlists;
  let heading = { back: '#/', backText: 'All mixes', nav: 'playlists' };
  if (filter.tag) {
    playlists = state.playlistTagIndex.get(filter.tag) || [];
    heading = { back: '#/playlists', backText: 'All playlists', kind: 'Tag', title: filter.tag, nav: 'playlists' };
  } else if (filter.creator) {
    playlists = state.creatorIndex.get(filter.creator) || [];
    heading = { back: '#/playlists', backText: 'All playlists', kind: 'Creator', title: filter.creator, nav: 'playlists' };
  }
  showChrome({
    sort: playlists.length > 0, browse: 'playlists',
    search: playlists.length ? 'playlists' : null,
    heading,
  });
  const root = view();
  root.innerHTML = '';
  if (!playlists.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = (filter.tag || filter.creator)
      ? 'No playlists match this filter.'
      : 'No playlists in this library yet.';
    root.appendChild(note);
    setActiveFilter(null);
    return;
  }
  renderPlaylists(root, playlists);
  const nr = noResultsEl();
  root.appendChild(nr);
  setPlaylistFilter(root, nr);
}

export function renderPlaylistView(id) {
  const pl = state.playlists.find(p => p.id === id);
  showChrome({
    sort: false, browse: false, search: null,
    heading: { back: '#/playlists', backText: 'All playlists', kind: 'Playlist', title: pl ? pl.title : id, nav: 'playlists' },
  });
  const root = view();
  root.innerHTML = '';
  if (!pl) {
    const note = document.createElement('div');
    note.className = 'manifest-status error';
    note.textContent = 'Playlist not found.';
    root.appendChild(note);
  } else {
    root.appendChild(playlistSection(pl));
  }
  setActiveFilter(null);
}

export function renderTag(tag) {
  showChrome({
    sort: true, browse: 'mixes', search: 'mixes',
    heading: { back: '#/', backText: 'All mixes', kind: 'Tag', title: tag, nav: 'home' },
  });
  renderMixList(state.tagIndex.get(tag) || [], { label: 'Mixes' });
}

export function renderArtist(name) {
  showChrome({
    sort: true, browse: 'mixes', search: 'mixes',
    heading: { back: '#/', backText: 'All mixes', kind: 'Artist', title: name, nav: 'home' },
  });
  renderMixList(state.artistIndex.get(name) || [], { label: 'Mixes' });
}

// letter: '' for all tracks, 'a'–'z' or 'other' for the A–Z artist index.
export function renderTracks(letter = '') {
  showChrome({
    sort: true, browse: 'tracks', search: 'tracks',
    heading: letter
      ? { back: '#/tracks', backText: 'All tracks', kind: 'Artists', title: letter === 'other' ? '#' : letter.toUpperCase(), nav: 'tracks' }
      : { back: '#/', backText: 'All mixes', nav: 'tracks' },
  });
  const root = view();
  root.innerHTML = '';
  let all = [...state.trackIndex.values()];
  if (letter) all = all.filter(t => trackLetterOf(t) === letter);
  const tracks = sortTracks(all);
  const section = sectionEl(`Tracks · ${tracks.length}`);
  if (!tracks.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = letter ? 'No tracks under this letter.' : 'No track data in this library yet.';
    section.appendChild(note);
    root.appendChild(section);
    setActiveFilter(null);
    return;
  }
  const list = document.createElement('div');
  list.className = 'track-list';
  for (const t of tracks) {
    const a = document.createElement('a');
    a.className = 'track-row';
    a.href = '#/track/' + encodeURIComponent(t.slug);
    a.dataset.search = `${t.artist} ${t.title}`.toLowerCase();
    a.dataset.mixIds = [...t.mixIds].join(',');
    const n = t.mixIds.size;
    a.innerHTML =
      `<span class="track-row-main"><span class="track-artist">${esc(t.artist || 'Unknown')}</span>` +
      `<span class="track-sep">—</span><span class="track-title">${esc(t.title || 'Untitled')}</span></span>` +
      `<span class="track-row-meta">${t.url ? '<span class="buy-dot" title="Has buy link">↗</span>' : ''}` +
      `<span class="mix-count">${n} mix${n === 1 ? '' : 'es'}</span></span>`;
    list.appendChild(a);
  }
  section.appendChild(list);
  const nr = noResultsEl();
  section.appendChild(nr);
  root.appendChild(section);
  setTrackFilter(list, nr);
}

export function renderTrackDetail(slug) {
  const t = state.trackIndex.get(slug);
  showChrome({
    sort: false, browse: false, search: null,
    heading: { back: '#/tracks', backText: 'Tracks', nav: 'tracks' },
  });
  const root = view();
  root.innerHTML = '';
  if (!t) {
    const note = document.createElement('div');
    note.className = 'manifest-status error';
    note.textContent = 'Track not found.';
    root.appendChild(note);
    setActiveFilter(null);
    return;
  }
  const head = document.createElement('div');
  head.className = 'track-detail-head';
  head.innerHTML =
    `<div class="track-detail-kind">Track</div>` +
    `<div class="track-detail-title">${esc(t.title || 'Untitled')}</div>` +
    `<div class="track-detail-artist">${esc(t.artist || 'Unknown artist')}</div>`;
  if (t.url) {
    const buy = document.createElement('a');
    buy.className = 'buy-btn';
    buy.href = t.url;
    buy.target = '_blank';
    buy.rel = 'noopener';
    buy.textContent = 'Buy / View ↗';
    head.appendChild(buy);
  }
  root.appendChild(head);

  const mixes = [...t.mixIds].map(id => state.mixMap.get(id)).filter(Boolean);
  const section = sectionEl(`Appears in · ${mixes.length} mix${mixes.length === 1 ? '' : 'es'}`);
  const stack = document.createElement('div');
  stack.className = 'player-stack';
  mixes.forEach(m => {
    // Cue each mix to the moment this track appears in it (per-mix — the
    // same track can sit at different times across mixes).
    const start = trackSecondsInMix(m, slug);
    stack.appendChild(makePlayer(m, start));
  });
  section.appendChild(stack);
  root.appendChild(section);
  setActiveFilter(null);
}

// Seconds at which the track identified by `slug` appears in `mix`, or
// undefined. Matches on the same normalized artist+title used by the index.
function trackSecondsInMix(mix, slug) {
  for (const tr of (mix.tracks || [])) {
    const s = slugify(`${(tr.artist || '').trim()} ${(tr.title || '').trim()}`);
    if (s === slug && Number.isFinite(tr.seconds)) return tr.seconds;
  }
  return undefined;
}

export function renderSingleMix() {
  showChrome({}); // singleMix flag hides the toolbar; everything else off
  const root = view();
  root.innerHTML = '';
  const mix = state.mixes[0];
  if (!mix) {
    root.innerHTML = '<div class="manifest-status error">Mix not found.</div>';
    return;
  }
  root.appendChild(makePlayer(mix, undefined, { noLinks: true }));
  setActiveFilter(null);
}
