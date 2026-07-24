import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt } from '../worker/src/jwt.js';

const SECRET = 'test-secret';

describe('signJwt / verifyJwt', () => {
  it('round-trips a payload and adds iat/exp', async () => {
    const token = await signJwt({ sub: 'u1', role: 'admin' }, SECRET);
    expect(token.split('.')).toHaveLength(3);
    const payload = await verifyJwt(token, SECRET);
    expect(payload).toMatchObject({ sub: 'u1', role: 'admin' });
    expect(payload.exp - payload.iat).toBe(7 * 24 * 3600);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signJwt({ sub: 'u1' }, 'other-secret');
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await signJwt({ sub: 'u1', role: 'user' }, SECRET);
    const [h, body, sig] = token.split('.');
    const forged = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    forged.role = 'admin';
    const forgedBody = Buffer.from(JSON.stringify(forged)).toString('base64url');
    expect(await verifyJwt(`${h}.${forgedBody}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signJwt({ sub: 'u1' }, SECRET, -10);
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });

  it('rejects garbage without throwing', async () => {
    for (const bad of [null, '', 'a.b', 'a.b.c.d', 'not-a-token', 42]) {
      expect(await verifyJwt(bad, SECRET)).toBeNull();
    }
  });
});
