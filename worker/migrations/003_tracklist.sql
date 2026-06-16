-- Off Grid D1 Schema — migration 003: per-mix tracklist
-- Apply with: wrangler d1 execute offgrid-db --remote --file=migrations/003_tracklist.sql
--
-- Each mix keeps the raw tracklist text the user typed (mixes.tracklist) plus a
-- parsed, individual-track representation in mix_tracks (one row per track).

ALTER TABLE mixes ADD COLUMN tracklist TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS mix_tracks (
  mix_id       TEXT NOT NULL REFERENCES mixes(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,        -- 0-based order within the mix
  time         TEXT DEFAULT '',         -- as written, e.g. "04:32"
  time_seconds INTEGER,                 -- parsed offset in seconds (nullable) — enables seek
  artist       TEXT DEFAULT '',
  title        TEXT DEFAULT '',
  PRIMARY KEY (mix_id, position)
);

CREATE INDEX IF NOT EXISTS idx_mix_tracks_mix ON mix_tracks(mix_id, position);
