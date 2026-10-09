/**
 * Pull hub-offloaded audio back onto the laptop.
 *
 * Reads the JSONL written when a local file was replaced with a symlink.
 * Downloads that id from homemini and writes the bytes back only when the
 * first 256KB sha1 matches the log. Stops before a write that would leave
 * less than 10 GB free (same floor as iPod sync staging).
 *
 * From the repo, on the hub:
 *   node --experimental-strip-types scripts/offload-rehydrate.ts \
 *     --library-root "$HOME/Music/JakeTunesLibrary" \
 *     --log "$HOME/Library/Application Support/JakeTunes/offload-replacements.jsonl"
 *
 * Optional: --base http://homemini:3000/audio
 */
import { mkdir, readFile, writeFile, lstat, statfs, rename, unlink } from 'fs/promises'
import { dirname } from 'path'
import { colonPathToAbs } from '../src/main/activity-boardable.ts'
import { parseReplacementLog, rehydrateReplacements } from '../src/main/offload-audio.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i < 0) return undefined
  return process.argv[i + 1]
}

async function main(): Promise<void> {
  const libraryRoot = arg('--library-root')
  const logPath = arg('--log')
  const base = (arg('--base') || 'http://homemini:3000/audio').replace(/\/$/, '')
  if (!libraryRoot || !logPath) {
    console.error('usage: node --experimental-strip-types scripts/offload-rehydrate.ts --library-root <JakeTunesLibrary> --log <offload-replacements.jsonl> [--base http://homemini:3000/audio]')
    process.exitCode = 1
    return
  }
  const text = await readFile(logPath, 'utf-8')
  const records = parseReplacementLog(text)
  const sep = process.platform === 'win32' ? '\\' : '/'
  const result = await rehydrateReplacements({
    records,
    freeBytes: async () => {
      const s = await statfs(libraryRoot)
      return Number(s.bavail) * Number(s.bsize)
    },
    fetchFull: async (id) => {
      const res = await fetch(`${base}/${encodeURIComponent(String(id))}`)
      if (!res.ok) return null
      return Buffer.from(await res.arrayBuffer())
    },
    currentKind: async (record) => {
      try {
        const st = await lstat(colonPathToAbs(record.path, libraryRoot, sep))
        if (st.isSymbolicLink()) return 'symlink'
        if (st.isFile()) return 'file'
        return 'missing'
      } catch {
        return 'missing'
      }
    },
    writeBack: async (record, bytes) => {
      const abs = colonPathToAbs(record.path, libraryRoot, sep)
      await mkdir(dirname(abs), { recursive: true })
      const tmp = abs + '.rehydrate.tmp'
      try { await unlink(tmp) } catch { /* no partial */ }
      await writeFile(tmp, bytes)
      await rename(tmp, abs)
    },
  })
  if (result.stoppedBecause) {
    console.error(`restored ${result.restored}, skipped ${result.skipped}, stopped: ${result.stoppedBecause}`)
    process.exitCode = 2
    return
  }
  console.log(`restored ${result.restored}, skipped ${result.skipped}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
