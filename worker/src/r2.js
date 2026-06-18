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

/**
 * Generate a presigned PUT URL for direct browser upload to R2.
 *
 * Request body: { key: "audio/my-mix.mp3", contentType: "audio/mpeg" }
 * Response: { url, key }   // key is the scoped "users/<id>/audio/my-mix.mp3"
 */
export async function handlePresign(request, env, user) {
  const { key, contentType } = await request.json();
  if (!key) {
    return jsonResponse({ error: 'Missing key' }, 400);
  }

  const ownerId = await resolveOwnerId(env.DB, user);
  const safeKey = scopeKey(key, ownerId);
  if (!safeKey) {
    return jsonResponse({ error: 'Invalid key' }, 400);
  }

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
  const safeKey = scopeKey(key, ownerId);
  if (!safeKey) {
    return jsonResponse({ error: 'Invalid key' }, 400);
  }

  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

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
