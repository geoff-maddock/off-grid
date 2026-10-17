#!/usr/bin/env node
// Build a tracklist from a Serato DJ history export.
//
//   node scripts/tracklist.mjs <serato.csv> [--format json|text] [--out file]
//
// json (default) prints the full tracklist; text prints lines you can paste
// into the admin's Tracklist box.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseSeratoHistory } from './tracklist/serato.mjs';
import { toJson, toText } from './tracklist/format.mjs';

const USAGE = 'Usage: node scripts/tracklist.mjs <serato.csv> [--format json|text] [--out file]';

function parseArgs(argv) {
  const opts = { input: null, format: 'json', out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') opts.format = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    else if (!opts.input) opts.input = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  if (!['json', 'text'].includes(opts.format)) throw new Error(`--format must be json or text`);
  if (opts.out === undefined) throw new Error('--out needs a file path');
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help || !opts.input) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
  }

  const tracklist = parseSeratoHistory(readFileSync(opts.input, 'utf8'));
  const output = opts.format === 'text' ? toText(tracklist) : toJson(tracklist);
  if (opts.out) {
    writeFileSync(opts.out, output);
    console.error(`Wrote ${tracklist.tracks.length} tracks to ${opts.out}`);
  } else {
    process.stdout.write(output);
  }
}

main();
