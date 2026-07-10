# Off Grid

> A self-hosted music sharing and streaming platform. Share tracks, playlists, and DJ mixes through an embeddable player that streams from storage **you** control. No ads, no accounts, no platform lock-in.

Off Grid is a lightweight, open stack for publishing audio on your own terms. You upload mixes through an admin UI, the files live in **Cloudflare R2** (cheap storage, **zero egress fees**), metadata lives in **Cloudflare D1**, and an embeddable `<offgrid-player>` web component drops the player onto any website you like.

Everything here is generic and reusable — clone it, point it at *your* Cloudflare account, and you have your own audio platform.

## Why

Streaming platforms take a cut, run ads, bury your work in an algorithm, and can pull it down at any time. Off Grid keeps the music on infrastructure you own and gives you a player you can paste into a blog, a band page, or your own site — while the audio streams from a location you control.

## How it works

```
Player Page (index.html)           Admin UI (admin/)
       │                                │
       │ fetches                        │ reads/writes
       ▼                                ▼
  manifest.json ◄──── Publish ──── Cloudflare Worker API
  (static, on R2)                       │
                                        ├── D1 (SQLite database)
                                        └── R2 (file storage)
```

- **Player page** (`index.html`) reads a static `manifest.json` from R2 and renders players dynamically.
- **Admin UI** (`admin/`) manages mixes and playlists via the Worker API, and uploads audio, cover art, and waveform peaks to R2.
- **Worker** (`worker/`) is a Cloudflare Worker backed by **D1** (metadata) and **R2** (files); it exposes a small REST API and publishes the manifest.
- **Web components** (`<offgrid-player>`, `<offgrid-playlist>`) render inside Shadow DOM so they can be embedded on any page without style conflicts.

---

## Onboarding

