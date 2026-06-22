# Off Grid — remaining roadmap

_Snapshot saved 2026-06-19. Source of truth for design rationale: [docs/multi-user-plan.md](../docs/multi-user-plan.md)._

## Status
**Shipped:** Phase 1 (accounts/auth), Phase 2a (ownership + per-user manifests),
Phase 3 (per-user R2 prefixes, PR #5), plus extras — clean `?user=` routes, self-host guide
([docs/self-hosting.md](../docs/self-hosting.md)), auto-peaks, tracklists, embed-code fixes.
**Remaining:** Phase 2b, Phase 4, Phase 5, mix-extractor integration.
(`docs/multi-user-plan.md` is stale: it still shows Phase 3 unshipped.)

## Phase 2b — Per-user slug namespaces
- **What:** `id` is currently a global PK (two users can't both have `summer-mix`). Make
  `(owner_id, id)` the uniqueness rule so each user has their own slug space.
- **Work:** surrogate PK on `mixes`, `UNIQUE(owner_id, id)`, repoint `playlist_mixes.mix_id` to the
  surrogate. SQLite can't alter a PK in place → table rebuild (create→copy→drop→rename) + FK updates.
  DB layer keys by surrogate/`(owner,id)`; API drops the global-uniqueness check.
- **Risk: HIGH** — PK/FK surgery on live prod D1. Needs backup + careful migration + testing.
- **Priority:** defer until slug collisions actually bite.

## Phase 4 — Bring-your-own-R2 (BYO-R2)
- **What:** each user stores their own R2 creds (account id, bucket, keys, public URL); their
  uploads/manifests go to their bucket. Shifts storage cost to each user. (Original IDEA.md goal.)
- **Work:** `user_storage` table (mode shared|byo, encrypted keys); `crypto.js` AES-256-GCM with a
  new `R2_CRED_KEY` secret; `r2.js` uses per-user creds when `mode==byo`; `GET/PUT /api/me/storage`;
  admin Account/Storage panel. Each BYO user sets up their own bucket + CORS + token.
- **Risk: MEDIUM** — storing others' cloud credentials; server must decrypt to presign (documented
  residual trust).
- **Priority:** only if you want users funding their own storage.

## Phase 5 — Polish (independent sub-items)
- **Login rate-limiting** (recommended before fully public) — none today; brute-force risk on
  `/auth/login`. Cloudflare rule or D1/KV failed-attempt counter.
- **CORS lockdown** (quick) — `CORS_ORIGIN` is `*`; set to real domain(s) in `wrangler.toml`.
- **Migrations framework** — move to `wrangler d1 migrations apply` (tracked in `d1_migrations`),
  with a one-time insert marking 001–004 as already applied on prod.
- **Onboarding CLI** (IDEA.md) — `npm run setup` that asks questions, writes `wrangler.toml` +
  `config.local.js`, optionally creates D1/R2, runs migrations, sets secrets, bootstraps admin.
- **Data-migration helpers** — reassign content owner; reprefix old root-key R2 files into
  `users/<id>/…`.

## mix-extractor integration (IDEA.md open question)
- **What:** auto-populate tracklists (timestamps/artist/title) and Bandcamp link enrichment from the
  mix-extractor tool.
- **Work:** add optional `url` field per track (`mix_tracks` + `tracks` JSON), render clickable links
  in the player tracklist, admin import path for mix-extractor output (+ optional Bandcamp lookup).
  Foundation (structured tracklists) already exists.

## Recommended order
1. CORS lockdown + login rate-limiting (Phase 5) — hardening before fully public.
2. mix-extractor + track links — highest feature value, low risk.
3. Migrations framework — removes migration-rerun pain.
4. Phase 4 (BYO-R2) — only if users should fund storage.
5. Phase 2b (slug namespaces) — defer until collisions bite.
