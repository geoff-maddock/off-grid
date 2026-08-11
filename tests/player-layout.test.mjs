// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// Importing registers the custom elements (the file has no exports).
beforeAll(async () => {
  await import('../audio-player.js');
});

// Detach players while the jsdom environment is still alive: the component's
// disconnectedCallback defers teardown to a microtask, which would otherwise
// fire after vitest deletes the `document` global.
afterEach(async () => {
  document.body.innerHTML = '';
  await new Promise((r) => setTimeout(r, 0));
});

// No `peaks` attribute anywhere in here: jsdom's canvas has no 2d context, so
// _drawStaticWaveform would throw. The layout paths under test never need it.
function makePlayer(attrs = {}) {
  const el = document.createElement('offgrid-player');
  el.setAttribute('title', 'Test Mix');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

describe('layout attribute', () => {
  it('defaults to horizontal', () => {
    const el = makePlayer();
    expect(el._layout).toBe('horizontal');
    expect(el._waveHeight()).toBe(64);
  });

  it('normalizes case and falls back on an unknown value', () => {
    expect(makePlayer({ layout: 'VERTICAL' })._layout).toBe('vertical');
    expect(makePlayer({ layout: 'sideways' })._layout).toBe('horizontal');
  });

  it('shrinks the waveform, and composes with size="slim"', () => {
    expect(makePlayer({ layout: 'vertical' })._waveHeight()).toBe(32);
    expect(makePlayer({ size: 'slim' })._waveHeight()).toBe(40);
    expect(makePlayer({ layout: 'vertical', size: 'slim' })._waveHeight()).toBe(24);
  });

  // jsdom doesn't compute the cascade for shadow styles, so assert on the
  // stylesheet text: --wave-h must be declared, not interpolated per render.
  it('declares the wave height in CSS rather than baking it in', () => {
    const css = makePlayer().shadowRoot.querySelector('style').textContent;
    expect(css).toContain(':host([layout="vertical"]) { --wave-h: 32px; }');
    expect(css).toContain(':host([layout="vertical"][size="slim"]) { --wave-h: 24px; }');
    expect(css).toContain(':host([size="slim"]) { --wave-h: 40px; }');
    expect(css).toContain(':host([layout="vertical"]) .thumb-wrap');
  });

  // The play button straddles the cover/meta seam, so .meta-row reserves a
  // right gutter for it — without one, a long title wraps under the button.
  it('reserves a gutter in the meta row for the overlapping play button', () => {
    const css = makePlayer().shadowRoot.querySelector('style').textContent;
    expect(css).toMatch(/:host\(\[layout="vertical"\]\) \.meta-row \{[^}]*padding: 12px 58px 2px 12px/);
    expect(css).toMatch(/:host\(\[layout="vertical"\]\[size="slim"\]\) \.meta-row \{[^}]*padding-right: 50px/);
  });

  // The reason this feature is CSS-driven: a rebuild would stop playback (#49).
  it('does not re-render the shadow DOM when the layout flips', () => {
    const el = makePlayer();
    const playBtn = el.shadowRoot.querySelector('.play-btn');
    const waveform = el.shadowRoot.getElementById('waveform');

    el.setAttribute('layout', 'vertical');
    el.removeAttribute('layout');
    el.setAttribute('layout', 'vertical');

    expect(el.shadowRoot.querySelector('.play-btn')).toBe(playBtn);
    expect(el.shadowRoot.getElementById('waveform')).toBe(waveform);
  });

  it('pushes the new height into WaveSurfer for both layout and size', () => {
    const el = makePlayer();
    // destroy() is stubbed too — disconnectedCallback tears the instance down.
    el._ws = { setOptions: vi.fn(), destroy: vi.fn() };

    el.setAttribute('layout', 'vertical');
    expect(el._ws.setOptions).toHaveBeenCalledWith({ height: 32 });

    el.setAttribute('size', 'slim');
    expect(el._ws.setOptions).toHaveBeenLastCalledWith({ height: 24 });
  });

  it('is a no-op before WaveSurfer exists', () => {
    const el = makePlayer();
    expect(el._ws).toBeFalsy();
    expect(() => el.setAttribute('layout', 'vertical')).not.toThrow();
  });
});

describe('layout in embed snippets', () => {
  it('round-trips a vertical player', () => {
    const code = makePlayer({ src: 'https://example.com/a.mp3', layout: 'vertical' })._generateEmbedCode();
    expect(code).toContain('layout="vertical"');
  });

  it('omits the attribute for a default player', () => {
    const code = makePlayer({ src: 'https://example.com/a.mp3' })._generateEmbedCode();
    expect(code).not.toContain('layout=');
  });
});

describe('playlist layout forwarding', () => {
  const TRACKS = [
    { title: 'One', src: 'https://example.com/1.mp3' },
    { title: 'Two', src: 'https://example.com/2.mp3' },
  ];

  function makePlaylist(attrs = {}) {
    const el = document.createElement('offgrid-playlist');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    el.tracks = TRACKS;
    return el;
  }

  const inner = (el) => el.shadowRoot.querySelector('#player-slot offgrid-player');

  it('forwards layout to the mounted player', () => {
    expect(inner(makePlaylist({ layout: 'vertical' })).getAttribute('layout')).toBe('vertical');
    expect(inner(makePlaylist()).hasAttribute('layout')).toBe(false);
  });

  it('forwards live changes, including removal', () => {
    const el = makePlaylist({ layout: 'vertical' });
    el.setAttribute('layout', 'horizontal');
    expect(inner(el).getAttribute('layout')).toBe('horizontal');
    el.removeAttribute('layout');
    expect(inner(el).hasAttribute('layout')).toBe(false);
  });

  it('includes layout in its embed snippet', () => {
    expect(makePlaylist({ layout: 'vertical' })._generateEmbedCode()).toContain('layout="vertical"');
    expect(makePlaylist()._generateEmbedCode()).not.toContain('layout=');
  });
});
