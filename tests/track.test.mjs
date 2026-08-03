import { describe, it, expect } from 'vitest';
import { handleTrack } from '../worker/src/api/track.js';

// Recording mock D1 with canned reads: respond(sql, args) supplies first()
// results per query; every read and batch is logged with its bound args.
function mockDb(respond = () => null) {
  const log = { queries: [], batches: [] };
  const db = {
    prepare(sql) {
      let args = [];
      const stmt = {
        sql,
        get args() { return args; },
        bind: (...a) => { args = a; return stmt; },
        run: async () => { log.queries.push({ sql, args }); },
        first: async () => { log.queries.push({ sql, args }); return respond(sql, args); },
        all: async () => { log.queries.push({ sql, args }); return { results: respond(sql, args) ?? [] }; },
      };
      return stmt;
    },
    async batch(stmts) { log.batches.push(stmts.map((s) => ({ sql: s.sql, args: s.args }))); },
  };
  return { db, log };
}

const mixExists = (sql) => (/SELECT 1 FROM mixes/.test(sql) ? { 1: 1 } : null);

function playRequest(body, cf) {
  return { text: async () => JSON.stringify(body), cf };
}

function playEnv(respond) {
  const { db, log } = mockDb(respond);
  return { env: { DB: db }, log };
}

const PLAY = '/api/track/play';
const SESSION = 'sess-12345678';

describe('handleTrack POST /api/track/play', () => {
  it('rejects a missing mixId', async () => {
    const { env } = playEnv();
    const resp = await handleTrack(playRequest({ sessionId: SESSION, seconds: 30 }), env, PLAY);
    expect(resp.status).toBe(400);
  });

  it('rejects a malformed sessionId', async () => {
    const { env } = playEnv(mixExists);
    const resp = await handleTrack(playRequest({ mixId: 'm1', sessionId: 'x!', seconds: 30 }), env, PLAY);
    expect(resp.status).toBe(400);
  });

  it('rejects non-positive seconds', async () => {
    const { env } = playEnv(mixExists);
    const resp = await handleTrack(playRequest({ mixId: 'm1', sessionId: SESSION, seconds: 0 }), env, PLAY);
    expect(resp.status).toBe(400);
  });

  it('clamps seconds to 300 per event', async () => {
    const { env, log } = playEnv(mixExists);
    const resp = await handleTrack(playRequest({ mixId: 'm1', sessionId: SESSION, seconds: 9999 }), env, PLAY);
    expect(resp.status).toBe(204);
    const insert = log.batches[0].find((s) => /INSERT INTO play_events/.test(s.sql));
    expect(insert.args[2]).toBe(300);
  });

  it('counts a play when cumulative seconds cross the 5s threshold', async () => {
    const { env, log } = playEnv((sql) =>
      /SUM\(seconds\)/.test(sql) ? { total: 0 } : mixExists(sql));
    await handleTrack(playRequest({ mixId: 'm1', sessionId: SESSION, seconds: 30 }), env, PLAY);
    const upsert = log.batches[0].find((s) => /mix_stats/.test(s.sql));
    expect(upsert.args[1]).toBe(1);
  });

  it('does not double-count a session already past the threshold', async () => {
    const { env, log } = playEnv((sql) =>
      /SUM\(seconds\)/.test(sql) ? { total: 10 } : mixExists(sql));
    await handleTrack(playRequest({ mixId: 'm1', sessionId: SESSION, seconds: 30 }), env, PLAY);
    const upsert = log.batches[0].find((s) => /mix_stats/.test(s.sql));
    expect(upsert.args[1]).toBe(0);
  });

  it('silently drops events past the per-minute budget', async () => {
    const { env, log } = playEnv((sql) =>
      /COUNT\(\*\)/.test(sql) ? { n: 6 } : mixExists(sql));
    const resp = await handleTrack(playRequest({ mixId: 'm1', sessionId: SESSION, seconds: 30 }), env, PLAY);
    expect(resp.status).toBe(204);
    expect(log.batches).toHaveLength(0);
  });

  it('rate check failures fail open and still record', async () => {
    const { env, log } = playEnv((sql) => {
      if (/COUNT\(\*\)/.test(sql)) throw new Error('boom');
      return mixExists(sql);
    });
    const resp = await handleTrack(playRequest({ mixId: 'm1', sessionId: SESSION, seconds: 30 }), env, PLAY);
    expect(resp.status).toBe(204);
    expect(log.batches).toHaveLength(1);
  });

  it('records the edge country code, uppercased', async () => {
    const { env, log } = playEnv(mixExists);
    await handleTrack(
      playRequest({ mixId: 'm1', sessionId: SESSION, seconds: 30 }, { country: 'de' }), env, PLAY);
    const insert = log.batches[0].find((s) => /INSERT INTO play_events/.test(s.sql));
    expect(insert.sql).toMatch(/country/);
    expect(insert.args[3]).toBe('DE');
  });

  it('records NULL country when request.cf is absent (local dev)', async () => {
    const { env, log } = playEnv(mixExists);
    await handleTrack(playRequest({ mixId: 'm1', sessionId: SESSION, seconds: 30 }), env, PLAY);
    const insert = log.batches[0].find((s) => /INSERT INTO play_events/.test(s.sql));
    expect(insert.args[3]).toBeNull();
  });

  it('insert and stats upsert run as one atomic batch', async () => {
    const { env, log } = playEnv(mixExists);
    await handleTrack(playRequest({ mixId: 'm1', sessionId: SESSION, seconds: 30 }), env, PLAY);
    expect(log.batches).toHaveLength(1);
    expect(log.batches[0].map((s) => s.sql)).toEqual([
      expect.stringMatching(/INSERT INTO play_events/),
      expect.stringMatching(/INSERT INTO mix_stats/),
    ]);
  });
});
