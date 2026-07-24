import { describe, it, expect } from 'vitest';
import {
  uniqueKey, validateUpload, keyFromPublicUrl, cleanupDeletedFiles, handleDirectUpload,
} from '../worker/src/r2.js';

describe('uniqueKey', () => {
  it('inserts a random suffix before the extension', () => {
    expect(uniqueKey('users/u1/covers/cover.jpg')).toMatch(/^users\/u1\/covers\/cover-[0-9a-f]{8}\.jpg$/);
    expect(uniqueKey('users/u1/peaks/mix.peaks.json')).toMatch(/^users\/u1\/peaks\/mix\.peaks-[0-9a-f]{8}\.json$/);
    expect(uniqueKey('users/u1/audio/noext')).toMatch(/^users\/u1\/audio\/noext-[0-9a-f]{8}$/);
  });

  it('never repeats', () => {
    expect(uniqueKey('a/b.jpg')).not.toBe(uniqueKey('a/b.jpg'));
  });
});

describe('validateUpload', () => {
  const v = validateUpload;
  it('accepts valid uploads per prefix', () => {
    expect(v('users/u1/covers/a.jpg', 'image/jpeg', 1000)).toBeNull();
    expect(v('users/u1/audio/mix.mp3', 'audio/mpeg', 1e8)).toBeNull();
    expect(v('users/u1/audio/mix.m4a', 'audio/x-m4a', 1e8)).toBeNull();
    expect(v('users/u1/audio/mix.m4a', 'video/mp4', 1e8)).toBeNull();
    expect(v('users/u1/audio/mix.flac', 'application/octet-stream', 1e8)).toBeNull();
    expect(v('users/u1/peaks/mix.peaks.json', 'application/json', 1e5)).toBeNull();
    expect(v('users/u1/peaks/a.json', 'application/json; charset=utf-8', 10)).toBeNull();
    expect(v('users/u1/covers/a.png', 'image/png', NaN)).toBeNull(); // unknown size allowed
  });

  it('rejects wrong types, extensions, prefixes, and oversizes', () => {
    expect(v('users/u1/covers/a.html', 'text/html', 10)).toBeTruthy();
    expect(v('users/u1/covers/a.svg', 'image/svg+xml', 10)).toBeTruthy();
    expect(v('users/u1/covers/a.jpg', 'application/octet-stream', 10)).toBeTruthy();
    expect(v('users/u1/audio/a.exe', 'audio/mpeg', 10)).toBeTruthy();
    expect(v('users/u1/stuff/a.jpg', 'image/jpeg', 10)).toBeTruthy();
    expect(v('users/u1/covers', 'image/jpeg', 10)).toBeTruthy();
    expect(v('users/u1/covers/a.jpg', 'image/jpeg', 11 * 1024 * 1024)).toBeTruthy();
    expect(v('users/u1/audio/a.mp3', 'audio/mpeg', 501 * 1024 * 1024)).toBeTruthy();
    expect(v('users/u1/audio/noext', 'audio/mpeg', 10)).toBeTruthy();
  });
});

describe('handleDirectUpload', () => {
  const user = { id: 'u1' };
  const setup = () => {
    const puts = [];
    const env = {
      DB: null,
      BUCKET: { put: async (key, _body, opts) => puts.push({ key, contentType: opts.httpMetadata.contentType }) },
    };
    return { env, puts };
  };
  const req = (headers) =>
    new Request('http://x/upload', { method: 'POST', body: 'x', headers, duplex: 'half' });

  it('stores under the user namespace with a unique suffix and echoes the key', async () => {
    const { env, puts } = setup();
    const r1 = await (await handleDirectUpload(req({ 'X-File-Key': 'covers/c.jpg', 'Content-Type': 'image/jpeg' }), env, user)).json();
    const r2 = await (await handleDirectUpload(req({ 'X-File-Key': 'covers/c.jpg', 'Content-Type': 'image/jpeg' }), env, user)).json();
    expect(puts[0].key).toMatch(/^users\/u1\/covers\/c-[0-9a-f]{8}\.jpg$/);
    expect(r1.key).toBe(puts[0].key);
    expect(r1.key).not.toBe(r2.key); // same filename twice → no overwrite
    expect(puts[0].contentType).toBe('image/jpeg');
  });

  it('rejects traversal and invalid types with 400', async () => {
    const { env, puts } = setup();
    expect((await handleDirectUpload(req({ 'X-File-Key': '../evil' }), env, user)).status).toBe(400);
    expect((await handleDirectUpload(req({ 'X-File-Key': 'covers/a.html', 'Content-Type': 'text/html' }), env, user)).status).toBe(400);
    expect(puts).toHaveLength(0);
  });
});

