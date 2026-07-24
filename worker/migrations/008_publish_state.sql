-- Unpublished-changes tracking: one row per owner. `dirty` is set by every
-- content write (mixes/playlists) and cleared when the manifest is published,
-- so the admin can show a persistent "unpublished changes" indicator.
CREATE TABLE IF NOT EXISTS publish_state (
  owner_id TEXT PRIMARY KEY,
  dirty INTEGER NOT NULL DEFAULT 0,
  published_at TEXT
);
