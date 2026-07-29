import { state, trackLetterOf } from './state.js';

// ---- SEO: per-view meta tags + JSON-LD ------------------------------
// Canonical/absolute-URL base: an explicit window.OFFGRID_SITE_URL (set in
// config.local.js) pins the real public domain; otherwise we derive it from
// wherever the page is being served.
const SITE_BASE = (window.OFFGRID_SITE_URL || (location.origin + location.pathname)).replace(/\/+$/, '');
// Static share pages (generate-share-pages.mjs) are opt-in: when
// OFFGRID_SHARE_BASE is set, mix canonicals point at <base>/<slug>/;
// otherwise they fall back to the ?mix= single-mix page.
const SHARE_BASE = (window.OFFGRID_SHARE_BASE || '').replace(/\/+$/, '');
function siteUrl(suffix) { return SITE_BASE + (suffix || ''); }
function mixPageUrl(id) {
  return SHARE_BASE ? SHARE_BASE + '/' + encodeURIComponent(id) + '/'
    : siteUrl('?mix=' + encodeURIComponent(id));
}
// Playlist share pages sit beside the mix ones (<base>/playlist/<slug>/),
// derived from the conventional .../mix SHARE_BASE. Hash-route fallback when
// share pages aren't generated.
const PLAYLIST_SHARE_BASE = /\/mix$/.test(SHARE_BASE) ? SHARE_BASE.replace(/\/mix$/, '/playlist') : '';
function playlistPageUrl(id) {
  return PLAYLIST_SHARE_BASE ? PLAYLIST_SHARE_BASE + '/' + encodeURIComponent(id) + '/'
    : siteUrl('#/playlist/' + encodeURIComponent(id));
}
// The chrome-less single-mix page — what an iframe embed should load.
function mixEmbedUrl(id) { return siteUrl('?mix=' + encodeURIComponent(id)); }

function _abs(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  try { return new URL(u, SITE_BASE).href; } catch (e) { return u; }
}
// Seconds → ISO 8601 duration (PT#H#M#S); '' when unknown/zero.
function _isoDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec <= 0) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (s ? s + 'S' : '');
}
function _encFmt(src) {
  const ext = (src || '').split('?')[0].split('#')[0].split('.').pop().toLowerCase();
  return { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/opus' }[ext] || '';
}

function _setMeta(attr, key, content) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!content) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.setAttribute('content', content);
}
function _setCanonical(url) {
  let el = document.head.querySelector('link[rel="canonical"]');
  if (!el) { el = document.createElement('link'); el.setAttribute('rel', 'canonical'); document.head.appendChild(el); }
  el.setAttribute('href', url);
}
function _setJsonLd(obj) {
  let el = document.getElementById('ld-json');
  if (!el) { el = document.createElement('script'); el.type = 'application/ld+json'; el.id = 'ld-json'; document.head.appendChild(el); }
  el.textContent = obj ? JSON.stringify(obj, null, 2) : '';
}

