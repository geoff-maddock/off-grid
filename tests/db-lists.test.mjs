import { describe, it, expect } from 'vitest';
import { listMixes, listPlaylists } from '../worker/src/db.js';

// Mock D1 that routes queries: the parent-table SELECT returns `rows`, the
// IN(...) child query returns `children` filtered to the bound ids.
function mockDb({ rows = [], children = [] } = {}) {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      return {
        bind: (...args) => ({
          all: async () => {
            queries.push({ sql, args });
            if (/FROM mixes|FROM playlists/.test(sql)) return { results: rows };
            const idKey = /mix_tracks/.test(sql) ? 'mix_id' : 'playlist_id';
            return { results: children.filter((c) => args.includes(c[idKey])) };
          },
          first: async () => null,
        }),
      };
    },
  };
}

const mixRow = (id) => ({
  id, title: `T-${id}`, artist: '', description: '', src: 'a.mp3', thumb: '',
  peaks: '', color: '#fff', tags: '[]', duration: 60, release_date: null,
  created_at: null, sort_order: 0, tracklist: '',
});

describe('listMixes batching', () => {
  it('loads all tracks with exactly one extra query and groups them per mix', async () => {
    const db = mockDb({
      rows: [mixRow('a'), mixRow('b'), mixRow('c')],
      children: [
        { mix_id: 'a', position: 0, time: '0:00', time_seconds: 0, artist: 'x', title: 't1', url: '' },
        { mix_id: 'c', position: 0, time: '0:00', time_seconds: 0, artist: 'y', title: 't2', url: '' },
        { mix_id: 'c', position: 1, time: '1:00', time_seconds: 60, artist: 'y', title: 't3', url: '' },
      ],
    });
    const mixes = await listMixes(db, {});
    expect(db.queries).toHaveLength(2); // 1 for mixes + 1 IN(...) for all tracks
    expect(db.queries[1].sql).toMatch(/WHERE mix_id IN \(\?, \?, \?\)/);
    expect(mixes.find((m) => m.id === 'a').tracks).toHaveLength(1);
    expect(mixes.find((m) => m.id === 'b').tracks).toHaveLength(0);
    expect(mixes.find((m) => m.id === 'c').tracks.map((t) => t.title)).toEqual(['t2', 't3']);
  });

  it('skips the child query entirely for an empty library', async () => {
    const db = mockDb();
    expect(await listMixes(db, {})).toEqual([]);
    expect(db.queries).toHaveLength(1);
  });

  it('chunks the IN(...) query to stay under D1 parameter limits', async () => {
    const db = mockDb({ rows: Array.from({ length: 200 }, (_, i) => mixRow(`m${i}`)) });
    await listMixes(db, {});
    expect(db.queries).toHaveLength(1 + 3); // ceil(200 / 90)
  });

  it('applies limit/offset only when provided', async () => {
    const db = mockDb({ rows: [mixRow('a')] });
    await listMixes(db, { limit: 10, offset: 20 });
    expect(db.queries[0].sql).toMatch(/LIMIT \? OFFSET \?$/);
    expect(db.queries[0].args.slice(-2)).toEqual([10, 20]);

    const db2 = mockDb({ rows: [mixRow('a')] });
    await listMixes(db2, {});
    expect(db2.queries[0].sql).not.toMatch(/LIMIT/);
  });
});

describe('listPlaylists batching', () => {
  const plRow = (id) => ({
    id, title: `P-${id}`, description: '', creator: '', thumb: '', color: '#fff', sort_order: 0,
  });

  it('loads members with one query, grouped in position order', async () => {
    const db = mockDb({
      rows: [plRow('p1'), plRow('p2')],
      children: [
        { playlist_id: 'p1', mix_id: 'a' },
        { playlist_id: 'p1', mix_id: 'b' },
        { playlist_id: 'p2', mix_id: 'c' },
      ],
    });
    const pls = await listPlaylists(db, 'u1');
    expect(db.queries).toHaveLength(2);
    expect(db.queries[0].args[0]).toBe('u1'); // owner scoping preserved
    expect(pls.find((p) => p.id === 'p1').mixIds).toEqual(['a', 'b']);
    expect(pls.find((p) => p.id === 'p2').mixIds).toEqual(['c']);
  });

  it('supports limit/offset', async () => {
    const db = mockDb({ rows: [plRow('p1')] });
    await listPlaylists(db, null, { limit: 5, offset: 10 });
    expect(db.queries[0].sql).toMatch(/LIMIT \? OFFSET \?$/);
    expect(db.queries[0].args).toEqual([5, 10]);
  });
});
