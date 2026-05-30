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
`database_id` into `worker/wrangler.toml`, apply the migration, set the four secrets, deploy.
✓ Checkpoint: the deploy prints a Worker URL, and this returns an **empty** (or seeded) list rather
than an auth error:
```bash
curl -H "Authorization: Bearer <YOUR_ADMIN_TOKEN>" https://<your-worker-url>/api/mixes
# → []   (or your mixes)
```
If you get `401`, your `ADMIN_TOKEN` header doesn't match the secret. If `500` about R2
credentials, re-check the three R2/account secrets.

**Stage 4 — Frontend wiring**
- Set `MANIFEST_URL` in `index.html` to `https://pub-xxxxxxxx.r2.dev/data/manifest.json`.
- Upload `audio-player.js` to R2 (or your own host) so embeds elsewhere can load it.
✓ Checkpoint: `index.html` points at your real R2 manifest URL.

**Stage 5 — First content**
Serve the admin locally (`python3 -m http.server 8080` → `http://localhost:8080/admin/`), log in
with your Worker URL + R2 public URL + admin token, add a mix, upload its files, generate peaks
(`node generate-peaks.js mixes/my-mix.mp3`), upload the peaks, then click **Publish**.
✓ Checkpoint: `https://pub-xxxxxxxx.r2.dev/data/manifest.json` now lists your mix.

**Stage 6 — Go live**
Open `index.html` (locally or hosted) — your mix renders and plays. Then drop an
`<offgrid-player>` onto any other page (see [Embedding](#embedding)).
✓ Checkpoint: the waveform draws and audio plays from your R2 URL. 🎉

### Onboarding troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Admin login fails | Wrong Worker URL or token | URL has no trailing slash; token matches `ADMIN_TOKEN` secret |
| Uploads fail (>95 MB) | R2 API token/secrets missing | Set `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CF_ACCOUNT_ID` |
| Player shows nothing | `MANIFEST_URL` wrong, or manifest not published | Verify the manifest URL loads JSON; click **Publish** |
| CORS errors in console | Bucket CORS not set | Re-run the `wrangler r2 bucket cors set` step |
| Waveform but no audio | `src` URL wrong / not public | Open the `src` URL directly; enable R2 public access |
| `wrangler` hangs on login | OAuth can't reach your machine (WSL) | Use `CLOUDFLARE_API_TOKEN` — see [WSL notes](#wsl-notes) |

---

## Quick start

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

# Authenticate with Cloudflare
npx wrangler login
# If login hangs (e.g. on WSL), use an API token instead:
#   export CLOUDFLARE_API_TOKEN="your-token"
#   (Create one with the "Edit Cloudflare Workers" template at
#    https://dash.cloudflare.com/profile/api-tokens)

# Create the D1 database, then paste the returned database_id into wrangler.toml
npx wrangler d1 create offgrid-db

# Apply the database schema
npx wrangler d1 execute offgrid-db --remote --file=migrations/001_init.sql

# Set secrets
npx wrangler secret put ADMIN_TOKEN          # Choose your admin password
npx wrangler secret put R2_ACCESS_KEY_ID     # From step 2
npx wrangler secret put R2_SECRET_ACCESS_KEY # From step 2
npx wrangler secret put CF_ACCOUNT_ID        # Your Cloudflare account ID

# Deploy
npx wrangler deploy
```

The deploy prints your Worker URL, e.g. `https://offgrid-api.YOUR-SUBDOMAIN.workers.dev`.

### 4. Point the player page at your manifest

In `index.html`, set `MANIFEST_URL` to your R2 manifest:

```javascript
const MANIFEST_URL = 'https://pub-xxxxxxxx.r2.dev/data/manifest.json';
```

### 5. Host `audio-player.js`

So you can embed the player on other sites, upload `audio-player.js` to R2 (or any CDN / your own domain) and reference it with an absolute URL in your embeds (see [Embedding](#embedding)).

### 6. Add your first mix

1. Run the admin UI (below), log in, and add a mix with metadata.
2. Generate peaks locally: `node generate-peaks.js mixes/my-mix.mp3`.
3. Upload the audio, cover, and peaks via the admin.
4. Click **Publish** to regenerate `manifest.json` on R2 — the public player page updates instantly.

---

## Admin UI

The admin interface lives at `admin/index.html`. Serve it with any static server:

```bash
python3 -m http.server 8080
# open http://localhost:8080/admin/
```

**Login** with:

- **Worker URL** — your deployed Worker (e.g. `https://offgrid-api.YOUR-SUBDOMAIN.workers.dev`)
- **R2 Public URL** — your bucket's public URL (e.g. `https://pub-xxxxxxxx.r2.dev`)
- **Admin token** — the password you set with `wrangler secret put ADMIN_TOKEN`

Or click **Use offline** to edit the local `data/manifest.json` without a backend.

**Features**

- **Mixes** — add / edit / delete with metadata (title, artist, tags, color, etc.)
- **File uploads** — push audio, cover art, and peaks straight to R2
- **Playlists** — build playlists by selecting and ordering mixes
- **Search & sort** — filter by title, artist, or tags
- **Publish** — generate `manifest.json` from D1 and write it to R2
- **Import / Export** — back up or restore `manifest.json`

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
| `duration` | No       | Pre-known duration string, e.g. `"3:42"` |

### `<offgrid-playlist>` — multiple tracks

Wraps an `<offgrid-player>` with a clickable track list, prev/next navigation, and autoplay. Tracks are defined as JSON in a child `<script type="application/json">`:

```html
<offgrid-playlist color="#ff5500" artist="Your Name">
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

---

## Peaks

Pre-computed waveform peaks let the player draw an accurate waveform on load without downloading the full audio file. Strongly recommended for large mixes.

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
  generate-peaks.js      # Waveform peak generation (Node.js + ffmpeg)
  admin/
    index.html           # Admin SPA shell
    admin.js             # Admin logic (CRUD, uploads, auth)
    admin.css            # Admin styles (dark theme)
  data/
    manifest.json        # Local/sample manifest (dev & offline use)
    schema.md            # Manifest JSON format documentation
  mixes/                 # Your local audio, covers, peaks (gitignored)
    images/              # Cover art
    peaks/               # Pre-computed waveform peaks
  worker/
    wrangler.toml        # Worker config (R2 + D1 bindings, vars)
    package.json         # Worker scripts & deps
    r2-cors.json         # R2 CORS configuration
    migrations/
      001_init.sql       # D1 database schema
    src/
      index.js           # Worker entry point (routing, CORS)
      auth.js            # Bearer-token authentication
      r2.js              # R2 operations (presigned URLs, upload, list, delete)
      aws-sign.js        # AWS Signature V4 for R2 presigned URLs
      db.js              # D1 query helpers + manifest generation
      api/
        mixes.js         # Mix CRUD endpoints
        playlists.js     # Playlist CRUD endpoints
        manifest.js      # Manifest generation + publish to R2
  scripts/
    migrate-to-r2.js     # One-time: upload local files to R2
    seed-d1.js           # One-time: seed D1 from manifest.json
```

---

## API reference

All endpoints require an `Authorization: Bearer <ADMIN_TOKEN>` header.

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
