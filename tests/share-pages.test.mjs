import { describe, it, expect } from 'vitest';
import { r2BaseFrom, videoUrlFor, renderPage } from '../generate-share-pages.mjs';

const SITE = { title: 'Off Grid' };
const BASE = 'https://example.com/audio';

function mix(overrides = {}) {
  return {
    id: 'test-mix',
    title: 'Test Mix',
    artist: 'DJ Test',
    description: 'A test mix.',
    src: 'https://pub-x.r2.dev/audio/test-mix-final1.mp3',
    thumb: 'https://pub-x.r2.dev/covers/test-mix.jpg',
    duration: 3600,
    ...overrides,
  };
}

describe('r2BaseFrom', () => {
  it('strips /data/manifest.json from a manifest URL', () => {
    expect(r2BaseFrom('https://pub-x.r2.dev/data/manifest.json')).toBe('https://pub-x.r2.dev');
  });

  it('strips per-user manifest paths down to their base', () => {
    expect(r2BaseFrom('https://pub-x.r2.dev/users/u1/data/manifest.json')).toBe('https://pub-x.r2.dev/users/u1');
  });

  it('prefers an explicit override, trimming trailing slashes', () => {
    expect(r2BaseFrom('https://pub-x.r2.dev/data/manifest.json', 'https://cdn.example.com/')).toBe('https://cdn.example.com');
  });

  it('returns empty for local file paths (no base to derive)', () => {
    expect(r2BaseFrom('data/manifest.json')).toBe('');
    expect(r2BaseFrom('/abs/path/manifest.json')).toBe('');
  });
});

describe('videoUrlFor', () => {
  it('derives video/<slug>.mp4 under the r2 base', () => {
    expect(videoUrlFor(mix(), 'https://pub-x.r2.dev')).toBe('https://pub-x.r2.dev/video/test-mix.mp4');
  });

  it('returns empty without a base or with an unsafe slug', () => {
    expect(videoUrlFor(mix(), '')).toBe('');
    expect(videoUrlFor(mix({ id: '../evil' }), 'https://pub-x.r2.dev')).toBe('');
  });
});

describe('renderPage og:video', () => {
  const videoUrl = 'https://pub-x.r2.dev/video/test-mix.mp4';

  it('emits the full og:video block when a video URL is given', () => {
    const html = renderPage(mix(), SITE, BASE, videoUrl);
    expect(html).toContain(`<meta property="og:video" content="${videoUrl}">`);
    expect(html).toContain(`<meta property="og:video:secure_url" content="${videoUrl}">`);
    expect(html).toContain('<meta property="og:video:type" content="video/mp4">');
    expect(html).toContain('<meta property="og:video:width" content="720">');
    expect(html).toContain('<meta property="og:video:height" content="720">');
  });

  it('keeps the existing audio/player tags alongside og:video', () => {
    const html = renderPage(mix(), SITE, BASE, videoUrl);
    expect(html).toContain('<meta property="og:type" content="music.song">');
    expect(html).toContain('<meta property="og:audio"');
    expect(html).toContain('<meta name="twitter:card" content="player">');
    expect(html).toContain('<meta name="twitter:player"');
  });

  it('emits no og:video tags when the video URL is absent', () => {
    expect(renderPage(mix(), SITE, BASE)).not.toContain('og:video');
    expect(renderPage(mix(), SITE, BASE, '')).not.toContain('og:video');
  });

  it('HTML-escapes the video URL', () => {
    const html = renderPage(mix(), SITE, BASE, 'https://pub-x.r2.dev/video/a.mp4?x=1&y=2');
    expect(html).toContain('content="https://pub-x.r2.dev/video/a.mp4?x=1&amp;y=2"');
  });
});
