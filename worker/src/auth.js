/**
 * Authentication — JWT sessions backed by D1 user accounts.
 *
 * `authenticate()` resolves the caller to a user record, or returns a 401
 * Response. A legacy ADMIN_TOKEN (shared secret) is still accepted as a
 * synthetic admin so an instance can be bootstrapped before any user exists.
 */

import { verifyJwt } from './jwt.js';

/**
 * @returns {Promise<{user: object} | {error: Response}>}
 */
export async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: unauthorized('Missing Authorization header') };

  // Legacy bootstrap: the shared ADMIN_TOKEN acts as a synthetic admin.
  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) {
    return { user: { id: '__admin_token__', email: null, display_name: 'Admin Token', role: 'admin', legacy: true } };
  }

  if (!env.JWT_SECRET) return { error: unauthorized('Auth not configured (set JWT_SECRET)') };

  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload || !payload.sub) return { error: unauthorized('Invalid or expired token') };

  const user = await env.DB
    .prepare('SELECT id, email, display_name, role, status, token_version FROM users WHERE id = ?')
    .bind(payload.sub)
    .first();

  if (!user || user.status !== 'active') return { error: unauthorized('Account inactive') };
  if ((payload.tv ?? 0) !== (user.token_version ?? 0)) return { error: unauthorized('Session expired, please log in again') };

  return { user };
}

export function requireRole(user, role) {
  return !!user && user.role === role;
}

export function unauthorized(message) {
  return jsonError(message, 401);
}

export function forbidden(message = 'Forbidden') {
  return jsonError(message, 403);
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
