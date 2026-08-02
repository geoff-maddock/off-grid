# Landing Wide Layout + Filter UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the player landing page a sidebar layout on wide viewports and a properly stateful, animated filter panel, per `docs/superpowers/specs/2026-08-01-landing-layout-design.md`.

**Architecture:** One DOM, CSS-grid-driven. `#browse-panel` becomes an `<aside>` inside a new `.layout` grid wrapper; at ≥1100px it renders as a permanent sticky rail next to a ~920px content column, below that it stays the collapsible panel (now class-driven and animated instead of `hidden`-toggled). Chip population gains most-used-first sorting with a cap + reveal pill; renderers pass their active filter into `showChrome` for chip highlighting and a narrow-screen clear pill.

**Tech Stack:** Plain static HTML/CSS/ES modules — no build step, no new dependencies. Repo-root ESLint + vitest (worker tests only; no frontend test infra exists and none is added, per spec §7). Visual verification via local static server + system Chromium.

## Global Constraints

- Branch: `landing-wide-layout` (already created; spec committed there). This checkout serves the live deployment — never commit to `main` directly.
- Preserve historical ids/classes for self-hosters' custom CSS: `#browse-panel`, `.browse-panel`, `.browse-group`, `.browse-group-label`, `.chip-row`, `.chip`, `.browse-toggle`.
- Desktop breakpoint: `min-width: 1100px`. Page max width 1240px desktop / 720px below. Rail 240px, gap 32px, content column capped 920px.
- Chip cap: 12 per capped group (artists, tags, playlist tags, creators). A–Z letter row uncapped, alphabetical.
- `localStorage` key for panel state: `filterOpen` (`'1'`/`'0'`); all storage access wrapped in try/catch (private-mode Safari).
- No personal/deployment-specific values in any tracked file.
- After every task: `npm run lint` from repo root must pass. `npm test` must stay green (it only covers `worker/`; run it in Task 6 and any task touching nothing frontend-only is still cheap to run).
- Commit at the end of every task with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Layout restructure (grid wrapper + sticky rail)

**Files:**
- Modify: `index.html:50-112` (toolbar button, panel → aside + inner wrapper, `.layout` + `<main>` wrapper)
- Modify: `styles.css` (`:root`, browse-panel block ~line 434, new `.layout` rules, desktop media query)

**Interfaces:**
- Produces: DOM order `header → nav.toolbar → div.layout > (aside#browse-panel > .browse-panel-inner > groups) + (main.content > search/hint/heading/#main-view) → footer`. Button `#browse-toggle` now has `aria-expanded` + `aria-controls`, text `Filter` (caret moves to CSS). Empty placeholder `<span class="filter-active-pill" id="filter-active-pill" hidden></span>` sits after the button (filled by Task 4). `.browse-panel-inner` exists for Task 2's animation.
- Consumes: nothing.

- [ ] **Step 1: Restructure `index.html`**

Replace the toolbar's button line:

```html
        <button class="browse-toggle" id="browse-toggle" type="button">Filter &#9662;</button>
```

with:

```html
        <button class="browse-toggle" id="browse-toggle" type="button" aria-expanded="false"
          aria-controls="browse-panel">Filter</button>
        <span class="filter-active-pill" id="filter-active-pill" hidden></span>
```

Then wrap the panel + content in the layout grid. The block from `<div class="browse-panel" ...>` through `</div>` of `#main-view` becomes (comments preserved verbatim from the current file; the five `browse-group` divs are unchanged, only nested one level deeper inside `.browse-panel-inner`):

