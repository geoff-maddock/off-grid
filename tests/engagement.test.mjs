import { describe, it, expect } from 'vitest';
import { handleEngagement } from '../worker/src/api/engagement.js';

// Recording mock D1: respond(sql, args) supplies canned first()/all() results;
// every read is logged with its SQL and bound args for assertions.
function mockDb(respond = () => null) {
  const log = { queries: [] };
  const db = {
    prepare(sql) {
      let args = [];
      const stmt = {
        sql,
        bind: (...a) => { args = a; return stmt; },
        first: async () => { log.queries.push({ sql, args }); return respond(sql, args); },
        all: async () => { log.queries.push({ sql, args }); return { results: respond(sql, args) ?? [] }; },
      };
      return stmt;
    },
  };
  return { db, log };
}

const USER = { id: 'u1', role: 'user' };

function call(path, { user = USER, respond, method = 'GET' } = {}) {
  const { db, log } = mockDb(respond);
  const request = { url: `https://api.test${path}` };
  return handleEngagement(request, { DB: db }, path.split('?')[0], method, user)
    .then((resp) => ({ resp, log }));
}

describe('handleEngagement routing', () => {
  it('ignores non-GET requests', async () => {
    const { resp } = await call('/api/engagement/summary', { method: 'POST' });
    expect(resp).toBeNull();
  });

  it('ignores unmatched paths', async () => {
    const { resp } = await call('/api/engagement/nope');
    expect(resp).toBeNull();
  });

  it('rejects an unknown period', async () => {
    const { resp } = await call('/api/engagement/summary?period=banana');
    expect(resp.status).toBe(400);
  });
});

describe('GET /api/engagement/summary', () => {
  it('defaults to a 7-day window', async () => {
    const { resp, log } = await call('/api/engagement/summary');
    expect(resp.status).toBe(200);
    expect((await resp.json()).period).toBe('7d');
    expect(log.queries.some((q) => q.args.includes('-7 days'))).toBe(true);
  });

  it('scopes every query to the owner', async () => {
    const { log } = await call('/api/engagement/summary?period=30d');
    for (const q of log.queries) {
      expect(q.sql).toMatch(/m\.owner_id = \?/);
      expect(q.args).toContain('u1');
    }
  });

  it('omits the owner clause when no owner resolves', async () => {
    const { log } = await call('/api/engagement/summary?period=30d', { user: null });
    expect(log.queries.every((q) => !/owner_id/.test(q.sql))).toBe(true);
  });

  it('period=all drops the time filter but caps the timeseries to 90 days', async () => {
    const { resp, log } = await call('/api/engagement/summary?period=all');
    const mixesQ = log.queries.find((q) => /GROUP BY t\.mix_id/.test(q.sql));
    expect(mixesQ.sql).not.toMatch(/created_at >=/);
    const tsQ = log.queries.find((q) => /strftime/.test(q.sql));
    expect(tsQ.args).toContain('-90 days');
    expect((await resp.json()).timeseries.capped).toBe(true);
  });

  it('buckets hourly for 24h and daily otherwise', async () => {
    const hourly = await call('/api/engagement/summary?period=24h');
    expect(hourly.log.queries.find((q) => /strftime/.test(q.sql)).args[0]).toBe('%Y-%m-%dT%H:00');
    expect((await hourly.resp.json()).timeseries.bucket).toBe('hour');

    const daily = await call('/api/engagement/summary?period=7d');
    expect(daily.log.queries.find((q) => /strftime/.test(q.sql)).args[0]).toBe('%Y-%m-%d');
    expect((await daily.resp.json()).timeseries.bucket).toBe('day');
  });

  it('counts distinct sessions across mixes instead of summing per-mix', async () => {
    const respond = (sql) => {
      if (/GROUP BY t\.mix_id/.test(sql)) {
        return [
          { mix_id: 'm1', title: 'A', artist: null, plays: 2, sessions: 2, seconds: 100, last_played_at: 'x' },
          { mix_id: 'm2', title: 'B', artist: null, plays: 1, sessions: 1, seconds: 50, last_played_at: 'y' },
        ];
      }
      if (/COUNT\(DISTINCT e\.session_id\) AS n/.test(sql)) return { n: 2 };
      return null;
    };
    const { resp } = await call('/api/engagement/summary', { respond });
    const body = await resp.json();
    expect(body.totals).toEqual({ plays: 3, sessions: 2, seconds: 150, activeMixes: 2 });
    expect(body.mixes[0]).toEqual({
      mixId: 'm1', title: 'A', artist: null, plays: 2, sessions: 2, seconds: 100, lastPlayedAt: 'x',
    });
  });
});

describe('GET /api/engagement/sessions', () => {
  const row = (i) => ({
    session_id: `sess-${String(i).padStart(8, '0')}`, country: 'US',
    first_seen: 'a', last_seen: 'b', seconds: 60, mix_count: 1,
  });

  it('clamps limit to 100 and fetches one extra row for hasMore', async () => {
    const { log } = await call('/api/engagement/sessions?limit=500');
    const q = log.queries.find((s) => /GROUP BY e\.session_id/.test(s.sql));
    expect(q.args).toContain(101);
  });

  it('reports hasMore and trims the extra row', async () => {
    const respond = (sql) =>
      /GROUP BY e\.session_id/.test(sql) ? Array.from({ length: 51 }, (_, i) => row(i)) : null;
    const { resp } = await call('/api/engagement/sessions', { respond });
    const body = await resp.json();
    expect(body.hasMore).toBe(true);
    expect(body.sessions).toHaveLength(50);
    expect(body.sessions[0]).toEqual({
      sessionId: 'sess-00000000', country: 'US', firstSeen: 'a', lastSeen: 'b', seconds: 60, mixCount: 1,
    });
  });

  it('applies an optional mixId filter', async () => {
    const { log } = await call('/api/engagement/sessions?mixId=m9');
    const q = log.queries.find((s) => /GROUP BY e\.session_id/.test(s.sql));
    expect(q.sql).toMatch(/e\.mix_id = \?/);
    expect(q.args).toContain('m9');
  });
});

describe('GET /api/engagement/session/:sessionId', () => {
  it('rejects a malformed session id', async () => {
    const { resp } = await call('/api/engagement/session/x!');
    expect(resp.status).toBe(400);
  });

  it('404s when the session has no visible events', async () => {
    const { resp } = await call('/api/engagement/session/sess-12345678');
    expect(resp.status).toBe(404);
  });

  it('returns the owner-scoped event log', async () => {
    const respond = (sql) => (/e\.session_id = \?/.test(sql)
      ? [
        { mix_id: 'm1', title: 'A', seconds: 30, created_at: 't1', country: null },
        { mix_id: 'm1', title: 'A', seconds: 45, created_at: 't2', country: 'FR' },
      ] : null);
    const { resp, log } = await call('/api/engagement/session/sess-12345678', { respond });
    const body = await resp.json();
    expect(body.sessionId).toBe('sess-12345678');
    expect(body.country).toBe('FR');
    expect(body.events).toEqual([
      { mixId: 'm1', title: 'A', seconds: 30, createdAt: 't1' },
      { mixId: 'm1', title: 'A', seconds: 45, createdAt: 't2' },
    ]);
    const q = log.queries.find((s) => /e\.session_id = \?/.test(s.sql));
    expect(q.sql).toMatch(/m\.owner_id = \?/);
    expect(q.args).toEqual(['sess-12345678', 'u1']);
  });
});
