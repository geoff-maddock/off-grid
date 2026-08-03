// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

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

const TRACKS = [
  { time: '01:00', seconds: 60, artist: 'Artist A', title: 'Opening Track', url: 'https://example.com/a' },
  { time: '05:00', seconds: 300, artist: 'Artist B', title: 'Second Track' },
];

function makePlayer(tracks = TRACKS) {
  const el = document.createElement('offgrid-player');
  el.setAttribute('title', 'Test Mix');
  document.body.appendChild(el);
  el.tracks = tracks;
  return el;
}

// The row is a persistent container (skip buttons + text span); the label
// itself lives in #np-text, while `hidden` is toggled on the container.
function np(el) {
  const row = el.shadowRoot.getElementById('now-playing');
  const text = el.shadowRoot.getElementById('np-text');
  return {
    get hidden() { return row.hidden; },
    get innerHTML() { return text.innerHTML; },
    get textContent() { return text.textContent; },
    querySelector: (sel) => text.querySelector(sel),
  };
}

describe('now-playing label', () => {
  it('stays hidden before playback starts, even as position updates', () => {
    const el = makePlayer();
    expect(np(el).hidden).toBe(true);
    el._updateActiveTrack(100);
    expect(np(el).hidden).toBe(true);
    expect(np(el).innerHTML).toBe('');
  });

  it('shows after playback starts and follows cue crossings', () => {
    const el = makePlayer();
    el._npStarted = true;
    el._updateNowPlaying(el._msTrackIndexAt(60));
    expect(np(el).hidden).toBe(false);
    expect(np(el).textContent).toBe('Now playing: Artist A – Opening Track');
    el._updateActiveTrack(300);
    expect(np(el).textContent).toBe('Now playing: Artist B – Second Track');
  });

  it('links only safe http(s) urls and escapes metadata', () => {
    const el = makePlayer([
      { seconds: 0, artist: '<b>Evil</b>', title: 'Track', url: 'https://example.com/x' },
      { seconds: 60, artist: 'Plain', title: 'NoUrl' },
      { seconds: 120, artist: 'Bad', title: 'Scheme', url: 'javascript:alert(1)' },
    ]);
    el._npStarted = true;

    el._updateNowPlaying(0);
    const a = np(el).querySelector('a');
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toBe('https://example.com/x');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener');
    expect(np(el).querySelector('b')).toBeNull();
    expect(np(el).textContent).toContain('<b>Evil</b>');

    el._updateNowPlaying(1);
    expect(np(el).querySelector('a')).toBeNull();

    el._updateNowPlaying(2);
    expect(np(el).querySelector('a')).toBeNull();
    expect(np(el).textContent).toContain('Bad – Scheme');
  });

  it('handles partial and missing metadata', () => {
    const el = makePlayer([
      { seconds: 0, artist: 'Only Artist' },
      { seconds: 60, title: 'Only Title' },
      { seconds: 120 },
    ]);
    el._npStarted = true;

    el._updateNowPlaying(0);
    expect(np(el).textContent).toBe('Now playing: Only Artist');
    el._updateNowPlaying(1);
    expect(np(el).textContent).toBe('Now playing: Only Title');
    el._updateNowPlaying(2);
    expect(np(el).textContent).toBe('Now playing: untitled');
    expect(np(el).querySelector('em')).toBeTruthy();
  });

  it('hides again when seeking before the first cue', () => {
    const el = makePlayer();
    el._npStarted = true;
    el._updateActiveTrack(100);
    expect(np(el).hidden).toBe(false);
    el._updateActiveTrack(5); // first cue is at 60
    expect(np(el).hidden).toBe(true);
    expect(np(el).innerHTML).toBe('');
  });

  it('clears when the tracklist is removed and re-syncs when replaced', () => {
    const el = makePlayer();
    el._npStarted = true;
    el._updateActiveTrack(100);
    expect(np(el).hidden).toBe(false);

    el.tracks = [];
    expect(np(el).hidden).toBe(true);
    expect(np(el).innerHTML).toBe('');

    el.tracks = TRACKS;
    el._updateActiveTrack(300);
    expect(np(el).textContent).toBe('Now playing: Artist B – Second Track');
  });
});

describe('now-playing skip buttons', () => {
  function makePlayable(t) {
    const el = makePlayer();
    el._npStarted = true;
    const calls = [];
    // Includes what disconnectedCallback's teardown touches (destroy etc.).
    el._ws = { getCurrentTime: () => t, isPlaying: () => false, pause: () => {}, destroy: () => {} };
    el._wsSeek = (s) => calls.push(s);
    return { el, calls };
  }

  it('next jumps to the next cue and no-ops on the last track', () => {
    const { el, calls } = makePlayable(100); // cues at 60, 300
    el.shadowRoot.getElementById('np-next').click();
    expect(calls).toEqual([300]);

    const last = makePlayable(400);
    last.el.shadowRoot.getElementById('np-next').click();
    expect(last.calls).toEqual([]);
  });

  it('back restarts the current track when >3s in, else jumps to the previous cue', () => {
    const { el, calls } = makePlayable(100); // 40s into the 60s cue
    el.shadowRoot.getElementById('np-prev').click();
    expect(calls).toEqual([60]);

    const early = makePlayable(302); // 2s into the 300s cue
    early.el.shadowRoot.getElementById('np-prev').click();
    expect(early.calls).toEqual([60]);

    const first = makePlayable(61); // 1s into the first cue
    first.el.shadowRoot.getElementById('np-prev').click();
    expect(first.calls).toEqual([0]);
  });
});

describe('now-playing responsive placement', () => {
  // jsdom has no ResizeObserver, so the observer setup is skipped; drive the
  // move method directly (the observer just calls it with width <= 520).
  it('moves below the waveform on narrow players and back into the meta column', () => {
    const el = makePlayer();
    const row = el.shadowRoot.getElementById('now-playing');
    const slot = el.shadowRoot.getElementById('np-below-slot');
    const meta = el.shadowRoot.querySelector('.meta-row');
    expect(row.parentNode).toBe(meta);

    el._placeNowPlaying(true);
    expect(row.parentNode).toBe(slot);
    el._placeNowPlaying(true); // idempotent
    expect(row.parentNode).toBe(slot);

    // The label keeps updating in its new home.
    el._npStarted = true;
    el._updateNowPlaying(0);
    expect(np(el).textContent).toBe('Now playing: Artist A – Opening Track');

    el._placeNowPlaying(false);
    expect(row.parentNode).toBe(meta);
    // Back in its original spot: just above the time row.
    expect(row.nextElementSibling).toBe(meta.querySelector('.time-row'));
  });
});

describe('_msTrackIndexAt', () => {
  it('returns the last cue at or before t, skipping non-finite seconds', () => {
    const el = makePlayer([
      { seconds: 60, title: 'A' },
      { time: '??', title: 'no-seconds' },
      { seconds: 300, title: 'B' },
    ]);
    expect(el._msTrackIndexAt(0)).toBe(-1);
    expect(el._msTrackIndexAt(59.9)).toBe(-1);
    expect(el._msTrackIndexAt(60)).toBe(0);
    expect(el._msTrackIndexAt(299)).toBe(0);
    expect(el._msTrackIndexAt(300)).toBe(2);
    expect(el._msTrackIndexAt(10000)).toBe(2);
  });
});