```html
    <div class="layout">

      <!-- Filter panel (UI label "Filter"; ids/classes keep the historical
           "browse" naming so self-hosters' custom CSS keeps working).
           Groups are shown per view: artists+tags on Mixes, tags+creators on
           Playlists, the A–Z artist index on Tracks. On wide viewports this
           renders as a permanent sidebar; below the breakpoint the Filter
           button collapses/expands it. -->
      <aside class="browse-panel" id="browse-panel" hidden>
        <div class="browse-panel-inner">
          <div class="browse-group" id="artist-group">
            <div class="browse-group-label">Artists</div>
            <div class="chip-row" id="artist-chips"></div>
          </div>
          <div class="browse-group" id="tag-group">
            <div class="browse-group-label">Tags</div>
            <div class="chip-row" id="tag-chips"></div>
          </div>
          <div class="browse-group" id="playlist-tag-group" hidden>
            <div class="browse-group-label">Tags</div>
            <div class="chip-row" id="playlist-tag-chips"></div>
          </div>
          <div class="browse-group" id="creator-group" hidden>
            <div class="browse-group-label">Creators</div>
            <div class="chip-row" id="creator-chips"></div>
          </div>
          <div class="browse-group" id="track-letter-group" hidden>
            <div class="browse-group-label">Artists A&ndash;Z</div>
            <div class="chip-row" id="track-letter-chips"></div>
          </div>
        </div>
      </aside>

      <main class="content">

        <!-- Search -->
        <div class="search-bar" id="search-bar">
          <input type="text" id="mix-search" placeholder="Search mixes &mdash; title, artist, tag, or track name..."
            autocomplete="off">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <button class="search-clear" id="search-clear">&times;</button>
        </div>
        <p class="search-hint" id="search-hint">Searches mix titles, artists, tags, and the track names inside each mix.
        </p>

        <!-- View heading / breadcrumb (filtered views) -->
        <div class="view-heading" id="view-heading" hidden></div>

        <!-- Main view (router fills this) -->
        <div id="main-view">
          <div class="manifest-status loading" id="manifest-loading">Loading mixes...</div>
        </div>

      </main>

    </div>
```

Note the panel now starts with the `hidden` attribute (it did not before): until the manifest loads there are no chips, and from this task on `hidden` strictly means "no chips in this view" (Task 2 rewires `showChrome` to keep it in sync).

- [ ] **Step 2: Add layout CSS in `styles.css`**

