/**
 * Re-ingest an iPod plays archive (2026-10-28).
 *
 * Every sync keeps a copy of the iPod's Play Counts / OTG files, the pre-sync
 * iTunesDB and the device's last-sync-manifest in
 *   <device state dir>/ipod-plays-archive/<timestamp>/
 * (src/main/ipod-plays-archive.ts). This brings an archive's plays home later,
 * through the same round-trip logic the app uses (planRoundTrip), and refuses
 * to count an archive twice (its ingest.json, the live round-trip state, or a
 * ledger line already holding the snapshot).
 *
 * DRY RUN by default — prints what would come home, writes nothing.
 *
 *   node --experimental-strip-types scripts/ipod-plays-reingest.ts \
 *     --archive "$HOME/Library/Application Support/JakeTunes/ipod-plays-archive/<stamp>"
 *
 * Options:
 *   --state <dir>      the iPod's state dir (default: the archive's grandparent)
 *   --root <dir>       the app state root holding library.json + play-events.jsonl
 *                      (default: the state dir, or the folder above ipod-pools/)
 *   --manifest <file>  map with this manifest instead of the archived one
 *   --apply            write: ledger line (kind roundtrip-reingest), play events,
 *                      library.json play counts (backup kept), archive ingest.json.
 *                      Refuses while JakeTunes is running when --root is the app's own
 *                      state dir — the app owns that library.json.
 *                      Never touches the live round-trip state.
 */
import { execFileSync } from 'child_process'
import { copyFile, readFile, rename, writeFile, appendFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { randomUUID } from 'crypto'
import {
  applyArchiveReingest,
  loadPlaysArchive,
  planArchiveReingest,
} from '../src/main/ipod-plays-archive.ts'
import {
  ROUNDTRIP_LEDGER_FILE,
  describeRoundTripOutcome,
  readRoundTripState,
  type ManifestLike,
  type RoundTripHost,
} from '../src/main/sync-engine/roundtrip.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function appIsRunning(): boolean {
  try {
    execFileSync('/usr/bin/pgrep', ['-f', 'JakeTunes.app/Contents/MacOS'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

type LibTrack = { id: number; title?: string; artist?: string; playCount?: number; lastPlayedAt?: number }

async function main(): Promise<void> {
  const archiveArg = arg('archive')
  if (!archiveArg) {
    console.error('usage: --archive <dir> [--state <dir>] [--root <dir>] [--manifest <file>] [--apply]')
    process.exit(2)
  }
  const archiveDir = resolve(archiveArg)
  const stateDir = resolve(arg('state') || dirname(dirname(archiveDir)))
  const poolsAt = stateDir.lastIndexOf('/ipod-pools/')
  const rootDir = resolve(arg('root') || (poolsAt >= 0 ? stateDir.slice(0, poolsAt) : stateDir))
  const apply = process.argv.includes('--apply')

  const archive = await loadPlaysArchive(archiveDir)
  const manifestPath = arg('manifest')
  const manifestOverride = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf-8')) as ManifestLike : undefined
  const state = await readRoundTripState(stateDir)
  const ledger = await readFile(join(stateDir, ROUNDTRIP_LEDGER_FILE), 'utf-8').catch(() => '')
  const verdict = planArchiveReingest(archive, state, ledger, manifestOverride)

  console.log(`archive  ${archiveDir}`)
  console.log(`  kept   ${archive.meta.archivedAt} (${archive.meta.reason}) — ${archive.meta.card.map((f) => `${f.name} ${f.bytes}B`).join(', ')}`)
  console.log(`state    ${stateDir}`)
  if (verdict.kind !== 'plan') {
    console.log(`→ nothing to do: ${verdict.kind} — ${verdict.why}`)
    return
  }
  const { plan } = verdict
  const libPath = join(rootDir, 'library.json')
  const lib = await readFile(libPath, 'utf-8').then((t) => JSON.parse(t) as { tracks?: LibTrack[] }).catch(() => ({ tracks: [] as LibTrack[] }))
  const byId = new Map((lib.tracks || []).map((t) => [t.id, t]))
  const total = plan.deltas.reduce((n, d) => n + d.delta, 0)
  console.log(`→ would bring home ${total} play(s) across ${plan.deltas.length} song(s)` +
    (plan.otgLists.length ? `, ${plan.otgLists.length} On-The-Go list(s)` : '') + (plan.unmatched ? `, ${plan.unmatched} unmatched` : ''))
  for (const d of plan.deltas) {
    const t = byId.get(d.id)
    console.log(`   +${d.delta}  #${d.id}  ${t ? `${t.title} — ${t.artist}` : '(not in library.json)'}` +
      (d.lastPlayedMs ? `  last ${new Date(d.lastPlayedMs).toISOString()}` : ''))
  }
  if (!apply) {
    console.log('dry run — nothing written. Re-run with --apply (JakeTunes must be quit).')
    return
  }
  // Only the app's own state root is the app's to write; a copy elsewhere (a test, a restore) is not.
  const appRoot = join(homedir(), 'Library', 'Application Support', 'JakeTunes')
  if (rootDir === appRoot && appIsRunning()) {
    console.error('JakeTunes is running — quit it first (the app owns library.json). Nothing written.')
    process.exit(1)
  }

  let updates: Array<{ id: number; field: string; value: number }> = []
  const host: RoundTripHost = {
    stateDir,
    getLibraryTracks: async () => (lib.tracks || []).map((t) => ({ id: t.id, playCount: t.playCount, lastPlayedAt: t.lastPlayedAt })),
    appendPlayEvents: async (trackId, count, tsMs) => {
      const lines = Array.from({ length: count }, () => `{"id":${trackId},"ts":${tsMs}}\n`).join('')
      await appendFile(join(rootDir, 'play-events.jsonl'), lines, 'utf-8')
    },
    sendToRenderer: (_channel, payload) => { updates = (payload as { updates: typeof updates }).updates },
    isSyncInFlight: () => false,
  }
  const outcome = await applyArchiveReingest(archiveDir, plan, host)
  if (updates.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await copyFile(libPath, `${libPath}.bak-reingest-${stamp}`)
    for (const u of updates) {
      const t = byId.get(u.id) as Record<string, unknown> | undefined
      if (t) t[u.field] = u.value
    }
    const tmp = `${libPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(lib, null, 2), 'utf-8')
    await rename(tmp, libPath)
  }
  console.log(`applied: ${describeRoundTripOutcome(outcome)}; ${updates.length} library field update(s)`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
