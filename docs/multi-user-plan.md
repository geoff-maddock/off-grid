# Multi-user accounts with per-user config — implementation plan

Status: **in progress** (Phase 1 backend started). Tracks the IDEA.md open question
"allow users to log in and have their cloudflare r2 info stored … map users to a set of config data".

## Decisions

- **Auth**: email + password. Accounts in D1, PBKDF2 (WebCrypto) password hashing, HS256 JWT sessions.
- **Sign-up**: invite / admin-provisioned (closed by default). Roles: `admin`, `user`.
- **Storage**: hybrid. Shared bucket with per-user key prefixes (`users/<id>/…`) by default; optional
  bring-your-own-R2 per user (credentials encrypted at rest in D1).

## Starting point (single-tenant)

- Shared `ADMIN_TOKEN`; `auth.js#requireAuth` compares Bearer to it.
- One R2 bucket via `env.BUCKET`; presign uses shared `CF_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`.
- `mixes`/`playlists` are global (no owner). Single `data/manifest.json` published to the bucket.
- Unused `users` table already present.

## Data model

`002_users_multitenant.sql` (Phase 1): add `email`, `password_hash`, `status`, `token_version` to
`users`; unique email index; `invites` table.
Later migration (Phase 2+): `user_storage` table (encrypted BYO-R2 creds), `owner_id` on
`mixes`/`playlists`, and per-user mix-id uniqueness `(owner_id, id)` via a surrogate PK.

## Auth subsystem

- `crypto.js` — PBKDF2-HMAC-SHA256 (100k iters — the Workers runtime cap, per-user salt) `hashPassword`/`verifyPassword`;
  SHA-256 `hashToken`; (later) AES-256-GCM `encryptSecret`/`decryptSecret` for BYO-R2 creds.
- `jwt.js` — HS256 `signJwt`/`verifyJwt` using secret `JWT_SECRET`. Payload `{sub, role, tv, exp}`.
- `auth.js` rewrite — `authenticate()` verifies JWT, loads the user, rejects if `status != active` or
  `payload.tv != users.token_version` (revocation despite stateless tokens). Legacy `ADMIN_TOKEN`
  kept as a bootstrap escape hatch only.

### Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /auth/login | public | email+password → JWT |
| POST | /auth/accept-invite | public (valid invite) | set password, activate, → JWT |
| POST | /auth/bootstrap | ADMIN_TOKEN, only if no admin | create first admin |
| GET | /auth/me | user | current user |
| POST | /auth/change-password | user | rotate password, bump token_version |
| POST | /api/users/invite | admin | create invite (returns link) |
| GET/PATCH/DELETE | /api/users[/:id] | admin | list / set role+status / delete |
| GET/PUT | /api/me/storage | user | (Phase 4) shared vs BYO-R2 config |

## Storage (Phase 3–4)

- Force every R2 key under `users/<userId>/…`; clamp list `?prefix=`; enforce on presign/upload/delete.
- BYO-R2: presign/upload use the decrypted per-user creds when `storage.mode == 'byo'`.
- Public URL derived server-side: shared → `${SHARED_R2_PUBLIC_URL}/users/<id>/…`; BYO → user's URL.

## Per-user content + manifests (Phase 2)

- Scope all mix/playlist queries by `owner_id`. `generateManifest(db, ownerId)`.
- Publish per user to `users/<id>/data/manifest.json` (or the user's bucket). Each user gets their own
  embeddable player URL.

## Admin UI (Phase 1–2)

- Login → email + password; store JWT (sessionStorage). All `apiFetch` send `Authorization: Bearer`.
- Drop pasted Worker URL (deploy-time constant) and R2 URL (derived from profile).
- New Account/Storage panel; admin-only Users panel (invite/list/disable/role).

## New secrets / config

`JWT_SECRET`, `R2_CRED_KEY` (AES master key), `SHARED_R2_PUBLIC_URL` var.

## Security checklist

PBKDF2 100k (Workers cap) + per-user salt + constant-time compare; JWT expiry + token_version revocation +
per-request status check; encrypt BYO-R2 secrets at rest (server can decrypt for presign — documented
residual trust); login rate-limiting; HTTPS; hard tenant-prefix enforcement on every R2 op.

## Phasing

1. ✅ **Accounts & auth** — migration 002, crypto/jwt, auth rewrite, login/invite/users endpoints, admin login + Users panel. *(shipped)*
2a. ✅ **Ownership (basic)** — migration 004 adds `owner_id` (IDs stay global), query scoping by owner, per-user manifest publish (`users/<id>/data/manifest.json`); the instance owner also writes the legacy `data/manifest.json` for backward-compat. Admin shows your manifest URL on publish. *(shipped)*
2b. **Ownership (namespaces)** — per-user mix-id uniqueness `(owner_id, id)` via a surrogate PK. *(deferred — riskiest migration)*
3. **Per-user prefixes** — tenant-scoped R2 keys + public-URL derivation (shared mode).
4. **BYO-R2** — user_storage, encryption, presign-with-user-creds, Storage panel.
5. **Polish** — onboarding CLI, data-migration helpers, rate limiting, docs.

## Risks

- Mix-ID uniqueness change (global → per-user) is the riskiest migration (PK + playlist_mixes FK).
- Embed discovery: `index.html` hardcodes one `MANIFEST_URL`; decide `?user=` vs per-user deploy.
- Cost attribution (shared = owner pays); BYO-R2 shifts cost but adds credential custody.
