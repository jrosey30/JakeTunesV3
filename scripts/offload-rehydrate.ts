/**
 * Pull hub-offloaded audio back onto the laptop.
 *
 * Reads the JSONL written when a local file was replaced with a symlink.
 * Downloads that id from homemini (raw /audio/:id, no transcode) and writes
 * the bytes back only when the size and full sha1 match the log. A 256KB
 * fingerprint is not enough. Stops before a write that would leave less
 * than 10 GB free (same floor as iPod sync staging).
 *
 * Library root: --library-root if passed, otherwise library.musicRoot from
 * app-settings.json when that iPod tree exists, otherwise
 * ~/Music2/JakeTunesLibrary (the hub tree that rsyncs to the NAS).
 *
 * From the repo, on the hub:
 *   node --experimental-strip-types scripts/offload-rehydrate.ts \
 *     --log "$HOME/Library/Application Support/JakeTunes/offload-replacements.jsonl"
 *
 * Optional: --library-root <JakeTunesLibrary> --base http://homemini:3000/audio
 */
import { existsSync, readFileSync } from 'fs'
import { mkdir, readFile, writeFile, lstat, statfs, rename, unlink } from 'fs/promises'
import { homedir } from 'os'
import { dirname } from 'path'
import { colonPathToAbs } from '../src/main/activity-boardable.ts'
import {
  musicRootFromSettings,
  offloadSettingsPaths,
  parseReplacementLog,
  rawAudioUrl,
  rehydrateReplacements,
  resolveOffloadLibraryRoot,
  urlAsksForTranscode,
  FULL_BODY_TIMEOUT_MS,
} from '../src/main/offload-audio.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i < 0) return undefined
  return process.argv[i + 1]
}

function settingsMusicRoot(home: string): string | null {
  for (const file of offloadSettingsPaths(home)) {
    try {
      const root = musicRootFromSettings(JSON.parse(readFileSync(file, 'utf-8')))
      if (root) return root
    } catch {
      // Missing or unreadable settings file. Try the next location.
    }
  }
  return null
}

async function main(): Promise<void> {
  const home = homedir()
  const logPath = arg('--log')
  const base = (arg('--base') || 'http://homemini:3000/audio').replace(/\/$/, '')
  const libraryRoot = resolveOffloadLibraryRoot({
    explicit: arg('--library-root'),
    settingsMusicRoot: settingsMusicRoot(home),
    home,
    exists: existsSync,
  })
  if (!logPath) {
    console.error('usage: node --experimental-strip-types scripts/offload-rehydrate.ts --log <offload-replacements.jsonl> [--library-root <JakeTunesLibrary>] [--base http://homemini:3000/audio]')
    console.error('library root is read from app-settings.json (library.musicRoot), then ~/Music2/JakeTunesLibrary')
    process.exitCode = 1
    return
  }
  if (urlAsksForTranscode(base)) {
    console.error('refusing a transcode URL; pass the raw /audio base')
    process.exitCode = 1
    return
  }
  console.log(`library root: ${libraryRoot}`)
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
      const url = rawAudioUrl(base, id)
      if (urlAsksForTranscode(url)) return null
      const res = await fetch(url, { signal: AbortSignal.timeout(FULL_BODY_TIMEOUT_MS) })
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
