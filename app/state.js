import { esc, slugify } from './util.js';

// App state: the manifest-derived data, indexes, sorting, and the
// per-view search filters (extracted from index.html, #58).

// ---- App state ------------------------------------------------------
export const state = {
  site: {},
  mixes: [],
  playlists: [],
  mixMap: new Map(),       // id -> mix
  artistIndex: new Map(),  // artist -> [mix]
  tagIndex: new Map(),     // tag -> [mix]
  trackIndex: new Map(),   // slug -> { slug, artist, title, url, mixIds:Set }
  sort: 'default',
  singleMix: false,
  theme: document.documentElement.dataset.theme || 'dark',  // dark | light | color
  layout: document.documentElement.dataset.layout || 'horizontal',  // horizontal | vertical
};
let activeFilter = null;   // current view's search handler: (query) => void

// Views without a search box clear the filter; main runs it on input.
export function setActiveFilter(fn) { activeFilter = fn; }
export function runActiveFilter(q) { if (activeFilter) activeFilter(q); }

export function sortMixes(mixes) {
  const arr = mixes.slice();
  if (state.sort === 'title') {
    arr.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  } else if (state.sort === 'artist') {
    arr.sort((a, b) => (a.artist || '').localeCompare(b.artist || ''));
  } else { // 'default' = newest by releaseDate desc; undated rows keep manifest order
    arr.sort((a, b) => {
      const da = a.releaseDate || '', db = b.releaseDate || '';
      if (da && db) return db.localeCompare(da);
      if (da) return -1;
      if (db) return 1;
      return 0;
    });
  }
  return arr;
}

export // Playlists share the same Sort dropdown. 'artist' maps to the playlist's
// creator; 'default' keeps the manifest/sort_order ordering from the worker.
function sortPlaylists(playlists) {
  const arr = playlists.slice();
  if (state.sort === 'title') {
    arr.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  } else if (state.sort === 'artist') {
    arr.sort((a, b) => (a.creator || '').localeCompare(b.creator || ''));
  }
  return arr;
}

export // Tracks share the same Sort dropdown. 'default' and 'artist' both order by
// artist then title (the natural track ordering); 'title' orders by title.
function sortTracks(tracks) {
  const arr = tracks.slice();
  if (state.sort === 'title') {
    arr.sort((a, b) => (a.title || '').localeCompare(b.title || '') || (a.artist || '').localeCompare(b.artist || ''));
  } else {
    arr.sort((a, b) => (a.artist || '').localeCompare(b.artist || '') || (a.title || '').localeCompare(b.title || ''));
  }
  return arr;
}

// ---- Index building -------------------------------------------------
export function buildIndexes() {
  state.mixMap = new Map(state.mixes.map(m => [m.id, m]));
  state.artistIndex = new Map();
  state.tagIndex = new Map();
  state.trackIndex = new Map();

  for (const mix of state.mixes) {
    const artist = (mix.artist || '').trim();
    if (artist) {
      if (!state.artistIndex.has(artist)) state.artistIndex.set(artist, []);
      state.artistIndex.get(artist).push(mix);
    }
    for (const tag of (mix.tags || [])) {
      if (!state.tagIndex.has(tag)) state.tagIndex.set(tag, []);
      state.tagIndex.get(tag).push(mix);
    }
    // No shared track entity in the data model — build one client-side by
    // matching normalized artist+title across every mix's tracklist.
    for (const t of (mix.tracks || [])) {
      const artistT = (t.artist || '').trim();
      const titleT = (t.title || '').trim();
      if (!artistT && !titleT) continue;
      const slug = slugify(`${artistT} ${titleT}`);
      let entry = state.trackIndex.get(slug);
      if (!entry) {
        entry = { slug, artist: artistT, title: titleT, url: '', mixIds: new Set() };
        state.trackIndex.set(slug, entry);
      }
      if (!entry.url && t.url) entry.url = t.url; // first non-empty buy link wins
      entry.mixIds.add(mix.id);
    }
  }

  // Playlist filter facets: tags aggregated from each playlist's mixes,
  // plus creators (only offered as chips when more than one exists).
  state.playlistTagIndex = new Map();
  state.creatorIndex = new Map();
  for (const pl of state.playlists) {
    const creator = (pl.creator || '').trim();
    if (creator) {
      if (!state.creatorIndex.has(creator)) state.creatorIndex.set(creator, []);
      state.creatorIndex.get(creator).push(pl);
    }
    const plTags = new Set();
    for (const id of (pl.mixIds || [])) {
      const m = state.mixMap.get(id);
      for (const tag of ((m && m.tags) || [])) plTags.add(tag);
    }
    for (const tag of plTags) {
      if (!state.playlistTagIndex.has(tag)) state.playlistTagIndex.set(tag, []);
      state.playlistTagIndex.get(tag).push(pl);
    }
  }

  // Track filter facet: an A–Z index over track artists (dedup'd tracks,
  // so counting after the mix loop above avoids per-mix double counts).
  state.trackLetterIndex = new Map();
  for (const t of state.trackIndex.values()) {
    const l = trackLetterOf(t);
    state.trackLetterIndex.set(l, (state.trackLetterIndex.get(l) || 0) + 1);
  }
}

// Bucket a track under its artist's first letter ('other' for anything
// non a–z); falls back to the title when the artist is empty.
export function trackLetterOf(t) {
  const ch = ((t.artist || t.title || '').trim().charAt(0) || '').toLowerCase();
  return /[a-z]/.test(ch) ? ch : 'other';
}

