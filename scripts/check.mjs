#!/usr/bin/env node
/**
 * Deployment doctor — verifies a live Off Grid install end to end.
 *
 * Runs the onboarding checkpoints automatically: the Worker's /config
 * endpoint, the published manifest, the first mix's audio/peaks URLs, bucket
 * CORS, and (optionally) an authenticated API call. Prints a pass/fail list
 * with a fix hint for every failure. Exit code 0 = healthy (warnings allowed),
 * 1 = at least one failure — safe to wire into CI or a cron.
 *
 * Usage:
 *   node scripts/check.mjs                        # reads config.local.js
 *   node scripts/check.mjs --token <jwt-or-admin-token>
 *   node scripts/check.mjs --worker https://offgrid-api.YOUR-SUBDOMAIN.workers.dev \
 *                          --manifest https://pub-xxxxxxxx.r2.dev/data/manifest.json
 *   node scripts/check.mjs --config path/to/config.local.js --verbose
 *
 * Requires Node 18+ (uses global fetch). No dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── CLI args ────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');

function argValue(name) {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(name + '='));
  return pref ? pref.slice(name.length + 1) : undefined;
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?/gm, ''));
  process.exit(0);
}

// ── Config resolution ───────────────────────────────────────────────

/** Evaluate a config.local.js (it only assigns window.*) against a stub. */
function loadLocalConfig(file) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    const win = {};
    new Function('window', src)(win);
    return win;
  } catch {
    return {};
  }
}

const configPath = argValue('--config') || path.join(ROOT, 'config.local.js');
const local = loadLocalConfig(configPath);
const workerBase = (argValue('--worker') || local.OFFGRID_API_BASE || '').replace(/\/+$/, '');
const manifestUrl = argValue('--manifest') || local.OFFGRID_MANIFEST_URL || '';
const token = argValue('--token');

// ── Check harness ───────────────────────────────────────────────────

const results = []; // {status: 'pass'|'fail'|'warn'|'skip', name, detail, hint}

function record(status, name, detail, hint) {
  results.push({ status, name, detail, hint });
  const icon = { pass: '✓', fail: '✗', warn: '!', skip: '-' }[status];
  let line = `${icon} ${name}`;
  if (detail && (VERBOSE || status !== 'pass')) line += ` — ${detail}`;
  console.log(line);
  if (hint && status !== 'pass') console.log(`    → ${hint}`);
}

async function get(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(10000), redirect: 'follow' });
}

// ── Checks ──────────────────────────────────────────────────────────

