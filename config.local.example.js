// Local override for the public player page (index.html).
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
