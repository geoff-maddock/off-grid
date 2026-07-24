import { describe, it, expect } from 'vitest';
import { markDirty, markPublished, getPublishState } from '../worker/src/db.js';
import { handleManifest } from '../worker/src/api/manifest.js';

// In-memory publish_state emulation keyed by owner.
function mockDb({ throws = false } = {}) {
  const state = new Map();
  return {
    state,
    prepare(sql) {
      const stmt = {
        args: [],
        bind(...args) { stmt.args = args; return stmt; },
        run: async () => {
          if (throws) throw new Error('no such table: publish_state');
          const owner = stmt.args[0];
          if (/dirty, published_at\) VALUES \(\?, 0/.test(sql)) {
            state.set(owner, { dirty: 0, published_at: 'now' });
          } else {
            state.set(owner, { ...(state.get(owner) || { published_at: null }), dirty: 1 });
          }
        },
        first: async () => {
          if (throws) throw new Error('no such table: publish_state');
          if (/FROM publish_state/.test(sql)) return state.get(stmt.args[0]) || null;
          return null;
        },
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    async batch() {},
  };
}

describe('publish state helpers', () => {
  it('markDirty → dirty, markPublished → clean with a timestamp', async () => {
    const db = mockDb();
    expect(await getPublishState(db, 'u1')).toEqual({ dirty: false, publishedAt: null });
    await markDirty(db, 'u1');
    expect((await getPublishState(db, 'u1')).dirty).toBe(true);
    await markPublished(db, 'u1');
    const s = await getPublishState(db, 'u1');
    expect(s.dirty).toBe(false);
    expect(s.publishedAt).toBeTruthy();
  });

  it('fails open when the table is missing (migration 008 not applied)', async () => {
    const db = mockDb({ throws: true });
    await expect(markDirty(db, 'u1')).resolves.toBeUndefined();
    await expect(markPublished(db, 'u1')).resolves.toBeUndefined();
    expect(await getPublishState(db, 'u1')).toEqual({ dirty: false, publishedAt: null });
  });

  it('no-ops without an owner', async () => {
    const db = mockDb();
    await markDirty(db, null);
    expect(db.state.size).toBe(0);
  });
});

describe('GET /api/manifest/status', () => {
  it('returns the owner state through the handler', async () => {
    const db = mockDb();
    await markDirty(db, 'u1');
    const res = await handleManifest(
      new Request('http://x/api/manifest/status'), { DB: db }, '/api/manifest/status', 'GET', { id: 'u1' }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).dirty).toBe(true);
  });
});
