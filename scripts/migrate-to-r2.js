#!/usr/bin/env node
/**
 * One-time migration script: upload existing audio files, covers, and peaks
 * from the local filesystem to Cloudflare R2 using wrangler, then update
 * manifest.json with the R2 public URLs.
 *
 * Prerequisites:
 *   - wrangler authenticated (npx wrangler login)
 *   - R2 bucket with public access enabled (or custom domain configured)
 *
 * Usage:
 *   node scripts/migrate-to-r2.js --dry-run     # Preview what would be uploaded
 *   node scripts/migrate-to-r2.js               # Actually upload and update manifest
 *
 * Environment variables:
 *   R2_BUCKET     — Bucket name (default: offgrid-media)
 *   R2_PUBLIC_URL — Public URL prefix for the bucket
 *                   Set this to your R2 public bucket URL or custom domain
 *                   e.g., https://pub-xxxxx.r2.dev or https://cdn.your-domain.com
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const AUDIO_DIR = path.resolve(__dirname, '..');
const WORKER_DIR = path.join(AUDIO_DIR, 'worker');
const MANIFEST_PATH = path.join(AUDIO_DIR, 'data', 'manifest.json');
const DRY_RUN = process.argv.includes('--dry-run');

const R2_BUCKET = process.env.R2_BUCKET || 'offgrid-media';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

if (!R2_PUBLIC_URL && !DRY_RUN) {
  console.error('ERROR: R2_PUBLIC_URL environment variable is required.');
  console.error('Set it to your R2 public bucket URL, e.g.:');
  console.error('  export R2_PUBLIC_URL="https://pub-xxxxx.r2.dev"');
  console.error('');
  console.error('To find your URL:');
  console.error('  1. Go to dash.cloudflare.com → R2 → offgrid-media → Settings');
  console.error('  2. Enable "Public access" if not already enabled');
  console.error('  3. Copy the public bucket URL');
  console.error('');
  console.error('Or run with --dry-run to preview without uploading.');
  process.exit(1);
}

function upload(localPath, r2Key) {
  const fullLocal = path.resolve(AUDIO_DIR, localPath);
  if (!fs.existsSync(fullLocal)) {
    console.warn(`  SKIP (not found): ${localPath}`);
    return null;
  }

  const sizeBytes = fs.statSync(fullLocal).size;
  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);

  if (DRY_RUN) {
    console.log(`  DRY RUN: ${localPath} (${sizeMB} MB) → ${r2Key}`);
    return `${R2_PUBLIC_URL || 'https://R2_PUBLIC_URL'}/${r2Key}`;
  }

  console.log(`  Uploading: ${localPath} (${sizeMB} MB) → ${r2Key}`);
  try {
    const cmd = `cd "${WORKER_DIR}" && npx wrangler r2 object put "${R2_BUCKET}/${r2Key}" --remote --file="${fullLocal}"`;
    execSync(cmd, { stdio: 'inherit', timeout: 600000 });
  } catch (err) {
    console.error(`  FAILED: ${localPath}`, err.message);
    return null;
  }

  return `${R2_PUBLIC_URL}/${r2Key}`;
}

// Load manifest
if (!fs.existsSync(MANIFEST_PATH)) {
  console.error('manifest.json not found at', MANIFEST_PATH);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
console.log(`Found ${manifest.mixes.length} mixes to migrate.\n`);

if (DRY_RUN) {
  console.log('=== DRY RUN MODE — no files will be uploaded ===\n');
}

for (const mix of manifest.mixes) {
  console.log(`Mix: ${mix.title} (${mix.id})`);

  // Upload audio
  if (mix.src && !mix.src.startsWith('http')) {
    const r2Key = `audio/${path.basename(mix.src)}`;
    const url = upload(mix.src, r2Key);
    if (url) mix.src = url;
  }

  // Upload cover art
  if (mix.thumb && !mix.thumb.startsWith('http')) {
    const r2Key = `covers/${path.basename(mix.thumb)}`;
    const url = upload(mix.thumb, r2Key);
    if (url) mix.thumb = url;
  }

  // Upload peaks
  if (mix.peaks && !mix.peaks.startsWith('http')) {
    const r2Key = `peaks/${path.basename(mix.peaks)}`;
    const url = upload(mix.peaks, r2Key);
    if (url) mix.peaks = url;
  }

  console.log('');
}

// Save updated manifest
if (!DRY_RUN) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('Updated manifest.json with R2 URLs.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Update MANIFEST_URL in index.html to point to R2');
  console.log(`     const MANIFEST_URL = '${R2_PUBLIC_URL}/data/manifest.json';`);
  console.log('  2. Run the seed script to update D1: node scripts/seed-d1.js');
  console.log('  3. Or use the admin UI to Publish the manifest to R2');
} else {
  console.log('DRY RUN complete. No files were modified.');
}
