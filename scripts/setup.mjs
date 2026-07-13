#!/usr/bin/env node
/**
 * Interactive setup wizard for a new Off Grid backend.
 *
 * Walks a fresh clone through the whole Cloudflare-side setup: checks wrangler
 * auth, writes worker/wrangler.toml from the template, creates the R2 bucket
 * and D1 database (pasting the database_id in for you), applies every
 * migration in order, sets the five Worker secrets (generating ADMIN_TOKEN and
 * JWT_SECRET on request), deploys, and prints a ready-to-paste config.local.js.
 *
 * Prerequisites (see docs/ONBOARDING.md, Stages 1-2): a Cloudflare account
 * with R2 activated, and an R2 API token (Access Key ID + Secret) if you want
 * large-file uploads.
 *
 * Usage:
 *   node scripts/setup.mjs                 # interactive
 *   node scripts/setup.mjs --dry-run       # print the plan, execute nothing
 *   node scripts/setup.mjs --yes           # accept all defaults, no prompts
 *   node scripts/setup.mjs --importing     # skip migration 004 (run it after
 *                                          # bootstrapping your admin — see docs)
 *   node scripts/setup.mjs --skip-deploy   # stop before `wrangler deploy`
 *   node scripts/setup.mjs --bucket my-bucket --worker-name my-api --db-name my-db
 *
 * Safe to re-run: every step checks current state first and skips what's
 * already done. Secrets are piped straight to `wrangler secret put` — never
 * logged or written to disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const WORKER_DIR = path.join(ROOT, 'worker');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// ── CLI args ────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const YES = argv.includes('--yes');
const IMPORTING = argv.includes('--importing');
const SKIP_DEPLOY = argv.includes('--skip-deploy');

function argValue(name) {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(name + '='));
  return pref ? pref.slice(name.length + 1) : undefined;
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(SCRIPT_PATH, 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?/gm, ''));
  process.exit(0);
}

// ── Output parsers (exported for testing) ──────────────────────────

export function parseDatabaseId(text) {
  const m = /database_id\W+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(text || '');
  return m ? m[1] : null;
}

export function parseWorkerUrl(text) {
  const m = /https:\/\/[^\s"']+\.workers\.dev/.exec(text || '');
  return m ? m[0] : null;
}

export function parseAccountId(text) {
  const m = /\b([0-9a-f]{32})\b/.exec(text || '');
  return m ? m[1] : null;
}

export function parsePublicBucketUrl(text) {
  const m = /https:\/\/pub-[0-9a-f]+\.r2\.dev/.exec(text || '');
  return m ? m[0] : null;
}

// ── Helpers ─────────────────────────────────────────────────────────

function log(msg) { console.log(msg); }
function step(n, title) { console.log(`\n[${n}/9] ${title}`); }

function fail(msg, hint) {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`  → ${hint}`);
  process.exit(1);
}

/** Run a command, capturing output. In dry-run, print it and run nothing. */
function run(cmd, args, opts = {}) {
  const display = opts.display || `${cmd === NPX ? 'npx' : cmd} ${args.join(' ')}`;
  if (DRY_RUN) {
    console.log(`  [dry-run] $ ${display}`);
    return { status: 0, stdout: '', stderr: '', dryRun: true };
  }
  console.log(`  $ ${display}`);
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || WORKER_DIR,
    encoding: 'utf8',
    input: opts.input,
    env: process.env,
  });
  if (res.error) return { status: 1, stdout: '', stderr: String(res.error.message) };
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function runOrFail(cmd, args, opts, hint) {
  const res = run(cmd, args, opts);
  if (res.status !== 0) {
    if (res.stderr) console.error(res.stderr.trim());
    fail(`Command failed: ${cmd === NPX ? 'npx' : cmd} ${args.join(' ')}`, hint);
  }
  return res;
}

