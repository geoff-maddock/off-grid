# Quick start

Get your own Off Grid instance — admin UI, streaming player, embeds — running on Cloudflare's free
tier. This is the abbreviated version; the full guide with explanations, checkpoints, and
troubleshooting is **[docs/ONBOARDING.md](docs/ONBOARDING.md)**.

## Prerequisites

- **Node.js 18+** (`node -v`)
- A **Cloudflare account** with **R2 activated** (R2 activation requires adding a payment method,
  even on the always-free tier)
- In the Cloudflare dashboard: an **R2 bucket** with **Public access** enabled (note its
  `https://pub-….r2.dev` URL), and an **R2 API token** (Object Read & Write — note the Access Key
  ID + Secret) — [details](docs/ONBOARDING.md#stage-1--storage-r2-bucket)

## Option A — the setup wizard

```bash
git clone <this-repo> off-grid && cd off-grid
node scripts/setup.mjs
```

The wizard creates the D1 database, writes `worker/wrangler.toml`, runs all migrations, sets the
secrets (generating `ADMIN_TOKEN`/`JWT_SECRET` for you), deploys the Worker, and prints your
`config.local.js`. Then skip to [First login](#first-login).

## Option B — by hand

```bash
git clone <this-repo> off-grid && cd off-grid/worker
npm install
cp wrangler.toml.example wrangler.toml
npx wrangler login

npx wrangler r2 bucket cors set offgrid-media --file ./r2-cors.json
npx wrangler d1 create offgrid-db     # paste database_id into wrangler.toml;
                                      # also set R2_PUBLIC_URL under [vars]
npm run db:migrate:all                # all 7 migrations, in order

npx wrangler secret put ADMIN_TOKEN           # openssl rand -hex 32 — save it!
npx wrangler secret put JWT_SECRET            # openssl rand -hex 32
npx wrangler secret put R2_ACCESS_KEY_ID      # from your R2 API token
npx wrangler secret put R2_SECRET_ACCESS_KEY  # from your R2 API token
npx wrangler secret put CF_ACCOUNT_ID         # dashboard sidebar

npx wrangler deploy                   # prints your Worker URL

cd .. && cp config.local.example.js config.local.js
# edit config.local.js:
#   window.OFFGRID_MANIFEST_URL = 'https://pub-xxxxxxxx.r2.dev/data/manifest.json';
#   window.OFFGRID_API_BASE     = 'https://offgrid-api.YOUR-SUBDOMAIN.workers.dev';
```

## First login

```bash
python3 -m http.server 8080    # or host the files anywhere static
```

Open `http://localhost:8080/admin/` → **First-time setup** → paste your `ADMIN_TOKEN` and choose
your admin email + password. Then **Add Mix** (waveform generates in-browser), **Save**, and
**Publish** — your library is live at `http://localhost:8080/` (and wherever you host it).

## Check it works

```bash
node scripts/check.mjs
```

## Next

- Full guide, hosting, invites, hardening: **[docs/ONBOARDING.md](docs/ONBOARDING.md)**
- Embedding players on other sites: **[README → Embedding](README.md#embedding)**
- Admin features and API: **[README](README.md)**
