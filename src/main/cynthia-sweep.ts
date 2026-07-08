/**
 * Cynthia overhaul — the background sweep.
 *
 * "Done before I ask": while nothing is playing, walk the library album
 * by album, run the deterministic scanner + the (disk-cached) MusicBrainz
 * diff, auto-apply the PROVABLE fixes through the existing overrides
 * pipeline (recorded in a revertable ledger), park judgment findings for
 * one-click review, and remember every dismissal so nothing re-nags.
 *
 * Pattern lineage: the audio-analysis queue (idle-gated worker, persisted
 * queue file, small batches per tick, progress events). All I/O with the
 * rest of main goes through injected hooks — no import of index.ts, so
 * the module stays cycle-free and testable.
 *
 * Sidecars (all JsonFileCache — atomic tmp+rename writes):
 *   cynthia-findings.json   albumKey → pending judgment findings + flags
 *   cynthia-dismissed.json  dismissKey → {at}   (trackId|field|newValue)
 *   cynthia-ledger.json     auto-applied receipts with oldValue (revertable)
 *   cynthia-sweep-queue.json queue + per-album sweptAt + daily escalation budget
 */

import { join } from 'path'
import { STATE_DIR } from './state-dir'
import { JsonFileCache } from './state-cache'
import { scanAlbum, type CynthiaScanTrack, type CynthiaFinding, type CynthiaScanFlag } from './cynthia-scan'
import { scanLibraryConsistency } from './cynthia-library-scan'
import { diffAgainstMusicBrainz, type MbLookupResult, type CynthiaMissingTrack } from './cynthia-mb-diff'
import { getCachedMbRelease } from './mb-release-cache'

// ⚠️ TWIN: src/renderer/utils/albumKey.ts albumKeyOf() — same key scheme,
// duplicated across the process boundary. Change BOTH or scope lookups break.
export function albumKeyOfMain(t: { artist?: string; albumArtist?: string; album?: string }): string {
  const artist = (t.albumArtist || t.artist || 'Unknown Artist').toLowerCase().trim()
  const album = (t.album || 'Unknown').toLowerCase().trim()
  return `${artist}|||${album}`
}

export interface CynthiaAlbumFindings {
  albumKey: string
  albumLabel: string
  scannedAt: number
  findings: CynthiaFinding[]          // judgment findings awaiting review
  missingTracks: CynthiaMissingTrack[]
  flags: CynthiaScanFlag[]
  autoAppliedCount: number            // receipts live in the ledger
}

export interface CynthiaLedgerEntry {
  id: string
  at: number
  albumKey: string
  albumLabel: string
  trackId: number
  field: string
  oldValue: string
  newValue: string
  reason: string
  source: string
  reverted?: boolean
}

interface SweepQueueState {
  queue: string[]                      // albumKeys awaiting sweep
  sweptAt: Record<string, number>
  initializedAt: number | null
  escalation: { day: string; used: number }
  /** Bump SCANNER_VERSION when detection rules evolve — stale versions
   *  force a full resweep instead of waiting out the 7-day TTL. */
  scannerVersion?: number
}

// v2: neat-freak pass (albumArtist/genre/year sibling fills + the
// library-wide vocabulary scan).
// v3: year-implausible flag (<1900 or >now+1, single-track albums
// included) + implausible years no longer seed sibling year fills.
const SCANNER_VERSION = 3

export interface CynthiaSweepHooks {
  /** Current library grouped by album key. Called fresh each tick. */
  getAlbums(): Map<string, { label: string; tracks: CynthiaScanTrack[] }>
  /** The uncached MusicBrainz lookup (sweep wraps it with the disk cache). */
  fetchMbRelease(artist: string, album: string): Promise<string>
  /** Write one override through the existing serialized pipeline. */
  applyOverride(trackId: number, field: string, value: string, fingerprint: string): Promise<void>
  /** True when it's safe to burn CPU/network (nothing playing). */
  isIdle(): boolean
  /** Progress + applied-fix events for the renderer. */
  sendProgress(payload: {
    swept: number
    total: number
    withFindings: number
    autoApplied: Array<{ trackId: number; field: string; newValue: string }>
    currentAlbum?: string
  }): void
  /** Optional Sonnet escalation for ambiguous albums (budgeted). */
  escalate?(albumKey: string, label: string, tracks: CynthiaScanTrack[], evidence: string): Promise<{ findings: CynthiaFinding[]; summary: string } | null>
}

