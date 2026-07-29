#!/usr/bin/env node
/**
 * Render and upload share videos: an mp4 per mix (still cover art + AAC
 * audio) that Discord plays inline via the og:video tags emitted by
 * generate-share-pages.mjs. Discord ignores twitter:player iframes and
 * og:audio for non-whitelisted sites — a direct mp4 URL is the only way to
 * get an inline player there.
 *
 * Runs locally (needs ffmpeg + ffprobe on PATH, and a wrangler login for the
 * upload step — like generate-peaks.js, this is a machine-of-the-owner step,
 * not a server/CI one). Videos land at <bucket>/video/<slug>.mp4, where the
 * share-page generator HEAD-probes for them; mixes without a rendition just
 * keep their static card.
 *
 * Usage:
 *   node generate-share-videos.mjs [options]
 *     --manifest <url|path>  Manifest to read. Default: OFFGRID_MANIFEST_URL
 *                            from config.local.js, else data/manifest.json.
 *     --r2-base <url>        Public base URL of the R2 bucket (existence
 *                            checks). Default: OFFGRID_R2_BASE from
 *                            config.local.js, else derived from the manifest
 *                            URL.
 *     --bucket <name>        R2 bucket to upload to. Default: bucket_name
 *                            from worker/wrangler.toml.
 *     --mix <slug>           Only render this mix.
 *     --limit <n>            Stop after rendering n videos (backfill in
 *                            chunks; ~1-2 min encode per 90-minute mix).
 *     --force                Re-render and re-upload even if the video
 *                            already exists in R2.
 *     --dry-run              Print what would be done, do nothing.
 *
 * Downloads are cached in mixes/share-videos/cache/ (gitignored) so re-runs
 * only fetch what's missing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { loadManifest, r2BaseFrom, videoUrlFor } from './generate-share-pages.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(SCRIPT_DIR, 'mixes', 'share-videos');
const CACHE_DIR = path.join(OUT_DIR, 'cache');
const WORKER_DIR = path.join(SCRIPT_DIR, 'worker');

// ---- CLI / config -----------------------------------------------------------

function parseArgs(argv) {
  const args = { force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') args.manifest = argv[++i];
    else if (a === '--r2-base') args.r2Base = argv[++i];
    else if (a === '--bucket') args.bucket = argv[++i];
    else if (a === '--mix') args.mix = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') { args.help = true; }
    else { console.error(`Unknown option: ${a}`); process.exit(1); }
  }
  return args;
}

function readConfigLocal() {
  const cfg = {};
  try {
    const src = fs.readFileSync(path.join(SCRIPT_DIR, 'config.local.js'), 'utf-8');
    const grab = (key) => {
      const m = src.match(new RegExp(`^\\s*window\\.${key}\\s*=\\s*['"]([^'"]+)['"]`, 'm'));
      return m ? m[1] : undefined;
    };
    cfg.manifestUrl = grab('OFFGRID_MANIFEST_URL');
    cfg.r2Base = grab('OFFGRID_R2_BASE');
  } catch (_) { /* no config.local.js — fine */ }
  return cfg;
}

// First bucket_name in wrangler.toml — the media bucket is the only
// [[r2_buckets]] entry the Worker defines.
export function parseBucketName(toml) {
  const m = String(toml || '').match(/^\s*bucket_name\s*=\s*["']([^"']+)["']/m);
  return m ? m[1] : '';
}

// ---- Rendering --------------------------------------------------------------

// Still cover + audio → mp4. yuv420p and even dimensions are compatibility
// requirements (Discord/Safari); 2 fps keeps the video track to a few
// hundred KB regardless of length; +faststart fronts the moov atom so the
// embed can stream and seek. Fixed 720x720 (padded) matches the
// og:video:width/height the share pages advertise.
export function ffmpegArgs(coverPath, audioPath, outPath) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-loop', '1', '-framerate', '2', '-i', coverPath,
    '-i', audioPath,
    '-map', '0:v', '-map', '1:a',
    '-vf', 'scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-tune', 'stillimage', '-r', '2', '-g', '4',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest', '-movflags', '+faststart',
    outPath,
  ];
}

function run(cmd, cmdArgs, opts = {}) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: 'utf-8', ...opts });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`${cmd} not found — install it and make sure it's on PATH.`);
    }
    throw err;
  }
}

