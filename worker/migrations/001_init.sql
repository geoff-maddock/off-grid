-- Off Grid D1 Database Schema
-- Apply with: wrangler d1 execute offgrid-db --file=migrations/001_init.sql

CREATE TABLE IF NOT EXISTS mixes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT DEFAULT '',
  description TEXT DEFAULT '',
  src TEXT NOT NULL,
  thumb TEXT DEFAULT '',
  peaks TEXT DEFAULT '',
  color TEXT DEFAULT '#ff5500',
  tags TEXT DEFAULT '[]',
  duration REAL,
  release_date TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  creator TEXT DEFAULT '',
  thumb TEXT DEFAULT '',
  color TEXT DEFAULT '#ff5500',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlist_mixes (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  mix_id TEXT NOT NULL REFERENCES mixes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (playlist_id, mix_id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT DEFAULT '',
  role TEXT DEFAULT 'admin',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mixes_artist ON mixes(artist);
CREATE INDEX IF NOT EXISTS idx_mixes_release ON mixes(release_date);
CREATE INDEX IF NOT EXISTS idx_playlist_mixes_pos ON playlist_mixes(playlist_id, position);
