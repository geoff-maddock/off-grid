-- Off Grid D1 Schema — migration 002: email+password accounts & invites
-- Apply with: wrangler d1 execute offgrid-db --remote --file=migrations/002_users_multitenant.sql
--
-- Phase 1 of the multi-user rollout (see docs/multi-user-plan.md). Adds auth
-- columns to the existing `users` table and an `invites` table. Content
-- ownership (owner_id) and per-user storage land in a later migration.

-- Auth fields on the pre-existing users table (id, username, display_name, role, created_at).
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;            -- "pbkdf2$<iters>$<saltHex>$<hashHex>"
ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active';  -- active | disabled
ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0; -- bump to revoke all sessions

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Pending invitations. We store a hash of the invite token, never the raw token.
CREATE TABLE IF NOT EXISTS invites (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'user',
  invited_by  TEXT REFERENCES users(id),
  created_at  TEXT DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  accepted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
