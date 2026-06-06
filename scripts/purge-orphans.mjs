// Identity-safe orphan purge: delete audio files on disk whose basename is
// NOT referenced by any library.json track path. Also deletes macOS `._*`
// resource-fork files. Never modifies library.json.
//
//   node scripts/purge-orphans.mjs           # dry run (default)
//   node scripts/purge-orphans.mjs --commit  # permanent delete

import { stat, unlink } from 'fs/promises'
import { basename } from 'path'
import {
  resolveMusicDir,
  loadLibrary,
  walkAudioFiles,
  isOrphanFile,
} from './lib-orphan-shared.mjs'

const commit = process.argv.includes('--commit')

const { musicDir, source } = resolveMusicDir()
const { tracks, indexed } = loadLibrary()

console.log(`music root: ${musicDir} (${source})`)
console.log(`mode: ${commit ? 'COMMIT (permanent delete)' : 'DRY RUN (pass --commit to delete)'}\n`)

const files = await walkAudioFiles(musicDir)
const toDelete = []
for (const f of files) {
  const check = isOrphanFile(f, indexed)
  if (check.orphan) toDelete.push({ path: f, reason: check.reason })
}

let totalBytes = 0
for (const item of toDelete) {
  try {
    const s = await stat(item.path)
    totalBytes += s.size
  } catch { /* gone */ }
}

console.log(`index: ${tracks.length} tracks | disk: ${files.length} audio files | orphans to purge: ${toDelete.length}`)
console.log(`reclaimable: ${(totalBytes / 1e9).toFixed(2)} GB\n`)

if (toDelete.length === 0) {
  console.log('Nothing to purge. Library mirror is tidy.')
  process.exit(0)
}

for (const item of toDelete) {
  const s = await stat(item.path).catch(() => null)
  const kb = s ? (s.size / 1024).toFixed(1) : '?'
  console.log(`  ${commit ? 'DELETE' : 'would delete'}  ${basename(item.path).padEnd(24)}  ${kb} KB  (${item.reason})`)
  if (commit) {
    try {
      await unlink(item.path)
    } catch (err) {
      console.error(`  FAILED: ${item.path}: ${err.message}`)
    }
  }
}

console.log(`\n${commit ? 'Deleted' : 'Would delete'} ${toDelete.length} file(s), ${(totalBytes / 1e9).toFixed(2)} GB`)
if (!commit) console.log('\nRe-run with --commit to permanently delete.')
