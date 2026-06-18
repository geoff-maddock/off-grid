/**
 * Off Grid API — Cloudflare Worker
 *
 * Public (no session):
 *   POST   /auth/login            — email + password → JWT
 *   POST   /auth/accept-invite    — set password from an invite → JWT
 *   POST   /auth/bootstrap        — create the first admin (ADMIN_TOKEN)
 *
 * Authenticated:
 *   GET    /auth/me               — current user
 *   POST   /auth/change-password
 *   *      /api/users             — admin: invite / list / patch / delete users
 *   POST   /presign               — presigned PUT URL for R2 upload
 *   POST   /upload                — direct upload (< 100MB)
 *   GET    /files                 — list R2 objects
 *   DELETE /files/*               — delete R2 object
 *   *      /api/mixes             — mix CRUD
 *   *      /api/playlists         — playlist CRUD
 *   *      /api/manifest          — generate / publish manifest
 */

import { authenticate } from './auth.js';
import { handlePublicAuth, handleAuth } from './api/auth.js';
import { handleUsers } from './api/users.js';
import { handlePresign, handleListFiles, handleDeleteFile, handleDirectUpload } from './r2.js';
import { handleMixes } from './api/mixes.js';
import { handlePlaylists } from './api/playlists.js';
import { handleManifest } from './api/manifest.js';

// Routes reachable without a session.
const PUBLIC_AUTH_PATHS = new Set(['/auth/login', '/auth/accept-invite', '/auth/bootstrap']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return corsResponse(env);
    }

    let response;

    try {
      // ── Public auth routes (no session) ──────────────────────
      if (PUBLIC_AUTH_PATHS.has(path)) {
        response = await handlePublicAuth(request, env, path, method);
        return addCors(response || notFound(), env);
      }

      // ── Everything else requires an authenticated user ───────
      const { user, error } = await authenticate(request, env);
      if (error) {
        return addCors(error, env);
      }

      // ── Auth (session-scoped) ────────────────────────────────
      if (path === '/auth/me' || path === '/auth/change-password') {
        response = await handleAuth(request, env, path, method, user);
      }
      // ── User management (admin) ──────────────────────────────
      else if (path.startsWith('/api/users')) {
        response = await handleUsers(request, env, path, method, user);
      }
      // ── R2 File Operations (scoped to the user's namespace) ──
      else if (method === 'POST' && path === '/presign') {
        response = await handlePresign(request, env, user);
      } else if (method === 'POST' && path === '/upload') {
        response = await handleDirectUpload(request, env, user);
      } else if (method === 'GET' && path === '/files') {
        response = await handleListFiles(request, env, user);
      } else if (method === 'DELETE' && path.startsWith('/files/')) {
        const key = decodeURIComponent(path.substring('/files/'.length));
        response = await handleDeleteFile(key, env, user);
      }
      // ── API Routes (D1-backed CRUD, scoped to the user) ──────
      else if (path.startsWith('/api/mixes')) {
        response = await handleMixes(request, env, path, method, user);
      } else if (path.startsWith('/api/playlists')) {
        response = await handlePlaylists(request, env, path, method, user);
      } else if (path.startsWith('/api/manifest')) {
        response = await handleManifest(request, env, path, method, user);
      }

      if (!response) {
        response = notFound();
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

function notFound() {
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
