-- Off Grid D1 Schema — migration 009: coarse geo on play events
-- Apply with: wrangler d1 execute offgrid-db --remote --file=migrations/009_play_geo.sql
-- IMPORTANT: apply BEFORE deploying the Worker that writes `country` —
-- the play-event INSERT names the column and fails if it is missing.
--
-- country is the ISO-3166-1 alpha-2 code from Cloudflare's request.cf.country,
-- captured server-side at the edge. Still no IPs, cookies, user agents, or
-- user identifiers — country-level only, nullable (local dev or unknown
-- edge location = NULL; historical rows stay NULL).

ALTER TABLE play_events ADD COLUMN country TEXT;

-- Owner-wide time-window scans for the admin Engagement tab
-- (JOIN mixes ... WHERE created_at >= ...). The 007 indexes both lead with
-- session_id / (mix_id, session_id) and cannot serve these.
CREATE INDEX IF NOT EXISTS idx_play_events_created_at ON play_events(created_at);
