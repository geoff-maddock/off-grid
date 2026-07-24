// Off Grid player page — app entry (extracted from index.html, #58).
// ---------------------------------------------------------------------
// Manifest URL, resolved in order:
//   1. ?manifest=<url>             (explicit, any manifest)
//   2. ?user=<id>                  (a user's library: <r2 base>/users/<id>/data/manifest.json)
//   3. window.OFFGRID_MANIFEST_URL (from gitignored config.local.js)
//   4. the placeholder below       (edit only for a committed default)
//
// In-page navigation uses hash routes (orthogonal to the params above):
//   #/                          home — all mixes (sortable)
//   #/playlists                 just the playlists
//   #/playlists/tag/<tag>       playlists whose mixes carry a tag
//   #/playlists/creator/<name>  playlists by a creator
//   #/playlist/<slug>           one playlist by its id/slug (in-app, with a back link)
//   #/mix/<slug>                one mix by its id/slug (in-app, with a back link)
//   #/tag/<tag>                 mixes carrying a tag
//   #/artist/<name>             mixes by an artist (the "user" page)
//   #/tracks                    unique tracks across all mixes (searchable)
//   #/tracks/letter/<letter>    tracks whose artist starts with a letter (a–z, 'other')
//   #/track/<slug>              one track + its buy link + every mix containing it
//
// Query param: ?tracklist=open renders every player with its tracklist open.
// ---------------------------------------------------------------------
export const _params = new URLSearchParams(location.search);
// R2 base for ?user= — explicit OFFGRID_R2_BASE, else derived from the
// configured manifest URL by stripping the /data/manifest.json suffix.
export const _r2Base = window.OFFGRID_R2_BASE
  || (window.OFFGRID_MANIFEST_URL || '').replace(/\/data\/manifest\.json$/, '');
export const _userId = _params.get('user');
export const _mixId = _params.get('mix'); // optional: show just this one mix
// ?tracklist=open|1|true → render every player with its tracklist expanded
export const _openTracklist = ['open', '1', 'true'].includes((_params.get('tracklist') || '').toLowerCase());
export const MANIFEST_URL =
  _params.get('manifest')
  || (_userId && _r2Base ? `${_r2Base}/users/${encodeURIComponent(_userId)}/data/manifest.json` : '')
  || window.OFFGRID_MANIFEST_URL
  || 'https://pub-xxxxxxxx.r2.dev/data/manifest.json';