const RESWEEP_TTL_MS = 7 * 24 * 60 * 60 * 1000
const ALBUMS_PER_TICK = 3
const TICK_IDLE_WAIT_MS = 30_000
const TICK_GAP_MS = 1_500            // breathe between batches (MB rate courtesy)
const AUTO_APPLY_CAP_PER_TICK = 50
const ESCALATIONS_PER_DAY = 25
const MB_MIN_TRACKS = 3              // singles/tiny scopes skip the MB fetch

const findingsCache = new JsonFileCache<Record<string, CynthiaAlbumFindings>>(
  () => join(STATE_DIR, 'cynthia-findings.json'),
  () => ({}),
  'cynthia-findings',
)
const dismissedCache = new JsonFileCache<Record<string, { at: number }>>(
  () => join(STATE_DIR, 'cynthia-dismissed.json'),
  () => ({}),
  'cynthia-dismissed',
)
const ledgerCache = new JsonFileCache<CynthiaLedgerEntry[]>(
  () => join(STATE_DIR, 'cynthia-ledger.json'),
  () => [],
  'cynthia-ledger',
)
const queueCache = new JsonFileCache<SweepQueueState>(
  () => join(STATE_DIR, 'cynthia-sweep-queue.json'),
  () => ({ queue: [], sweptAt: {}, initializedAt: null, escalation: { day: '', used: 0 } }),
  'cynthia-sweep-queue',
)

export function dismissKeyOf(f: { trackId: number; field: string; newValue: string }): string {
  return `${f.trackId}|${f.field}|${f.newValue}`
}

function fingerprintOf(t: CynthiaScanTrack): string {
  // ⚠️ TWIN: CynthiaPopover.tsx builds the same fp for interactive applies.
  return `${String(t.title || '').toLowerCase()}|${String(t.artist || '').toLowerCase()}|${t.duration}`
}

let running = false
let stopped = false
let hooksRef: CynthiaSweepHooks | null = null

export async function startCynthiaSweep(hooks: CynthiaSweepHooks): Promise<void> {
  hooksRef = hooks
  const state = await queueCache.get()
  const albums = hooks.getAlbums()
  const now = Date.now()
  const rulesChanged = (state.scannerVersion ?? 1) !== SCANNER_VERSION
  const stale = [...albums.keys()].filter(k => {
    if (rulesChanged) return true
    const at = state.sweptAt[k]
    return !at || now - at > RESWEEP_TTL_MS
  })
  const queued = new Set(state.queue)
  const additions = stale.filter(k => !queued.has(k))
  if (additions.length > 0 || state.initializedAt === null || rulesChanged) {
    await queueCache.update(s => ({
      ...s,
      queue: [...s.queue, ...additions],
      initializedAt: s.initializedAt ?? now,
      scannerVersion: SCANNER_VERSION,
    }))
    if (rulesChanged) console.log(`[cynthia-sweep] scanner rules v${SCANNER_VERSION} — full resweep queued (${additions.length} albums)`)
  }
  if (!running) {
    running = true
    stopped = false
    void workerLoop()
  }
  // Neat-freak pass: library-WIDE vocabulary consistency (cross-album
  // artist/genre/feat normalization the per-album scanner can't see).
  // Runs once per launch after a short idle delay; self-terminating —
  // applied fixes stop matching (oldValue === newValue) and dismissed
  // ones are filtered, so repeat launches converge to a no-op.
  setTimeout(() => { void runLibraryConsistencyPass() }, 60_000)
}

