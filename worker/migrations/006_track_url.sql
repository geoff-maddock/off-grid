-- Off Grid D1 Schema — migration 006: per-track link
-- Apply with: wrangler d1 execute offgrid-db --remote --file=migrations/006_track_url.sql
--
-- Adds an optional URL to each track (e.g. a Bandcamp/Discogs link), shown as a
-- clickable link in the player's tracklist.

ALTER TABLE mix_tracks ADD COLUMN url TEXT DEFAULT '';
