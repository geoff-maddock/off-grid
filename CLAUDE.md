# CLAUDE.md

Guidance for Claude Code (and any agent) working in this repo.

## Golden rule: keep docs in sync with code

**Whenever you change code, update the documentation that describes it — in the same change, not
later.** Treat docs as part of the definition of done. A code change that alters documented
behavior is incomplete until the docs match. Before finishing any task, re-read the affected docs
and confirm they still describe reality.

What tracks what:

| If you change…                                  | Also update…                                              |
|-------------------------------------------------|-----------------------------------------------------------|
| Worker routes / endpoints (`worker/src/**`)     | **API reference** table in `README.md`                    |
| Web component attributes, methods, or events (`audio-player.js`) | **Embedding** section tables in `README.md`      |
| Custom element names (`customElements.define`)  | All embed examples in `README.md` + `index.html`          |
| Manifest shape / fields (`worker/src/db.js`, manifest generation) | `data/schema.md` **and** the sample `data/manifest.json` |
| Setup/deploy steps, secrets, or Worker config   | **Onboarding** + **Quick start** in `README.md` + `worker/wrangler.toml.example` |
| Bucket/DB/Worker default names                  | `README.md`, `wrangler.toml.example` comments, `worker/src/r2.js` |
| Files added/removed/moved                       | **Project structure** tree in `README.md`                 |
| Build/run/peak commands or scripts              | The relevant `README.md` command blocks                   |

If a change makes part of the docs obsolete, delete or rewrite it — don't leave stale instructions.
When you add a new feature, add its documentation in the same pass (new section, table row, or
example). When unsure whether something is documented, grep `README.md` and `data/schema.md` for the
identifier you changed.

## This repo is the public, generic version

- **Never commit personal or deployment-specific values** (real domains, bucket names, R2 public
  URLs like `pub-...r2.dev`, `database_id`s, account IDs, tokens). Use placeholders:
  `https://your-domain.com`, `pub-xxxxxxxx.r2.dev`, `YOUR_DATABASE_ID`, `offgrid-media`, etc.
- Private notes and prod-specific material go in the gitignored `offline/` folder, never in
  tracked files.
- Secrets are set via `wrangler secret put` and must never appear in `wrangler.toml` or source.
- The real `worker/wrangler.toml` is **gitignored** (it holds account-specific `database_id`s etc.).
  Edit the committed `worker/wrangler.toml.example` template instead; keep it on generic placeholders.

## Conventions

- **Custom elements** are `<offgrid-player>` and `<offgrid-playlist>` (classes `OffgridPlayer`,
  `OffgridPlaylist`). Keep naming consistent if you add more.
- **Default infra names**: Worker `offgrid-api`, D1 `offgrid-db`, R2 bucket `offgrid-media`. These
  are defaults users override in `wrangler.toml`.
- No build step for the frontend — `index.html`, `audio-player.js`, and `admin/` are plain static
  files. The only `npm` project is `worker/` (Wrangler).
- WaveSurfer.js is loaded from CDN on first play; don't bundle it.

## Architecture (one-liner)

Admin UI → Cloudflare Worker (auth'd) → D1 (metadata) + R2 (files) → **Publish** writes a static
`manifest.json` to R2 → the public player page + web components read that manifest. See `README.md`
for the full picture.

## Project layout

See the **Project structure** section in `README.md` (keep it current when files move).
```
audio-player.js   web components       admin/    admin SPA
index.html        public player page   worker/   Cloudflare Worker (R2+D1 API)
generate-peaks.js peaks (ffmpeg)       data/     sample manifest + schema docs
scripts/          one-time migration   mixes/    local media (gitignored)
```
