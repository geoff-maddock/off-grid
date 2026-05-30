/**
 * Manifest generation and publish-to-R2 handler.
 */

import { generateManifest } from '../db.js';

export async function handleManifest(request, env, path, method) {
  const db = env.DB;

  // GET /api/manifest — generate and return manifest JSON
  if (method === 'GET' && path === '/api/manifest') {
    const manifest = await generateManifest(db);
    return jsonResponse(manifest);
  }

  // POST /api/manifest/publish — generate manifest and write to R2
  if (method === 'POST' && path === '/api/manifest/publish') {
    const manifest = await generateManifest(db);
    const json = JSON.stringify(manifest, null, 2);

    // Write to R2 as a static file
    await env.BUCKET.put('data/manifest.json', json, {
      httpMetadata: {
        contentType: 'application/json',
        cacheControl: 'public, max-age=60',
      },
    });

    return jsonResponse({
      published: true,
      mixCount: manifest.mixes.length,
      playlistCount: manifest.playlists.length,
    });
  }

  return null; // Not handled
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