In the `.browse-panel` block (~line 434), add the inner-wrapper rule and a `[hidden]` guard (needed because an explicit `display` beats the UA's `[hidden]` rule once Task 2 makes the panel a grid), directly after the existing `.browse-panel { ... }` rule:

```css
.browse-panel[hidden] {
  display: none;
}

.browse-panel-inner {
  min-width: 0;
}
```

Then append a new section at the end of the file:

```css
/* Wide-viewport layout: the filter panel becomes a permanent sticky rail
   next to the content column. Below the breakpoint, .layout is a plain
   block and the panel behaves as the collapsible mobile panel. */
@media (min-width: 1100px) {
  :root {
    --max-w: 1240px;
  }

  .layout {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: 0 32px;
    align-items: start;
  }

  /* No chips in this view -> no rail; let the content column center. */
  .layout:has(> .browse-panel[hidden]) {
    grid-template-columns: minmax(0, 1fr);
  }

  .layout > .content {
    max-width: 920px;
    margin: 0 auto;
    width: 100%;
  }

  .browse-panel {
    position: sticky;
    top: 24px;
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    margin-bottom: 0;
  }

  /* The rail is always open on desktop; the toggle only exists below the
     breakpoint. */
  .browse-toggle,
  .filter-active-pill {
    display: none;
  }
}
```

- [ ] **Step 3: Verify**

Run: `cd /var/www/geoff-maddock-portfolio/public/audio && npm run lint`
Expected: PASS.

Serve locally and sanity-check the DOM renders (full visual pass happens in Task 6):

```bash
python3 -m http.server 8901 --bind 127.0.0.1 &
curl -s http://127.0.0.1:8901/index.html | grep -c 'class="layout"'   # expect 1
kill %1
```

- [ ] **Step 4: Commit**

```bash
git add index.html styles.css
git commit -m "Landing layout: grid wrapper with sidebar rail on wide viewports"
```

---

### Task 2: Filter panel open/close mechanics

**Files:**
- Modify: `app/main.js:173-177` (toggle handler)
- Modify: `app/views.js:78-80` (showChrome panel visibility)
- Modify: `styles.css` (panel animation, button states)

**Interfaces:**
- Consumes: `.browse-panel-inner`, `aria-expanded` button from Task 1.
- Produces: panel open state = `.browse-panel.open` class (narrow screens only; desktop CSS ignores it). `showChrome` owns the `hidden` attribute: `panel.hidden = !anyChips`. `localStorage.filterOpen` persistence.

- [ ] **Step 1: Rewrite the toggle in `app/main.js`**

Replace:

```js
// Filter toggle shows/hides the chip panel (per-view groups)
document.getElementById('browse-toggle').addEventListener('click', () => {
  const panel = document.getElementById('browse-panel');
  panel.hidden = !panel.hidden;
});
```

with:

```js
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
```

- [ ] **Step 2: Let `showChrome` own the `hidden` attribute in `app/views.js`**

Replace:

```js
  const browseBtn = document.getElementById('browse-toggle');
  browseBtn.style.display = anyChips ? '' : 'none';
  if (!anyChips) document.getElementById('browse-panel').hidden = true;
```

with:

```js
  const browseBtn = document.getElementById('browse-toggle');
  browseBtn.style.display = anyChips ? '' : 'none';
  // `hidden` strictly means "no chips in this view" (both layouts); the
  // narrow-screen expand/collapse state is the .open class (see main.js).
  document.getElementById('browse-panel').hidden = !anyChips;
```

- [ ] **Step 3: Add animation + button-state CSS in `styles.css`**

Replace the existing `.browse-panel { ... }` rule:

```css
.browse-panel {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px;
  margin-bottom: 20px;
}
```

with (the `0fr <-> 1fr` grid-row technique animates the unknown content
height; padding/border/margin/opacity collapse alongside so the closed
panel takes no space):

```css
.browse-panel {
  display: grid;
  grid-template-rows: 1fr;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px;
  margin-bottom: 20px;
  transition: grid-template-rows 0.25s ease, padding 0.25s ease,
    margin-bottom 0.25s ease, opacity 0.2s ease, border-width 0.25s ease;
}
```

and extend the `.browse-panel-inner` rule from Task 1 to:

```css
.browse-panel-inner {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  /* Keep collapsed chips out of the tab order the moment the panel starts
     closing (visibility flips back instantly on open). */
  transition: visibility 0s linear 0.25s;
}
```

then add, right after it:

```css
/* Collapsed state — only below the breakpoint; the desktop rail ignores
   .open entirely. */
@media (max-width: 1099px) {
  .browse-panel:not(.open) {
    grid-template-rows: 0fr;
    padding-top: 0;
    padding-bottom: 0;
    border-top-width: 0;
    border-bottom-width: 0;
    margin-bottom: 0;
    opacity: 0;
  }

  .browse-panel:not(.open) .browse-panel-inner {
    visibility: hidden;
  }

  .browse-panel.open .browse-panel-inner {
    transition-delay: 0s;
  }
}
```

Finally add the button states next to the existing `.browse-toggle` styles (after the `.nav-link.active` rule):

```css
/* Filter button: caret flips with the panel, and the button takes the
   active-nav look while the panel is open. */
.browse-toggle::after {
  content: ' \25BE';
}

.browse-toggle[aria-expanded="true"]::after {
  content: ' \25B4';
}

.browse-toggle[aria-expanded="true"] {
  color: var(--accent);
  border-color: var(--border);
  background: var(--surface);
}
```

- [ ] **Step 4: Verify**

Run: `npm run lint` — expect PASS.
Quick behavior check in the browser happens in Task 6; for now confirm no console errors by loading the page once via the local server if convenient.

- [ ] **Step 5: Commit**

```bash
git add app/main.js app/views.js styles.css
git commit -m "Filter panel: animated class-based toggle with persisted state"
```

---

### Task 3: Chip capping + most-used-first ordering

**Files:**
- Modify: `app/state.js:138-171` (`populateChips`, new `revealChip` export)
- Modify: `styles.css` (`.chip-more` pill)

**Interfaces:**
- Consumes: chip row ids from Task 1 (unchanged).
- Produces: every chip carries `dataset.value` (the filter value it represents) and `dataset.href` (its original route, so Task 4 can restore it after flipping to a clear-route). Overflow chips have class `chip-overflow` + `hidden`. `export function revealChip(chipEl)` un-hides one chip and keeps the `+N more` pill count honest — Task 4 calls it for active chips past the cap.

- [ ] **Step 1: Rewrite `populateChips` in `app/state.js`**

Replace the whole `populateChips` function with:

```js
// Capped groups show the top CHIP_CAP chips (most-used first) with a
// "+N more" reveal pill — same pattern as playlist header tags.
const CHIP_CAP = 12;

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
      pill.textContent = `+${entries.length - cap} more`;
      pill.addEventListener('click', () => {
        row.querySelectorAll('.chip-overflow[hidden]').forEach(c => { c.hidden = false; });
        pill.remove();
      });
      row.appendChild(pill);
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
// past the cap) and keep the "+N more" pill count honest.
export function revealChip(chipEl) {
  if (!chipEl || !chipEl.hidden) return;
  chipEl.hidden = false;
  const row = chipEl.parentElement;
  const pill = row.querySelector('.chip-more');
  if (!pill) return;
  const left = row.querySelectorAll('.chip-overflow[hidden]').length;
  if (left) pill.textContent = `+${left} more`;
  else pill.remove();
}
```

- [ ] **Step 2: Add the reveal-pill CSS in `styles.css`**

After the `.chip-count` rules:

```css
/* "+N more" reveal pill at the end of a capped chip row. */
.chip-more {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  color: var(--text-muted);
  background: none;
  cursor: pointer;
}

.chip-more:hover {
  border-color: var(--accent);
  color: var(--accent);
}
```

- [ ] **Step 3: Verify**

Run: `npm run lint` — expect PASS.

- [ ] **Step 4: Commit**

```bash
git add app/state.js styles.css
git commit -m "Filter chips: most-used-first ordering, top-12 cap with reveal pill"
```

---

### Task 4: Active-filter indication

**Files:**
- Modify: `app/views.js` (`showChrome` signature + new `applyActiveFilterChip`; call sites `renderTag`, `renderArtist`, `renderPlaylistsView`, `renderTracks`)
- Modify: `styles.css` (`.chip-active`, `.chip-x`, `.filter-active-pill`)

**Interfaces:**
- Consumes: `dataset.value` / `dataset.href` on chips and `revealChip` from Task 3; `#filter-active-pill` placeholder from Task 1.
- Produces: `showChrome({ ..., active })` where `active` is `null` or `{ type: 'artist'|'tag'|'playlist-tag'|'creator'|'letter', value, label? }`.

- [ ] **Step 1: Add the active-chip logic in `app/views.js`**

Import `revealChip` (extend the existing `./state.js` import list). Then, above `showChrome`, add:

```js
// Active filter -> which chip row it lives in and the route that clears it.
const ACTIVE_CHIP_ROWS = {
  artist: { row: 'artist-chips', clear: '#/' },
  tag: { row: 'tag-chips', clear: '#/' },
  'playlist-tag': { row: 'playlist-tag-chips', clear: '#/playlists' },
  creator: { row: 'creator-chips', clear: '#/playlists' },
  letter: { row: 'track-letter-chips', clear: '#/tracks' },
};

// Highlight the chip matching the view's active filter (clicking it again
// clears), and mirror it as a dismissible pill next to the Filter button —
// the narrow-screen closed state's only trace of the filter (the pill is
// display:none on desktop, where the rail highlight covers it).
function applyActiveFilterChip(active) {
  document.querySelectorAll('.chip.chip-active').forEach(c => {
    c.classList.remove('chip-active');
    c.href = c.dataset.href;
    const x = c.querySelector('.chip-x');
    if (x) x.remove();
  });
  const pillHost = document.getElementById('filter-active-pill');
  pillHost.hidden = true;
  pillHost.innerHTML = '';
  const conf = active && ACTIVE_CHIP_ROWS[active.type];
  if (!conf) return;
  const label = active.label || active.value;
  const row = document.getElementById(conf.row);
  const match = [...row.querySelectorAll('.chip')].find(c => c.dataset.value === active.value);
  if (match) {
    revealChip(match); // never leave the highlight hidden behind "+N more"
    match.classList.add('chip-active');
    match.href = conf.clear;
    const x = document.createElement('span');
    x.className = 'chip-x';
    x.textContent = '×';
    match.appendChild(x);
  }
  const pill = document.createElement('a');
  pill.className = 'chip chip-active';
  pill.href = conf.clear;
  pill.innerHTML = `${esc(label)} <span class="chip-x">×</span>`;
  pillHost.appendChild(pill);
  pillHost.hidden = false;
}
```

- [ ] **Step 2: Wire it through `showChrome` and the renderers**

Change the signature to `export function showChrome({ sort = false, browse = false, search = null, heading = null, active = null })` and add `applyActiveFilterChip(active);` immediately after the `document.getElementById('browse-panel').hidden = !anyChips;` line (Task 2's version).

Call-site changes (only the `showChrome` argument objects):

- `renderTag(tag)`: add `active: { type: 'tag', value: tag }`
- `renderArtist(name)`: add `active: { type: 'artist', value: name }`
- `renderPlaylistsView`: declare `let active = null;` beside `heading`; in the `filter.tag` branch set `active = { type: 'playlist-tag', value: filter.tag };`, in the `filter.creator` branch set `active = { type: 'creator', value: filter.creator };`; pass `active` in the `showChrome` call.
- `renderTracks(letter)`: add `active: letter ? { type: 'letter', value: letter, label: letter === 'other' ? '#' : letter.toUpperCase() } : null`

- [ ] **Step 3: Add the CSS in `styles.css`**

After the `.chip-more` rules from Task 3:

```css
/* Chip for the view's active filter — clicking it clears the filter. */
.chip-active,
.chip-active:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
}

.chip-active .chip-count {
  color: var(--accent);
}

.chip-x {
  font-size: 12px;
  line-height: 1;
  opacity: 0.8;
}

/* Active-filter pill beside the Filter button (narrow screens only —
   the desktop media query hides it along with the button). */
.filter-active-pill {
  display: inline-flex;
}

.filter-active-pill[hidden] {
  display: none;
}
```

- [ ] **Step 4: Verify**

Run: `npm run lint` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add app/views.js styles.css
git commit -m "Filter chips: highlight the active filter with click-to-clear + toolbar pill"
```

---

### Task 5: Rail on detail views

**Files:**
- Modify: `app/views.js` (`showChrome` group selection, ~line 68)

**Interfaces:**
- Consumes: `BROWSE_GROUPS` map and `heading.nav` values (`home` | `playlists` | `tracks`) already present in `views.js`.
- Produces: detail views (mix/playlist/track, which pass `browse: false`) now show the chip groups of their parent list view, so the desktop rail never disappears between list and detail. Single-mix embed mode is unaffected (no chips exist there, so `anyChips` stays false and the panel stays hidden).

- [ ] **Step 1: Fall back to the nav section's groups**

In `showChrome`, replace:

```js
  const activeGroups = BROWSE_GROUPS[browse] || [];
```

with:

```js
  // Detail views pass browse:false but still get their parent list view's
  // groups, so the desktop rail persists across list <-> detail navigation
  // (spec §1). nav 'home' covers mix detail; single-mix mode never has
  // chips, so the panel stays hidden there regardless.
  const NAV_GROUPS = { home: 'mixes', playlists: 'playlists', tracks: 'tracks' };
  const groupsKey = browse || NAV_GROUPS[(heading && heading.nav) || 'home'];
  const activeGroups = BROWSE_GROUPS[groupsKey] || [];
```

- [ ] **Step 2: Verify**

Run: `npm run lint` — expect PASS.

- [ ] **Step 3: Commit**

```bash
git add app/views.js
git commit -m "Show the parent view's filter groups on detail views"
```

---

### Task 6: README update + full verification

**Files:**
- Modify: `README.md` (~line 174, the Filter-button paragraph)

**Interfaces:**
- Consumes: everything above.
- Produces: docs matching reality; visual evidence at desktop + mobile widths.

- [ ] **Step 1: Update the README paragraph**

Replace the sentence beginning "The **Filter** button reveals chips suited to each view:" so the paragraph reads:

```markdown
These hash routes are independent of the `?manifest=`/`?user=`/`?mix=` query params above (which pick
*which* manifest to load). **Filter** chips suit each view: artist and tag
chips on Mixes, tag chips (aggregated from each playlist's mixes) plus creator chips on Playlists
(creators only appear when the library has more than one), and an artist A–Z index on Tracks. On
wide screens the chips live in a permanent sidebar; on narrow screens the **Filter** button
expands/collapses them (the choice is remembered). Chip groups list the most-used entries first,
capped at 12 with a **+N more** pill; the active filter's chip is highlighted and clicking it (or
the pill beside the Filter button) clears the filter.
**Sort** orders the list by Newest (`releaseDate`), Title, or Artist. The same Sort dropdown also appears on the
Playlists and Tracks tabs — on Playlists, Artist sorts by the playlist creator; on Tracks it orders
by artist/title (Tracks have no date, so Newest keeps the natural artist–title order).
```

- [ ] **Step 2: Lint + tests**

Run: `npm run lint && npm test` from the repo root.
Expected: both PASS (tests are worker-only and untouched).

- [ ] **Step 3: Browser verification**

Serve the working tree (`python3 -m http.server 8901 --bind 127.0.0.1`) and drive system Chromium via the cached playwright-core workaround (see memory: browser-verify-workaround; stub `config.local.js` handling per live-deployment-config-local memory — the local server serves the real `config.local.js`, which is fine for read-only manifest access, but do not exercise any authed API).

Checks at **1440×900**:
- Rail visible left of content, content column ~920px, players stretched.
- Rail is sticky and independently scrollable when tall.
- No Filter button, no toolbar pill.
- Navigate to a tag view: rail chip highlighted with ×; clicking it returns to `#/`.
- Navigate to a mix detail page: rail still present with mixes groups.
- `+N more` pill expands a capped group.

Checks at **420×800**:
- Single column identical to the old layout when the panel is closed.
- Filter button shows `Filter ▾`; clicking animates the panel open, caret flips to `▴`, button highlights.
- Reload: panel open state persisted.
- On a tag view with the panel closed: pill `tag ×` beside the Filter button; clicking clears.

Save screenshots to the scratchpad directory and review them; fix anything broken before committing.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "README: document the sidebar filter layout and chip capping"
```

---

## Self-review notes

- Spec coverage: §1 → Tasks 1+5; §2 → Task 2; §3 → Task 4; §4 → Task 3; §5 → file lists + Task 6; §6 edge cases → Task 1 (`:has` collapse, `[hidden]` guard), Task 2 (`hidden` = no-chips only), Task 5 (single-mix note); §7 → Task 6.
- Type consistency: `dataset.value`/`dataset.href`/`revealChip` defined in Task 3, consumed in Task 4; `.browse-panel-inner` defined in Task 1, animated in Task 2; `active` shape identical in Tasks 4's producer/consumer lists.
- No frontend unit tests by design (spec §7): verification is lint + worker tests + scripted browser checks.
