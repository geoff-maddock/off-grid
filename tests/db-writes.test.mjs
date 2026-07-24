import { describe, it, expect } from 'vitest';
import { createMix, updatePlaylist, deleteMix, deletePlaylist } from '../worker/src/db.js';

// Recording mock D1: standalone .run()s and db.batch() calls are logged
// separately so tests can assert what runs atomically.
function mockDb() {
  const log = { runs: [], batches: [] };
  const db = {
    prepare(sql) {
      const stmt = {
        sql,
        bind: () => stmt,
        run: async () => { log.runs.push(sql); },
        first: async () => null,
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    async batch(stmts) { log.batches.push(stmts.map((s) => s.sql)); },
  };
  return { db, log };
}

describe('replace-set writes are atomic', () => {
  it('createMix writes tracks as one DELETE+INSERTs batch', async () => {
    const { db, log } = mockDb();
    await createMix(db, { id: 'm1', title: 'T', src: 'a.mp3', tracks: [{ title: 'x' }, { title: 'y' }] });
    expect(log.batches).toHaveLength(1);
    const [del, ...inserts] = log.batches[0];
    expect(del).toMatch(/^DELETE FROM mix_tracks/);
    expect(inserts).toHaveLength(2);
    expect(inserts.every((s) => /^INSERT INTO mix_tracks/.test(s))).toBe(true);
    expect(log.runs.some((s) => /mix_tracks/.test(s))).toBe(false);
  });

  it('empty tracks still clears atomically', async () => {
    const { db, log } = mockDb();
    await createMix(db, { id: 'm2', title: 'T', src: 'a.mp3', tracks: [] });
    expect(log.batches).toEqual([[expect.stringMatching(/^DELETE FROM mix_tracks/)]]);
  });

  it('updatePlaylist writes members as one batch', async () => {
    const { db, log } = mockDb();
    await updatePlaylist(db, 'p1', { title: 'P', mixIds: ['a', 'b', 'c'] });
    expect(log.batches).toHaveLength(1);
    expect(log.batches[0]).toHaveLength(4);
    expect(log.batches[0][0]).toMatch(/^DELETE FROM playlist_mixes/);
  });
});

describe('deletes clear stats atomically', () => {
  it('deleteMix batches all five deletes, mixes row last', async () => {
    const { db, log } = mockDb();
    await deleteMix(db, 'm1');
    expect(log.batches).toHaveLength(1);
    const b = log.batches[0];
    expect(b).toHaveLength(5);
    expect(b.some((s) => /play_events/.test(s))).toBe(true);
    expect(b.some((s) => /mix_stats/.test(s))).toBe(true);
    expect(b[b.length - 1]).toMatch(/FROM mixes/);
  });

  it('deletePlaylist is batched', async () => {
    const { db, log } = mockDb();
    await deletePlaylist(db, 'p1');
    expect(log.batches).toEqual([[
      expect.stringMatching(/playlist_mixes/),
      expect.stringMatching(/FROM playlists/),
    ]]);
  });
});