describe('keyFromPublicUrl', () => {
  const env = { R2_PUBLIC_URL: 'https://pub-abc.r2.dev' };
  it('maps own-namespace URLs and strips query/hash', () => {
    expect(keyFromPublicUrl('https://pub-abc.r2.dev/users/u1/covers/a.jpg', env, 'u1')).toBe('users/u1/covers/a.jpg');
    expect(keyFromPublicUrl('https://pub-abc.r2.dev/users/u1/audio/m.mp3?v=2#t', env, 'u1')).toBe('users/u1/audio/m.mp3');
  });
  it('refuses everything else', () => {
    expect(keyFromPublicUrl('https://example.com/users/u1/covers/a.jpg', env, 'u1')).toBeNull();
    expect(keyFromPublicUrl('https://pub-abc.r2.dev/users/u2/covers/a.jpg', env, 'u1')).toBeNull();
    expect(keyFromPublicUrl('https://pub-abc.r2.dev/covers/a.jpg', env, 'u1')).toBeNull(); // legacy root
    expect(keyFromPublicUrl('https://pub-abc.r2.dev/users/u1/covers/a.jpg', {}, 'u1')).toBeNull();
    expect(keyFromPublicUrl('https://pub-abc.r2.dev/users/u1/covers/a.jpg', env, null)).toBeNull();
    expect(keyFromPublicUrl('https://pub-abc.r2.dev/users/u1/../u2/x.jpg', env, 'u1')).toBeNull();
    expect(keyFromPublicUrl('covers/a.jpg', env, 'u1')).toBeNull();
    expect(keyFromPublicUrl('', env, 'u1')).toBeNull();
  });
});

describe('cleanupDeletedFiles', () => {
  const OWN = 'https://pub-abc.r2.dev/users/u1/covers/a.jpg';
  const setup = ({ mixRef = null, plRef = null, deleteThrows = false } = {}) => {
    const deleted = [];
    const db = {
      prepare: (sql) => ({
        bind: () => ({ first: async () => (/FROM mixes/.test(sql) ? mixRef : plRef) }),
      }),
    };
    const env = {
      R2_PUBLIC_URL: 'https://pub-abc.r2.dev',
      BUCKET: { delete: async (k) => { if (deleteThrows) throw new Error('boom'); deleted.push(k); } },
    };
    return { db, env, deleted };
  };

  it('deletes an unreferenced own file, skipping non-candidates', async () => {
    const { db, env, deleted } = setup();
    await cleanupDeletedFiles(env, db, 'u1', [OWN, null, '', 'https://example.com/x.jpg']);
    expect(deleted).toEqual(['users/u1/covers/a.jpg']);
  });

  it('keeps files still referenced by a mix or playlist', async () => {
    for (const refs of [{ mixRef: { id: 'm' } }, { plRef: { id: 'p' } }]) {
      const { db, env, deleted } = setup(refs);
      await cleanupDeletedFiles(env, db, 'u1', [OWN]);
      expect(deleted).toHaveLength(0);
    }
  });

  it('never propagates R2 or D1 failures', async () => {
    const { db, env } = setup({ deleteThrows: true });
    await expect(cleanupDeletedFiles(env, db, 'u1', [OWN])).resolves.toBeUndefined();
    const badDb = { prepare() { throw new Error('db down'); } };
    await expect(cleanupDeletedFiles(env, badDb, 'u1', [OWN])).resolves.toBeUndefined();
  });
});
