import { describe, it, expect } from 'vitest';
import { handleUsers } from '../worker/src/api/users.js';

// Mock D1 for the deleteUser path: routes each SELECT/DELETE by its SQL.
function mockDb({ targetRole = 'user', admins = 2, ownedMixes = 0, ownedPlaylists = 0 } = {}) {
  const deletes = [];
  return {
    deletes,
    prepare(sql) {
      const stmt = {
        bind: () => stmt,
        first: async () => {
          if (/FROM users WHERE id/.test(sql)) return { role: targetRole };
          if (/COUNT\(\*\).*FROM users/.test(sql)) return { n: admins };
          if (/FROM mixes/.test(sql)) return { n: ownedMixes };
          if (/FROM playlists/.test(sql)) return { n: ownedPlaylists };
          return null;
        },
        run: async () => { deletes.push(sql); },
      };
      return stmt;
    },
  };
}

const admin = { id: 'admin-1', role: 'admin' };
const del = (env, id = 'u2') =>
  handleUsers(new Request(`http://x/api/users/${id}`, { method: 'DELETE' }), env, `/api/users/${id}`, 'DELETE', admin);

describe('DELETE /api/users/:id content guard', () => {
  it('blocks with 409 while the user owns mixes', async () => {
    const db = mockDb({ ownedMixes: 3 });
    const res = await del({ DB: db });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/3 mix\(es\)/);
    expect(db.deletes).toHaveLength(0); // nothing deleted
  });

  it('blocks with 409 while the user owns playlists', async () => {
    const db = mockDb({ ownedPlaylists: 1 });
    const res = await del({ DB: db });
    expect(res.status).toBe(409);
    expect(db.deletes).toHaveLength(0);
  });

  it('deletes a user with no content', async () => {
    const db = mockDb();
    const res = await del({ DB: db });
    expect(res.status).toBe(200);
    expect(db.deletes).toEqual([expect.stringMatching(/DELETE FROM users/)]);
  });

  it('still refuses self-deletion and the last admin', async () => {
    const dbSelf = mockDb();
    const self = await handleUsers(
      new Request('http://x/api/users/admin-1', { method: 'DELETE' }),
      { DB: dbSelf }, '/api/users/admin-1', 'DELETE', admin
    );
    expect(self.status).toBe(400);

    const dbLast = mockDb({ targetRole: 'admin', admins: 1 });
    const last = await del({ DB: dbLast });
    expect(last.status).toBe(400);
    expect(dbLast.deletes).toHaveLength(0);
  });
});
