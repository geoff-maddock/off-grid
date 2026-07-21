/**
 * Play tracking + likes API handlers.
 *
 * POST /api/track/play and /api/track/like are PUBLIC (no session): they are
 * called by anonymous listeners on the player page and third-party embeds.
 * Bodies arrive as text/plain — that keeps the requests CORS "simple" (no
 * preflight), which is required for navigator.sendBeacon at page unload and
 * for embeds on arbitrary origins. Always JSON.parse(request.text()) here;
 * never trust or require a JSON content-type.
 *
 * GET /api/stats is authenticated and owner-scoped like the other /api routes.
 */

import { resolveOwnerId } from '../db.js';

const MAX_BODY_BYTES = 1024;
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
// Clamp per event. Normal heartbeats carry ~30-45s, but a hidden tab whose
// timers are throttled can legitimately flush a few minutes in one beacon.
const MAX_SECONDS_PER_EVENT = 300;
const PLAY_THRESHOLD_SECONDS = 5; // a session counts as one play past this
const MAX_EVENTS_PER_MINUTE = 6; // legit clients send ~2-3/min

// Public: POST /api/track/play and POST /api/track/like
export async function handleTrack(request, env, path) {
  const db = env.DB;

  const body = await readBody(request);
  if (!body || typeof body.mixId !== 'string' || !body.mixId || body.mixId.length > 128) {
    return jsonResponse({ error: 'Invalid payload' }, 400);
  }

  const mixExists = await db.prepare('SELECT 1 FROM mixes WHERE id = ?').bind(body.mixId).first();
  if (!mixExists) return jsonResponse({ error: 'Mix not found' }, 404);

  if (path === '/api/track/play') {
    if (typeof body.sessionId !== 'string' || !SESSION_ID_RE.test(body.sessionId)) {
      return jsonResponse({ error: 'Invalid payload' }, 400);
    }
    if (typeof body.seconds !== 'number' || !Number.isFinite(body.seconds) || body.seconds <= 0) {
      return jsonResponse({ error: 'Invalid payload' }, 400);
    }
    const seconds = Math.min(body.seconds, MAX_SECONDS_PER_EVENT);

    // Abuse guard (fail-open like ratelimit.js): a runaway/spoofing session is
    // silently ignored once it exceeds the per-minute event budget.
    try {
      const recent = await db.prepare(
        "SELECT COUNT(*) AS n FROM play_events WHERE session_id = ? AND created_at > datetime('now', '-1 minute')"
      ).bind(body.sessionId).first();
      if ((recent?.n ?? 0) >= MAX_EVENTS_PER_MINUTE) return noContent();
    } catch (err) {
      console.error('play_events rate check failed:', err);
    }

    // A session counts as one play the moment its cumulative listened time
    // crosses the threshold — seeking/pause-resume never inflates play_count.
    const prior = await db.prepare(
      'SELECT COALESCE(SUM(seconds), 0) AS total FROM play_events WHERE mix_id = ? AND session_id = ?'
    ).bind(body.mixId, body.sessionId).first();
    const priorSeconds = prior?.total ?? 0;
    const countsAsPlay =
      priorSeconds < PLAY_THRESHOLD_SECONDS && priorSeconds + seconds >= PLAY_THRESHOLD_SECONDS;

    await db.batch([
      db.prepare('INSERT INTO play_events (mix_id, session_id, seconds) VALUES (?, ?, ?)')
        .bind(body.mixId, body.sessionId, seconds),
      db.prepare(
        `INSERT INTO mix_stats (mix_id, play_count, total_seconds, last_played_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(mix_id) DO UPDATE SET
           play_count = play_count + excluded.play_count,
           total_seconds = total_seconds + excluded.total_seconds,
           last_played_at = excluded.last_played_at`
      ).bind(body.mixId, countsAsPlay ? 1 : 0, seconds),
    ]);
    return noContent();
  }

  if (path === '/api/track/like') {
    const action = body.action === 'unlike' ? 'unlike' : 'like';
    const delta = action === 'like' ? 1 : -1;
    await db.prepare(
      `INSERT INTO mix_stats (mix_id, like_count) VALUES (?, MAX(?, 0))
       ON CONFLICT(mix_id) DO UPDATE SET like_count = MAX(like_count + ?, 0)`
    ).bind(body.mixId, delta, delta).run();
    return noContent();
  }

  return null; // Not handled
}

