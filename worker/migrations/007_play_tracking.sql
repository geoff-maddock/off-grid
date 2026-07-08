-- Off Grid D1 Schema — migration 007: play tracking + likes
-- Apply with: wrangler d1 execute offgrid-db --remote --file=migrations/007_play_tracking.sql
--
-- play_events is an append-only log of listening heartbeats sent by the
-- public player (one row per ~30s of actual listening, keyed by an anonymous
-- per-page-load session id). mix_stats holds fast per-mix aggregates so the
-- admin UI never has to scan the log. No IPs or user identifiers are stored.
-- No FK to mixes: deleting a mix never fails, and historical stats survive.

CREATE TABLE IF NOT EXISTS play_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mix_id     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seconds    REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_play_events_session ON play_events(mix_id, session_id);
CREATE INDEX IF NOT EXISTS idx_play_events_created ON play_events(session_id, created_at);

CREATE TABLE IF NOT EXISTS mix_stats (
  mix_id         TEXT PRIMARY KEY,
  play_count     INTEGER NOT NULL DEFAULT 0,
  total_seconds  REAL NOT NULL DEFAULT 0,
  like_count     INTEGER NOT NULL DEFAULT 0,
  last_played_at TEXT
);
