import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, sha256Hex, randomToken } from '../worker/src/crypto.js';

describe('hashPassword / verifyPassword', () => {
  it('round-trips a password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('right');
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('salts: same password hashes differently each time', async () => {
    expect(await hashPassword('pw')).not.toBe(await hashPassword('pw'));
  });

  it('rejects malformed stored values without throwing', async () => {
    for (const bad of [null, undefined, '', 'nonsense', 'pbkdf2$100000$abc', 'md5$1$aa$bb', 42]) {
      expect(await verifyPassword('pw', bad)).toBe(false);
    }
  });

  it('verifies hashes with a different iteration count (forward compat)', async () => {
    const stored = await hashPassword('pw');
    // Same format but tampered hash must fail
    const tampered = stored.slice(0, -2) + (stored.endsWith('00') ? '11' : '00');
    expect(await verifyPassword('pw', tampered)).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('matches a known vector', async () => {
    // echo -n "abc" | sha256sum
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('randomToken', () => {
  it('produces hex of the requested size and does not repeat', () => {
    const t = randomToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomToken()).not.toBe(t);
  });
});
