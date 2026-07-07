// Local override for the public player page (index.html) and the admin UI
// (admin/index.html).
//
// Copy this file to `config.local.js` (which is gitignored) and set your real
// R2 manifest URL. This keeps your personal bucket URL out of the tracked
// index.html — no more accidental commits of `pub-...r2.dev`.
//
//   cp config.local.example.js config.local.js
//   # then edit config.local.js:
//
// window.OFFGRID_MANIFEST_URL = 'https://pub-xxxxxxxx.r2.dev/data/manifest.json';
//
// Alternatively, for a one-off without any file, just append a query param:
//   index.html?manifest=https://pub-xxxxxxxx.r2.dev/data/manifest.json
//
// Per-user libraries can be opened with a clean route:
//   index.html?user=<userId>
// which resolves to <r2 base>/users/<userId>/data/manifest.json. The r2 base is
// derived from OFFGRID_MANIFEST_URL above (its /data/manifest.json suffix is
// stripped). If your manifest URL doesn't follow that layout, set it explicitly:
//
// window.OFFGRID_R2_BASE = 'https://pub-xxxxxxxx.r2.dev';
//
// Worker API base URL (no trailing slash). When set, the admin page
// (admin/index.html) logs in with just email + password: the Worker URL comes
// from here and the R2 public URL from the Worker's GET /config endpoint.
//
// window.OFFGRID_API_BASE = 'https://offgrid-api.your-subdomain.workers.dev';
//
// Canonical site URL for SEO. The page sets per-view meta tags (title,
// description, Open Graph) and JSON-LD structured data, using this as the base
// for canonical/og:url and absolute @id/url values. If unset, it's derived from
// wherever the page is served (so it would read as localhost in dev). Pin it to
// your real public URL:
//
// window.OFFGRID_SITE_URL = 'https://your-domain.com/';
//
// Base URL of the static share pages written by generate-share-pages.mjs
// (scraper-readable per-mix pages, see README "Static share pages"). When set,
// mix canonicals/og:url/JSON-LD point at <base>/<slug>/ instead of ?mix=<id>.
// Leave unset if you don't generate share pages — otherwise canonicals would
// point at 404s.
//
// window.OFFGRID_SHARE_BASE = 'https://your-domain.com/mix';
