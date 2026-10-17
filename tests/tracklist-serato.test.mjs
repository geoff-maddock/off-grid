import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseCsv,
  clockToSeconds,
  formatOffset,
  parseSeratoHistory,
} from '../scripts/tracklist/serato.mjs';
import { toJson, toText } from '../scripts/tracklist/format.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/serato-history.csv', import.meta.url));
const CLI = fileURLToPath(new URL('../scripts/tracklist.mjs', import.meta.url));
const fixture = () => readFileSync(FIXTURE, 'utf8');

describe('parseCsv', () => {
  it('handles quoted commas, doubled quotes, CRLF and a BOM', () => {
    const rows = parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\r\n\r\n');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });
});

describe('clockToSeconds', () => {
  it('reads 24h, 12h and date-prefixed times', () => {
    expect(clockToSeconds('22:04:10')).toBe(22 * 3600 + 4 * 60 + 10);
    expect(clockToSeconds('10:04:10 PM')).toBe(22 * 3600 + 4 * 60 + 10);
    expect(clockToSeconds('12:00:05 AM')).toBe(5);
    expect(clockToSeconds('12:00:05 PM')).toBe(12 * 3600 + 5);
    expect(clockToSeconds('2026-10-10 22:04:10')).toBe(22 * 3600 + 4 * 60 + 10);
    expect(clockToSeconds('')).toBeNull();
    expect(clockToSeconds('25:00:00')).toBeNull();
  });
});

describe('formatOffset', () => {
  it('uses MM:SS under an hour and H:MM:SS after', () => {
    expect(formatOffset(0)).toBe('00:00');
    expect(formatOffset(353)).toBe('05:53');
    expect(formatOffset(3725)).toBe('1:02:05');
  });
});

// AC1: ordered JSON tracklist with artist, title and start time relative to
// the first track, for every played track.
describe('parseSeratoHistory (AC1)', () => {
  it('parses the sample export in order, relative to the first track', () => {
    const { session, tracks } = parseSeratoHistory(fixture());
    expect(session).toEqual({ name: '2026-10-10', start: '11:30:05 PM' });
    expect(tracks.map((t) => [t.position, t.time, t.artist, t.title])).toEqual([
      [1, '00:00', 'Example Artist One', 'Opening Drift'],
      [2, '05:53', 'The Placeholder Band', 'Night Bus, Part 2'],
      [3, '12:25', '', 'Untitled Dubplate'],
      [4, '18:15', 'Sample Collective', 'She Said "Later"'],
      [5, '25:10', 'Example Artist Two', 'Midnight Tool'],
      [6, '32:54', 'Fixture Sound System', 'After Hours'],
    ]);
    expect(tracks.every((t) => t.source === 'serato')).toBe(true);
  });

  it('keeps counting forward when the session crosses midnight', () => {
    const { tracks } = parseSeratoHistory(fixture());
    const after = tracks.find((t) => t.title === 'After Hours');
    expect(after.time_seconds).toBe(32 * 60 + 54);
    const secs = tracks.map((t) => t.time_seconds);
    expect([...secs].sort((a, b) => a - b)).toEqual(secs);
  });

  it('keeps rows with a blank artist', () => {
    const { tracks } = parseSeratoHistory(fixture());
    expect(tracks.find((t) => t.title === 'Untitled Dubplate').artist).toBe('');
  });

  it('matches headers by name, in any order, ignoring unknown columns', () => {
    const csv = [
      'Deck,Start Time,Extra,Artist,Name',
      ',20:00:00,,,My Session',
      '1,20:00:00,x,A,One',
      '2,21:05:30,y,B,Two',
    ].join('\n');
    const { session, tracks } = parseSeratoHistory(csv);
    expect(session.name).toBe('My Session');
    expect(tracks.map((t) => [t.time, t.artist, t.title])).toEqual([
      ['00:00', 'A', 'One'],
      ['1:05:30', 'B', 'Two'],
    ]);
  });

  it('works without a session row', () => {
    const csv = 'name,artist,start time,deck\nOne,A,20:00:00,1\nTwo,B,20:04:00,2\n';
    const { session, tracks } = parseSeratoHistory(csv);
    expect(session).toBeNull();
    expect(tracks.map((t) => t.time)).toEqual(['00:00', '04:00']);
  });

  it('drops rows a played column marks as not played', () => {
    const csv = 'name,artist,start time,deck,played\nOne,A,20:00:00,1,1\nCue,B,20:01:00,2,0\nTwo,C,20:04:00,1,yes\n';
    const { tracks } = parseSeratoHistory(csv);
    expect(tracks.map((t) => t.title)).toEqual(['One', 'Two']);
    expect(tracks.map((t) => t.position)).toEqual([1, 2]);
  });

  it('rejects an export without name or start time columns', () => {
    expect(() => parseSeratoHistory('artist,deck\nA,1\n')).toThrow(/name.*start time/);
    expect(() => parseSeratoHistory('')).toThrow(/empty/);
  });
});

describe('format', () => {
  const tracklist = {
    session: null,
    tracks: [
      { time: '00:00', artist: 'A', title: 'One' },
      { time: '05:53', artist: '', title: 'Solo' },
      { time: '1:02:05', artist: 'B', title: 'Two', url: 'https://example.bandcamp.com/track/two' },
    ],
  };

  it('writes admin-compatible text lines', () => {
    expect(toText(tracklist)).toBe(
      '00:00 A - One\n05:53 Solo\n1:02:05 B - Two https://example.bandcamp.com/track/two\n',
    );
  });

  it('writes pretty JSON that round-trips', () => {
    expect(JSON.parse(toJson(tracklist))).toEqual(tracklist);
  });
});

describe('scripts/tracklist.mjs CLI', () => {
  it('prints JSON by default and text with --format text', () => {
    const json = JSON.parse(execFileSync('node', [CLI, FIXTURE], { encoding: 'utf8' }));
    expect(json.tracks).toHaveLength(6);
    const text = execFileSync('node', [CLI, FIXTURE, '--format', 'text'], { encoding: 'utf8' });
    expect(text.split('\n')[0]).toBe('00:00 Example Artist One - Opening Drift');
  });

  it('writes to --out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracklist-'));
    try {
      const out = join(dir, 'mix.json');
      execFileSync('node', [CLI, FIXTURE, '--out', out], { stdio: 'pipe' });
      expect(JSON.parse(readFileSync(out, 'utf8')).tracks).toHaveLength(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on a bad option', () => {
    let code = 0;
    try {
      execFileSync('node', [CLI, FIXTURE, '--format', 'xml'], { stdio: 'pipe' });
    } catch (err) {
      code = err.status;
    }
    expect(code).toBe(2);
  });
});
