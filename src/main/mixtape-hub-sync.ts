/**
 * Mixtape hub client (2026-08-28) — tapes converge with homemini exactly
 * like playlists do (playlist-hub-sync.ts), plus a VOICE-AUDIO heal:
 * every intro/talkover a tape references is uploaded to the hub's store
 * when the hub lacks it and downloaded when this machine lacks it. Files
 * are immutable both sides — never overwritten, only added — and every
 * name is derived from paths under OUR mixtape-intros dir (a tape's JSON
 * can never aim the copier anywhere else).
 *
 * 2026-10-22 (audit A02) — same guard as the playlist client: a hub reply is
 * adopted only if no local writer (mixtape-save, mixtape-delete, the monthly
 * season tape — mixtape-store-writes.ts) moved the shelf since the snapshot we
 * sent, checked under the shelf's lock. Otherwise the reply is dropped and the
 * converge runs again at once; the hub already merged the snapshot, so nothing
 * is lost, and a tape deleted / edited / recorded during the request can no
 * longer be undone by an older answer (see hub-local-state.ts).
 *
 * Electron-free: deps injected, node --test loads it.
 */
import { basename, join } from 'path'
import { readFile, writeFile, rename, mkdir, access } from 'fs/promises'
import { loadTombstones, saveTombstones, sameTombstoneSet } from './playlist-tombstones.ts'
import { withCompanionInit } from './hub-companion.ts'
import {
  bumpLocalGen, snapshotLocalGens, movedGens, withLocalLock, lockKeys, MIXTAPE_HUB_COLLECTIONS,
} from './hub-local-state.ts'

export interface HubTapeLike {
  id?: unknown
  modifiedAt?: unknown
  introPath?: unknown
  talkovers?: unknown
  [k: string]: unknown
}

export interface MixtapeHubDeps {
  hubUrl: string
  device: string
  getMixtapes: () => Promise<HubTapeLike[]>
  setMixtapes: (tapes: HubTapeLike[]) => Promise<void>
  tombstonesFile: string
  /** This machine's mixtape-intros dir (absolute). */
  introsDir: string
  fetchFn?: typeof fetch
  log?: (msg: string) => void
}

const sig = (tapes: HubTapeLike[]): string =>
  JSON.stringify([...tapes].map((t) => [String(t.id), String(t.modifiedAt ?? '')]).sort())

/** Basenames of every voice file the given tapes reference, path-gated. */
export function referencedAudioNames(tapes: HubTapeLike[], introsDir: string): string[] {
  const prefix = introsDir.endsWith('/') ? introsDir : introsDir + '/'
  const names = new Set<string>()
  for (const t of tapes) {
    const paths: unknown[] = [t.introPath]
    if (Array.isArray(t.talkovers)) for (const tv of t.talkovers) paths.push((tv as { path?: unknown })?.path)
    for (const p of paths) {
      if (typeof p !== 'string') continue
      const name = basename(p)
      // EXACT composition: the path must be precisely dir + '/' + name — a
      // prefix check alone lets `dir/../evil.m4a` through (the test that
      // caught this). No subdirs, no traversal, m4a only.
      if (p !== prefix + name) continue
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.m4a$/.test(name)) names.add(name)
    }
  }
  return [...names].sort()
}

export interface MixtapeConvergeResult {
  ok: boolean
  changed: boolean
  audioPulled: number
  audioPushed: number
  error?: string
  /** Every attempt was overtaken by a newer local change; nothing adopted. */
  deferred?: boolean
}

/** Attempts per converge (the first plus immediate re-converges). */
const MAX_ATTEMPTS = 4

type Attempt = MixtapeConvergeResult & { stale?: boolean }

export async function convergeMixtapeHub(deps: MixtapeHubDeps): Promise<MixtapeConvergeResult> {
  const log = deps.log ?? ((m: string) => console.log(m))
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await convergeOnce(deps)
    if (!r.stale) return r
    log(`[mixtape-hub] a local change landed while the hub was answering (attempt ${attempt}/${MAX_ATTEMPTS}) — dropped that reply, converging again`)
  }
  return { ok: true, changed: false, audioPulled: 0, audioPushed: 0, deferred: true }
}

