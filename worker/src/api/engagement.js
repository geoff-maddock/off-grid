/**
 * Engagement API — period-windowed play analytics for the admin Engagement tab.
 *
 * All routes are authenticated and owner-scoped like /api/stats: every query
 * JOINs mixes on mix_id, which both applies owner scoping and drops orphaned
 * play_events for deleted mixes (007 has no FK by design).
 *
 *   GET /api/engagement/summary?period=7d
 *   GET /api/engagement/sessions?period=7d&mixId=<id>&limit=50&offset=0
 *   GET /api/engagement/session/:sessionId
 *
 * Requires migration 009 (play_events.country + created_at index).
 */

import { resolveOwnerId } from '../db.js';
import { SESSION_ID_RE } from './track.js';

// Allowed period values → SQLite datetime() offset (null = no time filter).
const PERIODS = {
  '24h': '-24 hours',
  '7d': '-7 days',
  '30d': '-30 days',
  '90d': '-90 days',
  all: null,
};
const PLAY_THRESHOLD_SECONDS = 5; // must match track.js
const MAX_SESSION_EVENTS = 500;

export async function handleEngagement(request, env, path, method, user) {
  if (method !== 'GET') return null;

  const url = new URL(request.url);
  const db = env.DB;

  const session = path.match(/^\/api\/engagement\/session\/([^/]+)$/);
  if (session) return sessionDetail(db, decodeURIComponent(session[1]), user);

  if (path !== '/api/engagement/summary' && path !== '/api/engagement/sessions') return null;

  const period = url.searchParams.get('period') || '7d';
  if (!(period in PERIODS)) return jsonResponse({ error: 'Invalid period' }, 400);

  const ownerId = await resolveOwnerId(db, user);
  if (path === '/api/engagement/summary') return summary(db, period, ownerId);
  return sessions(db, period, ownerId, url.searchParams);
}

