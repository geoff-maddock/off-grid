/**
 * Playlist CRUD API handlers
 */

import {
  listPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist,
  addMixToPlaylist, removeMixFromPlaylist, resolveOwnerId, markDirty
} from '../db.js';
import { cleanupDeletedFiles } from '../r2.js';
import { pageParams } from './mixes.js';

export async function handlePlaylists(request, env, path, method, user) {
  const db = env.DB;
  const ownerId = await resolveOwnerId(db, user); // scope all reads/writes to this owner

  // GET /api/playlists
  if (method === 'GET' && path === '/api/playlists') {
    const playlists = await listPlaylists(db, ownerId, pageParams(new URL(request.url)));
    return jsonResponse(playlists);
  }

  // Playlist by ID routes
  const plMatch = path.match(/^\/api\/playlists\/([^/]+)$/);
  const plMixMatch = path.match(/^\/api\/playlists\/([^/]+)\/mixes$/);
  const plMixDelMatch = path.match(/^\/api\/playlists\/([^/]+)\/mixes\/([^/]+)$/);

  // GET /api/playlists/:id
  if (method === 'GET' && plMatch) {
    const pl = await getPlaylist(db, decodeURIComponent(plMatch[1]), ownerId);
    if (!pl) return jsonResponse({ error: 'Playlist not found' }, 404);
    return jsonResponse(pl);
  }

  // POST /api/playlists
  if (method === 'POST' && path === '/api/playlists') {
    const body = await request.json();
    if (!body.id || !body.title) {
      return jsonResponse({ error: 'id and title are required' }, 400);
    }
    const existing = await getPlaylist(db, body.id); // IDs globally unique in this phase
    if (existing) {
      return jsonResponse({ error: 'Playlist with this ID already exists' }, 409);
    }
    const pl = await createPlaylist(db, { ...body, ownerId });
    await markDirty(db, ownerId);
    return jsonResponse(pl, 201);
  }

  // PUT /api/playlists/:id
  if (method === 'PUT' && plMatch) {
    const id = decodeURIComponent(plMatch[1]);
    const existing = await getPlaylist(db, id, ownerId); // 404 if not yours
    if (!existing) return jsonResponse({ error: 'Playlist not found' }, 404);
    const body = await request.json();
    if (!body.title) {
      return jsonResponse({ error: 'title is required' }, 400);
    }
    const pl = await updatePlaylist(db, id, body);
    await markDirty(db, ownerId);
    return jsonResponse(pl);
  }

  // DELETE /api/playlists/:id
  if (method === 'DELETE' && plMatch) {
    const id = decodeURIComponent(plMatch[1]);
    const existing = await getPlaylist(db, id, ownerId); // 404 if not yours
    if (!existing) return jsonResponse({ error: 'Playlist not found' }, 404);
    await deletePlaylist(db, id);
    // Best-effort cover cleanup once the row is gone (see cleanupDeletedFiles).
    await cleanupDeletedFiles(env, db, ownerId, [existing.thumb]);
    await markDirty(db, ownerId);
    return jsonResponse({ deleted: id });
  }

  // POST /api/playlists/:id/mixes — add a mix to playlist
  if (method === 'POST' && plMixMatch) {
    const playlistId = decodeURIComponent(plMixMatch[1]);
    if (!(await getPlaylist(db, playlistId, ownerId))) return jsonResponse({ error: 'Playlist not found' }, 404);
    const body = await request.json();
    if (!body.mixId) {
      return jsonResponse({ error: 'mixId is required' }, 400);
    }
    await addMixToPlaylist(db, playlistId, body.mixId);
    await markDirty(db, ownerId);
    const pl = await getPlaylist(db, playlistId, ownerId);
    return jsonResponse(pl);
  }

  // DELETE /api/playlists/:id/mixes/:mixId — remove a mix from playlist
  if (method === 'DELETE' && plMixDelMatch) {
    const playlistId = decodeURIComponent(plMixDelMatch[1]);
    if (!(await getPlaylist(db, playlistId, ownerId))) return jsonResponse({ error: 'Playlist not found' }, 404);
    const mixId = decodeURIComponent(plMixDelMatch[2]);
    await removeMixFromPlaylist(db, playlistId, mixId);
    await markDirty(db, ownerId);
    const pl = await getPlaylist(db, playlistId, ownerId);
    return jsonResponse(pl);
  }

  return null; // Not handled
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
