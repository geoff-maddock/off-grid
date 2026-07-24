import { describe, it, expect } from 'vitest';
import { AwsClient } from '../worker/src/aws-sign.js';

const client = () => new AwsClient({
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  service: 's3',
  region: 'auto',
});

describe('AwsClient presigned PUT (signQuery)', () => {
  it('produces a well-formed SigV4 presigned URL', async () => {
    const { url } = await client().sign(
      'https://acct.r2.cloudflarestorage.com/bucket/users/u1/audio/mix.mp3',
      { method: 'PUT', headers: { 'Content-Type': 'audio/mpeg' }, aws: { signQuery: true, expiresIn: 3600 } }
    );
    const u = new URL(url);
    expect(u.host).toBe('acct.r2.cloudflarestorage.com');
    expect(u.pathname).toBe('/bucket/users/u1/audio/mix.mp3');
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Credential')).toMatch(/^AKIAEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signature depends on the key path', async () => {
    const a = await client().sign('https://h.example/b/k1', { method: 'PUT', aws: { signQuery: true, expiresIn: 60 } });
    const b = await client().sign('https://h.example/b/k2', { method: 'PUT', aws: { signQuery: true, expiresIn: 60 } });
    expect(new URL(a.url).searchParams.get('X-Amz-Signature'))
      .not.toBe(new URL(b.url).searchParams.get('X-Amz-Signature'));
  });
});