function probeDuration(file) {
  const out = run('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(out.trim());
}

function extFromUrl(url, fallback) {
  const ext = url.split('?')[0].split('#')[0].split('.').pop().toLowerCase();
  return /^[a-z0-9]{2,4}$/.test(ext) ? ext : fallback;
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} (${url})`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

async function exists(url) {
  const res = await fetch(url, { method: 'HEAD' });
  return res.ok;
}

// ---- Main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node generate-share-videos.mjs [--manifest <url|path>] [--r2-base <url>] [--bucket <name>] [--mix <slug>] [--limit <n>] [--force] [--dry-run]');
    process.exit(0);
  }
  const cfg = readConfigLocal();

  let manifestSrc = args.manifest || cfg.manifestUrl;
  if (!manifestSrc) {
    manifestSrc = path.join(SCRIPT_DIR, 'data', 'manifest.json');
    console.warn('Warning: no --manifest and no config.local.js OFFGRID_MANIFEST_URL — using the sample data/manifest.json.');
  }

  const r2Base = r2BaseFrom(manifestSrc, args.r2Base || cfg.r2Base);
  if (!r2Base) {
    console.error('Error: --r2-base is required when the manifest is not a hosted …/data/manifest.json URL.');
    process.exit(1);
  }

  let bucket = args.bucket;
  if (!bucket) {
    try {
      bucket = parseBucketName(fs.readFileSync(path.join(WORKER_DIR, 'wrangler.toml'), 'utf-8'));
    } catch (_) { /* fall through to the error below */ }
  }
  if (!bucket) {
    console.error('Error: could not read bucket_name from worker/wrangler.toml — pass --bucket <name>.');
    process.exit(1);
  }

  const manifest = await loadManifest(manifestSrc);
  let mixes = manifest.mixes || [];
  if (args.mix) {
    mixes = mixes.filter((m) => m.id === args.mix);
    if (!mixes.length) { console.error(`Error: no mix with id ${JSON.stringify(args.mix)} in the manifest.`); process.exit(1); }
  }

  console.log(`Share videos for ${mixes.length} mix(es) → r2://${bucket}/video/ (public: ${r2Base}/video/)${args.dryRun ? '  (dry run)' : ''}`);
  if (!args.dryRun) fs.mkdirSync(CACHE_DIR, { recursive: true });

  let rendered = 0, skipped = 0, failed = 0;
  for (const mix of mixes) {
    const url = videoUrlFor(mix, r2Base);
    if (!url) { console.warn(`  Skipping mix with unsafe id: ${JSON.stringify(mix.id)}`); skipped++; continue; }
    if (!mix.src || !mix.thumb) { console.warn(`  ${mix.id}: missing src or thumb — skipped.`); skipped++; continue; }
    if (args.limit && rendered >= args.limit) { console.log(`  --limit ${args.limit} reached.`); break; }

    try {
      if (!args.force && await exists(url)) { skipped++; continue; }
      if (args.dryRun) { console.log(`  would render + upload ${mix.id} (${Math.round((mix.duration || 0) / 60)} min)`); rendered++; continue; }

      const audioPath = path.join(CACHE_DIR, `${mix.id}-audio.${extFromUrl(mix.src, 'mp3')}`);
      const coverPath = path.join(CACHE_DIR, `${mix.id}-cover.${extFromUrl(mix.thumb, 'jpg')}`);
      const outPath = path.join(OUT_DIR, `${mix.id}.mp4`);

      await download(mix.src, audioPath);
      await download(mix.thumb, coverPath);

      console.log(`  rendering ${mix.id}…`);
      run('ffmpeg', ffmpegArgs(coverPath, audioPath, outPath), { stdio: ['ignore', 'ignore', 'inherit'], encoding: undefined });

      const outDur = probeDuration(outPath);
      if (mix.duration && Math.abs(outDur - mix.duration) > 2) {
        console.warn(`  ${mix.id}: rendered duration ${outDur.toFixed(1)}s differs from manifest ${mix.duration}s`);
      }

      console.log(`  uploading ${mix.id}.mp4 (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB)…`);
      run('npx', ['wrangler', 'r2', 'object', 'put', `${bucket}/video/${mix.id}.mp4`,
        '--file', outPath, '--content-type', 'video/mp4', '--remote'],
      { cwd: WORKER_DIR, stdio: 'inherit', encoding: undefined });
      rendered++;
    } catch (err) {
      console.error(`  ${mix.id}: ${err.message}`);
      failed++;
    }
  }

  console.log(`Done. ${rendered} rendered, ${skipped} skipped, ${failed} failed.`);
  if (failed) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
