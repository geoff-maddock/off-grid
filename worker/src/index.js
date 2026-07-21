/**
 * Off Grid API — Cloudflare Worker
 *
 * Public (no session):
 *   GET    /config                — deployment config for clients ({ r2PublicUrl, needsSetup })
 *   POST   /auth/login            — email + password → JWT
 *   POST   /auth/accept-invite    — set password from an invite → JWT
 *   POST   /auth/bootstrap        — create the first admin (ADMIN_TOKEN)
 *   POST   /api/track/play        — anonymous listening heartbeat ({ mixId, sessionId, seconds })
 *   POST   /api/track/like        — anonymous like/unlike ({ mixId, action })
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
 *   GET    /api/stats             — per-mix play/like aggregates
 *   GET    /api/stats/:mixId      — one mix's stats detail (unique listeners, daily activity)
 */

import { authenticate } from './auth.js';
import { handlePublicAuth, handleAuth } from './api/auth.js';
import { handleUsers } from './api/users.js';
import { handlePresign, handleListFiles, handleDeleteFile, handleDirectUpload } from './r2.js';
import { handleMixes } from './api/mixes.js';
import { handlePlaylists } from './api/playlists.js';
import { handleManifest } from './api/manifest.js';
import { handleTrack, handleStats } from './api/track.js';

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
      // ── Public deployment config (no session) ────────────────
      // Only non-sensitive values: the R2 public URL already appears
      // in every published manifest/audio URL. null when unset, so
      // clients can tell "unconfigured" apart from "unreachable".
      if (method === 'GET' && path === '/config') {
        const r2PublicUrl = (env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '') || null;
        // needsSetup mirrors the /auth/bootstrap guard: true until the first
        // admin account exists, so the login UI can offer first-time setup
        // only when it's actually possible. A missing users table (migrations
        // not applied yet) also counts as "not set up".
        let needsSetup = true;
        try {
          const row = await env.DB
            .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND password_hash IS NOT NULL")
            .first();
          needsSetup = (row?.n ?? 0) === 0;
        } catch (_) { /* keep needsSetup = true */ }
        response = new Response(JSON.stringify({ r2PublicUrl, needsSetup }), {
          headers: { 'Content-Type': 'application/json' },
        });
        return addCors(response, env, request);
      }

      // ── Public play tracking + likes (no session) ────────────
      // Anonymous beacons from the player page and third-party embeds.
      if (method === 'POST' && path.startsWith('/api/track/')) {
        response = await handleTrack(request, env, path);
        return addCors(response || notFound(), env, request);
      }

      // ── Public auth routes (no session) ──────────────────────
      if (PUBLIC_AUTH_PATHS.has(path)) {
        response = await handlePublicAuth(request, env, path, method);
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
      } else if (path.startsWith('/api/stats')) {
        response = await handleStats(request, env, path, method, user);
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