// One shared readline interface for the whole run, with our own line buffer —
// per-question interfaces (and bare rl.question) drop piped lines that arrive
// between questions, and an EOF'd question would hang forever.
let rlInstance = null;
let muteEcho = false;
let stdinClosed = false;
const lineQueue = [];
let pendingLine = null;
function getRl() {
  if (!rlInstance) {
    rlInstance = readline.createInterface({ input: process.stdin, output: process.stdout });
    const original = rlInstance._writeToOutput;
    if (typeof original === 'function') {
      rlInstance._writeToOutput = function (str) {
        if (!muteEcho) original.call(this, str);
      };
    }
    rlInstance.on('line', (line) => {
      if (pendingLine) { const r = pendingLine; pendingLine = null; r(line); }
      else lineQueue.push(line);
    });
    rlInstance.on('close', () => {
      stdinClosed = true;
      if (pendingLine) eofExit();
    });
  }
  return rlInstance;
}
function closeRl() {
  if (rlInstance) { const rl = rlInstance; rlInstance = null; stdinClosed = true; rl.close(); }
}
function eofExit() {
  console.error('\n✗ Input stream ended before the wizard finished.');
  console.error('  → Run it interactively, or use --yes (accept defaults) / --dry-run.');
  process.exit(1);
}

/** Ask one question on the shared interface; exit loudly if stdin ends mid-question. */
function question(prompt) {
  getRl();
  process.stdout.write(prompt);
  if (lineQueue.length) {
    const line = lineQueue.shift();
    process.stdout.write('\n');
    return Promise.resolve(line);
  }
  if (stdinClosed) eofExit();
  return new Promise((resolve) => { pendingLine = resolve; });
}

/** Prompt for a line of input. In --yes / --dry-run mode, return the default. */
async function ask(q, def = '') {
  if (YES || DRY_RUN) return def;
  const answer = await question(def ? `${q} [${def}]: ` : `${q}: `);
  return answer.trim() || def;
}

async function confirm(q, def = true) {
  if (YES || DRY_RUN) return def;
  const a = await ask(`${q} (${def ? 'Y/n' : 'y/N'})`);
  if (!a) return def;
  return /^y(es)?$/i.test(a);
}

/** Prompt without echoing the typed value (for secrets). */
async function askSecret(q) {
  if (YES || DRY_RUN) return '';
  process.stdout.write(`${q}: `);
  muteEcho = true;
  const answer = await question('');
  muteEcho = false;
  process.stdout.write('\n');
  return answer.trim();
}

// ── wrangler.toml editing ───────────────────────────────────────────

const TOML_PATH = path.join(WORKER_DIR, 'wrangler.toml');
const TOML_EXAMPLE_PATH = path.join(WORKER_DIR, 'wrangler.toml.example');

function readToml() {
  return fs.existsSync(TOML_PATH) ? fs.readFileSync(TOML_PATH, 'utf8') : null;
}

function getTomlValue(content, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(content || '');
  return m ? m[1] : null;
}

function setTomlValue(content, key, value) {
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*)"[^"]*"`, 'm');
  if (!re.test(content)) fail(`Could not find \`${key} = "..."\` in wrangler.toml to update.`);
  return content.replace(re, `$1"${value}"`);
}

/** Apply {key: value} updates to wrangler.toml, confirming before changing a pre-existing file. */
async function updateToml(updates, preExisting) {
  let content = readToml();
  const changes = Object.entries(updates).filter(([k, v]) => v && getTomlValue(content, k) !== v);
  if (!changes.length) return;
  for (const [k, v] of changes) log(`  wrangler.toml: ${k} = "${v}"`);
  if (preExisting && !DRY_RUN) {
    const ok = await confirm('  wrangler.toml already existed — apply these changes to it?');
    if (!ok) fail('Aborted — wrangler.toml left untouched.', 'Re-run after editing it yourself, or remove it to start from the template.');
  }
  if (DRY_RUN) return;
  for (const [k, v] of changes) content = setTomlValue(content, k, v);
  fs.writeFileSync(TOML_PATH, content);
}

// ── Main flow ───────────────────────────────────────────────────────

