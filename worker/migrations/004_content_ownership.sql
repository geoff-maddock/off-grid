-- Off Grid D1 Schema — migration 004: per-user content ownership (Phase 2a)
-- Apply with: wrangler d1 execute offgrid-db --remote --file=migrations/004_content_ownership.sql
--
-- Adds an owner to each mix/playlist and backfills existing content to the
-- instance owner (the first admin). IDs stay globally unique in this phase;
-- queries are scoped by owner in the Worker. Run AFTER an admin account exists
-- (i.e. after /auth/bootstrap), so the backfill has someone to assign to.

ALTER TABLE mixes ADD COLUMN owner_id TEXT;
ALTER TABLE playlists ADD COLUMN owner_id TEXT;

CREATE INDEX IF NOT EXISTS idx_mixes_owner ON mixes(owner_id);
CREATE INDEX IF NOT EXISTS idx_playlists_owner ON playlists(owner_id);

-- Backfill existing content to the first real admin (the instance owner).
UPDATE mixes
   SET owner_id = (SELECT id FROM users WHERE role = 'admin' AND password_hash IS NOT NULL ORDER BY created_at ASC LIMIT 1)
 WHERE owner_id IS NULL;

UPDATE playlists
   SET owner_id = (SELECT id FROM users WHERE role = 'admin' AND password_hash IS NOT NULL ORDER BY created_at ASC LIMIT 1)
 WHERE owner_id IS NULL;
