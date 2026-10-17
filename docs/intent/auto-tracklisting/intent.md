# Intent: Auto tracklisting

Task Master: tm:b4727281e1a8

## Problem
Each mix needs a tracklist with buy links, and building one by hand is slow. Some mixes have
Serato history and some don't, and automated IDs are never perfect.

## Proposed outcome
off-grid builds the tracklist for a mix from a mix of sources. Serato history comes first,
optional audio-fingerprint scanning fills the gaps, and manual fixes always win. The resulting
tracklist links each track to Bandcamp.

## Users
The repo owner's own mixes first. Other DJs uploading their own mixes later.

## Constraints
- Lives in off-grid. Reuses mix-extractor code where it helps, or starts fresh if that's cleaner.
- Fingerprinting is optional and must be off by default.
- Manual edits are never overwritten by an automatic re-run.

## Out of scope for the first slices
Public multi-user accounts, the upload-triggered web flow, player UI templates, and hosting or
storage changes.

## User story
As a DJ publishing mixes on off-grid, I want a tracklist with Bandcamp links to be built
automatically from my Serato history (with optional audio scanning and manual fixes), so that
every mix has an accurate buy-the-music list without hand-typing it.
