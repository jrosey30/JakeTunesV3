/**
 * The learned taste score on the desktop (2026-10-19, the taste-engine
 * program). homemini's nightly taste engine (scripts/taste-engine.py) writes
 * taste-state.json to the NAS; this module adopts each new copy into the
 * local state dir (one stat per tick — the 11k-song file is only read when the
 * NAS copy changed) and serves it to the renderer.
 *
 * A Mac with no NAS mount (workmini, a replica — it never mounts the NAS)
 * asks homemini's backend instead: GET /api/taste-state serves the same file,
 * with an ETag, so the 10-minute poll downloads it once per nightly build.
 * Same rules either way: a malformed copy or an older build never replaces
 * the one in use.
 *
 * The renderer uses it only while the engine's ranking is PROMOTED (it beat
 * the v5 formula on held-back weeks of real listening) and FRESH (< 72 h);
 * otherwise it falls back — that is the automatic rollback.
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/tasteState.ts (same parse + rules)
 * and backend/src/routes/tasteState.ts (GET /api/taste-state, pullFromHub).
 */
import { join } from 'path'
import { readFile, stat, writeFile, rename } from 'fs/promises'
import { withCompanionInit } from './hub-companion.ts'

export const TASTE_STATE_FILE = 'taste-state.json'
export const TASTE_STATE_FRESH_MS = 72 * 3600 * 1000

export interface TasteState {
  builtAtMs: number
  promoted: boolean
  why: string
  /** song id -> [score on the v5 scale, percentile 0..1, discovery flags] */
  tracks: Map<string, [number, number, number]>
}

/** Pure: parse + validate. Null on anything malformed. */
export function parseTasteState(raw: string): TasteState | null {
  let o: unknown
  try { o = JSON.parse(raw) } catch { return null }
  const s = o as { v?: unknown; builtAt?: unknown; promoted?: unknown; why?: unknown; tracks?: unknown }
  if (!s || s.v !== 1 || typeof s.builtAt !== 'string' || !s.tracks || typeof s.tracks !== 'object') return null
  const builtAtMs = Date.parse(s.builtAt)
  if (!Number.isFinite(builtAtMs)) return null
  const tracks = new Map<string, [number, number, number]>()
  for (const [id, row] of Object.entries(s.tracks as Record<string, unknown>)) {
    if (!Array.isArray(row)) continue
    const [a, b, c] = [Number(row[0]), Number(row[1]), Number(row[2] ?? 0)]
    if (Number.isFinite(a) && a >= 0 && a <= 1 && Number.isFinite(b) && b >= 0 && b <= 1) tracks.set(id, [a, b, Number.isFinite(c) ? c : 0])
  }
  return { builtAtMs, promoted: s.promoted === true, why: String(s.why ?? ''), tracks }
}

/** Pure: is it usable right now? */
export function isUsable(state: TasteState | null, nowMs: number): boolean {
  return !!state && state.promoted && state.tracks.size > 0 && nowMs - state.builtAtMs <= TASTE_STATE_FRESH_MS
}

export interface TasteStateHost {
  localDir: string
  nasDir: string
  nasAvailable(): Promise<boolean>
  /** homemini backend origin (http://homemini:3000): the source while the NAS
   *  is not mounted. Absent / null = NAS only. */
  hubBase?: () => string | null
  fetchImpl?: typeof fetch
  log(msg: string): void
}

let current: TasteState | null = null
let lastNasMtime = 0
let lastHubEtag = ''
let lastHubProblem = ''

export function currentTasteState(): TasteState | null { return current }

async function loadLocal(host: TasteStateHost): Promise<void> {
  try {
    const s = parseTasteState(await readFile(join(host.localDir, TASTE_STATE_FILE), 'utf8'))
    if (s) current = s
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') host.log(`[taste-state] local copy unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Write a validated copy into the local state dir and use it — unless it is
 *  an older build than the one in use. */
async function adopt(host: TasteStateHost, raw: string, parsed: TasteState, via: string): Promise<boolean> {
  if (current && parsed.builtAtMs < current.builtAtMs) return false
  const local = join(host.localDir, TASTE_STATE_FILE)
  await writeFile(`${local}.tmp`, raw)
  await rename(`${local}.tmp`, local)
  current = parsed
  host.log(`[taste-state] adopted homemini's taste state ${via} (${parsed.tracks.size} songs, ${parsed.promoted ? 'learned ranking ON' : 'v5 fallback'}): ${parsed.why}`)
  return true
}

export async function pullTasteStateOnce(host: TasteStateHost): Promise<boolean> {
  if (!(await host.nasAvailable())) return pullFromHub(host)
  const nasPath = join(host.nasDir, TASTE_STATE_FILE)
  let st
  try { st = await stat(nasPath) } catch { return false }   // engine has not published yet
  if (st.mtimeMs === lastNasMtime) return false
  const raw = await readFile(nasPath, 'utf8')
  const parsed = parseTasteState(raw)
  lastNasMtime = st.mtimeMs
  if (!parsed) { host.log('[taste-state] NAS copy is malformed — keeping the current one'); return false }
  return adopt(host, raw, parsed, 'from the NAS')
}

/** Log a hub problem once per change of problem, not every 10-minute tick. */
function hubProblem(host: TasteStateHost, problem: string): false {
  if (problem !== lastHubProblem) host.log(`[taste-state] homemini copy unavailable: ${problem}`)
  lastHubProblem = problem
  return false
}

/** No NAS mount: GET /api/taste-state from homemini's backend (304 while the
 *  build is unchanged). ⚠️ TWIN: JakeTunesMobile backend/src/routes/tasteState.ts. */
async function pullFromHub(host: TasteStateHost): Promise<boolean> {
  const base = host.hubBase?.()
  if (!base) return false
  const headers: Record<string, string> = { accept: 'application/json' }
  if (lastHubEtag) headers['If-None-Match'] = lastHubEtag
  let res: Response
  let raw: string
  try {
    res = await (host.fetchImpl ?? fetch)(`${base}/api/taste-state`, withCompanionInit({ headers, signal: AbortSignal.timeout(30_000) }))
    if (res.status === 304) { lastHubProblem = ''; return false }
    if (!res.ok) return hubProblem(host, `HTTP ${res.status}`)   // 404 = backend has not read a copy yet
    raw = await res.text()
  } catch (err) {
    return hubProblem(host, err instanceof Error ? err.message : String(err))   // homemini unreachable — next tick
  }
  lastHubProblem = ''
  lastHubEtag = res.headers.get('etag') ?? ''
  const parsed = parseTasteState(raw)
  if (!parsed) { host.log('[taste-state] homemini copy is malformed — keeping the current one'); return false }
  return adopt(host, raw, parsed, 'from homemini (no NAS mount)')
}

export function startTasteStatePull(host: TasteStateHost): void {
  void loadLocal(host).then(() => pullTasteStateOnce(host)).catch((err) => host.log(`[taste-state] pull failed: ${err instanceof Error ? err.message : String(err)}`))
  setInterval(() => {
    void pullTasteStateOnce(host).catch((err) => host.log(`[taste-state] pull failed: ${err instanceof Error ? err.message : String(err)}`))
  }, 10 * 60_000)
}
