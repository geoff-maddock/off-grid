/**
 * Mix CRUD API handlers
 */

import { listMixes, getMix, createMix, updateMix, deleteMix } from '../db.js';

export async function handleMixes(request, env, path, method) {
  const db = env.DB;

  // GET /api/mixes
  if (method === 'GET' && path === '/api/mixes') {
    const url = new URL(request.url);
    const mixes = await listMixes(db, {
      tag: url.searchParams.get('tag'),
      artist: url.searchParams.get('artist'),
      sort: url.searchParams.get('sort'),
      dir: url.searchParams.get('dir'),
    });
    return jsonResponse(mixes);
  }

  // GET /api/mixes/:id
  const mixMatch = path.match(/^\/api\/mixes\/([^/]+)$/);
  if (method === 'GET' && mixMatch) {
    const mix = await getMix(db, decodeURIComponent(mixMatch[1]));
    if (!mix) return jsonResponse({ error: 'Mix not found' }, 404);
    return jsonResponse(mix);
  }

  // POST /api/mixes
  if (method === 'POST' && path === '/api/mixes') {
    const body = await request.json();
    if (!body.id || !body.title || !body.src) {
      return jsonResponse({ error: 'id, title, and src are required' }, 400);
    }
    const existing = await getMix(db, body.id);
    if (existing) {
      return jsonResponse({ error: 'Mix with this ID already exists' }, 409);
    }
    const mix = await createMix(db, body);
    return jsonResponse(mix, 201);
  }

  // PUT /api/mixes/:id
  if (method === 'PUT' && mixMatch) {
    const id = decodeURIComponent(mixMatch[1]);
    const existing = await getMix(db, id);
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
    const existing = await getMix(db, id);
    if (!existing) return jsonResponse({ error: 'Mix not found' }, 404);
    await deleteMix(db, id);
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