// WHERE clause + params shared by every windowed query.
function windowFilter(period, ownerId) {
  const where = [];
  const params = [];
  if (ownerId) { where.push('m.owner_id = ?'); params.push(ownerId); }
  if (PERIODS[period]) {
    where.push("e.created_at >= datetime('now', ?)");
    params.push(PERIODS[period]);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

async function summary(db, period, ownerId) {
  const { clause, params } = windowFilter(period, ownerId);
  const joined = 'FROM play_events e JOIN mixes m ON m.id = e.mix_id';

  // Period play counts are re-derived from the log with the same 5s-threshold
  // semantics as mix_stats.play_count: one play per (mix, session) whose
  // in-window seconds reach the threshold. A session straddling the window
  // boundary can count differently than in the all-time aggregate — accepted.
  const mixesSql = `
    SELECT t.mix_id, m2.title, m2.artist,
           SUM(CASE WHEN t.sec >= ${PLAY_THRESHOLD_SECONDS} THEN 1 ELSE 0 END) AS plays,
           COUNT(*) AS sessions,
           SUM(t.sec) AS seconds,
           MAX(t.last_at) AS last_played_at
    FROM (
      SELECT e.mix_id, e.session_id, SUM(e.seconds) AS sec, MAX(e.created_at) AS last_at
      ${joined} ${clause}
      GROUP BY e.mix_id, e.session_id
    ) t JOIN mixes m2 ON m2.id = t.mix_id
    GROUP BY t.mix_id
    ORDER BY plays DESC, seconds DESC`;

  // Hourly buckets for 24h, daily otherwise. "all" would produce an unbounded
  // series, so its chart is capped to the last 90 days (totals stay all-time).
  const bucketKind = period === '24h' ? 'hour' : 'day';
  const bucketFmt = bucketKind === 'hour' ? '%Y-%m-%dT%H:00' : '%Y-%m-%d';
  const tsFilter = period === 'all'
    ? windowFilter('90d', ownerId)
    : { clause, params };
  const timeseriesSql = `
    SELECT strftime(?, e.created_at) AS bucket,
           SUM(e.seconds) AS seconds,
           COUNT(DISTINCT e.session_id) AS sessions
    ${joined} ${tsFilter.clause}
    GROUP BY bucket ORDER BY bucket ASC`;

  const countriesSql = `
    SELECT COALESCE(e.country, '') AS country,
           COUNT(DISTINCT e.session_id) AS sessions,
           SUM(e.seconds) AS seconds
    ${joined} ${clause}
    GROUP BY 1 ORDER BY sessions DESC LIMIT 10`;

  // Distinct sessions across all mixes — summing the per-mix session counts
  // would double-count sessions that played more than one mix.
  const totalSessionsSql = `SELECT COUNT(DISTINCT e.session_id) AS n ${joined} ${clause}`;

  const [mixesRes, tsRes, countriesRes, totalSessions] = await Promise.all([
    db.prepare(mixesSql).bind(...params).all(),
    db.prepare(timeseriesSql).bind(bucketFmt, ...tsFilter.params).all(),
    db.prepare(countriesSql).bind(...params).all(),
    db.prepare(totalSessionsSql).bind(...params).first(),
  ]);

  const mixes = mixesRes.results.map((r) => ({
    mixId: r.mix_id,
    title: r.title,
    artist: r.artist,
    plays: r.plays,
    sessions: r.sessions,
    seconds: r.seconds,
    lastPlayedAt: r.last_played_at,
  }));

  return jsonResponse({
    period,
    totals: {
      plays: mixes.reduce((n, m) => n + m.plays, 0),
      sessions: totalSessions?.n ?? 0,
      seconds: mixes.reduce((n, m) => n + m.seconds, 0),
      activeMixes: mixes.length,
    },
    mixes,
    timeseries: {
      bucket: bucketKind,
      // period=all charts only the recent slice; the flag lets the UI say so
      capped: period === 'all',
      points: tsRes.results.map((r) => ({
        bucket: r.bucket,
        seconds: r.seconds,
        sessions: r.sessions,
      })),
    },
    countries: countriesRes.results.map((r) => ({
      country: r.country,
      sessions: r.sessions,
      seconds: r.seconds,
    })),
  });
}

async function sessions(db, period, ownerId, searchParams) {
  const { clause, params } = windowFilter(period, ownerId);
  const extra = [];
  const mixId = searchParams.get('mixId');
  if (mixId) { extra.push('e.mix_id = ?'); params.push(mixId); }

  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit'), 10) || 50));
  const offset = Math.max(0, parseInt(searchParams.get('offset'), 10) || 0);

  let where = clause;
  if (extra.length) where = where ? `${where} AND ${extra.join(' AND ')}` : `WHERE ${extra.join(' AND ')}`;

  const sql = `
    SELECT e.session_id, MAX(e.country) AS country,
           MIN(e.created_at) AS first_seen, MAX(e.created_at) AS last_seen,
           SUM(e.seconds) AS seconds, COUNT(DISTINCT e.mix_id) AS mix_count
    FROM play_events e JOIN mixes m ON m.id = e.mix_id ${where}
    GROUP BY e.session_id
    ORDER BY last_seen DESC
    LIMIT ? OFFSET ?`;

  const result = await db.prepare(sql).bind(...params, limit + 1, offset).all();
  const rows = result.results;
  return jsonResponse({
    sessions: rows.slice(0, limit).map((r) => ({
      sessionId: r.session_id,
      country: r.country,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      seconds: r.seconds,
      mixCount: r.mix_count,
    })),
    hasMore: rows.length > limit,
  });
}

// One anonymous session's event log. No period filter — a session id lives
// for a single page-load, so it is already time-bounded.
async function sessionDetail(db, sessionId, user) {
  if (!SESSION_ID_RE.test(sessionId)) return jsonResponse({ error: 'Invalid session id' }, 400);

  const ownerId = await resolveOwnerId(db, user);
  let sql = `
    SELECT e.mix_id, m.title, e.seconds, e.created_at, e.country
    FROM play_events e JOIN mixes m ON m.id = e.mix_id
    WHERE e.session_id = ?`;
  const params = [sessionId];
  if (ownerId) { sql += ' AND m.owner_id = ?'; params.push(ownerId); }
  sql += ` ORDER BY e.created_at ASC LIMIT ${MAX_SESSION_EVENTS}`;

  const result = await db.prepare(sql).bind(...params).all();
  // Unknown session and not-your-session are indistinguishable by design.
  if (!result.results.length) return jsonResponse({ error: 'Session not found' }, 404);

  return jsonResponse({
    sessionId,
    country: result.results.find((r) => r.country)?.country ?? null,
    events: result.results.map((r) => ({
      mixId: r.mix_id,
      title: r.title,
      seconds: r.seconds,
      createdAt: r.created_at,
    })),
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
