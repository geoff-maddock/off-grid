/**
 * Mix CRUD API handlers
 */

import { listMixes, getMix, createMix, updateMix, deleteMix, resolveOwnerId } from '../db.js';
import { cleanupDeletedFiles } from '../r2.js';

// Optional ?limit= / ?offset= for list endpoints (omitted → everything, so
// existing clients and manifest generation are unaffected). Exported for reuse.
export function pageParams(url) {
  const limit = parseInt(url.searchParams.get('limit'), 10);
  const offset = parseInt(url.searchParams.get('offset'), 10);
  const out = {};
  if (Number.isFinite(limit) && limit > 0) out.limit = Math.min(limit, 1000);
  if (Number.isFinite(offset) && offset >= 0) out.offset = offset;
  return out;
}

export async function handleMixes(request, env, path, method, user) {
  const db = env.DB;
  const ownerId = await resolveOwnerId(db, user); // scope all reads/writes to this owner

  // GET /api/mixes
  if (method === 'GET' && path === '/api/mixes') {
    const url = new URL(request.url);
    const mixes = await listMixes(db, {
      tag: url.searchParams.get('tag'),
      artist: url.searchParams.get('artist'),
      sort: url.searchParams.get('sort'),
      dir: url.searchParams.get('dir'),
      ownerId,
      ...pageParams(url),
    });
    return jsonResponse(mixes);
  }

  // GET /api/mixes/:id
  const mixMatch = path.match(/^\/api\/mixes\/([^/]+)$/);
  if (method === 'GET' && mixMatch) {
    const mix = await getMix(db, decodeURIComponent(mixMatch[1]), ownerId);
    if (!mix) return jsonResponse({ error: 'Mix not found' }, 404);
    return jsonResponse(mix);
  }

  // POST /api/mixes
  if (method === 'POST' && path === '/api/mixes') {
    const body = await request.json();
    if (!body.id || !body.title || !body.src) {
      return jsonResponse({ error: 'id, title, and src are required' }, 400);
    }
    // IDs are globally unique in this phase.
    const existing = await getMix(db, body.id);
    if (existing) {
      return jsonResponse({ error: 'Mix with this ID already exists' }, 409);
    }
    const mix = await createMix(db, { ...body, ownerId });
    return jsonResponse(mix, 201);
  }

  // PUT /api/mixes/:id
  if (method === 'PUT' && mixMatch) {
    const id = decodeURIComponent(mixMatch[1]);
    const existing = await getMix(db, id, ownerId); // 404 if not yours
    if (!existing) return jsonResponse({ error: 'Mix not found' }, 404);
    const body = await request.json();
    if (!body.title || !body.src) {
      return jsonResponse({ error: 'title and src are required' }, 400);
    }
    const mix = await updateMix(db, id, body);
    return jsonResponse(mix);
  }

  // DELETE /api/mixes/:id
  if (method === 'DELETE' && mixMatch) {
    const id = decodeURIComponent(mixMatch[1]);
    const existing = await getMix(db, id, ownerId); // 404 if not yours
    if (!existing) return jsonResponse({ error: 'Mix not found' }, 404);
    await deleteMix(db, id);
    // After the row is gone: remove its files from R2 unless another record
    // still references them (best-effort, owner-scoped — see cleanupDeletedFiles).
    await cleanupDeletedFiles(env, db, ownerId, [existing.src, existing.thumb, existing.peaks]);
    return jsonResponse({ deleted: id });
  }

  return null; // Not handled
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