async function main() {
  log('Off Grid setup wizard');
  log('─────────────────────');
  if (DRY_RUN) log('(dry run — printing the plan, executing nothing)');

  // [1/9] Preflight
  step(1, 'Preflight checks');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) fail(`Node 18+ required (you have ${process.version}).`, 'Install a newer Node from https://nodejs.org');
  log(`  ✓ Node ${process.version}`);
  if (!fs.existsSync(WORKER_DIR)) fail('worker/ directory not found next to scripts/ — is this a full checkout?');
  if (!fs.existsSync(path.join(WORKER_DIR, 'node_modules'))) {
    log('  worker/node_modules missing — installing dependencies…');
    runOrFail(NPM, ['install'], {}, 'Check your npm/network setup and re-run.');
  } else {
    log('  ✓ worker dependencies installed');
  }

  // [2/9] Cloudflare auth
  step(2, 'Cloudflare authentication');
  let accountId = null;
  {
    const res = run(NPX, ['wrangler', 'whoami']);
    if (!res.dryRun) {
      if (res.status !== 0 || /not authenticated|You are not logged in/i.test(res.stdout + res.stderr)) {
        fail('wrangler is not authenticated.',
          'Run `npx wrangler login` in worker/ (or, if the browser flow can\'t reach your machine — e.g. WSL — export CLOUDFLARE_API_TOKEN; see docs/ONBOARDING.md → Troubleshooting), then re-run this wizard.');
      }
      accountId = parseAccountId(res.stdout);
      log('  ✓ authenticated' + (accountId ? ` (account ${accountId.slice(0, 8)}…)` : ''));
    }
  }

  // [3/9] wrangler.toml
  step(3, 'Worker configuration (wrangler.toml)');
  const preExisting = fs.existsSync(TOML_PATH);
  if (!preExisting) {
    log('  creating worker/wrangler.toml from the template');
    if (!DRY_RUN) fs.copyFileSync(TOML_EXAMPLE_PATH, TOML_PATH);
  } else {
    log('  ✓ worker/wrangler.toml exists — existing values become the defaults below');
  }
  const toml = readToml() || fs.readFileSync(TOML_EXAMPLE_PATH, 'utf8');
  const workerName = argValue('--worker-name')
    || await ask('  Worker name', getTomlValue(toml, 'name') || 'offgrid-api');
  const bucketName = argValue('--bucket')
    || await ask('  R2 bucket name (created in the dashboard, Stage 1)', getTomlValue(toml, 'bucket_name') || 'offgrid-media');
  const dbName = argValue('--db-name')
    || await ask('  D1 database name', getTomlValue(toml, 'database_name') || 'offgrid-db');
  await updateToml({ name: workerName, bucket_name: bucketName, R2_BUCKET_NAME: bucketName, database_name: dbName }, preExisting);

  // [4/9] R2 bucket
  step(4, `R2 bucket (${bucketName})`);
  {
    const res = run(NPX, ['wrangler', 'r2', 'bucket', 'create', bucketName]);
    if (!res.dryRun && res.status !== 0) {
      if (/already (exists|owned)/i.test(res.stdout + res.stderr)) log('  ✓ bucket already exists');
      else { console.error(res.stderr.trim()); fail('Could not create the R2 bucket.', 'Is R2 activated on your account? It needs a payment method even on the free tier — see docs/ONBOARDING.md → Accounts.'); }
    }
  }
  let pubUrl = getTomlValue(readToml() || '', 'R2_PUBLIC_URL');
  if (pubUrl && pubUrl.includes('pub-xxxxxxxx')) pubUrl = null;
  if (!pubUrl) {
    let devUrl = run(NPX, ['wrangler', 'r2', 'bucket', 'dev-url', 'get', bucketName]);
    pubUrl = parsePublicBucketUrl(devUrl.stdout);
    if (!pubUrl && !devUrl.dryRun) {
      log('  public dev URL not enabled yet — enabling it');
      run(NPX, ['wrangler', 'r2', 'bucket', 'dev-url', 'enable', bucketName], { input: 'y\n' });
      devUrl = run(NPX, ['wrangler', 'r2', 'bucket', 'dev-url', 'get', bucketName]);
      pubUrl = parsePublicBucketUrl(devUrl.stdout);
    }
    if (!pubUrl && !DRY_RUN) {
      pubUrl = await ask('  Could not detect the public bucket URL. Paste it (dashboard → R2 → bucket → Settings → Public access, e.g. https://pub-xxxxxxxx.r2.dev)');
      if (!pubUrl) fail('A public bucket URL is required.', 'Enable Public access on the bucket, then re-run.');
    }
    if (pubUrl) {
      pubUrl = pubUrl.replace(/\/+$/, '');
      await updateToml({ R2_PUBLIC_URL: pubUrl }, preExisting);
    }
  } else {
    log(`  ✓ R2_PUBLIC_URL already set (${pubUrl})`);
  }
  run(NPX, ['wrangler', 'r2', 'bucket', 'cors', 'set', bucketName, '--file', './r2-cors.json'], { input: 'y\n' });

  // [5/9] D1 database
  step(5, `D1 database (${dbName})`);
  let dbId = getTomlValue(readToml() || '', 'database_id');
  if (dbId && dbId !== 'YOUR_DATABASE_ID') {
    log(`  ✓ database_id already set (${dbId.slice(0, 8)}…)`);
  } else {
    const res = run(NPX, ['wrangler', 'd1', 'create', dbName]);
    dbId = parseDatabaseId(res.stdout + res.stderr);
    if (!dbId && !res.dryRun) {
      // Maybe it already exists, or output format changed — look it up.
      const list = run(NPX, ['wrangler', 'd1', 'list', '--json']);
      try {
        const entry = JSON.parse(list.stdout).find((d) => d.name === dbName);
        if (entry) dbId = entry.uuid || entry.id || null;
      } catch { /* fall through */ }
    }
    if (!dbId && !DRY_RUN) fail('Could not determine the database_id.', `Run \`npx wrangler d1 create ${dbName}\` yourself and paste the id into worker/wrangler.toml, then re-run.`);
    if (dbId) await updateToml({ database_id: dbId }, preExisting);
  }

  // [6/9] Migrations
  step(6, 'Database migrations');
  const migrations = fs.readdirSync(path.join(WORKER_DIR, 'migrations'))
    .filter((f) => f.endsWith('.sql')).sort();
  for (const file of migrations) {
    if (IMPORTING && file.startsWith('004_')) {
      log(`  skipping ${file} (--importing: run it after bootstrapping your admin — see docs/ONBOARDING.md Stage 3)`);
      continue;
    }
    const res = run(NPX, ['wrangler', 'd1', 'execute', dbName, '--remote', '-y', `--file=migrations/${file}`]);
    if (!res.dryRun && res.status !== 0) {
      if (/duplicate column name|already exists/i.test(res.stdout + res.stderr)) {
        log(`  ✓ ${file} appears already applied — continuing`);
      } else {
        console.error(res.stderr.trim());
        fail(`Migration ${file} failed.`, `Fix the error and re-run, or apply it manually: npx wrangler d1 execute ${dbName} --remote --file=migrations/${file}`);
      }
    }
  }

  // [7/9] Secrets
  step(7, 'Worker secrets');
  const generatedNote = [];
  let adminToken = null;
  const putSecret = (name, value) => {
    if (DRY_RUN) { console.log(`  [dry-run] $ echo '********' | npx wrangler secret put ${name}`); return; }
    const res = spawnSync(NPX, ['wrangler', 'secret', 'put', name], {
      cwd: WORKER_DIR, input: value + '\n', stdio: ['pipe', 'inherit', 'inherit'], env: process.env,
    });
    if (res.status !== 0) fail(`Setting secret ${name} failed.`, `Retry manually: npx wrangler secret put ${name}`);
  };
  const secretPlan = [
    { name: 'ADMIN_TOKEN', desc: 'bootstrap/CLI admin token (you type it once into First-time setup)', generate: true },
    { name: 'JWT_SECRET', desc: 'signs login sessions (you never need to see it)', generate: true },
    { name: 'R2_ACCESS_KEY_ID', desc: 'R2 API token access key (Stage 2)', generate: false },
    { name: 'R2_SECRET_ACCESS_KEY', desc: 'R2 API token secret (Stage 2)', generate: false },
    { name: 'CF_ACCOUNT_ID', desc: 'your Cloudflare account ID', generate: false, defaultValue: accountId },
  ];
  for (const s of secretPlan) {
    if (DRY_RUN) { putSecret(s.name); continue; }
    if (!(await confirm(`  Set ${s.name} (${s.desc})?`))) { log(`  skipped ${s.name}`); continue; }
    let value = null;
    if (s.generate && (await confirm(`    Auto-generate a random ${s.name}?`))) {
      value = crypto.randomBytes(32).toString('hex');
      if (s.name === 'ADMIN_TOKEN') adminToken = value;
      else generatedNote.push(s.name);
    } else if (s.defaultValue && (await confirm(`    Use the account ID detected from wrangler (${s.defaultValue})?`))) {
      value = s.defaultValue;
    } else {
      value = await askSecret(`    Paste the value for ${s.name} (input hidden)`);
    }
    if (!value) { log(`  skipped ${s.name} (no value)`); continue; }
    putSecret(s.name, value);
  }

  // [8/9] Deploy
  step(8, 'Deploy the Worker');
  let workerUrl = null;
  if (SKIP_DEPLOY) {
    log('  skipped (--skip-deploy). Deploy later with: cd worker && npx wrangler deploy');
  } else {
    const res = runOrFail(NPX, ['wrangler', 'deploy'], {}, 'Fix the error above and re-run (the wizard skips completed steps).');
    if (res.stdout) process.stdout.write(res.stdout);
    workerUrl = parseWorkerUrl(res.stdout);
  }

  // [9/9] Summary
  step(9, 'Done — next steps');
  const pub = pubUrl || 'https://pub-xxxxxxxx.r2.dev';
  const worker = workerUrl || `https://${workerName}.YOUR-SUBDOMAIN.workers.dev`;
  const snippet =
    `window.OFFGRID_MANIFEST_URL = '${pub}/data/manifest.json';\n` +
    `window.OFFGRID_API_BASE = '${worker}';\n`;
  log('');
  if (adminToken) {
    log('  ★ Your generated ADMIN_TOKEN (shown once — save it now, you need it for First-time setup):');
    log(`    ${adminToken}`);
    log('');
  }
  if (generatedNote.length) log(`  Generated and set: ${generatedNote.join(', ')} (no need to save these)`);
  const configPath = path.join(ROOT, 'config.local.js');
  log('  Frontend config (config.local.js):');
  log(snippet.replace(/^/gm, '    '));
  if (!fs.existsSync(configPath) && !DRY_RUN && (pubUrl || workerUrl)) {
    if (await confirm('  config.local.js does not exist — write it with these values?')) {
      fs.writeFileSync(configPath, `// Written by scripts/setup.mjs — see config.local.example.js for all options.\n${snippet}`);
      log('  ✓ wrote config.local.js');
    }
  } else if (fs.existsSync(configPath)) {
    log('  config.local.js already exists — left untouched; merge the values above yourself if needed.');
  }
  log('  Next:');
  log('    1. Serve the frontend (e.g. `python3 -m http.server 8080`) and open /admin/');
  log('    2. Click “First-time setup”, paste your ADMIN_TOKEN, choose your admin email + password');
  if (IMPORTING) log('    2b. Then apply migration 004: cd worker && npx wrangler d1 execute ' + dbName + ' --remote --file=migrations/004_content_ownership.sql');
  log('    3. Add a mix, click Publish, and open the player page');
  log('    4. Verify everything: node scripts/check.mjs');
  log('  Full guide: docs/ONBOARDING.md');
  closeRl();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  main().catch((err) => {
    console.error('\n✗ Unexpected error:', err.message);
    process.exit(1);
  });
}