async function runLibraryConsistencyPass(): Promise<void> {
  const hooks = hooksRef
  if (!hooks) return
  try {
    const albums = hooks.getAlbums()
    const allTracks: CynthiaScanTrack[] = []
    const albumKeyByTrack = new Map<number, { key: string; label: string }>()
    for (const [key, { label, tracks }] of albums) {
      for (const t of tracks) {
        allTracks.push(t)
        albumKeyByTrack.set(t.id, { key, label })
      }
    }
    if (allTracks.length === 0) return
    const dismissed = await dismissedCache.get()
    const found = scanLibraryConsistency(allTracks).filter(f =>
      f.oldValue !== f.newValue && !dismissed[dismissKeyOf(f)],
    )
    if (found.length === 0) return

    const byId = new Map(allTracks.map(t => [t.id, t]))
    const applied: Array<{ trackId: number; field: string; newValue: string }> = []
    const ledgerAdds: CynthiaLedgerEntry[] = []
    const pendingByAlbum = new Map<string, CynthiaFinding[]>()
    let appliedCount = 0
    const LIBRARY_PASS_APPLY_CAP = 100

    for (const f of found) {
      const home = albumKeyByTrack.get(f.trackId)
      const track = byId.get(f.trackId)
      if (!home || !track) continue
      if (f.provable && hooks.isIdle() && appliedCount < LIBRARY_PASS_APPLY_CAP) {
        try {
          await hooks.applyOverride(f.trackId, f.field, f.newValue, fingerprintOf(track))
          appliedCount++
          applied.push({ trackId: f.trackId, field: f.field, newValue: f.newValue })
          ledgerAdds.push({
            id: `${Date.now().toString(36)}-lib-${f.trackId}-${f.field}`,
            at: Date.now(),
            albumKey: home.key,
            albumLabel: home.label,
            trackId: f.trackId,
            field: f.field,
            oldValue: f.oldValue,
            newValue: f.newValue,
            reason: f.reason,
            source: f.source,
          })
          continue
        } catch { /* fall through to pending */ }
      }
      const arr = pendingByAlbum.get(home.key)
      if (arr) arr.push(f)
      else pendingByAlbum.set(home.key, [f])
    }

    if (ledgerAdds.length > 0) await ledgerCache.update(l => [...l, ...ledgerAdds].slice(-2000))
    if (pendingByAlbum.size > 0) {
      await findingsCache.update(fc => {
        const next = { ...fc }
        for (const [key, adds] of pendingByAlbum) {
          const existing = next[key]
          const label = albumKeyByTrack.get(adds[0].trackId)?.label || key
          const seen = new Set((existing?.findings || []).map(dismissKeyOf))
          const merged = [...(existing?.findings || []), ...adds.filter(f => !seen.has(dismissKeyOf(f)))]
          next[key] = existing
            ? { ...existing, findings: merged }
            : { albumKey: key, albumLabel: label, scannedAt: Date.now(), findings: merged, missingTracks: [], flags: [], autoAppliedCount: 0 }
        }
        return next
      })
    }
    if (applied.length > 0) {
      hooks.sendProgress({ swept: 0, total: 0, withFindings: 0, autoApplied: applied, currentAlbum: 'library consistency pass' })
    }
    console.log(`[cynthia-sweep] library consistency pass: ${found.length} findings, ${applied.length} auto-applied, ${found.length - applied.length} queued for review`)
  } catch (err) {
    console.warn('[cynthia-sweep] library consistency pass failed:', err instanceof Error ? err.message : err)
  }
}

export function stopCynthiaSweep(): void {
  stopped = true
}

/** Re-queue specific albums (imports, metadata edits). */
export async function enqueueAlbumsForSweep(albumKeys: string[]): Promise<void> {
  if (albumKeys.length === 0) return
  await queueCache.update(s => {
    const queued = new Set(s.queue)
    const additions = albumKeys.filter(k => !queued.has(k))
    return additions.length ? { ...s, queue: [...s.queue, ...additions] } : s
  })
}

