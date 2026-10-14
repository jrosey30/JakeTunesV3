#!/usr/bin/env node
/**
 * Brief 192 — the stale root bundle stays dead.
 *
 * The repo-root `index.js` was an 808 KB esbuild bundle of an old main
 * process (last committed 2026-08-04) that presented as the app; the
 * real entry point is `out/main/index.js`, built from
 * `src/main/index.ts` (package.json "main"). The bundle is deleted;
 * this check fails if ANY `index.js` reappears at the repo root —
 * there is no legitimate root bundle, stamped or otherwise, so its
 * presence is the regression.
 *
 * Wired into `npm run check` and CI (.github/workflows/check.yml).
 * Root defaults to this script's repo; override with argv[2] or
 * JT_ROOT_BUNDLE_CHECK_DIR (the test uses a fixture tree).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2] || process.env.JT_ROOT_BUNDLE_CHECK_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '..')

if (existsSync(join(root, 'index.js'))) {
  console.error(
    'FAIL (Brief 192): a bundle exists at the repo root (index.js).\n' +
    'The app entry point is out/main/index.js, built from src/main/index.ts.\n' +
    'Delete the root index.js — do not ship, stamp, or run it.',
  )
  process.exit(1)
}
console.log('[brief-192] no root bundle — entry point is out/main/index.js')
