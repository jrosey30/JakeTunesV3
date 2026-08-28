/**
 * Mixtape hub client (2026-08-28) — tapes converge with homemini exactly
 * like playlists do (playlist-hub-sync.ts), plus a VOICE-AUDIO heal:
 * every intro/talkover a tape references is uploaded to the hub's store
 * when the hub lacks it and downloaded when this machine lacks it. Files
 * are immutable both sides — never overwritten, only added — and every
 * name is derived from paths under OUR mixtape-intros dir (a tape's JSON
 * can never aim the copier anywhere else).
 *
 * Electron-free: deps injected, node --test loads it.
 */
import { basename, join } from 'path'
import { readFile, writeFile, rename, mkdir, access } from 'fs/promises'
import { loadTombstones, saveTombstones } from './playlist-tombstones.ts'

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
}

export async function convergeMixtapeHub(deps: MixtapeHubDeps): Promise<MixtapeConvergeResult> {
  const fetchFn = deps.fetchFn ?? fetch
  const log = deps.log ?? ((m: string) => console.log(m))
  const none = { audioPulled: 0, audioPushed: 0 }
  try {
    const [tapes, tombstones] = await Promise.all([
      deps.getMixtapes(),
      loadTombstones(deps.tombstonesFile),
    ])
    const res = await fetchFn(`${deps.hubUrl}/api/desktop-mixtapes/converge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mixtapes: tapes, tombstones, device: deps.device }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { ok: false, changed: false, ...none, error: `hub ${res.status}` }
    const merged = await res.json() as { ok?: boolean; mixtapes?: HubTapeLike[]; tombstones?: Array<{ id: string; name: string; deletedAt: string }> }
    if (!merged?.ok || !Array.isArray(merged.mixtapes)) return { ok: false, changed: false, ...none, error: 'bad hub reply' }

    const changed = sig(merged.mixtapes) !== sig(tapes)
    if (changed) {
      await deps.setMixtapes(merged.mixtapes)
      log(`[mixtape-hub] adopted hub state: ${merged.mixtapes.length} tapes (was ${tapes.length})`)
    }
    if (Array.isArray(merged.tombstones)) await saveTombstones(merged.tombstones, deps.tombstonesFile)

    // ── Voice-audio heal (never overwrites, either side) ──
    let audioPulled = 0
    let audioPushed = 0
    const wanted = referencedAudioNames(merged.mixtapes, deps.introsDir)
    if (wanted.length) {
      const invRes = await fetchFn(`${deps.hubUrl}/api/desktop-mixtapes/audio`, { signal: AbortSignal.timeout(10_000) })
      const hubNames = new Set(invRes.ok ? ((await invRes.json() as { names?: string[] }).names ?? []) : [])
      await mkdir(deps.introsDir, { recursive: true })
      for (const name of wanted) {
        const local = join(deps.introsDir, name)
        const haveLocal = await access(local).then(() => true, () => false)
        if (!haveLocal && hubNames.has(name)) {
          const dl = await fetchFn(`${deps.hubUrl}/api/desktop-mixtapes/audio/${name}`, { signal: AbortSignal.timeout(30_000) })
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
          const up = await fetchFn(`${deps.hubUrl}/api/desktop-mixtapes/audio/${name}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'audio/mp4' },
            body: buf,
            signal: AbortSignal.timeout(60_000),
          })
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

export function initMixtapeHubSync(deps: MixtapeHubDeps): void {
  bound = deps
}

export function scheduleMixtapeHubConverge(delayMs = 5_000): void {
  if (!bound) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    if (running || !bound) return
    running = true
    void convergeMixtapeHub(bound).finally(() => { running = false })
  }, delayMs)
}
