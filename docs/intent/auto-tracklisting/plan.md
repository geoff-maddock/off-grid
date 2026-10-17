# Plan: Auto tracklisting (from spec.md, 2026-10-16)
Task Master: tm:b4727281e1a8 · Branch: agent/auto-tracklisting · PR: (draft, opened with this plan)

## What's already in off-grid
off-grid already stores and shows tracklists, so this work feeds that pipeline rather than
adding a new one:
- `mixes.tracklist` holds the raw text and `mix_tracks` holds the parsed rows
  (`time`, `time_seconds`, `artist`, `title`, `url`). See migrations 003 and 006.
- The admin's `parseTracklist()` (`admin/admin.js`) reads lines like
  `04:32 Artist - Title https://artist.bandcamp.com/track/x`.
- The player already renders `tracks[]` from the manifest, with the `url` as a link
  (`data/schema.md`, `audio-player.js`).

So the CLI writes a JSON tracklist **and** the same line format the admin already parses. That
way a result can be pasted into the admin today, with no Worker or schema change in the first
slices.

## Reuse vs. fresh
mix-extractor is Python (ffmpeg + Whisper + LLM + AudD, with link enrichment). off-grid is plain
JS/Node with vitest. **Proposal: start fresh in JS** and borrow mix-extractor's approach (sample
the mix every ~90 s for fingerprints; per-track link lookup), not its code. This keeps one
language and one test runner in the repo.

## Files that change
- `scripts/tracklist.mjs` — CLI entry: `node scripts/tracklist.mjs <serato.csv> [--out file]
  [--format json|text] [--bandcamp] [--overrides file] [--fingerprint <audio>]`
- `scripts/tracklist/serato.mjs` — parse a Serato history CSV export into ordered entries
  (slice 1)
- `scripts/tracklist/format.mjs` — JSON output and the admin-compatible text lines (slice 1)
- `scripts/tracklist/bandcamp.mjs` — link lookup behind an injectable fetch, with a JSON cache
  file (slice 2)
- `scripts/tracklist/overrides.mjs` — load and merge manual fixes (slice 3)
- `scripts/tracklist/fingerprint.mjs` — provider interface + one provider, off by default
  (slice 4)
- `tests/fixtures/serato-history.csv` — synthetic sample export with made-up artists (slice 1)
- `tests/tracklist-*.test.mjs` — one test file per module
- `README.md` — a "Building a tracklist" command block and the project-structure tree
  (every slice that adds files, per CLAUDE.md)
- `data/schema.md` + `data/manifest.json` — only if slice 5 adds manifest fields (e.g. `source`)

## Slices
- [x] 1. Serato CSV → JSON tracklist CLI, with a sample-export fixture and tests — covers AC 1
- [ ] 2. Bandcamp lookup with a cache; "no match" marker; failures logged, run continues — covers
      AC 2 (**needs your OK on scraping and request rate first**, see Risks)
- [ ] 3. Manual overrides merged on re-run, so corrected entries are never replaced — covers AC 3
      (**needs your call on where fixes live**: proposed a `<mix>.overrides.json` file beside the
      export for now, admin/D1 later)
- [ ] 4. Fingerprint provider interface, off by default, one provider behind `--fingerprint` —
      covers AC 4, 5 (**needs provider + spend ceiling**; mix-extractor uses AudD)
- [ ] 5. Mix-page rendering: emit the admin text format (and, if wanted, a `source` field), and
      add a test that a finished tracklist renders artist – title with a buy link — covers AC 6.
      Mostly already supported by the existing player; this slice proves it with a test.

## Acceptance criteria → proof
- [x] AC1 — test: `tests/tracklist-serato.test.mjs` parses `tests/fixtures/serato-history.csv`
      and checks order, artist, title, and start times relative to the first track (incl. a
      session that crosses midnight and rows with a blank artist)
- [ ] AC2 — test: `tests/tracklist-bandcamp.test.mjs` with a mocked fetch: match → URL set; no
      result → `"no match"`; a thrown/500 response → entry marked, run still completes; cached
      entries make no request
- [ ] AC3 — test: `tests/tracklist-overrides.test.mjs` runs the pipeline twice with an override
      saved and asserts the corrected entry is byte-identical after the second run
- [ ] AC4 — test: `tests/tracklist-fingerprint.test.mjs` runs the pipeline with defaults and a
      mocked provider client, and asserts the client was never called
- [ ] AC5 — test: same file; enabled + a gap with no Serato entry → entry added with
      `source: "fingerprint"` and `confidence`; a fingerprint hit overlapping a Serato entry
      leaves the Serato entry unchanged
- [ ] AC6 — test: `tests/tracklist-render.test.mjs` feeds a finished tracklist through the text
      formatter and the admin `parseTracklist()` rules, and checks the player's tracklist
      markup shows `artist – title` plus a link only where a URL exists

## Risks
- **No real Serato export in hand.** The fixture is modelled on Serato DJ's History → Export CSV
  (a session row, then one row per track with `name`, `artist`, `start time`, `end time`,
  `playtime`, `deck`). The parser matches headers by name and ignores unknown columns, but a
  real export (artist/titles can be swapped for fakes) would de-risk slice 1. Drop one at
  `offline/` and I'll check against it.
- **Unplayed / previewed tracks.** Serato logs tracks loaded briefly. Slice 1 keeps every row the
  export marks as played; filtering very short plays is a later option, not a default.
- **Bandcamp has no public search API** (open question). Scraping search results may break their
  terms and is fragile. Slice 2 won't start until you decide; the lookup is behind an
  injectable fetch so tests never hit the network.
- **Fingerprinting costs money per minute** (open question). Slice 4 is off by default, needs an
  API key via env var (never committed), and won't start until you pick a provider and cap.
- **Public repo.** off-grid is the public, generic version, so these docs and fixtures use no
  personal names, real tracklists, domains or keys.
- **Multi-user** stays out of scope until accounts/storage/takedown questions are answered.

## Log
- 2026-10-16: plan drafted; no code yet. Draft PR opened for plan review.
- 2026-10-17: slice 1 done. `scripts/tracklist.mjs` + `scripts/tracklist/{serato,format}.mjs`,
  fixture, and `tests/tracklist-serato.test.mjs` (15 tests). Built fresh in JS as proposed (no
  reply yet on reuse vs. fresh; nothing here depends on mix-extractor). The CLI only takes
  `--format` and `--out` so far; `--bandcamp`, `--overrides` and `--fingerprint` arrive with
  their slices. Every entry carries `source: "serato"` now so slice 4 can tell sources apart.
  An optional `played` column is honoured (rows marked 0/false/no are dropped). Still modelled on
  a synthetic export; a real one in `offline/` would confirm the header names.

<!-- Add a "## Blocked" section here with the question when the builder needs input. -->
