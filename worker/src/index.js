/**
 * Off Grid API — Cloudflare Worker
 *
 * Routes:
 *   POST   /presign        — Generate presigned PUT URL for R2 upload
 *   POST   /upload         — Direct upload (small files only, < 100MB)
 *   GET    /files          — List R2 objects
 *   DELETE /files/*        — Delete R2 object
 *   GET    /api/mixes      — List mixes (Phase 4)
 *   ...                    — More CRUD endpoints in Phase 4
 */

import { requireAuth } from './auth.js';
import { handlePresign, handleListFiles, handleDeleteFile, handleDirectUpload } from './r2.js';
import { handleMixes } from './api/mixes.js';
import { handlePlaylists } from './api/playlists.js';
import { handleManifest } from './api/manifest.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return corsResponse(env);
    }

    // All routes require auth
    const authError = requireAuth(request, env);
    if (authError) {
      return addCors(authError, env);
    }

    let response;

    try {
      // ── R2 File Operations ──────────────────────────────────
      if (method === 'POST' && path === '/presign') {
        response = await handlePresign(request, env);
      } else if (method === 'POST' && path === '/upload') {
        response = await handleDirectUpload(request, env);
      } else if (method === 'GET' && path === '/files') {
        response = await handleListFiles(request, env);
      } else if (method === 'DELETE' && path.startsWith('/files/')) {
        const key = decodeURIComponent(path.substring('/files/'.length));
        response = await handleDeleteFile(key, env);
      }
      // ── API Routes (D1-backed CRUD) ──────────────────────────
      else if (path.startsWith('/api/mixes')) {
        response = await handleMixes(request, env, path, method);
      } else if (path.startsWith('/api/playlists')) {
        response = await handlePlaylists(request, env, path, method);
      } else if (path.startsWith('/api/manifest')) {
        response = await handleManifest(request, env, path, method);
      }

      if (!response) {
        response = new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (err) {
      console.error('Worker error:', err);
      response = new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return addCors(response, env);
  },
};

function corsResponse(env) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(env),
  });
}

function addCors(response, env) {
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(corsHeaders(env))) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Key',
    'Access-Control-Max-Age': '86400',
  };
}
