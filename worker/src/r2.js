/**
 * R2 storage operations — upload via presigned URLs, list, delete.
 *
 * Every object key is namespaced under the caller's `users/<ownerId>/` prefix,
 * so users can't collide with or reach each other's files.
 */

import { AwsClient } from './aws-sign.js';
import { resolveOwnerId } from './db.js';

// Force a client-supplied key under the owner's namespace. Returns the scoped
// key, or null if the key is malformed or targets another user's space.
function scopeKey(key, ownerId) {
  if (!ownerId) return null;
  const k = String(key).replace(/^\/+/, '');
  if (!k || k.includes('..') || !/^[a-zA-Z0-9\-_./]+$/.test(k)) return null;

  const base = `users/${ownerId}/`;
  if (k.startsWith(base)) return k;        // already correctly scoped
  if (k.startsWith('users/')) return null; // attempt to target another user
  return base + k;                         // prepend the owner's namespace
}

// Per-prefix upload rules: what may live under each users/<id>/<prefix>/.
// Extensions are the primary gate (browsers report unreliable MIME types for
// some audio containers); content types are checked against a pattern with an
// octet-stream fallback allowed only where noted.
const UPLOAD_RULES = {
  audio: {
    exts: ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'webm'],
    types: /^(audio\/|video\/(mp4|webm)$|application\/(ogg|octet-stream)$)/,
    maxBytes: 500 * 1024 * 1024,
  },
  covers: {
    exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'],
    types: /^image\//,
    maxBytes: 10 * 1024 * 1024,
  },
  peaks: {
    exts: ['json'],
    types: /^application\/json$/,
    maxBytes: 5 * 1024 * 1024,
  },
};

// Validate a scoped key (users/<id>/<prefix>/<name>) plus declared content
// type and size against the prefix's rules. Returns an error string or null.
// Exported for testing.
export function validateUpload(scopedKey, contentType, size) {
  const parts = scopedKey.split('/');
  const prefix = parts[2];
  const name = parts.slice(3).join('/');
  const rules = UPLOAD_RULES[prefix];
  if (!rules || !name) {
    return `Uploads must go under one of: ${Object.keys(UPLOAD_RULES).join('/, ')}/`;
  }
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!rules.exts.includes(ext)) {
    return `File type .${ext || '(none)'} is not allowed under ${prefix}/`;
  }
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!rules.types.test(ct)) {
    return `Content type "${ct || 'unknown'}" is not allowed under ${prefix}/`;
  }
  if (Number.isFinite(size) && size > rules.maxBytes) {
    return `File too large for ${prefix}/ (max ${Math.round(rules.maxBytes / (1024 * 1024))} MB)`;
  }
  return null;
}

// Insert a short random suffix before the extension so two uploads with the
// same filename never overwrite each other. Exported for testing.
export function uniqueKey(key) {
  const suffix = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const slash = key.lastIndexOf('/');
  const dir = key.slice(0, slash + 1);
  const name = key.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0
    ? `${dir}${name.slice(0, dot)}-${suffix}${name.slice(dot)}`
    : `${dir}${name}-${suffix}`;
}

/**
 * Generate a presigned PUT URL for direct browser upload to R2.
 *
 * Request body: { key: "audio/my-mix.mp3", contentType: "audio/mpeg" }
 * Response: { url, key }   // key is the scoped "users/<id>/audio/my-mix.mp3"
 */
export async function handlePresign(request, env, user) {
  const { key, contentType, size } = await request.json();
  if (!key) {
    return jsonResponse({ error: 'Missing key' }, 400);
  }

  const ownerId = await resolveOwnerId(env.DB, user);
  const scoped = scopeKey(key, ownerId);
  if (!scoped) {
    return jsonResponse({ error: 'Invalid key' }, 400);
  }
  // Size here is client-declared (presigned PUTs sign only the host header),
  // so this is a sanity check, not enforcement — see #44.
  const invalid = validateUpload(scoped, contentType, Number(size));
  if (invalid) {
    return jsonResponse({ error: invalid }, 400);
  }
  const safeKey = uniqueKey(scoped);

  const accountId = env.CF_ACCOUNT_ID || '';
  const accessKeyId = env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || '';

  if (!accessKeyId || !secretAccessKey || !accountId) {
    return jsonResponse({ error: 'R2 credentials not configured. Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and CF_ACCOUNT_ID as secrets.' }, 500);
  }

  const bucketName = env.R2_BUCKET_NAME || 'offgrid-media';
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const url = `${endpoint}/${bucketName}/${safeKey}`;

  const aws = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  const expiresIn = 3600; // 1 hour
  const presignedUrl = await aws.sign(url, {
    method: 'PUT',
    headers: contentType ? { 'Content-Type': contentType } : {},
    aws: { signQuery: true, expiresIn },
  });

  return jsonResponse({
    url: presignedUrl.url,
    key: safeKey,
  });
}

/**
 * List objects under the caller's namespace.
 * Query params: ?prefix=audio/&limit=100  (clamped to users/<id>/)
 */
export async function handleListFiles(request, env, user) {
  const ownerId = await resolveOwnerId(env.DB, user);
  if (!ownerId) {
    return jsonResponse({ objects: [], truncated: false, cursor: null });
  }
  const base = `users/${ownerId}/`;

  const url = new URL(request.url);
  const requested = (url.searchParams.get('prefix') || '').replace(/^\/+/, '');
  const prefix = requested.startsWith(base) ? requested : base + requested;
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 1000);
  const cursor = url.searchParams.get('cursor') || undefined;

  const listed = await env.BUCKET.list({ prefix, limit, cursor });

  return jsonResponse({
    objects: listed.objects.map(obj => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
    })),
    truncated: listed.truncated,
    cursor: listed.truncated ? listed.cursor : null,
  });
}

/**
 * Delete an object from R2 — only within the caller's namespace.
 * DELETE /files/:key
 */
export async function handleDeleteFile(key, env, user) {
  if (!key) {
    return jsonResponse({ error: 'Missing key' }, 400);
  }
  const ownerId = await resolveOwnerId(env.DB, user);
  if (!ownerId || !key.startsWith(`users/${ownerId}/`)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  await env.BUCKET.delete(key);
  return jsonResponse({ deleted: key });
}

/**
 * Upload a file directly through the Worker (for small files < 100MB).
 * POST /upload with file in body; Header: X-File-Key: audio/my-mix.mp3
 * Returns the scoped key.
 */
export async function handleDirectUpload(request, env, user) {
  const key = request.headers.get('X-File-Key');
  if (!key) {
    return jsonResponse({ error: 'Missing X-File-Key header' }, 400);
  }

  const ownerId = await resolveOwnerId(env.DB, user);
  const scoped = scopeKey(key, ownerId);
  if (!scoped) {
    return jsonResponse({ error: 'Invalid key' }, 400);
  }

  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
  const declaredSize = Number(request.headers.get('Content-Length'));
  const invalid = validateUpload(scoped, contentType, declaredSize);
  if (invalid) {
    return jsonResponse({ error: invalid }, 400);
  }
  const safeKey = uniqueKey(scoped);

  await env.BUCKET.put(safeKey, request.body, {
    httpMetadata: { contentType },
  });

  return jsonResponse({ key: safeKey, contentType });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
