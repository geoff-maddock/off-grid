/**
 * Manifest generation and publish-to-R2 handler.
 */

import { generateManifest, resolveOwnerId, getOwnerUserId } from '../db.js';

export async function handleManifest(request, env, path, method, user) {
  const db = env.DB;
  const ownerId = await resolveOwnerId(db, user); // publish/return only this owner's content

  // GET /api/manifest — generate and return manifest JSON for the current owner
  if (method === 'GET' && path === '/api/manifest') {
    const manifest = await generateManifest(db, ownerId);
    return jsonResponse(manifest);
  }

  // POST /api/manifest/publish — write the owner's manifest to R2
  if (method === 'POST' && path === '/api/manifest/publish') {
    if (!ownerId) return jsonResponse({ error: 'No owner could be resolved for this session' }, 400);

    const manifest = await generateManifest(db, ownerId);
    const json = JSON.stringify(manifest, null, 2);
    const opts = { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' } };

    // Per-user manifest — this is the URL each user embeds.
    const manifestKey = `users/${ownerId}/data/manifest.json`;
    await env.BUCKET.put(manifestKey, json, opts);

    // The instance owner also writes the legacy path so existing embeds that
    // point at data/manifest.json keep working unchanged.
    const isOwner = ownerId === (await getOwnerUserId(db));
    if (isOwner) await env.BUCKET.put('data/manifest.json', json, opts);

    return jsonResponse({
      published: true,
      manifestKey,
      legacyManifest: isOwner,
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
