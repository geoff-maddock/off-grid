import { describe, it, expect } from 'vitest';
import {
  parseDatabaseId, parseWorkerUrl, parseAccountId, parsePublicBucketUrl,
} from '../scripts/setup.mjs';

describe('wrangler output parsers', () => {
  it('parseDatabaseId reads d1 create output (toml and json styles)', () => {
    expect(parseDatabaseId(`
      [[d1_databases]]
      binding = "DB"
      database_name = "offgrid-db"
      database_id = "1234abcd-12ab-34cd-56ef-1234567890ab"
    `)).toBe('1234abcd-12ab-34cd-56ef-1234567890ab');
    expect(parseDatabaseId('"database_id": "abcdef01-2345-6789-abcd-ef0123456789"'))
      .toBe('abcdef01-2345-6789-abcd-ef0123456789');
    expect(parseDatabaseId('no ids here')).toBeNull();
    expect(parseDatabaseId('')).toBeNull();
  });

  it('parseWorkerUrl finds the deployed workers.dev URL', () => {
    expect(parseWorkerUrl(`
      Uploaded offgrid-api (3.22 sec)
      Deployed offgrid-api triggers (0.24 sec)
        https://offgrid-api.someone.workers.dev
      Current Version ID: 0000
    `)).toBe('https://offgrid-api.someone.workers.dev');
    expect(parseWorkerUrl('nothing deployed')).toBeNull();
  });

  it('parseAccountId finds a 32-hex account id', () => {
    const id = 'a'.repeat(31) + 'b';
    expect(parseAccountId(`Account ID: ${id}`)).toBe(id);
    expect(parseAccountId('Account ID: tooshort')).toBeNull();
  });

  it('parsePublicBucketUrl finds the pub-*.r2.dev URL', () => {
    expect(parsePublicBucketUrl('Public URL: https://pub-0123456789abcdef.r2.dev/'))
      .toBe('https://pub-0123456789abcdef.r2.dev');
    expect(parsePublicBucketUrl('bucket is private')).toBeNull();
  });
});