// Capped groups show the top CHIP_CAP chips (most-used first) with a
// "+N more" / "− less" toggle pill — same pattern as playlist header tags.
const CHIP_CAP = 12;

// Point the row's toggle pill at its current state: "+N more" while any
// overflow chip is hidden, "− less" once they're all revealed.
function syncMorePill(row) {
  const pill = row.querySelector('.chip-more');
  if (!pill) return;
  const hidden = row.querySelectorAll('.chip-overflow[hidden]').length;
  pill.textContent = hidden ? `+${hidden} more` : '− less';
  pill.setAttribute('aria-label', hidden ? `Show ${hidden} more filters` : 'Show fewer filters');
}

export function populateChips() {
  const chip = (href, label, count) => {
    const a = document.createElement('a');
    a.className = 'chip';
    a.href = href;
    // Original route + filter value, so the active-chip logic (views.js)
    // can flip the href to a clear-route and back, and find this chip.
    a.dataset.href = href;
    a.dataset.value = label;
    a.innerHTML = `${esc(label)} <span class="chip-count">${count}</span>`;
    return a;
  };
  const fill = (rowId, entries, hrefFor, cap = CHIP_CAP) => {
    const row = document.getElementById(rowId);
    row.innerHTML = '';
    entries.forEach(([name, items], i) => {
      const c = chip(hrefFor(name), name, Array.isArray(items) ? items.length : items);
      if (cap && i >= cap) {
        c.classList.add('chip-overflow');
        c.hidden = true;
      }
      row.appendChild(c);
    });
    if (cap && entries.length > cap) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'chip chip-more';
      pill.addEventListener('click', () => {
        if (row.querySelector('.chip-overflow[hidden]')) {
          row.querySelectorAll('.chip-overflow[hidden]').forEach(c => { c.hidden = false; });
        } else {
          // Collapse, but never re-hide the active filter's highlighted chip.
          row.querySelectorAll('.chip-overflow:not(.chip-active)').forEach(c => { c.hidden = true; });
        }
        syncMorePill(row);
      });
      row.appendChild(pill);
      syncMorePill(row);
    }
  };
  // Most-used first; the alphabetical pre-sort makes ties alphabetical
  // (Array.sort is stable).
  const size = (v) => (Array.isArray(v) ? v.length : v);
  const byCount = (index) => [...index.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .sort((a, b) => size(b[1]) - size(a[1]));

  fill('artist-chips', byCount(state.artistIndex), n => '#/artist/' + encodeURIComponent(n));
  fill('tag-chips', byCount(state.tagIndex), n => '#/tag/' + encodeURIComponent(n));
  fill('playlist-tag-chips', byCount(state.playlistTagIndex), n => '#/playlists/tag/' + encodeURIComponent(n));
  // A single creator can't differentiate anything — offer the group only at 2+.
  fill('creator-chips', state.creatorIndex.size >= 2 ? byCount(state.creatorIndex) : [],
    n => '#/playlists/creator/' + encodeURIComponent(n));

  // The A–Z index stays alphabetical and uncapped (26 small chips max).
  const letterRow = document.getElementById('track-letter-chips');
  letterRow.innerHTML = '';
  for (const l of [...'abcdefghijklmnopqrstuvwxyz', 'other']) {
    const count = state.trackLetterIndex.get(l);
    if (!count) continue;
    const c = chip('#/tracks/letter/' + l, l === 'other' ? '#' : l.toUpperCase(), count);
    c.dataset.value = l; // route value, not the display label
    letterRow.appendChild(c);
  }
  // Per-view group visibility (and hiding the toggle when the active
  // view has no chips) is handled by showChrome().
}

// Un-hide a single overflow chip (used when the active filter's chip sits
// past the cap) and keep the toggle pill's count honest.
export function revealChip(chipEl) {
  if (!chipEl || !chipEl.hidden) return;
  chipEl.hidden = false;
  syncMorePill(chipEl.parentElement);
}

// ---- Search wiring (context-aware) ----------------------------------
export function setMixFilter(stack, noResults) {
  activeFilter = (q) => {
    let visible = 0;
    stack.querySelectorAll('.player-entry').forEach(entry => {
      const match = !q
        || entry.dataset.title.includes(q)
        || entry.dataset.artist.includes(q)
        || entry.dataset.tags.includes(q)
        || entry.dataset.tracks.includes(q);
      entry.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    if (noResults) noResults.style.display = (visible === 0 && q) ? 'block' : 'none';
  };
}

export function setTrackFilter(list, noResults) {
  activeFilter = (q) => {
    // Typing a full mix title (case-insensitive) also surfaces every track
    // on that mix, on top of the usual artist/title substring matching.
    const titleMixIds = new Set();
    if (q) {
      for (const m of state.mixes) {
        if ((m.title || '').toLowerCase().trim() === q) titleMixIds.add(String(m.id));
      }
    }
    let visible = 0;
    list.querySelectorAll('.track-row').forEach(row => {
      const match = !q || row.dataset.search.includes(q)
        || (titleMixIds.size > 0 && (row.dataset.mixIds || '').split(',').some(id => titleMixIds.has(id)));
      row.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    if (noResults) noResults.style.display = (visible === 0 && q) ? 'block' : 'none';
  };
}

export function setPlaylistFilter(container, noResults) {
  activeFilter = (q) => {
    let visible = 0;
    container.querySelectorAll('.section').forEach(section => {
      const match = !q || (section.dataset.search || '').includes(q);
      section.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    if (noResults) noResults.style.display = (visible === 0 && q) ? 'block' : 'none';
  };
}
