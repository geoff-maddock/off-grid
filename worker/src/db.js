/**
 * D1 database query helpers for mixes and playlists.
 */

// ── Mixes ──────────────────────────────────────────────────────────

export async function listMixes(db, { tag, artist, sort = 'sort_order', dir = 'asc', ownerId } = {}) {
  const allowedSorts = ['title', 'artist', 'duration', 'release_date', 'sort_order', 'created_at'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'sort_order';
  const sortDir = dir === 'desc' ? 'DESC' : 'ASC';

  const where = [];
  const params = [];
  if (ownerId) { where.push('owner_id = ?'); params.push(ownerId); }
  if (tag) { where.push('tags LIKE ?'); params.push(`%"${tag}"%`); }
  else if (artist) { where.push('artist = ?'); params.push(artist); }

  let sql = `SELECT * FROM mixes`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY ${sortCol} ${sortDir}`;

  const result = await db.prepare(sql).bind(...params).all();
  const mixes = result.results.map(parseMixRow);
  for (const mix of mixes) {
    mix.tracks = await getMixTracks(db, mix.id);
  }
  return mixes;
}

// ownerId (optional) scopes the lookup — returns null if the mix isn't owned by them.
export async function getMix(db, id, ownerId) {
  const sql = ownerId ? 'SELECT * FROM mixes WHERE id = ? AND owner_id = ?' : 'SELECT * FROM mixes WHERE id = ?';
  const result = await (ownerId ? db.prepare(sql).bind(id, ownerId) : db.prepare(sql).bind(id)).first();
  if (!result) return null;
  const mix = parseMixRow(result);
  mix.tracks = await getMixTracks(db, id);
  return mix;
}

export async function createMix(db, mix) {
  const sql = `INSERT INTO mixes (id, title, artist, description, src, thumb, peaks, color, tags, duration, release_date, sort_order, tracklist, owner_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await db.prepare(sql).bind(
    mix.id, mix.title, mix.artist || '', mix.description || '',
    mix.src, mix.thumb || '', mix.peaks || '', mix.color || '#ff5500',
    JSON.stringify(mix.tags || []), mix.duration || null,
    mix.releaseDate || null, mix.sortOrder || 0, mix.tracklist || '', mix.ownerId || null
  ).run();
  await setMixTracks(db, mix.id, mix.tracks);
  return getMix(db, mix.id);
}

export async function updateMix(db, id, mix) {
  const sql = `UPDATE mixes SET title=?, artist=?, description=?, src=?, thumb=?, peaks=?,
               color=?, tags=?, duration=?, release_date=?, sort_order=?, tracklist=?, updated_at=datetime('now')
               WHERE id=?`;
  await db.prepare(sql).bind(
    mix.title, mix.artist || '', mix.description || '',
    mix.src, mix.thumb || '', mix.peaks || '', mix.color || '#ff5500',
    JSON.stringify(mix.tags || []), mix.duration || null,
    mix.releaseDate || null, mix.sortOrder || 0, mix.tracklist || '', id
  ).run();
  // Only replace tracks when the caller actually sent a tracklist payload.
  if (mix.tracks !== undefined) {
    await setMixTracks(db, id, mix.tracks);
  }
  return getMix(db, id);
}

export async function deleteMix(db, id) {
  await db.batch([
    db.prepare('DELETE FROM mix_tracks WHERE mix_id = ?').bind(id),
    db.prepare('DELETE FROM playlist_mixes WHERE mix_id = ?').bind(id),
    db.prepare('DELETE FROM play_events WHERE mix_id = ?').bind(id),
    db.prepare('DELETE FROM mix_stats WHERE mix_id = ?').bind(id),
    db.prepare('DELETE FROM mixes WHERE id = ?').bind(id),
  ]);
}

// ── Mix Tracks (parsed tracklist) ──────────────────────────────────

async function getMixTracks(db, mixId) {
  const result = await db.prepare(
    'SELECT position, time, time_seconds, artist, title, url FROM mix_tracks WHERE mix_id = ? ORDER BY position ASC'
  ).bind(mixId).all();
  return (result.results || []).map((t) => ({
    position: t.position,
    time: t.time || '',
    seconds: t.time_seconds,
    artist: t.artist || '',
    title: t.title || '',
    url: t.url || '',
  }));
}

// Replace all of a mix's tracks with the provided array (already parsed by the
// client). Batched so a failure can't leave the tracklist deleted but not
// re-inserted (D1 runs a batch as a single transaction).
async function setMixTracks(db, mixId, tracks) {
  const stmts = [db.prepare('DELETE FROM mix_tracks WHERE mix_id = ?').bind(mixId)];
  for (let i = 0; i < (Array.isArray(tracks) ? tracks.length : 0); i++) {
    const t = tracks[i] || {};
    const seconds = Number.isFinite(t.seconds) ? Math.round(t.seconds)
      : (Number.isFinite(t.timeSeconds) ? Math.round(t.timeSeconds) : null);
    stmts.push(db.prepare(
      'INSERT INTO mix_tracks (mix_id, position, time, time_seconds, artist, title, url) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(mixId, i, String(t.time || ''), seconds, String(t.artist || ''), String(t.title || ''), String(t.url || '')));
  }
  await db.batch(stmts);
}

// ── Playlists ──────────────────────────────────────────────────────

export async function listPlaylists(db, ownerId) {
  const sql = ownerId
    ? 'SELECT * FROM playlists WHERE owner_id = ? ORDER BY sort_order ASC, title ASC'
    : 'SELECT * FROM playlists ORDER BY sort_order ASC, title ASC';
  const result = await (ownerId ? db.prepare(sql).bind(ownerId) : db.prepare(sql)).all();

  const playlists = [];
  for (const row of result.results) {
    const mixes = await getPlaylistMixes(db, row.id);
    playlists.push({
      id: row.id,
      title: row.title,
      description: row.description,
      creator: row.creator,
      thumb: row.thumb || null,
      color: row.color,
      sortOrder: row.sort_order,
      mixIds: mixes.map(m => m.mix_id),
    });
  }
  return playlists;
}

export async function getPlaylist(db, id, ownerId) {
  const sql = ownerId ? 'SELECT * FROM playlists WHERE id = ? AND owner_id = ?' : 'SELECT * FROM playlists WHERE id = ?';
  const row = await (ownerId ? db.prepare(sql).bind(id, ownerId) : db.prepare(sql).bind(id)).first();
  if (!row) return null;

  const mixes = await getPlaylistMixes(db, id);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    creator: row.creator,
    thumb: row.thumb || null,
    color: row.color,
    sortOrder: row.sort_order,
    mixIds: mixes.map(m => m.mix_id),
  };
}

export async function createPlaylist(db, pl) {
  const sql = `INSERT INTO playlists (id, title, description, creator, thumb, color, sort_order, owner_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  await db.prepare(sql).bind(
    pl.id, pl.title, pl.description || '', pl.creator || '',
    pl.thumb || '', pl.color || '#ff5500', pl.sortOrder || 0, pl.ownerId || null
  ).run();

  if (pl.mixIds && pl.mixIds.length > 0) {
    await setPlaylistMixes(db, pl.id, pl.mixIds);
  }

  return getPlaylist(db, pl.id);
}

export async function updatePlaylist(db, id, pl) {
  const sql = `UPDATE playlists SET title=?, description=?, creator=?, thumb=?, color=?,
               sort_order=?, updated_at=datetime('now') WHERE id=?`;
  await db.prepare(sql).bind(
    pl.title, pl.description || '', pl.creator || '',
    pl.thumb || '', pl.color || '#ff5500', pl.sortOrder || 0, id
  ).run();

  if (pl.mixIds) {
    await setPlaylistMixes(db, id, pl.mixIds);
  }

  return getPlaylist(db, id);
}

export async function deletePlaylist(db, id) {
  await db.batch([
    db.prepare('DELETE FROM playlist_mixes WHERE playlist_id = ?').bind(id),
    db.prepare('DELETE FROM playlists WHERE id = ?').bind(id),
  ]);
}

// ── Playlist Mix Management ────────────────────────────────────────

async function getPlaylistMixes(db, playlistId) {
  const result = await db.prepare(
    'SELECT mix_id FROM playlist_mixes WHERE playlist_id = ? ORDER BY position ASC'
  ).bind(playlistId).all();
  return result.results;
}

// Batched: delete + re-insert run as one transaction (see setMixTracks).
async function setPlaylistMixes(db, playlistId, mixIds) {
  const stmts = [db.prepare('DELETE FROM playlist_mixes WHERE playlist_id = ?').bind(playlistId)];
  for (let i = 0; i < mixIds.length; i++) {
    stmts.push(db.prepare(
      'INSERT INTO playlist_mixes (playlist_id, mix_id, position) VALUES (?, ?, ?)'
    ).bind(playlistId, mixIds[i], i));
  }
  await db.batch(stmts);
}

export async function addMixToPlaylist(db, playlistId, mixId) {
  const maxPos = await db.prepare(
    'SELECT COALESCE(MAX(position), -1) as pos FROM playlist_mixes WHERE playlist_id = ?'
  ).bind(playlistId).first();

  await db.prepare(
    'INSERT OR IGNORE INTO playlist_mixes (playlist_id, mix_id, position) VALUES (?, ?, ?)'
  ).bind(playlistId, mixId, (maxPos?.pos ?? -1) + 1).run();
}

export async function removeMixFromPlaylist(db, playlistId, mixId) {
  await db.prepare(
    'DELETE FROM playlist_mixes WHERE playlist_id = ? AND mix_id = ?'
  ).bind(playlistId, mixId).run();
}

// ── Manifest Generation ────────────────────────────────────────────

export async function generateManifest(db, ownerId) {
  const mixes = await listMixes(db, { ownerId });
  const playlists = await listPlaylists(db, ownerId);

  return {
    site: {
      title: 'OFF-GRID',
      tagline: 'Self-hosted streaming audio.',
      accent: '#ff5500',
      logoText: '',
    },
    mixes,
    playlists,
  };
}

// ── Ownership helpers ──────────────────────────────────────────────

// The instance owner = the first real admin (matches migration 004's backfill).
export async function getOwnerUserId(db) {
  const row = await db.prepare(
    "SELECT id FROM users WHERE role = 'admin' AND password_hash IS NOT NULL ORDER BY created_at ASC LIMIT 1"
  ).first();
  return row ? row.id : null;
}

// Which owner's content a request acts on. A legacy ADMIN_TOKEN session has no
// real user row, so it acts as the instance owner.
export async function resolveOwnerId(db, user) {
  if (user && user.legacy) return getOwnerUserId(db);
  return user ? user.id : null;
}

// ── Helpers ────────────────────────────────────────────────────────

function parseMixRow(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    description: row.description,
    src: row.src,
    thumb: row.thumb || null,
    peaks: row.peaks || null,
    color: row.color,
    tags: safeParse(row.tags, []),
    duration: row.duration,
    releaseDate: row.release_date,
    createdAt: row.created_at || null,
    sortOrder: row.sort_order,
    tracklist: row.tracklist || '',
  };
}

function safeParse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}