async function workerLoop(): Promise<void> {
  while (!stopped) {
    const hooks = hooksRef
    if (!hooks) return
    if (!hooks.isIdle()) {
      await sleep(TICK_IDLE_WAIT_MS)
      continue
    }
    const state = await queueCache.get()
    if (state.queue.length === 0) {
      await sleep(5 * 60_000)  // drained — check again in 5 min (new enqueues restart naturally)
      continue
    }
    const batch = state.queue.slice(0, ALBUMS_PER_TICK)
    const albums = hooks.getAlbums()
    let autoAppliedThisTick = 0

    for (const albumKey of batch) {
      if (stopped || !hooks.isIdle()) break
      const album = albums.get(albumKey)
      if (!album) continue  // deleted since queued
      try {
        autoAppliedThisTick += await sweepOneAlbum(albumKey, album.label, album.tracks, hooks, autoAppliedThisTick)
      } catch (err) {
        console.warn(`[cynthia-sweep] album failed (${album.label}):`, err instanceof Error ? err.message : err)
      }
    }

    const doneNow = Date.now()
    await queueCache.update(s => {
      const remaining = s.queue.filter(k => !batch.includes(k))
      const sweptAt = { ...s.sweptAt }
      for (const k of batch) sweptAt[k] = doneNow
      return { ...s, queue: remaining, sweptAt }
    })

    const findings = await findingsCache.get()
    const withFindings = Object.values(findings).filter(f => f.findings.length > 0 || f.missingTracks.length > 0).length
    const st = await queueCache.get()
    hooks.sendProgress({
      swept: Object.keys(st.sweptAt).length,
      total: albums.size,
      withFindings,
      autoApplied: [],
    })

    await sleep(TICK_GAP_MS)
  }
  running = false
}

