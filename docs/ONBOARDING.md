# Self-hosting Off Grid — the complete onboarding guide

This is the end-to-end walkthrough from **nothing** — no Cloudflare account, no code checked out —
to your own audio platform: an admin UI where you upload mixes, and a player you can embed on any
site, all running on infrastructure you control. Budget **30–45 minutes** the first time.

- Just want the commands? See **[QUICKSTART.md](../QUICKSTART.md)**.
- Want the backend steps automated? Run the interactive wizard — **`node scripts/setup.mjs`** —
  after Stage 2 below; it handles Stages 3 (D1, migrations, secrets, deploy) for you.
- Reference for everything else (embedding, admin features, the API): the **[README](../README.md)**.

## The mental model

There are four moving parts. Understanding how they relate makes the rest obvious:

1. **R2** is a storage bucket — your audio files, cover images, peaks, and the published
   `manifest.json` live here. It has a **public URL** (`https://pub-xxxxxxxx.r2.dev`) that anyone
   can read from, with no egress fees.
2. **D1** is a SQLite database holding the *metadata* (mix titles, artists, tags, playlist order).
   The public never touches it directly.
3. **The Worker** is the only thing with write access. The admin UI calls it (authenticated) to
   edit D1 and upload to R2. It also **publishes**: read D1 → write a static `manifest.json` to R2.
4. **The player page + web component** are pure static frontend. They read the public
   `manifest.json` from R2 and render players. No backend calls, nothing secret.

So the data flow is: **admin → Worker → (D1 + R2) → Publish → manifest.json on R2 → player reads it.**

Correspondingly, an instance has two deployable parts linked only by URLs:

- **Static frontend** — `index.html`, `audio-player.js`, `admin/`, `config.local.js`. Host these
  anywhere that serves plain files: your own web server, Cloudflare Pages, GitHub Pages, etc.
- **The Worker** — runs on Cloudflare (a free `*.workers.dev` URL or a custom route on your
  domain), backed by D1 + R2.

## What you need

### Environment

| Need | Check | Notes |
|------|-------|-------|
| Node.js 18+ | `node -v` → `v18.x` or higher | Install from [nodejs.org](https://nodejs.org) or your package manager. Includes `npm`/`npx`, which run the Cloudflare CLI (`wrangler`) — no global install needed |
| git | `git --version` | To clone the repo |
| A terminal | — | All backend setup is command-line |
| Somewhere to host static files | — | Any web server, Cloudflare Pages, or even R2 itself. `localhost` works for solo use |
| ffmpeg + ffprobe | `ffmpeg -version` | **Optional.** Only needed for the bulk peaks CLI (`generate-peaks.js`); the admin UI generates waveforms in your browser automatically |

### Accounts

You need exactly one account: **Cloudflare** (free plan is fine).

1. Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). You do **not**
   need to own a domain or move DNS to Cloudflare — Workers and R2 work standalone.
2. **Activate R2**: in the dashboard, open **R2** (under **Storage & databases**) and complete
   the short checkout flow that adds the R2 subscription to your account. Cloudflare requires
   **adding a payment method** (credit card or PayPal) to enable R2, even if you stay entirely
   within the free tier and are never charged. This is the one step people get stuck on — do it
   up front.

You do **not** need a custom domain to start — Cloudflare gives you a free `*.workers.dev` Worker
URL and a `pub-*.r2.dev` public bucket URL.

### What it costs

Everything in this stack fits Cloudflare's free tiers for personal-scale use:

| Service | Free tier | Beyond it |
|---------|-----------|-----------|
| **R2** (files) | 10 GB storage, 1M writes + 10M reads/month | $0.015/GB/month — and **zero egress fees**, so streaming is free no matter how many people listen |
| **Workers** (API) | 100,000 requests/day | $5/month for 10M requests |
| **D1** (database) | 5 GB, 5M reads/day | Metadata for a mix library won't approach this |

