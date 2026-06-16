/**
 * Admin-only user management.
 *
 *   POST   /api/users/invite   { email, role? } -> { inviteToken, email, role, expiresAt }
 *   GET    /api/users          -> [ { id, email, displayName, role, status, createdAt } ]
 *   PATCH  /api/users/:id       { role?, status? }
 *   DELETE /api/users/:id
 *
 * All routes require an admin caller.
 */

import { forbidden } from '../auth.js';
import { randomToken, sha256Hex } from '../crypto.js';

const INVITE_TTL_DAYS = 7;
const ROLES = ['admin', 'user'];
const STATUSES = ['active', 'disabled'];

export async function handleUsers(request, env, path, method, user) {
  if (user.role !== 'admin') return forbidden('Admin access required');

  if (method === 'POST' && path === '/api/users/invite') return invite(request, env, user);
  if (method === 'GET' && path === '/api/users') return listUsers(env);

  const idMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1]);
    if (method === 'PATCH') return patchUser(request, env, user, id);
    if (method === 'DELETE') return deleteUser(env, user, id);
  }

  return null;
}

async function invite(request, env, admin) {
  const { email, role } = await readJson(request);
  if (!email) return json({ error: 'Email is required' }, 400);
  const inviteRole = ROLES.includes(role) ? role : 'user';
  const normEmail = String(email).trim().toLowerCase();

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(normEmail).first();
  if (existing) return json({ error: 'A user with this email already exists' }, 409);

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000).toISOString();

  // One pending invite per email — replace any prior one.
  await env.DB.prepare('DELETE FROM invites WHERE email = ? AND accepted_at IS NULL').bind(normEmail).run();
  await env.DB.prepare(
    'INSERT INTO invites (token_hash, email, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(tokenHash, normEmail, inviteRole, admin.id, expiresAt).run();

  // The raw token is returned ONCE; only its hash is stored.
  return json({ inviteToken: token, email: normEmail, role: inviteRole, expiresAt });
}

async function listUsers(env) {
  const result = await env.DB.prepare(
    'SELECT id, email, display_name, role, status, created_at FROM users ORDER BY created_at ASC'
  ).all();
  const users = (result.results || []).map((u) => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name || '',
    role: u.role,
    status: u.status,
    createdAt: u.created_at,
  }));
  return json(users);
}

async function patchUser(request, env, admin, id) {
  if (id === admin.id) return json({ error: 'You cannot change your own role or status' }, 400);
  const { role, status } = await readJson(request);

  const target = await env.DB.prepare('SELECT id, role, status, token_version FROM users WHERE id = ?').bind(id).first();
  if (!target) return json({ error: 'User not found' }, 404);

  const sets = [];
  const params = [];
  if (role !== undefined) {
    if (!ROLES.includes(role)) return json({ error: 'Invalid role' }, 400);
    if (target.role === 'admin' && role !== 'admin' && (await adminCount(env)) <= 1) {
      return json({ error: 'Cannot demote the last admin' }, 400);
    }
    sets.push('role = ?'); params.push(role);
  }
  if (status !== undefined) {
    if (!STATUSES.includes(status)) return json({ error: 'Invalid status' }, 400);
    sets.push('status = ?'); params.push(status);
    if (status === 'disabled') {
      // Revoke existing sessions by bumping the token version.
      sets.push('token_version = ?'); params.push((target.token_version ?? 0) + 1);
    }
  }
  if (!sets.length) return json({ error: 'Nothing to update' }, 400);

  params.push(id);
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
  return json({ ok: true });
}

async function deleteUser(env, admin, id) {
  if (id === admin.id) return json({ error: 'You cannot delete your own account' }, 400);
  const target = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(id).first();
  if (!target) return json({ error: 'User not found' }, 404);
  if (target.role === 'admin' && (await adminCount(env)) <= 1) {
    return json({ error: 'Cannot delete the last admin' }, 400);
  }
  // NOTE: content ownership/reassignment arrives with Phase 2 (owner_id).
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ── Helpers ────────────────────────────────────────────────────────

async function adminCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").first();
  return row?.n ?? 0;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
