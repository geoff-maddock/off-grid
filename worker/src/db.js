/**
 * D1 database query helpers for mixes and playlists.
 */

// ── Mixes ──────────────────────────────────────────────────────────

export async function listMixes(db, { tag, artist, sort = 'sort_order', dir = 'asc' } = {}) {
  const allowedSorts = ['title', 'artist', 'duration', 'release_date', 'sort_order', 'created_at'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'sort_order';
  const sortDir = dir === 'desc' ? 'DESC' : 'ASC';

  let sql = `SELECT * FROM mixes`;
  const params = [];

  if (tag) {
    sql += ` WHERE tags LIKE ?`;
    params.push(`%"${tag}"%`);
  } else if (artist) {
    sql += ` WHERE artist = ?`;
    params.push(artist);
  }

  sql += ` ORDER BY ${sortCol} ${sortDir}`;

  const result = await db.prepare(sql).bind(...params).all();
  return result.results.map(parseMixRow);
}

export async function getMix(db, id) {
  const result = await db.prepare('SELECT * FROM mixes WHERE id = ?').bind(id).first();
  return result ? parseMixRow(result) : null;
}

export async function createMix(db, mix) {
  const sql = `INSERT INTO mixes (id, title, artist, description, src, thumb, peaks, color, tags, duration, release_date, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await db.prepare(sql).bind(
    mix.id, mix.title, mix.artist || '', mix.description || '',
    mix.src, mix.thumb || '', mix.peaks || '', mix.color || '#ff5500',
    JSON.stringify(mix.tags || []), mix.duration || null,
    mix.releaseDate || null, mix.sortOrder || 0
  ).run();
  return getMix(db, mix.id);
}

export async function updateMix(db, id, mix) {
  const sql = `UPDATE mixes SET title=?, artist=?, description=?, src=?, thumb=?, peaks=?,
               color=?, tags=?, duration=?, release_date=?, sort_order=?, updated_at=datetime('now')
               WHERE id=?`;
  await db.prepare(sql).bind(
    mix.title, mix.artist || '', mix.description || '',
    mix.src, mix.thumb || '', mix.peaks || '', mix.color || '#ff5500',
    JSON.stringify(mix.tags || []), mix.duration || null,
    mix.releaseDate || null, mix.sortOrder || 0, id
  ).run();
  return getMix(db, id);
}

export async function deleteMix(db, id) {
  await db.prepare('DELETE FROM playlist_mixes WHERE mix_id = ?').bind(id).run();
  await db.prepare('DELETE FROM mixes WHERE id = ?').bind(id).run();
}

// ── Playlists ──────────────────────────────────────────────────────

export async function listPlaylists(db) {
  const result = await db.prepare(
    'SELECT * FROM playlists ORDER BY sort_order ASC, title ASC'
  ).all();

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

export async function getPlaylist(db, id) {
  const row = await db.prepare('SELECT * FROM playlists WHERE id = ?').bind(id).first();
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
  const sql = `INSERT INTO playlists (id, title, description, creator, thumb, color, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?)`;
  await db.prepare(sql).bind(
    pl.id, pl.title, pl.description || '', pl.creator || '',
    pl.thumb || '', pl.color || '#ff5500', pl.sortOrder || 0
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
  await db.prepare('DELETE FROM playlist_mixes WHERE playlist_id = ?').bind(id).run();
  await db.prepare('DELETE FROM playlists WHERE id = ?').bind(id).run();
}

// ── Playlist Mix Management ────────────────────────────────────────

async function getPlaylistMixes(db, playlistId) {
  const result = await db.prepare(
    'SELECT mix_id FROM playlist_mixes WHERE playlist_id = ? ORDER BY position ASC'
  ).bind(playlistId).all();
  return result.results;
}

async function setPlaylistMixes(db, playlistId, mixIds) {
  await db.prepare('DELETE FROM playlist_mixes WHERE playlist_id = ?').bind(playlistId).run();

  for (let i = 0; i < mixIds.length; i++) {
    await db.prepare(
      'INSERT INTO playlist_mixes (playlist_id, mix_id, position) VALUES (?, ?, ?)'
    ).bind(playlistId, mixIds[i], i).run();
  }
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

export async function generateManifest(db) {
  const mixes = await listMixes(db);
  const playlists = await listPlaylists(db);

  return {
    site: {
      title: 'The Mixes',
      tagline: 'No ads. No accounts. Just audio.',
      accent: '#ff5500',
    },
    mixes,
    playlists,
  };
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
    sortOrder: row.sort_order,
  };
}

function safeParse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}
