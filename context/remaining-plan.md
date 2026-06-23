# Off Grid — remaining roadmap

_Updated 2026-06-23. Source of truth for design rationale: [docs/multi-user-plan.md](../docs/multi-user-plan.md)._

## Status
**Shipped:** Phase 1 (accounts/auth), Phase 2a (ownership + per-user manifests), Phase 3 (per-user
R2 prefixes); production hardening (CORS allowlist + login rate-limiting, migrations 005); per-track
links (Bandcamp/Discogs, migration 006); landing-page browsing (issue 19 — hash-routed tag/artist
views, sortable mix list, broadened search, and a client-side tracks database with per-track detail);
plus extras — clean `?user=` and `?mix=` routes, self-host
guide ([docs/self-hosting.md](../docs/self-hosting.md)), auto-peaks, tracklists with auto-timestamps,
embed-code fixes, modal UX.

**Remaining:** migrations framework, Phase 4 (BYO-R2), Phase 2b (slug namespaces); a dedicated
mix-extractor import (only if its output isn't the supported line format).

## Migrations framework (next)
- **What:** move from raw `wrangler d1 execute --file` (no tracking, re-runs re-apply and the
  `ALTER`s error) to `wrangler d1 migrations apply` (tracked in `d1_migrations`).
- **Work:** reorganize `worker/migrations/` into the wrangler-recognized sequence; a one-time insert
  marking 001–006 as already applied on prod so they don't re-run.
- **Risk: LOW.** Quality-of-life — ends the migration-rerun pain.

## Phase 4 — Bring-your-own-R2 (BYO-R2)
- **What:** each user stores their own R2 creds (account id, bucket, keys, public URL); their
  uploads/manifests go to their bucket. Shifts storage cost to each user. (Original IDEA.md goal.)
- **Work:** `user_storage` table (mode shared|byo, encrypted keys); `crypto.js` AES-256-GCM with a
  new `R2_CRED_KEY` secret; `r2.js` uses per-user creds when `mode==byo`; `GET/PUT /api/me/storage`;
  admin Account/Storage panel. Each BYO user sets up their own bucket + CORS + token.
- **Risk: MEDIUM** — storing others' cloud credentials; server must decrypt to presign (documented
  residual trust).
- **Priority:** only if you want users funding their own storage.

## Phase 2b — Per-user slug namespaces
- **What:** `id` is currently a global PK (two users can't both have `summer-mix`). Make
  `(owner_id, id)` the uniqueness rule so each user has their own slug space.
- **Work:** surrogate PK on `mixes`, `UNIQUE(owner_id, id)`, repoint `playlist_mixes.mix_id` to the
  surrogate. SQLite can't alter a PK in place → table rebuild (create→copy→drop→rename) + FK updates.
- **Risk: HIGH** — PK/FK surgery on live prod D1. Needs backup + careful migration + testing.
- **Priority:** defer until slug collisions actually bite.

## mix-extractor import (conditional)
- **Done:** per-track link foundation — paste `time artist - title <url>` lines and the URL becomes a
  clickable Bandcamp/Discogs link (migration 006). Handles most mix-extractor line output.
- **Remaining (only if needed):** a dedicated importer if mix-extractor emits a different shape
  (e.g. JSON) — pending confirmation of its output format.

## Phase 5 polish — remaining sub-items
- ✅ Login rate-limiting — shipped.
- ✅ CORS lockdown — shipped.
- **Onboarding CLI** — `npm run setup` that asks questions and writes `wrangler.toml` +
  `config.local.js`, optionally creates D1/R2, runs migrations, sets secrets, bootstraps admin.
- **Data-migration helpers** — reassign content owner; reprefix old root-key R2 files into
  `users/<id>/…`.

## Recommended order
1. **Migrations framework** — removes migration-rerun pain.
2. **Phase 4 (BYO-R2)** — only if users should fund storage.
3. **Phase 2b (slug namespaces)** — defer until collisions bite.
4. mix-extractor dedicated import / onboarding CLI — as needed.
