/**
 * Authentication endpoints.
 *
 * Public (no session required):
 *   POST /auth/login          { email, password } -> { token, user }
 *   POST /auth/accept-invite  { token, password, displayName } -> { token, user }
 *   POST /auth/bootstrap      { email, password, displayName } -> { token, user }
 *                             (requires the legacy ADMIN_TOKEN; only if no admin exists)
 *
 * Authenticated:
 *   GET  /auth/me
 *   POST /auth/change-password { currentPassword, newPassword } -> { token }
 */

import { hashPassword, verifyPassword, sha256Hex } from '../crypto.js';
import { signJwt } from '../jwt.js';

const MIN_PASSWORD = 8;

export async function handlePublicAuth(request, env, path, method) {
  if (method === 'POST' && path === '/auth/login') return login(request, env);
  if (method === 'POST' && path === '/auth/accept-invite') return acceptInvite(request, env);
  if (method === 'POST' && path === '/auth/bootstrap') return bootstrap(request, env);
  return null;
}

export async function handleAuth(request, env, path, method, user) {
  if (method === 'GET' && path === '/auth/me') {
    return json({ user: publicUser(user) });
  }
  if (method === 'POST' && path === '/auth/change-password') {
    return changePassword(request, env, user);
  }
  return null;
}

// ── Handlers ───────────────────────────────────────────────────────

async function login(request, env) {
  if (!env.JWT_SECRET) return json({ error: 'Auth not configured (set JWT_SECRET)' }, 500);
  const { email, password } = await readJson(request);
  if (!email || !password) return json({ error: 'Email and password are required' }, 400);

  const user = await env.DB
    .prepare('SELECT id, email, display_name, role, status, token_version, password_hash FROM users WHERE email = ?')
    .bind(normalizeEmail(email))
    .first();

  // Generic message — don't reveal whether the email exists.
  if (!user || user.status !== 'active' || !user.password_hash) {
    return json({ error: 'Invalid email or password' }, 401);
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    return json({ error: 'Invalid email or password' }, 401);
  }

  return json({ token: await mintToken(env, user), user: publicUser(user) });
}

async function acceptInvite(request, env) {
  const { token, password, displayName } = await readJson(request);
  if (!token || !password) return json({ error: 'Token and password are required' }, 400);
  if (password.length < MIN_PASSWORD) return json({ error: `Password must be at least ${MIN_PASSWORD} characters` }, 400);

  const invite = await env.DB
    .prepare('SELECT token_hash, email, role, expires_at, accepted_at FROM invites WHERE token_hash = ?')
    .bind(await sha256Hex(token))
    .first();

  if (!invite || invite.accepted_at) return json({ error: 'Invalid or already-used invite' }, 400);
  if (Date.now() > Date.parse(invite.expires_at)) return json({ error: 'Invite has expired' }, 400);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(invite.email).first();
  if (existing) return json({ error: 'An account already exists for this email' }, 409);

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users (id, username, email, display_name, role, status, password_hash, token_version)
     VALUES (?, ?, ?, ?, ?, 'active', ?, 0)`
  ).bind(id, invite.email, invite.email, (displayName || '').trim(), invite.role || 'user', passwordHash).run();

  await env.DB.prepare("UPDATE invites SET accepted_at = datetime('now') WHERE token_hash = ?")
    .bind(invite.token_hash).run();

  const user = { id, email: invite.email, display_name: displayName || '', role: invite.role || 'user', token_version: 0 };
  return json({ token: await mintToken(env, user), user: publicUser(user) });
}

async function bootstrap(request, env) {
  // Guarded by the legacy shared secret; usable only before the first admin exists.
  const header = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!env.ADMIN_TOKEN || header !== env.ADMIN_TOKEN) {
    return json({ error: 'Bootstrap requires the ADMIN_TOKEN' }, 401);
  }
  const existing = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND password_hash IS NOT NULL")
    .first();
  if ((existing?.n ?? 0) > 0) return json({ error: 'Already bootstrapped' }, 409);

  const { email, password, displayName } = await readJson(request);
  if (!email || !password) return json({ error: 'Email and password are required' }, 400);
  if (password.length < MIN_PASSWORD) return json({ error: `Password must be at least ${MIN_PASSWORD} characters` }, 400);

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const normEmail = normalizeEmail(email);
  await env.DB.prepare(
    `INSERT INTO users (id, username, email, display_name, role, status, password_hash, token_version)
     VALUES (?, ?, ?, ?, 'admin', 'active', ?, 0)`
  ).bind(id, normEmail, normEmail, (displayName || '').trim(), passwordHash).run();

  const user = { id, email: normEmail, display_name: displayName || '', role: 'admin', token_version: 0 };
  return json({ token: await mintToken(env, user), user: publicUser(user) });
}

async function changePassword(request, env, user) {
  if (user.legacy) return json({ error: 'The bootstrap token has no password to change' }, 400);
  const { currentPassword, newPassword } = await readJson(request);
  if (!currentPassword || !newPassword) return json({ error: 'Current and new password are required' }, 400);
  if (newPassword.length < MIN_PASSWORD) return json({ error: `Password must be at least ${MIN_PASSWORD} characters` }, 400);

  const row = await env.DB.prepare('SELECT password_hash, token_version FROM users WHERE id = ?').bind(user.id).first();
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
    return json({ error: 'Current password is incorrect' }, 401);
  }

  const newHash = await hashPassword(newPassword);
  const newVersion = (row.token_version ?? 0) + 1; // invalidates existing sessions
  await env.DB.prepare("UPDATE users SET password_hash = ?, token_version = ? WHERE id = ?")
    .bind(newHash, newVersion, user.id).run();

  const token = await mintToken(env, { ...user, token_version: newVersion });
  return json({ token });
}

// ── Helpers ────────────────────────────────────────────────────────

function mintToken(env, user) {
  return signJwt({ sub: user.id, role: user.role, tv: user.token_version ?? 0 }, env.JWT_SECRET);
}

function publicUser(user) {
  return { id: user.id, email: user.email, displayName: user.display_name || '', role: user.role };
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
