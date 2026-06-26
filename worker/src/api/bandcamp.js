/**
 * Bandcamp embed resolver — public, unauthenticated.
 *
 *   GET /api/bandcamp-embed?url=<bandcamp page url>
 *
 * A track's stored `url` is a Bandcamp *page* URL (e.g.
 * https://artist.bandcamp.com/track/foo). Bandcamp's embedded player iframe,
 * however, needs the numeric track/album id (…/EmbeddedPlayer/track=NNN/…),
 * which isn't in that URL and can't be fetched from the browser (CORS). This
 * endpoint fetches the page server-side, extracts the embed URL from its
 * <meta property="og:video"> tag, caches the result, and returns it as JSON so
 * the static public player can render the iframe.
 *
 * SSRF guard: only http(s) URLs on bandcamp.com / *.bandcamp.com are fetched —
 * the worker must never act as an open proxy.
 */

const CACHE_TTL = 86400; // 1 day

export async function handleBandcampEmbed(request, env) {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get('url');

  const parsed = parseBandcampUrl(target);
  if (!parsed) {
    return jsonResponse({ error: 'A valid bandcamp.com url is required' }, 400);
  }

  // Cache by the normalized target URL (so different query strings on the
  // request don't fragment the cache).
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.local/bandcamp-embed?url=${encodeURIComponent(parsed.href)}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let embed;
  try {
    embed = await resolveEmbed(parsed.href);
  } catch (err) {
    console.error('bandcamp-embed fetch failed:', err);
    return jsonResponse({ error: 'Could not reach Bandcamp' }, 502);
  }

  if (!embed) {
    return jsonResponse({ error: 'No embed found for this url' }, 404);
  }

  const response = jsonResponse(embed, 200, {
    'Cache-Control': `public, max-age=${CACHE_TTL}`,
  });
  // Store a clone for subsequent hits (waitUntil isn't available here, so just
  // await — the put is cheap and the page is already fetched).
  await cache.put(cacheKey, response.clone());
  return response;
}

/** Return { href } for an allowed Bandcamp URL, or null. */
function parseBandcampUrl(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'bandcamp.com' && !host.endsWith('.bandcamp.com')) return null;
  return { href: u.href };
}

/** Fetch the page and pull the embed URL + numeric id out of its HTML. */
async function resolveEmbed(href) {
  const resp = await fetch(href, {
    headers: { 'User-Agent': 'offgrid-audio/1.0 (+bandcamp-embed)' },
    redirect: 'follow',
  });
  if (!resp.ok) return null;
  const html = await resp.text();

  // Preferred: the og:video meta points straight at the EmbeddedPlayer URL.
  let embedUrl =
    matchMeta(html, 'property', 'og:video') ||
    matchMeta(html, 'name', 'twitter:player');

  // Fallback: any EmbeddedPlayer URL embedded in the page markup.
  if (!embedUrl) {
    const m = html.match(/https?:\/\/bandcamp\.com\/EmbeddedPlayer\/[^\s"'<>]+/i);
    if (m) embedUrl = m[0];
  }
  if (!embedUrl) return null;

  embedUrl = decodeEntities(embedUrl);
  const idMatch = embedUrl.match(/\b(track|album)=(\d+)/i);
  return {
    embedUrl,
    kind: idMatch ? idMatch[1].toLowerCase() : null,
    id: idMatch ? idMatch[2] : null,
  };
}

/** Extract a <meta {attr}="{value}" content="…"> value, attribute order agnostic. */
function matchMeta(html, attr, value) {
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+${attr}=["']${esc}["'][^>]*content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*${attr}=["']${esc}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&quot;/g, '"');
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