// Authed: GET /api/stats — per-mix aggregates for the requesting owner's mixes.
//         GET /api/stats/:mixId — detail for one mix (unique listeners + daily activity).
export async function handleStats(request, env, path, method, user) {
  if (method !== 'GET') return null;

  const detail = path.match(/^\/api\/stats\/([^/]+)$/);
  if (detail) return statsDetail(env.DB, decodeURIComponent(detail[1]), user);
  if (path !== '/api/stats') return null;

  const db = env.DB;
  const ownerId = await resolveOwnerId(db, user);

  const where = [];
  const params = [];
  if (ownerId) { where.push('m.owner_id = ?'); params.push(ownerId); }

  let sql = `SELECT m.id, m.title, m.artist,
                    COALESCE(s.play_count, 0) AS play_count,
                    COALESCE(s.total_seconds, 0) AS total_seconds,
                    COALESCE(s.like_count, 0) AS like_count,
                    s.last_played_at
             FROM mixes m
             LEFT JOIN mix_stats s ON s.mix_id = m.id`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY play_count DESC, m.title ASC';

  const result = await db.prepare(sql).bind(...params).all();
  const stats = result.results.map((row) => ({
    mixId: row.id,
    title: row.title,
    artist: row.artist,
    playCount: row.play_count,
    totalSeconds: row.total_seconds,
    likeCount: row.like_count,
    lastPlayedAt: row.last_played_at,
  }));
  return jsonResponse({ stats });
}

// One mix's aggregates plus what the log can add: distinct anonymous sessions
// all-time, and per-day seconds/sessions for the last 30 days (zero-days are
// absent — the client fills the calendar). Owner-scoped like every /api route.
async function statsDetail(db, mixId, user) {
  const ownerId = await resolveOwnerId(db, user);

  let sql = `SELECT m.id,
                    COALESCE(s.play_count, 0) AS play_count,
                    COALESCE(s.total_seconds, 0) AS total_seconds,
                    COALESCE(s.like_count, 0) AS like_count,
                    s.last_played_at
             FROM mixes m
             LEFT JOIN mix_stats s ON s.mix_id = m.id
             WHERE m.id = ?`;
  const params = [mixId];
  if (ownerId) { sql += ' AND m.owner_id = ?'; params.push(ownerId); }
  const row = await db.prepare(sql).bind(...params).first();
  if (!row) return jsonResponse({ error: 'Mix not found' }, 404);

  const [unique, daily] = await Promise.all([
    db.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM play_events WHERE mix_id = ?')
      .bind(mixId).first(),
    db.prepare(
      `SELECT date(created_at) AS day,
              SUM(seconds) AS seconds,
              COUNT(DISTINCT session_id) AS sessions
       FROM play_events
       WHERE mix_id = ? AND created_at >= datetime('now', '-30 days')
       GROUP BY day ORDER BY day ASC`
    ).bind(mixId).all(),
  ]);

  return jsonResponse({
    mixId: row.id,
    playCount: row.play_count,
    totalSeconds: row.total_seconds,
    likeCount: row.like_count,
    lastPlayedAt: row.last_played_at,
    uniqueListeners: unique?.n ?? 0,
    daily: daily.results.map((d) => ({ day: d.day, seconds: d.seconds, sessions: d.sessions })),
  });
}

// Beacon bodies are text/plain and size-capped; any parse failure → null → 400.
async function readBody(request) {
  try {
    const text = await request.text();
    if (!text || text.length > MAX_BODY_BYTES) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function noContent() {
  return new Response(null, { status: 204 });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