async function sweepOneAlbum(
  albumKey: string,
  label: string,
  tracks: CynthiaScanTrack[],
  hooks: CynthiaSweepHooks,
  alreadyAppliedThisTick: number,
): Promise<number> {
  const scan = scanAlbum(tracks)
  let mbFindings: CynthiaFinding[] = []
  let missingTracks: CynthiaMissingTrack[] = []
  let mbFlags: CynthiaScanFlag[] = []
  let ambiguous = false

  if (tracks.length >= MB_MIN_TRACKS) {
    const artist = String(tracks[0].albumArtist || tracks[0].artist || '')
    const album = String(tracks[0].album || '')
    if (artist && album) {
      try {
        const { raw } = await getCachedMbRelease(artist, album, hooks.fetchMbRelease)
        const mb = JSON.parse(raw) as MbLookupResult
        const diff = diffAgainstMusicBrainz(tracks, mb, { artist, album })
        mbFindings = diff.findings
        missingTracks = diff.missingTracks
        mbFlags = diff.flags
        ambiguous = diff.ambiguous
      } catch (err) {
        console.warn(`[cynthia-sweep] MB diff failed for ${label}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  const dismissed = await dismissedCache.get()
  const all = [...scan.findings, ...mbFindings].filter(f =>
    f.oldValue !== f.newValue && !dismissed[dismissKeyOf(f)],
  )

  // Split: provable → auto-apply (capped); judgment → pending findings.
  const byId = new Map(tracks.map(t => [t.id, t]))
  const applied: Array<{ trackId: number; field: string; newValue: string }> = []
  const pending: CynthiaFinding[] = []
  const ledgerAdds: CynthiaLedgerEntry[] = []
  let appliedCount = alreadyAppliedThisTick

  for (const f of all) {
    const track = byId.get(f.trackId)
    if (f.provable && track && appliedCount < AUTO_APPLY_CAP_PER_TICK) {
      try {
        await hooks.applyOverride(f.trackId, f.field, f.newValue, fingerprintOf(track))
        appliedCount++
        applied.push({ trackId: f.trackId, field: f.field, newValue: f.newValue })
        ledgerAdds.push({
          id: `${Date.now().toString(36)}-${f.trackId}-${f.field}`,
          at: Date.now(),
          albumKey,
          albumLabel: label,
          trackId: f.trackId,
          field: f.field,
          oldValue: f.oldValue,
          newValue: f.newValue,
          reason: f.reason,
          source: f.source,
        })
      } catch (err) {
        console.warn(`[cynthia-sweep] auto-apply failed (${label} / ${f.field}):`, err instanceof Error ? err.message : err)
        pending.push(f)
      }
    } else {
      pending.push(f)
    }
  }

  if (ledgerAdds.length > 0) {
    await ledgerCache.update(l => [...l, ...ledgerAdds].slice(-2000))
  }

  // Escalation: genuinely ambiguous album + budget remains → Sonnet pass.
  let escalationFindings: CynthiaFinding[] = []
  if (ambiguous && hooks.escalate) {
    const today = new Date().toISOString().slice(0, 10)
    const st = await queueCache.get()
    const used = st.escalation.day === today ? st.escalation.used : 0
    if (used < ESCALATIONS_PER_DAY) {
      await queueCache.update(s => ({ ...s, escalation: { day: today, used: used + 1 } }))
      try {
        const evidence = JSON.stringify({ scanFlags: [...scan.flags, ...mbFlags], note: 'release identity ambiguous — pick the right edition and derive fixes' })
        const result = await hooks.escalate(albumKey, label, tracks, evidence)
        if (result) {
          escalationFindings = result.findings.filter(f =>
            f.oldValue !== f.newValue && !dismissed[dismissKeyOf(f)],
          ).map(f => ({ ...f, provable: false }))  // model output never auto-applies
        }
      } catch (err) {
        console.warn(`[cynthia-sweep] escalation failed (${label}):`, err instanceof Error ? err.message : err)
      }
    }
  }

  const entry: CynthiaAlbumFindings = {
    albumKey,
    albumLabel: label,
    scannedAt: Date.now(),
    findings: [...pending, ...escalationFindings],
    missingTracks,
    flags: [...scan.flags, ...mbFlags],
    autoAppliedCount: applied.length,
  }
  await findingsCache.update(fc => ({ ...fc, [albumKey]: entry }))

  if (applied.length > 0) {
    hooks.sendProgress({ swept: 0, total: 0, withFindings: 0, autoApplied: applied, currentAlbum: label })
  }
  return applied.length
}

// ── Read/mutate APIs for the IPC layer ──

export async function getFindingsFor(albumKeys: string[]): Promise<Record<string, CynthiaAlbumFindings>> {
  const all = await findingsCache.get()
  const dismissed = await dismissedCache.get()
  const out: Record<string, CynthiaAlbumFindings> = {}
  for (const k of albumKeys) {
    const entry = all[k]
    if (!entry) continue
    out[k] = { ...entry, findings: entry.findings.filter(f => !dismissed[dismissKeyOf(f)]) }
  }
  return out
}

export async function dismissFinding(f: { trackId: number; field: string; newValue: string }): Promise<void> {
  await dismissedCache.update(d => ({ ...d, [dismissKeyOf(f)]: { at: Date.now() } }))
}

export async function getLedger(limit = 200): Promise<CynthiaLedgerEntry[]> {
  const l = await ledgerCache.get()
  return l.slice(-limit).reverse()
}

/**
 * Revert an auto-applied fix: restore oldValue through the same override
 * pipeline (identity: the exact ledger entry id). The entry is marked
 * reverted, and the fix is auto-dismissed so the next sweep doesn't
 * immediately re-apply it.
 */
export async function revertLedgerEntry(
  id: string,
  applyOverride: CynthiaSweepHooks['applyOverride'],
  getTrack: (trackId: number) => CynthiaScanTrack | undefined,
): Promise<{ ok: boolean; error?: string }> {
  const ledger = await ledgerCache.get()
  const entry = ledger.find(e => e.id === id)
  if (!entry) return { ok: false, error: 'ledger entry not found' }
  if (entry.reverted) return { ok: false, error: 'already reverted' }
  const track = getTrack(entry.trackId)
  if (!track) return { ok: false, error: 'track no longer in library' }
  await applyOverride(entry.trackId, entry.field, entry.oldValue, fingerprintOf(track))
  await dismissedCache.update(d => ({ ...d, [dismissKeyOf({ trackId: entry.trackId, field: entry.field, newValue: entry.newValue })]: { at: Date.now() } }))
  await ledgerCache.update(l => l.map(e => (e.id === id ? { ...e, reverted: true } : e)))
  return { ok: true }
}

export async function sweepStatus(): Promise<{ swept: number; queued: number; withFindings: number; autoAppliedTotal: number; lastSweptAt: number | null }> {
  const st = await queueCache.get()
  const findings = await findingsCache.get()
  const ledger = await ledgerCache.get()
  const sweptTimes = Object.values(st.sweptAt)
  return {
    swept: sweptTimes.length,
    queued: st.queue.length,
    withFindings: Object.values(findings).filter(f => f.findings.length > 0 || f.missingTracks.length > 0).length,
    autoAppliedTotal: ledger.filter(e => !e.reverted).length,
    lastSweptAt: sweptTimes.length ? Math.max(...sweptTimes) : null,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
