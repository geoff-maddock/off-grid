# Spec: Auto tracklisting

Task Master: tm:b4727281e1a8 · Target repo: geoff-maddock/off-grid (related code may come from
mix-extractor and cutups-setlists)

## Acceptance criteria
1. Given a Serato history export (CSV) for a session, when the tracklist command runs on it, then
   it outputs an ordered JSON tracklist with artist, title, and start time relative to the first
   track, for every played track.
2. Given a tracklist entry, when Bandcamp lookup runs, then the entry gets a Bandcamp URL if a
   match is found, and is marked "no match" otherwise. Lookup failures don't stop the run.
3. Given a tracklist with a manual correction saved, when the auto process runs again on the same
   mix, then the corrected entry is unchanged.
4. Given fingerprint scanning is disabled (the default), when the process runs, then no external
   fingerprinting API is called. A test asserts this with a mocked client.
5. Given fingerprint scanning is enabled and a gap with no Serato entry, when the scan returns a
   match, then the entry is added with source "fingerprint" and a confidence value, and
   Serato-sourced entries are never replaced.
6. Given a finished tracklist, when it's rendered for a mix page, then each track shows
   artist – title and a buy link when one exists.

## Suggested slices
1. CLI in off-grid: Serato CSV in → JSON tracklist out, with tests using a sample export (AC 1).
2. Bandcamp link lookup and caching (AC 2).
3. Manual overrides file or table, merged on re-run (AC 3).
4. Optional fingerprint-provider interface, with one provider behind a flag (AC 4, 5).
5. Tracklist rendering on the mix page (AC 6).

## Open questions (carried forward)
- Which fingerprint provider, and what monthly spend ceiling? Most charge per minute of audio.
  (Money: owner decides.)
- Bandcamp has no official public search API. Is scraping acceptable for the owner's own use, and
  at what request rate?
- Opening it to other DJs: accounts, storage costs, other people's data, and copyright/takedown
  handling all need decisions before any multi-user slice. (Risk.)
- Reuse mix-extractor code, or start fresh? Someone has to look at mix-extractor first.
- Where are manual fixes stored: a file in the repo, or the off-grid database/admin UI?

## Decisions
- 2026-10-12: Use mixed sources. Serato history is the most accurate and comes first; fill in the
  rest and scan mixes that have no Serato source; manual fixes are allowed.
- 2026-10-12: Build it in off-grid (mix-extractor may have relevant code; starting from scratch is
  OK).
- 2026-10-12: First slice is a CLI or script. Audio fingerprinting is optional.
- 2026-10-12: Long-term it's for the owner's mixes and other DJs' mixes.
