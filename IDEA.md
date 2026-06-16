---
title: Off Grid - A self-hosted music sharing and streaming platform
status: idea
tags: [off-grid, idea, dj mix, hosting]
created: 2026-04-01}
---

## Core idea
- Create a way to share music, tracks, playlists and mixes with an embedded player that can be put on different sites and streams from a location that I control.
- Add an admin page that allows uploading and processing tracks to be shared
- Create an onboarding document and or command line tool that asks the questions and sets up the configuration for the user to get started

## Open questions
- [2026-04-30] How to integrate with mix-extractor to allow for tracklistings and bandcamp link enrichment
- [2026-04-30] How to automatically do the peak generation for uploaded tracks
- [2026-04-30] How to allow users to log in and have their cloudflare r2 info stored so it will be automatically used with uploads and track management - map users to a set of config data
  - [2026-05-30] DESIGNED — see [docs/multi-user-plan.md](docs/multi-user-plan.md). Email+password accounts (D1 + PBKDF2 + JWT), invite/admin-provisioned, hybrid storage (shared per-user prefixes by default, optional bring-your-own-R2 with encrypted creds). Phase 1 (accounts & auth) in progress.

## Next actions
- [2026-04-30] Move the auto player script tag to reference cloudflare cdn instead of my site

## Notes
- Using Cloudflare R2 for storage
- Simple database for user management and track metadata 
- A web component for the the player that wraps wavesurfer and can be embedded on different sites