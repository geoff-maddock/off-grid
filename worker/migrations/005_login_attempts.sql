-- Off Grid D1 Schema — migration 005: login rate limiting
-- Apply with: wrangler d1 execute offgrid-db --remote --file=migrations/005_login_attempts.sql
--
-- Records failed login attempts per IP so /auth/login can throttle brute force.
-- Rows are pruned opportunistically once they age out of the window.

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT,
  email      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, created_at);