async function main() {
  console.log('Off Grid deployment check');
  console.log('─────────────────────────');

  // 1. Config resolved
  if (!workerBase && !manifestUrl) {
    record('fail', 'Configuration', `no Worker or manifest URL found (looked in ${path.relative(process.cwd(), configPath) || configPath})`,
      'cp config.local.example.js config.local.js and set OFFGRID_API_BASE + OFFGRID_MANIFEST_URL, or pass --worker/--manifest.');
    finish();
  }
  record('pass', 'Configuration',
    `worker: ${workerBase || '(not set)'}, manifest: ${manifestUrl || '(not set)'}`);

  // 2. Worker /config
  let needsSetup = null;
  if (workerBase) {
    try {
      const res = await get(`${workerBase}/config`);
      if (!res.ok) {
        record('fail', 'Worker /config', `HTTP ${res.status}`,
          'Is the Worker deployed and the URL right (no trailing slash)? cd worker && npx wrangler deploy');
      } else {
        const body = await res.json();
        needsSetup = body.needsSetup;
        if (!body.r2PublicUrl) {
          record('warn', 'Worker /config', 'r2PublicUrl is null',
            'Set R2_PUBLIC_URL under [vars] in worker/wrangler.toml and redeploy — without it, admin login needs manual URL fields.');
        } else {
          record('pass', 'Worker /config', `r2PublicUrl: ${body.r2PublicUrl}, needsSetup: ${body.needsSetup}`);
        }
        if (body.needsSetup === true) {
          record('warn', 'Admin account', 'needsSetup is true — no admin account exists yet',
            'Open the admin UI → First-time setup with your ADMIN_TOKEN (docs/ONBOARDING.md Stage 6).');
        }
      }
    } catch (err) {
      record('fail', 'Worker /config', err.message,
        'Worker unreachable — check the URL and that it is deployed.');
    }
  } else {
    record('skip', 'Worker /config', 'no Worker URL configured', 'Set OFFGRID_API_BASE or pass --worker.');
  }

  // 3. Manifest
  let manifest = null;
  if (manifestUrl) {
    try {
      const res = await get(manifestUrl, { headers: { Origin: 'https://example.com' } });
      if (!res.ok) {
        record('fail', 'Manifest', `HTTP ${res.status} from ${manifestUrl}`,
          res.status === 404
            ? 'Nothing published yet (click Publish in the admin), or the URL/bucket public access is wrong.'
            : 'Check the manifest URL and R2 public access.');
      } else {
        try {
          manifest = JSON.parse(await res.text());
        } catch {
          record('fail', 'Manifest', 'response is not valid JSON', 'Is the URL pointing at manifest.json?');
        }
        if (manifest) {
          if (!Array.isArray(manifest.mixes)) {
            record('fail', 'Manifest', 'JSON has no mixes[] array', 'This does not look like an Off Grid manifest — check the URL.');
          } else if (manifest.mixes.length === 0) {
            record('warn', 'Manifest', 'valid, but the library is empty',
              'Add a mix in the admin and click Publish.');
          } else {
            record('pass', 'Manifest', `${manifest.mixes.length} mix(es), ${(manifest.playlists || []).length} playlist(s)`);
          }
          // CORS spot check on the same response
          const acao = res.headers.get('access-control-allow-origin');
          if (acao) record('pass', 'Bucket CORS', `access-control-allow-origin: ${acao}`);
          else record('warn', 'Bucket CORS', 'no access-control-allow-origin header on the manifest response',
            'Cross-origin embeds/pages may fail to load it: cd worker && npx wrangler r2 bucket cors set <bucket> --file ./r2-cors.json');
        }
      }
    } catch (err) {
      record('fail', 'Manifest', err.message, 'URL unreachable — check it in a browser.');
    }
  } else {
    record('skip', 'Manifest', 'no manifest URL configured', 'Set OFFGRID_MANIFEST_URL or pass --manifest.');
  }

  // 4. First mix assets
  const first = manifest && Array.isArray(manifest.mixes) ? manifest.mixes[0] : null;
  if (first) {
    for (const [field, label] of [['src', 'audio'], ['peaks', 'peaks']]) {
      const url = first[field];
      if (!url) { if (field === 'peaks') record('skip', `First mix ${label}`, 'none set'); continue; }
      if (!/^https?:\/\//.test(url)) {
        record('warn', `First mix ${label}`, `relative URL (${url}) — fine for local/offline use, but embeds on other sites need absolute R2 URLs`);
        continue;
      }
      try {
        const res = await get(url, { method: 'HEAD' });
        if (res.ok) record('pass', `First mix ${label}`, `${res.status} ${url}`);
        else record('fail', `First mix ${label}`, `HTTP ${res.status} for ${url}`,
          'Open the URL in a browser — if it 404s, re-upload; if 401/403, enable Public access on the bucket.');
      } catch (err) {
        record('fail', `First mix ${label}`, `${err.message} for ${url}`, 'Check the URL and bucket public access.');
      }
    }
  }

  // 5. Authenticated API (optional)
  if (token) {
    if (workerBase) {
      try {
        const res = await get(`${workerBase}/api/mixes`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const mixes = await res.json();
          record('pass', 'Authenticated API', `GET /api/mixes → ${Array.isArray(mixes) ? mixes.length + ' mix(es)' : 'ok'}`);
        } else if (res.status === 401) {
          record('fail', 'Authenticated API', 'HTTP 401',
            'Token rejected — it must be a login JWT (from /auth/login) or the exact ADMIN_TOKEN secret. JWTs expire; log in again for a fresh one.');
        } else {
          record('fail', 'Authenticated API', `HTTP ${res.status}`, 'Unexpected response — check the Worker logs (npx wrangler tail).');
        }
      } catch (err) {
        record('fail', 'Authenticated API', err.message, 'Worker unreachable.');
      }
    } else {
      record('skip', 'Authenticated API', '--token given but no Worker URL configured', 'Set OFFGRID_API_BASE or pass --worker.');
    }
  } else {
    record('skip', 'Authenticated API', 'pass --token <jwt-or-admin-token> to test it');
  }

  finish();
}

function finish() {
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  console.log('─────────────────────────');
  console.log(`${fails ? '✗' : '✓'} ${results.filter((r) => r.status === 'pass').length} passed, ${warns} warning(s), ${fails} failure(s)`);
  if (fails) console.log('  Full setup guide & troubleshooting: docs/ONBOARDING.md');
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error('✗ Unexpected error:', err.message);
  process.exit(1);
});
