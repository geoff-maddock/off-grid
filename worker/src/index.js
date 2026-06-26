/**
 * Off Grid API — Cloudflare Worker
 *
 * Public (no session):
 *   POST   /auth/login            — email + password → JWT
 *   POST   /auth/accept-invite    — set password from an invite → JWT
 *   POST   /auth/bootstrap        — create the first admin (ADMIN_TOKEN)
 *   GET    /api/bandcamp-embed    — resolve a Bandcamp page URL → embed URL (cached)
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
import { handleBandcampEmbed } from './api/bandcamp.js';

// Routes reachable without a session.
const PUBLIC_AUTH_PATHS = new Set(['/auth/login', '/auth/accept-invite', '/auth/bootstrap']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return corsResponse(env, request);
    }

    let response;

    try {
      // ── Public auth routes (no session) ──────────────────────
      if (PUBLIC_AUTH_PATHS.has(path)) {
        response = await handlePublicAuth(request, env, path, method);
        return addCors(response || notFound(), env, request);
      }

      // ── Public Bandcamp embed resolver (no session) ──────────
      // The static public player calls this to turn a Bandcamp page URL into
      // an embeddable iframe URL; it stays ahead of authenticate().
      if (method === 'GET' && path === '/api/bandcamp-embed') {
        response = await handleBandcampEmbed(request, env);
        return addCors(response || notFound(), env, request);
      }

      // ── Everything else requires an authenticated user ───────
      const { user, error } = await authenticate(request, env);
      if (error) {
        return addCors(error, env, request);
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

    return addCors(response, env, request);
  },
};

function notFound() {
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

function corsResponse(env, request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(env, request),
  });
}

function addCors(response, env, request) {
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(corsHeaders(env, request))) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}

// CORS_ORIGIN may be "*" (allow any) or a comma-separated allowlist of exact
// origins. For an allowlist we echo the request's Origin when it matches (and
// set Vary: Origin); otherwise we return a non-matching origin so the browser
// blocks the response.
function corsHeaders(env, request) {
  const configured = (env.CORS_ORIGIN || '*').trim();
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Key',
    'Access-Control-Max-Age': '86400',
  };

  if (configured === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  const allowlist = configured.split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request && request.headers.get('Origin');
  // Echo the origin only when it's allowed; otherwise return "null" so the
  // browser blocks the response (never echo a different real origin).
  headers['Access-Control-Allow-Origin'] = (origin && allowlist.includes(origin)) ? origin : 'null';
  headers['Vary'] = 'Origin';
  return headers;
}