A guided, end-to-end walkthrough from an empty Cloudflare account to a working player embedded on
your own site. Budget **30–45 minutes** the first time. If you just want the commands, skip to
[Quick start](#quick-start) — this section is the narrated version with checkpoints and
troubleshooting.

### The mental model

There are four moving parts. Understanding how they relate makes the rest obvious:

1. **R2** is a storage bucket — your audio files, cover images, peaks, and the published
   `manifest.json` live here. It has a **public URL** (`https://pub-xxxxxxxx.r2.dev`) that anyone
   can read from, with no egress fees.
2. **D1** is a SQLite database holding the *metadata* (mix titles, artists, tags, playlist order).
   The public never touches it directly.
3. **The Worker** is the only thing with write access. The admin UI calls it (authenticated with
   your `ADMIN_TOKEN`) to edit D1 and upload to R2. It also **publishes**: read D1 → write a static
   `manifest.json` to R2.
4. **The player page + web component** are pure static frontend. They read the public
   `manifest.json` from R2 and render players. No backend calls, nothing secret.

So the data flow is: **admin → Worker → (D1 + R2) → Publish → manifest.json on R2 → player reads it.**

### Before you begin — prerequisites & how to verify

Run these and confirm each works before continuing:

| Need | Check | Expected |
|------|-------|----------|
| Node.js 18+ | `node -v` | `v18.x` or higher |
| ffmpeg | `ffmpeg -version` | prints a version (only needed for peaks) |
| ffprobe | `ffprobe -version` | prints a version |
| A Cloudflare account | log in at [dash.cloudflare.com](https://dash.cloudflare.com) | dashboard loads |

You do **not** need a custom domain to start — Cloudflare gives you a free `*.workers.dev` Worker
URL and a `pub-*.r2.dev` public bucket URL.

### Onboarding path

Follow these stages in order. Each ends with a **✓ Checkpoint** — don't move on until it passes.

**Stage 0 — Get the code**
```bash
git clone <this-repo> off-grid && cd off-grid
cd worker && npm install && cd ..
```
✓ Checkpoint: `worker/node_modules/` exists.

**Stage 1 — Storage (R2)**
Create the bucket, enable public access, copy the public URL, and set CORS. See
[Quick start → Create an R2 bucket](#1-create-an-r2-bucket).
✓ Checkpoint: opening `https://pub-xxxxxxxx.r2.dev/` in a browser returns an R2 response (a 404 is
fine — it means the URL resolves), and you've saved your **R2 public URL** somewhere.

**Stage 2 — Upload credentials (R2 API token)**
Create an **Object Read & Write** token scoped to your bucket; save the Access Key ID + Secret.
See [Quick start → Create an R2 API token](#2-create-an-r2-api-token-for-uploads).
✓ Checkpoint: you have both keys saved.

**Stage 3 — Backend (Worker + D1)**
Run through [Quick start → Deploy the Worker](#3-deploy-the-worker): create D1, paste the
`database_id` into `worker/wrangler.toml`, set `R2_PUBLIC_URL` under `[vars]` to the public
bucket URL from Stage 1, apply the migration, set the secrets, deploy.
✓ Checkpoint: the deploy prints a Worker URL, `curl https://<your-worker-url>/config` returns
`{"r2PublicUrl":"https://pub-…r2.dev"}`, and this returns an **empty** (or seeded) list rather
than an auth error:
```bash
curl -H "Authorization: Bearer <YOUR_ADMIN_TOKEN>" https://<your-worker-url>/api/mixes
# → []   (or your mixes)
```
If you get `401`, your `ADMIN_TOKEN` header doesn't match the secret. If `500` about R2
credentials, re-check the three R2/account secrets.

**Stage 4 — Frontend wiring**
- Point the player page at your manifest (see [step 4](#4-point-the-player-page-at-your-manifest)) —
  `cp config.local.example.js config.local.js` and set your R2 URL, or just use `?manifest=…`.
- In the same `config.local.js`, set `window.OFFGRID_API_BASE` to your Worker URL so the admin
  page picks it up and login needs only email + password.
- Upload `audio-player.js` to R2 (or your own host) so embeds elsewhere can load it.
✓ Checkpoint: opening `index.html` (with the param or local config) lists your mixes.

**Stage 5 — First content**
Serve the admin locally (`python3 -m http.server 8080` → `http://localhost:8080/admin/`), log in
via **First-time setup** with your admin token (the Worker/R2 URLs are picked up from
`config.local.js` and the Worker's `/config` endpoint; the URL fields only appear if that
config is missing), click **Add Mix**, and **Choose File** to
select your audio. The admin uploads it and **automatically generates the waveform and duration**
in your browser — just fill in the title/artist/cover, then **Save** and click **Publish**.
✓ Checkpoint: `https://pub-xxxxxxxx.r2.dev/data/manifest.json` now lists your mix.

**Stage 6 — Go live**
Open `index.html` (locally or hosted) — your mix renders and plays. Then drop an
`<offgrid-player>` onto any other page (see [Embedding](#embedding)).
✓ Checkpoint: the waveform draws and audio plays from your R2 URL. 🎉

### Onboarding troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Admin login fails | Wrong Worker URL or token | URL has no trailing slash; token matches `ADMIN_TOKEN` secret |
| Admin still asks for Worker/R2 URLs | `config.local.js` missing `OFFGRID_API_BASE`, or Worker lacks `R2_PUBLIC_URL` var | Set both, redeploy the Worker, reload the admin |
| Uploads fail (>95 MB) | R2 API token/secrets missing | Set `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CF_ACCOUNT_ID` |
| Player shows nothing | `MANIFEST_URL` wrong, or manifest not published | Verify the manifest URL loads JSON; click **Publish** |
| CORS errors in console | Bucket CORS not set | Re-run the `wrangler r2 bucket cors set` step |
| Waveform but no audio | `src` URL wrong / not public | Open the `src` URL directly; enable R2 public access |
| `wrangler` hangs on login | OAuth can't reach your machine (WSL) | Use `CLOUDFLARE_API_TOKEN` — see [WSL notes](#wsl-notes) |

---

## Quick start

> Running your own independent instance? See the end-to-end
> **[Self-hosting guide](docs/self-hosting.md)** — it ties these steps together and adds the
> multi-user bootstrap, hosting, and invite specifics.

**Prerequisites**

- Node.js 18+
- `ffmpeg` and `ffprobe` on your PATH (for waveform peak generation)
- A Cloudflare account (free tier is enough to start)

### 1. Create an R2 bucket

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **R2** → **Create Bucket** (e.g. `offgrid-media`).
2. Bucket **Settings** → enable **Public access**, and copy the **Public bucket URL** (e.g. `https://pub-xxxxxxxx.r2.dev`).
3. Set CORS so browsers can upload and stream:
   ```bash
   cd worker
   npx wrangler r2 bucket cors set offgrid-media --file ./r2-cors.json
   ```
   `r2-cors.json` allows `GET`, `HEAD`, and `PUT` from any origin.

> If you name your bucket something other than `offgrid-media`, update `bucket_name` and `R2_BUCKET_NAME` in `worker/wrangler.toml` to match.

### 2. Create an R2 API token (for uploads)

Needed for uploading large files (>95 MB) via presigned URLs:

1. **R2** → **Manage R2 API Tokens** → **Create API Token** (Account token).
2. Permissions: **Object Read & Write**, scoped to your bucket.
3. Copy the **Access Key ID** and **Secret Access Key**.

### 3. Deploy the Worker

```bash
cd worker
npm install

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

# In wrangler.toml [vars], set R2_PUBLIC_URL to your bucket's public URL (from
# step 1). It's not a secret — the Worker serves it via GET /config so admins
# log in with just email + password.

# Apply the database schema (run every migration in order)
npx wrangler d1 execute offgrid-db --remote --file=migrations/001_init.sql
npx wrangler d1 execute offgrid-db --remote --file=migrations/002_users_multitenant.sql
npx wrangler d1 execute offgrid-db --remote --file=migrations/003_tracklist.sql
# 004 backfills existing content to the first admin — run it AFTER bootstrapping your admin account
npx wrangler d1 execute offgrid-db --remote --file=migrations/004_content_ownership.sql
npx wrangler d1 execute offgrid-db --remote --file=migrations/005_login_attempts.sql
npx wrangler d1 execute offgrid-db --remote --file=migrations/006_track_url.sql
npx wrangler d1 execute offgrid-db --remote --file=migrations/007_play_tracking.sql

# Set secrets
npx wrangler secret put ADMIN_TOKEN          # Bootstrap/legacy admin token
npx wrangler secret put JWT_SECRET           # Random string, e.g. `openssl rand -hex 32`
npx wrangler secret put R2_ACCESS_KEY_ID     # From step 2
npx wrangler secret put R2_SECRET_ACCESS_KEY # From step 2
npx wrangler secret put CF_ACCOUNT_ID        # Your Cloudflare account ID

# Deploy
npx wrangler deploy
```

The deploy prints your Worker URL, e.g. `https://offgrid-api.YOUR-SUBDOMAIN.workers.dev`.

### 4. Point the player page at your manifest

The public page (`index.html`) resolves its manifest URL in this order, so you don't have to edit
(and risk committing) your real bucket URL in the tracked file:

1. **`?manifest=<url>` query param** — best for quick local testing:
   `index.html?manifest=https://pub-xxxxxxxx.r2.dev/data/manifest.json`
2. **`config.local.js`** (gitignored) — a persistent local default:
   ```bash
   cp config.local.example.js config.local.js
   # then set:  window.OFFGRID_MANIFEST_URL = 'https://pub-xxxxxxxx.r2.dev/data/manifest.json';
   #            window.OFFGRID_API_BASE = 'https://offgrid-api.YOUR-SUBDOMAIN.workers.dev';
   ```
   `OFFGRID_API_BASE` is also what the admin page uses to find your Worker, so set it here once
   and the admin login only asks for email + password.
3. The placeholder in `index.html` — only change this if you want a committed default.

### 5. Host `audio-player.js`

So you can embed the player on other sites, upload `audio-player.js` to R2 (or any CDN / your own domain) and reference it with an absolute URL in your embeds (see [Embedding](#embedding)).

### 6. Add your first mix

1. Run the admin UI (below) and log in.
2. Click **Add Mix** → **Choose File** and select your audio. The admin uploads it and
   **auto-generates the waveform peaks and duration in your browser** — no manual peak step.
3. Fill in the title, artist, and cover image, then **Save**.
4. Click **Publish** to regenerate `manifest.json` on R2 — the public player page updates instantly.

> Prefer the command line, or have a big back catalog? `generate-peaks.js` still works for
> generating peaks in bulk (see [Peaks](#peaks)); the admin just makes it automatic for everyday use.

Optional: for scraper-readable link previews (Facebook, Slack, etc.) of individual mixes, generate
static share pages — see [Static share pages](#static-share-pages-generate-share-pagesmjs).

---

## Admin UI

The admin interface lives at `admin/index.html`. Serve it with any static server:

```bash
python3 -m http.server 8080
# open http://localhost:8080/admin/
```

**Login** with your **email + password**. The admin finds your Worker via `OFFGRID_API_BASE` in
`config.local.js` and fetches the R2 public URL from the Worker's `GET /config` endpoint (the
`R2_PUBLIC_URL` var in `wrangler.toml`). If either isn't configured — or the Worker is
unreachable — the login form falls back to showing **Worker URL** / **R2 Public URL** fields you
can fill in manually (they're remembered in localStorage).

First time? While no admin account exists yet, the login screen offers **First-time setup**:
provide your `ADMIN_TOKEN` (the `wrangler secret`) plus the email/password for the initial admin —
this calls `/auth/bootstrap` to create your account. After that you sign in with email + password
(a JWT session), and the setup button disappears on config-driven deployments (it stays available
when you're using the manual URL fields).

To add more people: as an admin, open the **Users** tab → **Invite User**, then send them the
generated invite link (it opens the admin to an "accept invite" screen where they set a password).

Without any deployment config, the login screen also offers **Use offline** to edit the local
`data/manifest.json` without a backend (hidden on config-driven deployments).

**Features**

- **Mixes** — add / edit / delete with metadata (title, artist, tags, color, etc.)
- **Automatic waveforms** — choosing an audio file uploads it and generates the waveform peaks and
  duration **in your browser** (Web Audio), then uploads the peaks JSON — no `ffmpeg`, no manual
  step. Override or supply peaks manually under **Advanced** if you ever need to.
- **File uploads** — push audio and cover art straight to R2
- **Playlists** — build playlists by selecting and ordering mixes
- **Tracklists** — paste a tracklist into one field; the admin parses each line (timestamp, artist,
  title, and an optional link) into individual tracks on save. Missing timestamps are auto-filled
  evenly across the mix; a URL on a line (e.g. a Bandcamp link) becomes a clickable link in the
  player tracklist. The structured `tracks` array is included in the manifest.
- **Search & sort** — filter by title, artist, or tags
- **Play stats** — the mixes table shows sortable **Plays**, **Time played**, and **Likes** columns,
  fed by anonymous listener tracking (see [Play tracking & likes](#play-tracking--likes)). Requires
  migration `007_play_tracking.sql`; the columns show zeros until it's applied. On narrow viewports
  these stat columns (and, on phone-size screens, Duration, Artist, and Tags) are hidden
  progressively to keep the table readable; a mix's first three tags show as chips with a "+N"
  overflow badge.
- **Users** (admin) — invite people, set roles (admin/user), disable or delete accounts
- **Publish** — write your library's `manifest.json` to R2. Afterward the admin shows **your manifest
  URL** plus a **▶ Preview** button (see [Viewing & sharing a library](#viewing--sharing-a-library)).
- **Import / Export** — back up or restore `manifest.json`

> Auto-generation decodes the audio at a low sample rate to stay memory-friendly. For an
> exceptionally long mix where in-browser decoding fails, the audio still uploads — generate its
> peaks with `node generate-peaks.js` (see below) and add the file under **Advanced**.

### Multi-user & ownership

Each account owns its own mixes and playlists — a user only sees and edits their own content, and
**Publish** writes a **per-user manifest** to `users/<id>/data/manifest.json`. The instance owner
(the first admin) additionally writes the shared `data/manifest.json`, so the main player page and
any existing embeds keep working. Admins can invite people and manage accounts from the **Users**
tab. (Roles today: an `admin` can manage users; a `user` cannot — content is otherwise per-owner.)

Uploaded files are namespaced per user too: each account's audio, covers, and peaks live under
`users/<id>/audio|covers|peaks/…` in R2, and the Worker enforces that prefix on every upload — so
users can't collide with or reach each other's files. (Files uploaded before this change keep their
original keys; their stored URLs are absolute, so they keep working.)

**Production hardening.** Two things to set before a public deployment:
- **CORS** — set `CORS_ORIGIN` (in `wrangler.toml`) to a comma-separated allowlist of the exact
  origins your admin is served from instead of `*`, e.g. `https://your-domain.com,http://localhost:8080`.
  The Worker echoes a request's Origin only when it's on the list.
- **Login rate limiting** — `/auth/login` throttles failed attempts per IP (10 per 15 min) via the
  `login_attempts` table (migration 005). It fails open on limiter errors. For distributed attacks,
  pair it with a Cloudflare WAF rate-limit rule.

### Viewing & sharing a library

After Publish, the admin shows your **manifest URL** and a **▶ Preview** button. There are three ways
to play/share a library:

1. **▶ Preview / clean per-user link** — opens the player page at `https://<your-site>/?user=<id>`,
   which the page resolves to that user's `users/<id>/data/manifest.json`. Share that link and anyone
   can listen. (The page derives the R2 base from your configured manifest URL; override with
   `window.OFFGRID_R2_BASE` if your layout differs.)
2. **Any manifest** renders via the explicit `?manifest=<url>` param (see
   [step 4](#4-point-the-player-page-at-your-manifest)) — handy for one-offs.
3. **A single mix** — add `?mix=<id>` to show just one mix on the player page (composes with the
   above, e.g. `?user=<id>&mix=<id>` or `?manifest=<url>&mix=<id>`); the **Link** button on each row
   in the admin copies this URL. Or embed it anywhere with the web component (see
   [Embedding](#embedding)), using the `src`/`peaks`/`tracks` values from the manifest.

Everything is served from your public R2 bucket, so libraries and embeds work cross-origin from any site.

### Browsing the public page

The public page (`index.html`) is more than a flat list — it has client-side browsing built entirely
on the loaded manifest (no extra requests, no backend). Navigation uses **hash routes**, so deep
links are shareable and bookmarkable and work on a static host:

| Route             | Shows                                                                       |
|-------------------|-----------------------------------------------------------------------------|
| `#/`              | All mixes (sortable) plus playlists                                          |
| `#/playlists`     | Just the playlists (each title links to its own page)                        |
| `#/playlist/<slug>` | One playlist by its id/slug, in-app with a back link                      |
| `#/mix/<slug>`    | One mix by its id/slug, in-app with a back link                            |
| `#/tag/<tag>`     | Mixes carrying that tag (tag chips and in-player tag pills link here)        |
| `#/artist/<name>` | Mixes by that artist — the per-"user" view                                  |
| `#/tracks`        | Every unique track across all mixes, searchable                             |
| `#/track/<slug>`  | One track with its buy link, then every mix that contains it                |

These hash routes are independent of the `?manifest=`/`?user=`/`?mix=` query params above (which pick
*which* manifest to load). The **Browse** button reveals artist and tag chips; **Sort** orders the
list by Newest (`releaseDate`), Title, or Artist. The same Sort dropdown also appears on the
Playlists and Tracks tabs — on Playlists, Artist sorts by the playlist creator; on Tracks it orders
by artist/title (Tracks have no date, so Newest keeps the natural artist–title order).

The toolbar's **color-mode toggle** cycles the whole page — chrome *and* every embedded
player/playlist — through the same three themes as the embedded players: **Dark** (default) →
**Light** → **Color**. In Color mode the page chrome stays dark (with a subtle accent tint) while
each embedded player switches to its own color styling. The choice is saved to `localStorage` and
applied before first paint on the next visit, so there's no flash. First-time visitors default to
Dark.

> `#/mix/<slug>` keeps the page chrome (nav + back link); the `?mix=<id>` query param is the
> chrome-less single-mix mode meant for embeds. Add **`?tracklist=open`** to any URL to render every
> player with its tracklist already expanded — including a single mix, e.g.
> `?mix=dawn-patrol&tracklist=open` or `#/mix/dawn-patrol` with `?tracklist=open`. When a player is
> showing its tracklist open, the **embed** code it generates carries `open-tracklist` too, so the
> embedded copy opens the same way.

**Search** matches mix title, artist, tags, **and the track names inside each mix**, so typing a track's
artist or title surfaces the mixes that contain it. On `#/tracks` the same box filters tracks by
artist/title. On `#/playlists` it filters playlists by their name plus the mixes and tracks they
contain, so typing a mix or track name narrows to the playlists that include it.

> Because tracks aren't a shared entity in the data model, "every mix containing a track" is computed
> client-side by matching normalized `artist` + `title` across each mix's tracklist. In-page
> navigation re-renders the view, which stops any in-progress playback.

### Meta tags & structured data

As you navigate, the page rewrites its `<head>` for the current view — `<title>`, `<meta name="description">`,
a `<link rel="canonical">`, Open Graph tags (`og:title`/`description`/`type`/`url`/`image`/`site_name`, plus
`og:audio`/`og:audio:type` on mix pages), and Twitter card tags (`twitter:card`/`title`/`description`/`image`;
mix pages with a cover get a `player` card pointing at the `?mix=` embed page) — and emits
[schema.org](https://schema.org) JSON-LD in `<script type="application/ld+json">`:

| View | JSON-LD |
|------|---------|
| Single mix (`?mix=`, `#/mix/<slug>`) | `MusicRecording` with an `AudioObject` (the embed) and an `ItemList` of tracks (`MusicRecording` each, with the track's buy `url`) |
| Track detail (`#/track/<slug>`) | `MusicRecording` for the track, `isPartOf` the mixes that contain it |
| Artist (`#/artist/<name>`) | `MusicGroup` with the artist's mixes as `track` |
| Playlists (`#/playlists`) | `CollectionPage` → `ItemList` of `MusicPlaylist` |
| Single playlist (`#/playlist/<slug>`) | `MusicPlaylist` with its mixes as `track` |
| Home / tag / tracks | `CollectionPage` → `ItemList` of the listed mixes/tracks |

Durations use ISO 8601 (`PT58M30S`) and `releaseDate` maps to `datePublished`. Absolute URLs (canonical,
`og:url`, JSON-LD `@id`/`url`/`embedUrl`) are built from **`window.OFFGRID_SITE_URL`** when set (see
`config.local.example.js`), falling back to the current page location.

> These tags are set by JavaScript. Googlebot executes JS and will see them, and they're ideal for your
> own tooling/crawlers — but most social scrapers (Facebook/Slack/etc.) don't run JS, and hash fragments
> (`#/mix/<slug>`) are never even sent to the server, so link-preview cards for hash routes always show
> the generic static `<head>`. The fix is **static share pages** (below): real per-mix HTML that scrapers
> can read, generated from the manifest.

### Static share pages (`generate-share-pages.mjs`)

`generate-share-pages.mjs` reads your published manifest and writes one static page per mix to
`mix/<slug>/index.html`. Each page carries the full scraper-readable markup — Open Graph `music.song`
tags (`og:image` cover, `og:audio` + `og:audio:type`, `music:duration`/`music:release_date`), a Twitter
`player` card pointing at the chrome-less `?mix=<id>` embed page (falls back to a `summary` card when
the mix has no cover), and the same `MusicRecording` JSON-LD the SPA emits — plus an instant redirect
into the player (`#/mix/<slug>`) for human visitors, with a `<noscript>` fallback.

```bash
# Uses OFFGRID_MANIFEST_URL / OFFGRID_SITE_URL from config.local.js when present
node generate-share-pages.mjs

# Or fully explicit
node generate-share-pages.mjs \
  --manifest https://pub-xxxxxxxx.r2.dev/data/manifest.json \
  --site-url https://your-domain.com \
  --out mix --sitemap
```

Flags: `--manifest <url|path>` (default: `OFFGRID_MANIFEST_URL`, else the sample `data/manifest.json`),
`--site-url <url>` (required; default: `OFFGRID_SITE_URL`), `--out <dir>` (default: `mix/`, wiped and
regenerated each run), `--sitemap` (also writes `mix/sitemap.xml` — point Search Console or a
`Sitemap:` line in your robots.txt at it), `--dry-run`. Requires Node 18+.

Then set **`window.OFFGRID_SHARE_BASE`** in `config.local.js` (see `config.local.example.js`) so the
SPA's canonicals, `og:url`, and JSON-LD `@id`/`url` point at the share pages — and share
`https://your-domain.com/mix/<slug>/` URLs instead of hash URLs. Leave it unset if you don't generate
share pages (canonicals then fall back to `?mix=<id>` as before).

Run the script in your site's build/deploy step so pages regenerate on every deploy, e.g.:

```json
"build": "node public/audio/generate-share-pages.mjs --sitemap && astro build"
```

> Share pages are frozen at build time: a mix published in the admin UI gets its page (and updated
> metadata) on your site's next build. The `mix/` output folder is gitignored — treat it as a build
> artifact.

---

## Embedding

### 1. Include the script

```html
<script src="https://your-domain.com/audio-player.js"></script>
```

(Use the URL where you hosted `audio-player.js` in step 5.)

### 2. Add a player

```html
<offgrid-player
  src="https://pub-xxxxxxxx.r2.dev/audio/mix.mp3"
  title="My Mix"
  artist="Your Name"
  color="#ff5500"
  theme="dark"
  size="standard"
  thumb="https://pub-xxxxxxxx.r2.dev/covers/cover.jpg"
  peaks="https://pub-xxxxxxxx.r2.dev/peaks/mix.peaks.json">
</offgrid-player>
```

The player renders inside Shadow DOM, so host-page styles won't interfere.

### `<offgrid-player>` — single track

| Attribute  | Required | Description |
|------------|----------|-------------|
| `src`      | Yes      | URL to the audio file (MP3, WAV, OGG, etc.) |
| `title`    | No       | Track title (default: "Untitled Track") |
| `artist`   | No       | Artist name |
| `thumb`    | No       | URL to a thumbnail/cover image |
| `peaks`    | No       | URL to a pre-computed peaks JSON file (see [Peaks](#peaks)) |
| `color`    | No       | Accent color as hex (default: `#ff5500`) |
| `theme`    | No       | Color styling: `dark` (default), `light`, or `color` (uses `color` as the background/primary with auto-contrast text & waveform) |
| `size`     | No       | Layout: `standard` (default) or `slim` (compact — smaller cover, shorter waveform, tighter padding) |
| `duration` | No       | Pre-known duration string, e.g. `"3:42"` |
| `description` | No | Free text shown in the collapsible "More" panel |
| `release-date` | No | ISO date (`YYYY-MM-DD`) shown as a formatted "Released:" line in the "More" panel |
| `title-href` | No | If set, the title renders as a link to this URL (used by the player page for `#/mix/<id>`); omit for plain text |
| `artist-href` | No | If set, the artist renders as a link to this URL (used by the player page for `#/artist/<name>`); omit for plain text |
| `open-tracklist` | No | Boolean attribute — render with the tracklist panel expanded (when the player has tracks) |
| `start-at` | No | Cue position in seconds — the player shows this time and begins playback there on first play (no autoplay) |
| `mix-id` | No | Mix id from the manifest — together with an API base, enables [play tracking & likes](#play-tracking--likes); omit for a tracking-free player |
| `api-base` | No | Worker URL to send tracking beacons to (no trailing slash); falls back to `window.OFFGRID_API_BASE` from `config.local.js` |

Clicking the cover art opens the full-size image in a built-in lightbox (click the backdrop or press
`Escape` to close). The "More" panel appears whenever a `description` or `release-date` is present.

**Tracklist (optional).** A player can show a collapsible tracklist; tracks with a parsed time are
click-to-seek. Provide it either as a JS property (used by the player page from the manifest):

```js
player.tracks = [
  { time: "00:00", seconds: 0,   artist: "Artist A", title: "Opening Track" },
  { time: "04:32", seconds: 272, artist: "Artist B", title: "Second Track"  }
];
```

…or inline for a static embed, via a child `<script type="application/json" class="tracklist">`:

```html
<offgrid-player src="…" title="…">
  <script type="application/json" class="tracklist">
    [ { "time": "00:00", "seconds": 0, "artist": "Artist A", "title": "Opening Track" } ]
  </script>
</offgrid-player>
```

### `<offgrid-playlist>` — multiple tracks

Wraps an `<offgrid-player>` with a clickable track list, prev/next navigation, autoplay, and an
**Embed** button in the footer that reveals a copy-to-clipboard `<offgrid-playlist>` snippet. Tracks
are defined as JSON in a child `<script type="application/json">`:

```html
<offgrid-playlist color="#ff5500" artist="Your Name" theme="dark" size="standard">
  <script type="application/json">
    [
      {"src": "track1.mp3", "title": "Track One", "thumb": "cover1.jpg", "peaks": "track1.peaks.json"},
      {"src": "track2.mp3", "title": "Track Two", "peaks": "track2.peaks.json"}
    ]
  </script>
</offgrid-playlist>
```

| Attribute | Required | Description |
|-----------|----------|-------------|
| `color`   | No       | Accent color for the embedded player and track list |
| `artist`  | No       | Default artist for tracks that don't specify one |
| `theme`   | No       | Color styling: `dark` (default), `light`, or `color`; forwarded to the embedded player |
| `size`    | No       | Layout: `standard` (default) or `slim`; forwarded to the embedded player |
| `api-base` | No      | Worker URL for [play tracking](#play-tracking--likes); forwarded to the embedded player (falls back to `window.OFFGRID_API_BASE`) |

Track objects also accept a `mixId` field — when present (the player page includes it from the
manifest), the embedded player tracks plays and shows the like button for that mix.

### Play one at a time

Pause every other player when one starts:

```html
<script>
  document.addEventListener('trackplay', (e) => {
    document.querySelectorAll('offgrid-player').forEach(p => {
      if (p !== e.target) p.pause();
    });
  });
</script>
```

### JavaScript API

| Method        | Description |
|---------------|-------------|
| `play()`      | Start playback (lazy-loads audio on first call) |
| `pause()`     | Pause playback |
| `stop()`      | Stop and reset to the beginning |
| `isPlaying()` | Returns `true` if currently playing |

| Event         | Detail   | Description |
|---------------|----------|-------------|
| `trackplay`   | `{src}`  | Fired when playback starts |
| `trackpause`  | —        | Fired when playback pauses |
| `trackfinish` | —        | Fired when the track ends |

### Play tracking & likes

When a player has both a `mix-id` and an API base (the `api-base` attribute, or
`window.OFFGRID_API_BASE` from `config.local.js`), it reports anonymous listening stats to the
Worker; without them it's a complete no-op. Requires migration `007_play_tracking.sql`.

- **Heartbeats** — the player accumulates *actually listened* seconds (seeking and pausing don't
  count; each delta is clamped to wall-clock elapsed time) and POSTs a tiny beacon to
  `/api/track/play` every ~30 seconds of listening, plus a final flush on pause, finish,
  tab-hide/close, and playlist track switch. Listening in a backgrounded tab still counts: the
  player accumulates from the media element's `timeupdate` events plus a coarse backstop interval
  (runs only while playing), neither of which depends on `requestAnimationFrame`.
- **What counts as a play** — a session (one page-load of one mix, identified by a random client
  UUID) counts as **one** play once its cumulative listening crosses 5 seconds. Replays after
  seeking or pause/resume never inflate the count.
- **Likes** — a heart button appears on trackable players. Likes are anonymous; the browser's
  `localStorage` remembers them per mix so the button toggles and repeat likes from the same
  browser are suppressed (client-side only — this is a vibe metric, not an audited one).
- **Privacy** — no IPs, cookies, or user identifiers are stored; just mix id, a random session id,
  seconds listened, and a timestamp.
- **Embeds** — the copy-paste embed snippet bakes in `mix-id` and the resolved `api-base`, so
  players embedded on other sites keep reporting. Beacons are sent as `text/plain` so they work
  cross-origin without preflight.

Stats appear in the admin mixes table (Plays / Time played / Likes) via the authenticated
`GET /api/stats` endpoint.

---

## Peaks

Pre-computed waveform peaks let the player draw an accurate waveform on load without downloading the full audio file. Strongly recommended for large mixes.

**You usually don't need to do this manually** — the admin UI generates peaks in your browser when
you choose an audio file (see [Admin UI](#admin-ui)). The CLI below is for bulk processing or as a
fallback. Both produce the same `{peaks, duration}` format, so they're interchangeable.

```bash
# Single file
node generate-peaks.js mixes/my-mix.mp3

# All MP3s in the mixes directory
node generate-peaks.js --all

# Custom number of samples (default: 800)
node generate-peaks.js mixes/my-mix.mp3 1200
```

Output: `<basename>.peaks.json` next to the source file. Requires `ffmpeg`/`ffprobe` on your PATH.

```json
{
  "peaks": [0.042, 0.187, 0.534, 0.891, ...],
  "duration": 5355.22
}
```

---

## Optional: migrate existing files

If you already have local audio/covers/peaks and a `data/manifest.json`, two helper scripts do a one-time migration:

```bash
# Seed D1 from an existing manifest
node scripts/seed-d1.js

# Upload local files to R2 (preview first)
node scripts/migrate-to-r2.js --dry-run
export R2_PUBLIC_URL="https://pub-xxxxxxxx.r2.dev"
node scripts/migrate-to-r2.js
```

---

## Project structure

```
off-grid/
  index.html             # Public player page (loads manifest.json from R2)
  audio-player.js        # Web component source (<offgrid-player>, <offgrid-playlist>)
  config.local.example.js # Copy to config.local.js (gitignored) to set your manifest + Worker API URLs
  generate-peaks.js      # Waveform peak generation CLI (Node.js + ffmpeg) — bulk/fallback
  generate-share-pages.mjs # Static per-mix share pages (OG/Twitter/JSON-LD) for scrapers
  mix/                   # Generated share pages (gitignored build artifact)
  assets/                # Site icon (favicon.ico) + brand images
  admin/
    index.html           # Admin SPA shell
    admin.js             # Admin logic (CRUD, uploads, auth)
    peaks.js             # In-browser waveform/duration generation (Web Audio)
    admin.css            # Admin styles (dark theme)
  data/
    manifest.json        # Local/sample manifest (dev & offline use)
    schema.md            # Manifest JSON format documentation
  mixes/                 # Your local audio, covers, peaks (gitignored)
    images/              # Cover art
    peaks/               # Pre-computed waveform peaks
  worker/
    wrangler.toml.example # Template — copy to wrangler.toml (gitignored) and fill in IDs
    package.json         # Worker scripts & deps
    r2-cors.json         # R2 CORS configuration
    migrations/
      001_init.sql       # D1 database schema
      002_users_multitenant.sql  # Auth columns + invites (multi-user)
      003_tracklist.sql  # Per-mix tracklist + mix_tracks table
      004_content_ownership.sql  # owner_id on mixes/playlists + backfill
      005_login_attempts.sql     # Login rate-limit table
      006_track_url.sql  # Optional per-track link (mix_tracks.url)
      007_play_tracking.sql      # Play events log + per-mix stats (plays/time/likes)
    src/
      index.js           # Worker entry point (routing, CORS)
      auth.js            # Session auth — verifies JWT, loads user
      jwt.js             # HS256 JWT sign/verify (WebCrypto)
      crypto.js          # Password hashing (PBKDF2) + token helpers
      ratelimit.js       # D1-backed login rate limiting
      r2.js              # R2 operations (presigned URLs, upload, list, delete)
      aws-sign.js        # AWS Signature V4 for R2 presigned URLs
      db.js              # D1 query helpers + manifest generation
      api/
        auth.js          # Login, invite acceptance, bootstrap, change-password
        users.js         # Admin user management (invite/list/patch/delete)
        mixes.js         # Mix CRUD endpoints
        playlists.js     # Playlist CRUD endpoints
        manifest.js      # Manifest generation + publish to R2
        track.js         # Public play/like tracking + authed stats
  scripts/
    migrate-to-r2.js     # One-time: upload local files to R2
    seed-d1.js           # One-time: seed D1 from manifest.json
```

---

## API reference

Authenticated endpoints take an `Authorization: Bearer <token>` header, where the token is a
**login JWT** (from `/auth/login`) or — for bootstrap/legacy use — the shared `ADMIN_TOKEN`.

### Config

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/config` | public | Deployment config for clients → `{ r2PublicUrl, needsSetup }` (`r2PublicUrl` from the `R2_PUBLIC_URL` var, `null` when unset; `needsSetup` is `true` until the first admin exists) |

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/login` | public | Email + password → `{ token, user }` |
| `POST` | `/auth/accept-invite` | public | Set password from an invite token → `{ token, user }` |
| `POST` | `/auth/bootstrap` | `ADMIN_TOKEN` | Create the first admin (only when none exists) |
| `GET`  | `/auth/me` | user | Current user |
| `POST` | `/auth/change-password` | user | Rotate password (invalidates other sessions) |

### Users (admin)

| Method   | Path | Description |
|----------|------|-------------|
| `POST`   | `/api/users/invite` | Create an invite (`{ email, role? }`) → one-time `inviteToken` |
| `GET`    | `/api/users` | List users |
| `PATCH`  | `/api/users/:id` | Set `role` / `status` |
| `DELETE` | `/api/users/:id` | Delete a user |

### R2 file operations

| Method   | Path                    | Description |
|----------|-------------------------|-------------|
| `POST`   | `/presign`              | Presigned PUT URL for large uploads |
| `POST`   | `/upload`               | Direct upload (< 100 MB, set `X-File-Key` header) |
| `GET`    | `/files?prefix=audio/`  | List R2 objects |
| `DELETE` | `/files/:key`           | Delete an R2 object |

### Mix CRUD

| Method   | Path              | Description |
|----------|-------------------|-------------|
| `GET`    | `/api/mixes`      | List mixes (`?tag=`, `?artist=`, `?sort=`, `?dir=`) |
| `GET`    | `/api/mixes/:id`  | Get one mix |
| `POST`   | `/api/mixes`      | Create |
| `PUT`    | `/api/mixes/:id`  | Update |
| `DELETE` | `/api/mixes/:id`  | Delete (also removes from playlists) |

### Playlist CRUD

| Method   | Path                              | Description |
|----------|-----------------------------------|-------------|
| `GET`    | `/api/playlists`                  | List with resolved mixes |
| `GET`    | `/api/playlists/:id`              | Get one |
| `POST`   | `/api/playlists`                  | Create |
| `PUT`    | `/api/playlists/:id`              | Update |
| `DELETE` | `/api/playlists/:id`              | Delete |
| `POST`   | `/api/playlists/:id/mixes`        | Add a mix (`{"mixId": "..."}`) |
| `DELETE` | `/api/playlists/:id/mixes/:mixId` | Remove a mix |

### Manifest

| Method | Path                     | Description |
|--------|--------------------------|-------------|
| `GET`  | `/api/manifest`          | Generate manifest JSON from D1 |
| `POST` | `/api/manifest/publish`  | Write `manifest.json` to R2 |

### Tracking & stats

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/track/play` | public | Listening heartbeat from the player: `{ mixId, sessionId, seconds }` → `204`. Seconds are clamped to 300/event (throttled background tabs can flush minutes at once); ≥ 6 events per session per minute are silently dropped |
| `POST` | `/api/track/like` | public | Anonymous like: `{ mixId, action }` (`action`: `like` \| `unlike`, default `like`) → `204` |
| `GET`  | `/api/stats` | user | Per-mix aggregates for your mixes → `{ stats: [{ mixId, title, artist, playCount, totalSeconds, likeCount, lastPlayedAt }] }` |

The public tracking endpoints accept their JSON body as **`text/plain`** — the player sends
`navigator.sendBeacon` simple requests so they survive page unload and work from cross-origin
embeds without CORS preflight. See [Play tracking & likes](#play-tracking--likes).

---

## WSL notes

If you develop on WSL:

- **D1 and R2 local mode can fail** due to a `workerd` memory allocation issue — always use `--remote`:
  ```bash
  npx wrangler d1 execute offgrid-db --remote --file=migrations/001_init.sql
  ```
- **`wrangler login` may hang** if the OAuth redirect can't reach WSL — use an API token instead:
  ```bash
  export CLOUDFLARE_API_TOKEN="your-token"
  ```

---

## Cost

Cloudflare R2 storage runs ~$0.015/GB/month with **zero egress fees**. A library of 100 mixes at 200 MB each (20 GB) costs about **$0.30/month** regardless of how many times it streams.

## Dependencies

- [WaveSurfer.js v7](https://wavesurfer.xyz) — loaded from CDN on first use
- [Wrangler v4](https://developers.cloudflare.com/workers/wrangler/) — Worker / D1 / R2 tooling
- `ffmpeg` / `ffprobe` — required only for peak generation

## Roadmap

See [IDEA.md](./IDEA.md) for the product vision and open questions. Planned directions:

- Integration with mix-extractor for tracklistings and Bandcamp link enrichment
- Automatic peak generation on upload
- Multi-user accounts that map each user to their own R2 / config

## License

No license file is included yet. Add one (e.g. MIT) before publishing if you want others to reuse it freely.
