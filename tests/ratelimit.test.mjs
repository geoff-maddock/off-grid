import { describe, it, expect, vi, afterEach } from 'vitest';
import { tooManyAttempts, recordFailedLogin, clearFailedLogins } from '../worker/src/ratelimit.js';

// Recording mock D1: configure the COUNT the SELECT returns; log all runs.
function mockDb({ count = 0, throws = false } = {}) {
  const runs = [];
  return {
    runs,
    prepare(sql) {
      if (throws) throw new Error('d1 down');
      return {
        bind: (...args) => ({
          first: async () => ({ n: count }),
          run: async () => { runs.push({ sql, args }); },
        }),
      };
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('tooManyAttempts', () => {
  it('is false below the limit and true at it', async () => {
    expect(await tooManyAttempts(mockDb({ count: 9 }), '1.2.3.4')).toBe(false);
    expect(await tooManyAttempts(mockDb({ count: 10 }), '1.2.3.4')).toBe(true);
  });

  it('disables limiting with no ip', async () => {
    expect(await tooManyAttempts(mockDb({ count: 999 }), '')).toBe(false);
  });

  it('fails open on a D1 error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await tooManyAttempts(mockDb({ throws: true }), '1.2.3.4')).toBe(false);
  });
});

describe('recordFailedLogin', () => {
  it('inserts the attempt (no prune when random is high)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const db = mockDb();
    await recordFailedLogin(db, '1.2.3.4', 'x@y.z');
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].sql).toMatch(/INSERT INTO login_attempts/);
    expect(db.runs[0].args).toEqual(['1.2.3.4', 'x@y.z']);
  });

  it('prunes aged rows when the dice say so', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const db = mockDb();
    await recordFailedLogin(db, '1.2.3.4', null);
    expect(db.runs).toHaveLength(2);
    expect(db.runs[1].sql).toMatch(/DELETE FROM login_attempts WHERE created_at/);
  });

  it('does nothing with no ip, and never throws on D1 errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = mockDb();
    await recordFailedLogin(db, '', 'x@y.z');
    expect(db.runs).toHaveLength(0);
    await expect(recordFailedLogin(mockDb({ throws: true }), '1.2.3.4', 'x')).resolves.toBeUndefined();
  });
});

describe('clearFailedLogins', () => {
  it('deletes the ip rows and fails open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = mockDb();
    await clearFailedLogins(db, '1.2.3.4');
    expect(db.runs[0].sql).toMatch(/DELETE FROM login_attempts WHERE ip/);
    await expect(clearFailedLogins(mockDb({ throws: true }), '1.2.3.4')).resolves.toBeUndefined();
  });
});