// ---- JSON-LD builders ----
function mixRef(m) {
  const o = { '@type': 'MusicRecording', name: m.title, url: mixPageUrl(m.id) };
  if (m.artist) o.byArtist = { '@type': 'MusicGroup', name: m.artist };
  if (m.thumb) o.image = _abs(m.thumb);
  return o;
}
// Full MusicRecording for a single mix: AudioObject embed + ItemList tracklist.
function mixJsonLd(mix) {
  const page = mixPageUrl(mix.id);
  const o = { '@context': 'https://schema.org', '@type': 'MusicRecording', '@id': page + '#mix', name: mix.title, url: page };
  if (mix.artist) o.byArtist = { '@type': 'MusicGroup', name: mix.artist };
  if (mix.releaseDate) o.datePublished = mix.releaseDate;
  const dur = _isoDuration(mix.duration);
  if (dur) o.duration = dur;
  if (mix.tags && mix.tags.length) o.genre = mix.tags;
  if (mix.thumb) o.image = _abs(mix.thumb);
  if (mix.description) o.description = mix.description;
  if (mix.src) {
    const audio = { '@type': 'AudioObject', contentUrl: _abs(mix.src), embedUrl: mixEmbedUrl(mix.id) };
    const fmt = _encFmt(mix.src); if (fmt) audio.encodingFormat = fmt;
    if (dur) audio.duration = dur;
    o.audio = audio;
  }
  const tracks = mix.tracks || [];
  if (tracks.length) {
    o.track = {
      '@type': 'ItemList', numberOfItems: tracks.length,
      itemListElement: tracks.map((t, i) => {
        const rec = { '@type': 'MusicRecording', name: t.title || 'Untitled' };
        if (t.artist) rec.byArtist = { '@type': 'MusicGroup', name: t.artist };
        if (/^https?:\/\//i.test(t.url || '')) rec.url = t.url;
        return { '@type': 'ListItem', position: i + 1, item: rec };
      }),
    };
  }
  return o;
}
function trackJsonLd(t, mixes, page) {
  const o = { '@context': 'https://schema.org', '@type': 'MusicRecording', '@id': page + '#track',
    name: t.title || 'Untitled', url: /^https?:\/\//i.test(t.url || '') ? t.url : page };
  if (t.artist) o.byArtist = { '@type': 'MusicGroup', name: t.artist };
  if (mixes.length) o.isPartOf = mixes.map(m => ({ '@type': 'MusicRecording', name: m.title, url: mixPageUrl(m.id) }));
  return o;
}
function collectionJsonLd(name, url, description, mixes) {
  return { '@context': 'https://schema.org', '@type': 'CollectionPage', name, url,
    ...(description ? { description } : {}),
    mainEntity: { '@type': 'ItemList', numberOfItems: mixes.length,
      itemListElement: mixes.map((m, i) => ({ '@type': 'ListItem', position: i + 1, item: mixRef(m) })) } };
}
function artistJsonLd(name, url, mixes) {
  const o = { '@context': 'https://schema.org', '@type': 'MusicGroup', '@id': url + '#artist', name, url };
  if (mixes.length) o.track = mixes.map(mixRef);
  return o;
}
function tracksJsonLd(tracks, url, description) {
  return { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Tracks', url, description,
    mainEntity: { '@type': 'ItemList', numberOfItems: tracks.length,
      itemListElement: tracks.map((t, i) => {
        const rec = { '@type': 'MusicRecording', name: t.title || 'Untitled', url: siteUrl('#/track/' + encodeURIComponent(t.slug)) };
        if (t.artist) rec.byArtist = { '@type': 'MusicGroup', name: t.artist };
        return { '@type': 'ListItem', position: i + 1, item: rec };
      }) } };
}
function playlistsJsonLd(playlists, url, description) {
  return { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Playlists', url, description,
    mainEntity: { '@type': 'ItemList', numberOfItems: playlists.length,
      itemListElement: playlists.map((pl, i) => ({ '@type': 'ListItem', position: i + 1,
        item: { '@type': 'MusicPlaylist', name: pl.title, numTracks: (pl.mixIds || []).length,
          ...(pl.creator ? { author: { '@type': 'MusicGroup', name: pl.creator } } : {}) } })) } };
}

function playlistJsonLd(pl, url, description) {
  const tracks = (pl.mixIds || []).map(id => state.mixMap.get(id)).filter(Boolean);
  const o = { '@context': 'https://schema.org', '@type': 'MusicPlaylist', '@id': url + '#playlist',
    name: pl.title, url, description, numTracks: tracks.length };
  if (pl.creator) o.author = { '@type': 'MusicGroup', name: pl.creator };
  const image = pl.thumb || (tracks.find(m => m.thumb) || {}).thumb;
  if (image) o.image = _abs(image);
  if (tracks.length) o.track = tracks.map(mixRef);
  return o;
}

function applySEO(d, siteName) {
  document.title = d.title;
  _setMeta('name', 'description', d.description);
  _setCanonical(d.canonical);
  _setMeta('property', 'og:site_name', siteName);
  _setMeta('property', 'og:title', d.title);
  _setMeta('property', 'og:description', d.description);
  _setMeta('property', 'og:type', d.ogType || 'website');
  _setMeta('property', 'og:url', d.canonical);
  _setMeta('property', 'og:image', d.image);
  _setMeta('property', 'og:audio', d.audioUrl);
  _setMeta('property', 'og:audio:type', d.audioUrl ? d.audioType : '');
  // og:video (the Discord inline-player mp4) is deliberately static-share-
  // page-only: scrapers that would use it never run this JS, and emitting a
  // guessed video/<slug>.mp4 URL here without an existence check would point
  // JS-running crawlers at 404s. See generate-share-pages.mjs.
  // Twitter player card needs both an embed URL and an image; otherwise
  // fall back to a plain summary card.
  const player = d.embed && d.image ? d.embed : '';
  _setMeta('name', 'twitter:card', player ? 'player' : 'summary');
  _setMeta('name', 'twitter:title', d.title);
  _setMeta('name', 'twitter:description', d.description);
  _setMeta('name', 'twitter:image', d.image);
  _setMeta('name', 'twitter:player', player);
  _setMeta('name', 'twitter:player:width', player ? '500' : '');
  _setMeta('name', 'twitter:player:height', player ? '260' : '');
  _setJsonLd(d.jsonld);
}

// Derive the descriptor for the current route and apply it.
export function updateSEO(r) {
  const siteName = state.site.title || 'Off Grid';
  const tagline = state.site.tagline || 'Self hosted embedded audio player for DJ mixes and playlists.';
  const firstThumb = (list) => { const m = list.find(x => x && x.thumb); return m ? _abs(m.thumb) : ''; };
  let title, description, ogType = 'website', image = '', canonical = siteUrl(), jsonld = null;
  let audioUrl = '', audioType = '', embed = '';

  if (r.view === 'mix') {
    const mix = state.mixMap.get(r.arg);
    if (mix) {
      const who = mix.artist ? ` by ${mix.artist}` : '';
      title = `${mix.title}${who} — ${siteName}`;
      description = mix.description || `${mix.title}${who}.`;
      ogType = 'music.song';
      image = mix.thumb ? _abs(mix.thumb) : '';
      canonical = mixPageUrl(mix.id);
      jsonld = mixJsonLd(mix);
      audioUrl = mix.src ? _abs(mix.src) : '';
      audioType = _encFmt(mix.src);
      embed = audioUrl ? mixEmbedUrl(mix.id) : '';
    } else { title = `Mix not found — ${siteName}`; description = tagline; }
  } else if (r.view === 'track') {
    const t = state.trackIndex.get(r.arg);
    if (t) {
      const mixes = [...t.mixIds].map(id => state.mixMap.get(id)).filter(Boolean);
      const who = t.artist ? ` by ${t.artist}` : '';
      title = `${t.title || 'Untitled'}${who} — ${siteName}`;
      description = `${t.title || 'Untitled'}${who}, featured in ${mixes.length} mix${mixes.length === 1 ? '' : 'es'}.`;
      ogType = 'music.song';
      image = firstThumb(mixes);
      canonical = siteUrl('#/track/' + encodeURIComponent(t.slug));
      jsonld = trackJsonLd(t, mixes, canonical);
    } else { title = `Track not found — ${siteName}`; description = tagline; }
  } else if (r.view === 'tag') {
    const mixes = state.tagIndex.get(r.arg) || [];
    title = `Tag: ${r.arg} — ${siteName}`;
    description = `Mixes tagged “${r.arg}” (${mixes.length}).`;
    canonical = siteUrl('#/tag/' + encodeURIComponent(r.arg));
    image = firstThumb(mixes);
    jsonld = collectionJsonLd(`Tag: ${r.arg}`, canonical, description, mixes);
  } else if (r.view === 'artist') {
    const mixes = state.artistIndex.get(r.arg) || [];
    title = `${r.arg} — ${siteName}`;
    description = `Mixes by ${r.arg} (${mixes.length}).`;
    ogType = 'profile';
    canonical = siteUrl('#/artist/' + encodeURIComponent(r.arg));
    image = firstThumb(mixes);
    jsonld = artistJsonLd(r.arg, canonical, mixes);
  } else if (r.view === 'tracks') {
    let tracks = [...state.trackIndex.values()];
    if (r.letter) {
      tracks = tracks.filter(t => trackLetterOf(t) === r.letter);
      const label = r.letter === 'other' ? '#' : r.letter.toUpperCase();
      title = `Tracks: artists ${label} — ${siteName}`;
      description = `Tracks by artists under ${label} (${tracks.length}).`;
      canonical = siteUrl('#/tracks/letter/' + r.letter);
    } else {
      title = `Tracks — ${siteName}`;
      description = `Every track across the mixes (${tracks.length}).`;
      canonical = siteUrl('#/tracks');
    }
    jsonld = tracksJsonLd(tracks, canonical, description);
  } else if (r.view === 'playlists') {
    let playlists = state.playlists;
    if (r.tag) {
      playlists = state.playlistTagIndex.get(r.tag) || [];
      title = `Playlists tagged ${r.tag} — ${siteName}`;
      description = `Playlists with ${r.tag} mixes (${playlists.length}).`;
      canonical = siteUrl('#/playlists/tag/' + encodeURIComponent(r.tag));
    } else if (r.creator) {
      playlists = state.creatorIndex.get(r.creator) || [];
      title = `Playlists by ${r.creator} — ${siteName}`;
      description = `Playlists by ${r.creator} (${playlists.length}).`;
      canonical = siteUrl('#/playlists/creator/' + encodeURIComponent(r.creator));
    } else {
      title = `Playlists — ${siteName}`;
      description = `Playlists in this library (${state.playlists.length}).`;
      canonical = siteUrl('#/playlists');
    }
    jsonld = playlistsJsonLd(playlists, canonical, description);
  } else if (r.view === 'playlist') {
    const pl = state.playlists.find(p => p.id === r.arg);
    canonical = siteUrl('#/playlist/' + encodeURIComponent(r.arg));
    if (pl) {
      const who = pl.creator ? ` by ${pl.creator}` : '';
      title = `${pl.title}${who} — ${siteName}`;
      description = pl.description || `${pl.title} — a playlist of ${(pl.mixIds || []).length} mixes.`;
      ogType = 'music.playlist';
      canonical = playlistPageUrl(pl.id);
      image = pl.thumb ? _abs(pl.thumb)
        : firstThumb((pl.mixIds || []).map(id => state.mixMap.get(id)).filter(Boolean));
      jsonld = playlistJsonLd(pl, canonical, description);
    } else { title = `Playlist not found — ${siteName}`; description = tagline; }
  } else { // home
    title = `${siteName} — Mixes`;
    description = tagline;
    canonical = siteUrl();
    image = firstThumb(state.mixes);
    jsonld = collectionJsonLd(siteName, canonical, description, state.mixes);
  }
  applySEO({ title, description, ogType, image, canonical, jsonld, audioUrl, audioType, embed }, siteName);
}
