# Landing page: wide-viewport layout + filter UX — design

Date: 2026-08-01
Status: approved (design), pending implementation

## Goals

1. Use wide-viewport screen real estate: the page is currently a single 720px column
   (`--max-w` in `styles.css`), leaving most of a desktop screen empty.
2. Improve the filter controls' open/closed behavior: the panel currently pops in/out via the
   `hidden` attribute with no animation, no button state, and no trace of the active filter
   when closed.

Decisions made during brainstorming: sidebar + wider column on desktop (not a player grid);
sidebar always visible on desktop (not collapsible); rail also shown on detail views; all four
filter-UX improvements (button state + animation, active-filter display when closed, chip
capping with a reveal pill, persisted open/closed state).

## 1. Layout structure

One DOM, CSS-grid-driven — no duplicated markup, no JS moving nodes between layouts.
`index.html` is restructured lightly:

```
.page
  header.site-header       <- spans full width
  nav.toolbar              <- spans full width (nav links · sort · theme)
  .layout
    aside  = #browse-panel   (existing element, same ids/classes)
    main   = search bar + hint + view-heading + #main-view
  footer                   <- spans full width
```

At the desktop breakpoint (**min-width: 1100px**):

- `.page` max-width rises from 720px to ~1240px.
- `.layout` becomes `grid-template-columns: 240px minmax(0, 1fr)` with a ~32px gap.
- The rail (`#browse-panel`) is `position: sticky` below the top of the viewport, with
  `max-height` and its own `overflow-y: auto` scrollbar when the chip lists are tall.
- The content column is capped around 920px so waveform players stretch but don't get absurd.
- The "Filter ▾" toggle button is hidden; the rail is always visible.
- Detail views (single mix / playlist / track) keep the rail visible: `showChrome` stops
  force-hiding all groups when `browse: false` and instead shows the chip groups for the
  nearest list view (mix detail → mixes groups, playlist detail → playlists groups,
  track detail → tracks group). Layout never shifts between list and detail views.

Below 1100px everything behaves as today: single column, panel collapses behind the Filter
button, current spacing preserved.

Compatibility: the historical ids/classes (`#browse-panel`, `.browse-panel`, `.browse-group`,
`.chip-row`, `.chip`) are preserved so self-hosters' custom CSS keeps working.

## 2. Filter open/close mechanics (narrow screens)

- Replace the `hidden`-attribute toggle with an `.open` class on `#browse-panel` plus
  `aria-expanded` on the Filter button. The `hidden` attribute remains only for the true
  "no chips exist in this view" case (applies in both layouts).
- Animate open/close with the `grid-template-rows: 0fr <-> 1fr` technique (an inner wrapper
  with `overflow: hidden`), which animates unknown content heights without max-height hacks.
  The desktop media query forces the panel visible regardless of `.open`.
- The button's caret flips (▾ closed / ▴ open) via CSS on `[aria-expanded="true"]`, and the
  button takes the active nav-link style (accent text, surface background, border) while open.
- The open/closed choice persists in `localStorage` under `filterOpen` and is applied on load
  (narrow layout only; the key is ignored on desktop).

## 3. Active-filter indication

Each filtered renderer (tag, artist, playlist tag, creator, track letter) passes its filter
into `showChrome` as `active: { type, value }`.

- The matching chip gets a `.chip-active` accent style and a small ×; its href flips to the
  unfiltered route so clicking it again clears the filter.
- If the active chip would fall past the display cap (see §4), it is force-included so the
  highlight is never hidden behind the reveal pill.
- On narrow screens, a dismissible pill (label + ×, accent-styled) renders next to the Filter
  button so the closed state still shows what's applied; the × links to the unfiltered route.
  The pill is hidden on desktop, where the rail highlight plus the existing view-heading
  breadcrumb cover it.

## 4. Chip capping

In `populateChips` (`app/state.js`):

- Artist, tag, playlist-tag, and creator groups sort **most-used first** (count descending,
  ties keeping the existing alphabetical order) instead of purely alphabetical.
- Each capped group shows the top 12 chips plus a `+N more` reveal pill that expands the full
  list in place — the same pattern as playlist header tags. No collapse-back control.
- The A–Z track-letter row stays uncapped and keeps its alphabetical order.

## 5. Scope of change

Touched files:

| File | Change |
|------|--------|
| `index.html` | `.layout` wrapper: panel becomes the aside, search/hint/heading/main-view wrapped in `<main>`; button gets `aria-expanded` |
| `styles.css` | Desktop grid + breakpoint, sticky rail, panel animation, button states, `.chip-active`, reveal pill, active-filter pill |
| `app/main.js` | Toggle logic: `.open` class, `aria-expanded`, `localStorage` persistence |
| `app/views.js` | `showChrome`: `active` param, chip highlighting, mobile filter pill, detail-view group fallback, class-based (not `hidden`) open state |
| `app/state.js` | `populateChips`: count-descending sort, cap + reveal pill |
| `README.md` | Update the Filter-button paragraph (§ around line 174) to describe the sidebar-on-desktop behavior |

Not touched: worker, manifest shape, web components (`audio-player.js`), admin UI. No new
dependencies, no build step introduced.

## 6. Error handling / edge cases

- No chips at all in a view → panel/rail hidden entirely (existing `anyChips` logic), content
  column spans normally; on desktop the grid collapses to a single centered column.
- Single-mix embed mode (`?mix=`) → toolbar and panel stay hidden as today; layout wrapper is
  inert.
- Manifest load failure → unchanged fallback behavior; the layout wrapper must not depend on
  JS having run (no-JS users see the stacked single-column flow).
- Sort-while-playing in-place reorder (`resortInPlace`) is unaffected — the player stack DOM
  is unchanged.

## 7. Verification

- `npm run lint` and `npm test` from the repo root (worker tests must stay green; no frontend
  test infra exists and none is added).
- Visual check via local static server + system-Chromium screenshots at ~1440px (rail layout,
  sticky behavior, detail views) and ~420px (toggle animation, button states, active-filter
  pill, persistence across reload).
- Work happens on a feature branch (`landing-wide-layout`) since this checkout serves the
  live deployment; merge via PR per repo convention.
