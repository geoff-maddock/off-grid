import js from '@eslint/js';
import globals from 'globals';

// Three file groups, matching how the code actually runs:
//  - plain browser scripts (no modules, no build step): audio-player.js, admin/
//  - the Cloudflare Worker (ES modules): worker/src/
//  - Node tooling (scripts/, generators, tests)
export default [
  {
    ignores: [
      'node_modules/',
      'worker/node_modules/',
      'mix/',        // generated share pages
      'mixes/',      // local media
      'offline/',
      'data/',
      'config.local.js',  // gitignored per-deployment config
    ],
  },
  js.configs.recommended,
  {
    rules: {
      // Legacy-friendly: empty catch is an established pattern here for
      // best-effort paths; _-prefixed args/catch vars are intentional.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['audio-player.js', 'admin/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        WaveSurfer: 'readonly',   // loaded from CDN at runtime
        OffgridPeaks: 'readonly', // defined by admin/peaks.js
      },
    },
  },
  {
    // The <\/script> escapes in embed-snippet strings are deliberate: they
    // keep the file safe to inline into an HTML <script> block.
    files: ['audio-player.js'],
    rules: { 'no-useless-escape': 'off' },
  },
  {
    files: ['worker/src/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.serviceworker },
    },
  },
  {
    files: ['scripts/**/*.js', 'generate-*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    files: ['scripts/**/*.mjs', 'generate-*.mjs', 'tests/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
