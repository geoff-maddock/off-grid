import { describe, it, expect } from 'vitest';
import { parseBucketName, ffmpegArgs } from '../generate-share-videos.mjs';

describe('parseBucketName', () => {
  it('reads bucket_name from a wrangler.toml [[r2_buckets]] block', () => {
    const toml = [
      'name = "offgrid-api"',
      '[[r2_buckets]]',
      'binding = "BUCKET"',
      'bucket_name = "offgrid-media"',
    ].join('\n');
    expect(parseBucketName(toml)).toBe('offgrid-media');
  });

  it('returns empty when no bucket_name is present', () => {
    expect(parseBucketName('name = "offgrid-api"')).toBe('');
    expect(parseBucketName('')).toBe('');
  });
});

describe('ffmpegArgs', () => {
  const args = ffmpegArgs('/tmp/cover.jpg', '/tmp/mix.mp3', '/tmp/out.mp4');

  it('builds a still-image + AAC recipe with streaming-safe flags', () => {
    for (const required of [
      '-loop', '-tune', 'stillimage', 'yuv420p', '-shortest', '+faststart', 'aac',
    ]) {
      expect(args).toContain(required);
    }
    expect(args[args.length - 1]).toBe('/tmp/out.mp4');
    expect(args).toContain('/tmp/cover.jpg');
    expect(args).toContain('/tmp/mix.mp3');
  });

  it('pads to the fixed 720x720 the share pages advertise', () => {
    expect(args.join(' ')).toContain('scale=720:720');
    expect(args.join(' ')).toContain('pad=720:720');
  });
});
