# Self-hosting your own Off Grid instance

Off Grid is generic — anyone can run their own independent instance (own Worker, D1, R2, admin,
and domain). This guide is the end-to-end path. It links to the main [README](../README.md) for the
mechanics and adds the instance-specific steps (multi-user bootstrap, hosting, inviting people).

An instance has two deployable parts that are linked only by URLs:
- **Static frontend** — `index.html`, `audio-player.js`, `admin/`, `config.local.js`. Host these on
  your domain / Cloudflare Pages / R2 static hosting.
- **The Worker** — runs on Cloudflare (a `*.workers.dev` URL or a custom route on your zone), backed
  by D1 + R2.

## 1. Storage, Worker, and database

Follow the README [Quick start](../README.md#quick-start) through deploying the Worker:
1. Create an **R2 bucket** (public access + CORS via `worker/r2-cors.json`).
2. Create an **R2 API token** (Object Read & Write) for presigned uploads.
3. In `worker/`: `cp wrangler.toml.example wrangler.toml`, fill in your bucket name + `database_id`,
   then `npm install` and `wrangler deploy`.

## 2. Database migrations + first admin

Apply **all** migrations in order, then create your admin account:

```bash
cd worker
for m in 001_init 002_users_multitenant 003_tracklist 004_content_ownership; do
  npx wrangler d1 execute <your-db> --remote --file=migrations/$m.sql
done
```

Set the secrets (see [README](../README.md#3-deploy-the-worker)) — at minimum `ADMIN_TOKEN`,
`JWT_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CF_ACCOUNT_ID`:

```bash
npx wrangler secret put JWT_SECRET   # openssl rand -hex 32
# …and the others
```

Then **bootstrap the first admin**: open the admin, click **First-time setup**, and enter your
`ADMIN_TOKEN` + the email/password you want. (On a fresh install there's no existing content, so
migration 004's backfill is a no-op; on an instance that already had mixes, run 004 *after*
bootstrapping so it can assign them to your admin.)

## 3. Host the frontend

Serve the static files at a **public URL** — this matters because invite links point at wherever the
admin is hosted (see below), so `localhost` only works for solo use.

- Player page at e.g. `https://your-site/` and admin at `https://your-site/admin/`.
- Create `config.local.js` (gitignored — see `config.local.example.js`) and set your manifest URL:
  ```js
  window.OFFGRID_MANIFEST_URL = 'https://pub-xxxxxxxx.r2.dev/data/manifest.json';
  ```
- Upload `audio-player.js` somewhere public so embeds on other sites can load it.

## 4. Log in and add content

In the admin, sign in with your **Worker URL**, **R2 Public URL**, and email/password. Add a mix
(audio auto-generates the waveform + duration), then **Publish**. The admin shows your manifest URL
and a **▶ Preview** link. See [Viewing & sharing a library](../README.md#viewing--sharing-a-library).

## 5. Invite collaborators (optional)

As an admin, open the **Users** tab → **Invite User**. The generated link embeds your Worker + R2
URLs and points at *your* admin, so invitees just open it and set a password. Each account owns its
own mixes and publishes its own `users/<id>/data/manifest.json`; uploads are namespaced under
`users/<id>/…`. (Today an `admin` can manage users; a `user` manages only their own content.)

## Notes

- **Custom Worker domain** (optional): add a Workers route like `api.your-site.com` on your zone
  instead of the `*.workers.dev` URL.
- **Migrations aren't tracked** by `wrangler d1 execute` — re-running a migration re-applies it and
  the `ALTER`s will error. Apply each once. (A future switch to `wrangler d1 migrations` would make
  this idempotent.)
- Keep your real `worker/wrangler.toml` out of git (it's gitignored) — edit `wrangler.toml.example`
  only for generic placeholders.
