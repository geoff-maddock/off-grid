// Parse a Serato DJ history export (History → Export → CSV) into ordered
// tracklist entries with start times relative to the first track.
//
// The export is one session row followed by one row per loaded track, with
// headers like `name, artist, start time, end time, playtime, deck`. Headers
// are matched by name (case-insensitive) and unknown columns are ignored, so
// a different column order or extra columns don't break parsing.

// Minimal RFC 4180 CSV reader: quoted fields, "" escapes, commas and newlines
// inside quotes, CRLF or LF line endings, and a leading BOM.
export function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// Clock time of day in seconds from "22:04:10", "10:04:10 PM", or a value
// with a leading date ("2026-10-10 22:04:10"). Returns null if unparseable.
export function clockToSeconds(value) {
  const m = String(value || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3] || 0);
  const ampm = m[4] && m[4].toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59 || sec > 59) return null;
  return h * 3600 + min * 60 + sec;
}

// Offset in seconds → "MM:SS", or "H:MM:SS" once past an hour. Both forms are
// what the admin's parseTracklist() reads as a timestamp.
export function formatOffset(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const FALSEY = new Set(['0', 'false', 'no', 'n']);

function looksLikeSessionRow(rec, hasDeck) {
  if (rec.artist) return false;
  if (hasDeck) return !rec.deck;
  return /\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(rec.name);
}

export function parseSeratoHistory(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('Serato export is empty');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const idx = {
    name: col('name'),
    artist: col('artist'),
    start: col('start time'),
    deck: col('deck'),
    played: col('played'),
  };
  if (idx.name < 0 || idx.start < 0) {
    throw new Error('Serato export needs "name" and "start time" columns');
  }
  const get = (r, i) => (i >= 0 && r[i] != null ? r[i].trim() : '');

  let records = rows.slice(1).map((r) => ({
    name: get(r, idx.name),
    artist: get(r, idx.artist),
    start: get(r, idx.start),
    deck: get(r, idx.deck),
    played: get(r, idx.played),
  }));

  let session = null;
  if (records.length && looksLikeSessionRow(records[0], idx.deck >= 0)) {
    const s = records.shift();
    session = { name: s.name, start: s.start };
  }

  // Keep every row the export marks as played (rows without a played column
  // count as played). Rows with no title or no readable start time are dropped.
  records = records.filter((r) => !FALSEY.has(r.played.toLowerCase()) && r.name);

  const tracks = [];
  let first = null;
  let prev = null;
  let dayOffset = 0;
  for (const r of records) {
    const clock = clockToSeconds(r.start);
    if (clock == null) continue;
    // A clock time earlier than the previous one means the set crossed midnight.
    if (prev != null && clock < prev) dayOffset += 86400;
    prev = clock;
    const abs = clock + dayOffset;
    if (first == null) first = abs;
    const offset = abs - first;
    tracks.push({
      position: tracks.length + 1,
      time: formatOffset(offset),
      time_seconds: offset,
      artist: r.artist,
      title: r.name,
      source: 'serato',
    });
  }
  return { session, tracks };
}
