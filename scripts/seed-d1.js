#!/usr/bin/env node
/**
 * Seed D1 database from manifest.json.
 *
 * Generates SQL INSERT statements from the manifest and executes them
 * against the D1 database using wrangler.
 *
 * Usage:
 *   node scripts/seed-d1.js              # Seed remote D1
 *   node scripts/seed-d1.js --local      # Seed local D1 (for dev)
 *   node scripts/seed-d1.js --dry-run    # Print SQL without executing
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MANIFEST_PATH = path.resolve(__dirname, '..', 'data', 'manifest.json');
const WORKER_DIR = path.resolve(__dirname, '..', 'worker');
const DB_NAME = 'offgrid-db';
const DRY_RUN = process.argv.includes('--dry-run');
const LOCAL = process.argv.includes('--local');

if (!fs.existsSync(MANIFEST_PATH)) {
  console.error('manifest.json not found at', MANIFEST_PATH);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  return `'${String(val).replace(/'/g, "''")}'`;
}

const statements = [];

// Insert mixes
for (const m of manifest.mixes) {
  statements.push(
    `INSERT OR REPLACE INTO mixes (id, title, artist, description, src, thumb, peaks, color, tags, duration, release_date, sort_order) VALUES (${esc(m.id)}, ${esc(m.title)}, ${esc(m.artist || '')}, ${esc(m.description || '')}, ${esc(m.src)}, ${esc(m.thumb || '')}, ${esc(m.peaks || '')}, ${esc(m.color || '#ff5500')}, ${esc(JSON.stringify(m.tags || []))}, ${m.duration || 'NULL'}, ${esc(m.releaseDate)}, 0);`
  );
}

// Insert playlists
for (const p of manifest.playlists) {
  statements.push(
    `INSERT OR REPLACE INTO playlists (id, title, description, creator, thumb, color, sort_order) VALUES (${esc(p.id)}, ${esc(p.title)}, ${esc(p.description || '')}, ${esc(p.creator || '')}, ${esc(p.thumb || '')}, ${esc(p.color || '#ff5500')}, 0);`
  );

  // Insert playlist-mix associations
  if (p.mixIds) {
    for (let i = 0; i < p.mixIds.length; i++) {
      statements.push(
        `INSERT OR REPLACE INTO playlist_mixes (playlist_id, mix_id, position) VALUES (${esc(p.id)}, ${esc(p.mixIds[i])}, ${i});`
      );
    }
  }
}

const sql = statements.join('\n');

if (DRY_RUN) {
  console.log('-- DRY RUN: SQL that would be executed:\n');
  console.log(sql);
  process.exit(0);
}

// Write SQL to temp file and execute
const tmpFile = path.join(WORKER_DIR, '_seed.sql');
fs.writeFileSync(tmpFile, sql);

try {
  const locationFlag = LOCAL ? '--local' : '--remote';
  const cmd = `cd "${WORKER_DIR}" && npx wrangler d1 execute ${DB_NAME} ${locationFlag} --file=_seed.sql`;
  console.log(`Seeding ${LOCAL ? 'local' : 'remote'} D1 database...`);
  execSync(cmd, { stdio: 'inherit' });
  console.log(`Seeded ${manifest.mixes.length} mixes, ${manifest.playlists.length} playlists.`);
} finally {
  try { fs.unlinkSync(tmpFile); } catch {}
}
