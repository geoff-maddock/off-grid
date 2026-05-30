/**
 * R2 storage operations — upload via presigned URLs, list, delete.
 */

import { AwsClient } from './aws-sign.js';

/**
 * Generate a presigned PUT URL for direct browser upload to R2.
 *
 * Request body: { key: "audio/my-mix.mp3", contentType: "audio/mpeg" }
 * Response: { url: "https://...", key: "audio/my-mix.mp3" }
 */
export async function handlePresign(request, env) {
  const { key, contentType } = await request.json();

  if (!key) {
    return jsonResponse({ error: 'Missing key' }, 400);
  }

  // Sanitize key — only allow alphanumeric, hyphens, underscores, dots, and slashes
  const safeKey = key.replace(/[^a-zA-Z0-9\-_./]/g, '');
  if (safeKey !== key || key.includes('..')) {
    return jsonResponse({ error: 'Invalid key' }, 400);
  }

  // Use the R2 binding to generate a presigned URL
  // Workers R2 doesn't have native presigned URL support,
  // so we use the S3-compatible API with AWS Signature V4
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
 * List objects in the R2 bucket.
 *
 * Query params: ?prefix=audio/&limit=100
 * Response: { objects: [{ key, size, uploaded }], truncated, cursor }
 */
export async function handleListFiles(request, env) {
  const url = new URL(request.url);
  const prefix = url.searchParams.get('prefix') || '';
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
 * Delete an object from R2.
 *
 * DELETE /files/:key
 */
export async function handleDeleteFile(key, env) {
  if (!key) {
    return jsonResponse({ error: 'Missing key' }, 400);
  }

  await env.BUCKET.delete(key);
  return jsonResponse({ deleted: key });
}

/**
 * Upload a file directly through the Worker (for small files < 100MB).
 * For larger files, use presigned URLs instead.
 *
 * POST /upload with file in request body
 * Headers: X-File-Key: audio/my-mix.mp3
 */
export async function handleDirectUpload(request, env) {
  const key = request.headers.get('X-File-Key');
  if (!key) {
    return jsonResponse({ error: 'Missing X-File-Key header' }, 400);
  }

  const safeKey = key.replace(/[^a-zA-Z0-9\-_./]/g, '');
  if (safeKey !== key || key.includes('..')) {
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