Worked example: a library of 100 mixes at 200 MB each (20 GB) is 10 GB over the free tier, so it
costs about **$0.15/month** regardless of how many times it streams. A library under 10 GB stays
at $0.

## Setup, stage by stage

Follow these in order. Each stage ends with a **✓ Checkpoint** — don't move on until it passes.

### Stage 0 — Get the code

```bash
git clone <this-repo> off-grid && cd off-grid
cd worker && npm install && cd ..
```

**✓ Checkpoint:** `worker/node_modules/` exists.

### Stage 1 — Storage (R2 bucket)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **R2** → **Create bucket** (e.g. `offgrid-media`).
2. Bucket **Settings** → under **Public Development URL**, click **Enable** (type `allow` to
   confirm — this is the r2.dev subdomain), and copy the public URL
   (e.g. `https://pub-xxxxxxxx.r2.dev`). Save it — you'll use it in Stages 3 and 4.
   (Cloudflare rate-limits r2.dev URLs and recommends a [custom bucket
   domain](#production-hardening) for production traffic — fine to start with, switch later.)
3. Set CORS so browsers can upload and stream:
   ```bash
   cd worker
   npx wrangler r2 bucket cors set offgrid-media --file ./r2-cors.json
   ```
   (`npx wrangler` will ask you to log in the first time — that's fine; if login hangs, see
   [Troubleshooting](#troubleshooting) for the WSL/API-token alternative.) `r2-cors.json` allows
   `GET`, `HEAD`, and `PUT` from any origin.

> If you name your bucket something other than `offgrid-media`, use your name everywhere the docs
> say `offgrid-media`, and update `bucket_name` and `R2_BUCKET_NAME` in `worker/wrangler.toml`
> (Stage 3) to match.

**✓ Checkpoint:** opening `https://pub-xxxxxxxx.r2.dev/` in a browser returns an R2 response (a
404 is fine — it means the URL resolves), and you've saved your **R2 public URL**.

### Stage 2 — Upload credentials (R2 API token)

The Worker uploads small files through its R2 binding, but large uploads (>95 MB — most DJ mixes)
go directly from your browser to R2 via presigned URLs, which need API credentials:

1. On the **R2** overview page, under **Account Details**, click **Manage** next to
   **API Tokens** → **Create Account API token**.
2. Permissions: **Object Read & Write**, scoped to your bucket.
3. Copy the **Access Key ID** and **Secret Access Key** (the secret is shown only once).

While you're in the dashboard, also note your **Account ID** (in the **Account Details** section
of the R2 or Workers & Pages overview page, and in every dashboard URL — it's the path segment
after `dash.cloudflare.com/`) — it's needed as a secret in Stage 3.

**✓ Checkpoint:** you have three values saved: Access Key ID, Secret Access Key, Account ID.

> **Shortcut:** from here you can run **`node scripts/setup.mjs`** (from the repo root) and let the
> wizard do all of Stage 3 interactively — create the database, write the config, run the
> migrations, set the secrets, and deploy. If you use it, skip to Stage 4 when it finishes.
> The rest of Stage 3 documents the same steps done by hand.

### Stage 3 — Backend (Worker + D1)

All commands run in `worker/`.

```bash
cd worker

# Create your local Wrangler config from the template (it's gitignored, so your
# account-specific IDs stay out of version control).
cp wrangler.toml.example wrangler.toml

# Authenticate with Cloudflare
npx wrangler login
# If login hangs (e.g. on WSL), use an API token instead:
#   export CLOUDFLARE_API_TOKEN="your-token"
#   (Create one with the "Edit Cloudflare Workers" template at
#    https://dash.cloudflare.com/profile/api-tokens)

# Create the D1 database, then paste the returned database_id into wrangler.toml
npx wrangler d1 create offgrid-db
```

Now edit `wrangler.toml`:

- Paste the `database_id` printed by `d1 create` into the `[[d1_databases]]` block.
- Under `[vars]`, set `R2_PUBLIC_URL` to your bucket's public URL from Stage 1. It's not a
  secret — the Worker serves it via `GET /config` so admins log in with just email + password.
- If you renamed the bucket, set `bucket_name` and `R2_BUCKET_NAME` to match.

> If you name your database something other than `offgrid-db`, also set `database_name` in
> `wrangler.toml` **and** edit the `db:*` scripts in `worker/package.json` — they hardcode
> `offgrid-db`, so `npm run db:migrate:all` below will fail against a renamed database until you
> update them. (The setup wizard doesn't have this problem: `node scripts/setup.mjs --db-name my-db`
> runs the migrations against whatever name you give it.)

Apply the database schema — **all migrations, in order**:

```bash
npm run db:migrate:all
```

> This runs every file in `worker/migrations/` (001–008) against your remote D1 database.
> (`npm run db:migrate` applies only `001_init.sql` — don't stop there, or tracklists, accounts,
> rate limiting, and play tracking will be missing.) Migrations aren't tracked by
> `wrangler d1 execute`: run each once, on a fresh database. On a **fresh install** running all
> seven up front is correct — migration 004's ownership backfill is a no-op when there's no
> content yet.
>
> **Importing an existing library?** (i.e. you plan to run `scripts/seed-d1.js` with pre-existing
> mixes) — hold `004_content_ownership.sql` back and run it **after** you bootstrap your admin
> account in Stage 6, so the backfill can assign your content to that account:
> `npx wrangler d1 execute offgrid-db --remote --file=migrations/004_content_ownership.sql`

Set the five secrets (each command prompts for the value):

| Secret | What it is | How to get/generate |
|--------|------------|---------------------|
| `ADMIN_TOKEN` | Bootstrap/CLI admin token — you'll type it once into **First-time setup** (Stage 6) | Generate: `openssl rand -hex 32` (save it somewhere safe) |
| `JWT_SECRET` | Signs login session tokens | Generate: `openssl rand -hex 32` (you never need to see it again) |
| `R2_ACCESS_KEY_ID` | R2 API token key | From Stage 2 |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret | From Stage 2 |
| `CF_ACCOUNT_ID` | Your Cloudflare account ID | From Stage 2 (Account Details / dashboard URL) |

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put JWT_SECRET
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put CF_ACCOUNT_ID

# Deploy
npx wrangler deploy
```

The deploy prints your Worker URL, e.g. `https://offgrid-api.YOUR-SUBDOMAIN.workers.dev`.

**✓ Checkpoint:**

```bash
curl https://<your-worker-url>/config
# → {"r2PublicUrl":"https://pub-xxxxxxxx.r2.dev","needsSetup":true}

curl -H "Authorization: Bearer <YOUR_ADMIN_TOKEN>" https://<your-worker-url>/api/mixes
# → []   (an empty list, not an auth error)
```

If you get `401`, your `ADMIN_TOKEN` header doesn't match the secret. If `500` about R2
credentials, re-check the three R2/account secrets. If `r2PublicUrl` is `null`, set the
`R2_PUBLIC_URL` var in `wrangler.toml` and redeploy.

### Stage 4 — Frontend config

The frontend never hardcodes your URLs — everything goes in `config.local.js` (gitignored):

```bash
cd ..   # back to the repo root
cp config.local.example.js config.local.js
```

Edit `config.local.js` and set:

```js
// Required — where the player page finds your library:
window.OFFGRID_MANIFEST_URL = 'https://pub-xxxxxxxx.r2.dev/data/manifest.json';

// Required — your Worker URL (no trailing slash). The admin uses it to log in,
// and public players use it for anonymous play tracking + likes:
window.OFFGRID_API_BASE = 'https://offgrid-api.YOUR-SUBDOMAIN.workers.dev';
```

Three more are optional (all documented in `config.local.example.js`): `OFFGRID_R2_BASE` (only if
your manifest URL doesn't end in `/data/manifest.json`), `OFFGRID_SITE_URL` (canonical URL for SEO
meta tags), and `OFFGRID_SHARE_BASE` (if you generate
[static share pages](../README.md#static-share-pages-generate-share-pagesmjs)).

For a quick test without any file, the player page also accepts
`index.html?manifest=https://pub-xxxxxxxx.r2.dev/data/manifest.json`.

**✓ Checkpoint:** serving the repo root (`python3 -m http.server 8080`) and opening
`http://localhost:8080/` shows the player page without console errors about a missing manifest URL.
(An empty library is expected — nothing is published yet.)

### Stage 5 — Host the frontend

Serve the static files at a **public URL**. This matters beyond aesthetics: invite links (Stage 8)
point at wherever the admin is hosted, so `localhost` only works for solo use.

- Player page at e.g. `https://your-site.com/` and admin at `https://your-site.com/admin/`.
- Copy `index.html`, `audio-player.js`, `admin/`, `assets/`, and your `config.local.js` to the
  host — `scripts/deploy-static.sh <target-dir>` does exactly this copy for a directory-based
  deploy. Cloudflare Pages, GitHub Pages, or any web server all work; there is no build step.
- Also upload `audio-player.js` somewhere public (your site or the R2 bucket) so embeds on *other*
  sites can load it with an absolute URL.

**✓ Checkpoint:** `https://your-site.com/admin/` loads and shows the login form (with email +
password fields — meaning it found your Worker via `config.local.js`).

### Stage 6 — First admin account

While no admin account exists, the login screen offers **First-time setup**:

1. Open the admin (hosted, or `http://localhost:8080/admin/` for solo use).
2. Click **First-time setup**, paste your `ADMIN_TOKEN` (from Stage 3), and choose the email +
   password for the initial admin.
3. This calls `/auth/bootstrap` to create your account and signs you in. From now on you log in
   with email + password; the setup button disappears.

If you're importing an existing library, now run migration 004 (see Stage 3) and the
[migration scripts](../README.md#optional-migrate-existing-files).

**✓ Checkpoint:** `curl https://<your-worker-url>/config` now shows `"needsSetup":false`.

### Stage 7 — First mix + Publish

1. In the admin, click **Add Mix** → **Choose File** and select your audio. The admin uploads it
   and **auto-generates the waveform peaks and duration in your browser** — no ffmpeg, no manual
   step.
2. Fill in the title, artist, and cover image, then **Save**.
3. Click **Publish** to write `manifest.json` to R2 — the public player page updates instantly.

> Prefer the command line, or have a big back catalog? `generate-peaks.js` still works for
> generating peaks in bulk (see [Peaks](../README.md#peaks)); the admin just makes it automatic.

**✓ Checkpoint:** `https://pub-xxxxxxxx.r2.dev/data/manifest.json` lists your mix.

### Stage 8 — Go live & embed

Open your player page — the mix renders, the waveform draws, and audio streams from your R2 URL. 🎉

From here:

- **Embed anywhere**: drop an `<offgrid-player>` onto any page — see
  [Embedding](../README.md#embedding). Each player in the admin/public page also has a copy-paste
  **Embed** snippet.
- **Share libraries and mixes**: per-user links, `?mix=` single-mix pages, hash routes — see
  [Viewing & sharing a library](../README.md#viewing--sharing-a-library).
- **Link previews** on social/chat apps: generate
  [static share pages](../README.md#static-share-pages-generate-share-pagesmjs).

## Verify your install

`scripts/check.mjs` runs the same checkpoints automatically against a live deployment:

```bash
node scripts/check.mjs               # uses config.local.js
node scripts/check.mjs --token <jwt-or-admin-token>   # also test authenticated endpoints
node scripts/check.mjs --email you@example.com --password <pw>   # also test the login flow itself

# Or fully explicit (e.g. in CI):
node scripts/check.mjs --worker https://<worker-url> --manifest https://<manifest-url>
```

It checks the Worker `/config` endpoint, the manifest URL, the first mix's audio/peaks URLs, and
bucket CORS, and prints a pass/fail list with a fix hint for each failure. Exit code 0 means
healthy — safe to wire into CI or a cron.

## Inviting collaborators (multi-user)

As an admin, open the **Users** tab → **Invite User**. The generated link embeds your Worker + R2
URLs and points at *your* admin, so invitees just open it and set a password.

Each account owns its own mixes and playlists, and **Publish** writes a per-user manifest to
`users/<id>/data/manifest.json` (uploads are namespaced under `users/<id>/…` too). The instance
owner — the first admin — additionally writes the shared `data/manifest.json`, so the main player
page keeps working. Details: [Multi-user & ownership](../README.md#multi-user--ownership).

## Production hardening

Before opening an instance to the world:

- **Lock down CORS** — set `CORS_ORIGIN` in `wrangler.toml` to a comma-separated allowlist of the
  exact origins your admin is served from instead of `*`, e.g.
  `https://your-domain.com,http://localhost:8080`, then redeploy. The Worker echoes a request's
  Origin only when it's on the list.
- **Login rate limiting** — built in: `/auth/login` throttles failed attempts per IP (10 per
  15 min) via the `login_attempts` table (migration 005). For distributed attacks, pair it with a
  Cloudflare WAF rate-limit rule.
- **Custom Worker domain** (optional) — add a Workers route like `api.your-site.com` on your zone
  instead of the `*.workers.dev` URL, then update `OFFGRID_API_BASE`.
- **Custom bucket domain** (optional) — R2 supports a custom domain per bucket instead of
  `pub-*.r2.dev`; update `R2_PUBLIC_URL` and `OFFGRID_MANIFEST_URL` if you switch.

## Local development

- Frontend: just serve the repo root — `python3 -m http.server 8080`. No build step.
- Worker: `cd worker && npx wrangler dev`. For local secrets, copy `worker/.dev.vars.example` to
  `worker/.dev.vars` (gitignored) and fill in dev values — `wrangler dev` loads it automatically.
- Local D1: `npm run db:migrate:all:local` applies the schema to the local dev database (but see
  the WSL caveat below).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Admin login fails | Wrong Worker URL or token | URL has no trailing slash; token matches `ADMIN_TOKEN` secret |
| Admin still asks for Worker/R2 URLs | `config.local.js` missing `OFFGRID_API_BASE`, or Worker lacks `R2_PUBLIC_URL` var | Set both, redeploy the Worker, reload the admin |
| Uploads fail (>95 MB) | R2 API token/secrets missing | Set `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CF_ACCOUNT_ID` |
| Player shows nothing | `MANIFEST_URL` wrong, or manifest not published | Verify the manifest URL loads JSON; click **Publish** |
| CORS errors in console | Bucket CORS not set | Re-run the `wrangler r2 bucket cors set` step |
| Waveform but no audio | `src` URL wrong / not public | Open the `src` URL directly; enable the bucket's Public Development URL |
| A migration errors with `duplicate column name` | It was already applied | Skip it — migrations aren't tracked, apply each exactly once |
| Stats columns show zeros | Migration 007 not applied | `npx wrangler d1 execute offgrid-db --remote --file=migrations/007_play_tracking.sql` |
| R2 won't activate | No payment method on the account | Add one (free tier still costs $0) — see [Accounts](#accounts) |
| `wrangler login` hangs | OAuth redirect can't reach your machine (common on WSL) | `export CLOUDFLARE_API_TOKEN="your-token"` (create one with the "Edit Cloudflare Workers" template at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)) |
| `d1 execute` / local mode fails on WSL | `workerd` memory allocation issue in local mode | Always use `--remote` on WSL, e.g. `npx wrangler d1 execute offgrid-db --remote --file=migrations/001_init.sql` |

Still stuck? Run `node scripts/check.mjs --verbose` and work through the failures top to bottom.