async function convergeOnce(deps: MixtapeHubDeps): Promise<Attempt> {
  const fetchFn = deps.fetchFn ?? fetch
  const log = deps.log ?? ((m: string) => console.log(m))
  const none = { audioPulled: 0, audioPushed: 0 }
  try {
    // Generations FIRST, then the reads (see hub-local-state.ts).
    const since = snapshotLocalGens()
    const [tapes, tombstones] = await Promise.all([
      deps.getMixtapes(),
      loadTombstones(deps.tombstonesFile),
    ])
    const res = await fetchFn(`${deps.hubUrl}/api/desktop-mixtapes/converge`, withCompanionInit({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mixtapes: tapes, tombstones, device: deps.device }),
      signal: AbortSignal.timeout(15_000),
    }))
    if (!res.ok) return { ok: false, changed: false, ...none, error: `hub ${res.status}` }
    const merged = await res.json() as { ok?: boolean; mixtapes?: HubTapeLike[]; tombstones?: Array<{ id: string; name: string; deletedAt: string }> }
    if (!merged?.ok || !Array.isArray(merged.mixtapes)) return { ok: false, changed: false, ...none, error: 'bad hub reply' }

    const hubTapes = merged.mixtapes
    const changed = sig(hubTapes) !== sig(tapes)

    // Under the shelf's lock — the one every local tape writer takes — check
    // that nothing local moved since the snapshot, then adopt.
    const outcome = await withLocalLock(lockKeys.mixtapeStore(deps.tombstonesFile), async (): Promise<'stale' | 'adopted'> => {
      if (movedGens(since, MIXTAPE_HUB_COLLECTIONS).length > 0) return 'stale'
      if (changed) {
        await deps.setMixtapes(hubTapes)
        bumpLocalGen('mixtapes')
        log(`[mixtape-hub] adopted hub state: ${hubTapes.length} tapes (was ${tapes.length})`)
      }
      if (Array.isArray(merged.tombstones)) {
        const current = await loadTombstones(deps.tombstonesFile)
        await saveTombstones(merged.tombstones, deps.tombstonesFile)
        if (!sameTombstoneSet(current, merged.tombstones)) bumpLocalGen('mixtapeTombstones')
      }
      return 'adopted'
    })
    if (outcome === 'stale') return { ok: true, changed: false, ...none, stale: true }

    // ── Voice-audio heal (never overwrites, either side) ──
    let audioPulled = 0
    let audioPushed = 0
    const wanted = referencedAudioNames(hubTapes, deps.introsDir)
    if (wanted.length) {
      const invRes = await fetchFn(`${deps.hubUrl}/api/desktop-mixtapes/audio`, withCompanionInit({ signal: AbortSignal.timeout(10_000) }))
      const hubNames = new Set(invRes.ok ? ((await invRes.json() as { names?: string[] }).names ?? []) : [])
      await mkdir(deps.introsDir, { recursive: true })
      for (const name of wanted) {
        const local = join(deps.introsDir, name)
        const haveLocal = await access(local).then(() => true, () => false)
        if (!haveLocal && hubNames.has(name)) {
          const dl = await fetchFn(`${deps.hubUrl}/api/desktop-mixtapes/audio/${name}`, withCompanionInit({ signal: AbortSignal.timeout(30_000) }))
          if (dl.ok) {
            const buf = Buffer.from(await dl.arrayBuffer())
            if (buf.length > 0) {
              const tmp = `${local}.${process.pid}.${Date.now()}.tmp`
              await writeFile(tmp, buf)
              await rename(tmp, local)
              audioPulled++
            }
          }
        } else if (haveLocal && !hubNames.has(name)) {
          const buf = await readFile(local)
          const up = await fetchFn(`${deps.hubUrl}/api/desktop-mixtapes/audio/${name}`, withCompanionInit({
            method: 'PUT',
            headers: { 'Content-Type': 'audio/mp4' },
            body: buf,
            signal: AbortSignal.timeout(60_000),
          }))
          if (up.ok) audioPushed++
        }
      }
      if (audioPulled || audioPushed) log(`[mixtape-hub] voice audio: pulled ${audioPulled}, pushed ${audioPushed}`)
    }
    return { ok: true, changed, audioPulled, audioPushed }
  } catch (err) {
    return { ok: false, changed: false, ...none, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Debounced scheduling (bound once by index.ts at boot) ───────────
let bound: MixtapeHubDeps | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let running = false
/** Asked for while one was in flight, or the last one was overtaken by local
 *  changes on every attempt: run once more when it ends (never drop it). */
let rerun = false
let rerunDelayMs = 1_000

export function initMixtapeHubSync(deps: MixtapeHubDeps, opts?: { rerunDelayMs?: number }): void {
  bound = deps
  rerunDelayMs = opts?.rerunDelayMs ?? 1_000
}

export function scheduleMixtapeHubConverge(delayMs = 5_000): void {
  if (!bound) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void runScheduledConverge()
  }, delayMs)
}

async function runScheduledConverge(): Promise<void> {
  const deps = bound
  if (!deps) return
  if (running) { rerun = true; return }
  running = true
  try {
    const r = await convergeMixtapeHub(deps)
    if (r.deferred) rerun = true
  } finally {
    running = false
  }
  if (rerun) {
    rerun = false
    scheduleMixtapeHubConverge(rerunDelayMs)
  }
}
