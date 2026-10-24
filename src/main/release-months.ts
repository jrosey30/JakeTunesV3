/**
 * The desktop's copy of homemini's release months (2026-10-24): this year's
 * releases by month, for the sidebar's month playlists (src/common/release-months.ts).
 *
 * Polled with an ETag every 10 minutes (one download per change), the last
 * good copy kept in the local state dir so a homemini outage costs nothing.
 * No freshness gate: a month list a week old is still right. An older
 * document never replaces a newer one.
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/routes/releaseMonths.ts (the route this
 * calls; 503 until homemini's first build) — same idiom as top1000-scores.ts.
 */
import { join } from 'path'
import { readFile, writeFile, rename } from 'fs/promises'
import { withCompanionInit } from './hub-companion.ts'
import { parseReleaseMonths, type ReleaseMonths } from '../common/release-months.ts'

export const RELEASE_MONTHS_FILE = 'release-months.json'

export interface ReleaseMonthsHost {
  localDir: string
  /** homemini backend origin (http://homemini:3000). Absent / null = keep the local copy only. */
  hubBase?: () => string | null
  fetchImpl?: typeof fetch
  log(msg: string): void
}

let current: ReleaseMonths | null = null
let lastEtag = ''
let lastProblem = ''

export function currentReleaseMonths(): ReleaseMonths | null { return current }

async function loadLocal(host: ReleaseMonthsHost): Promise<void> {
  try {
    const s = parseReleaseMonths(await readFile(join(host.localDir, RELEASE_MONTHS_FILE), 'utf8'))
    if (s) current = s
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') host.log(`[release-months] local copy unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function adopt(host: ReleaseMonthsHost, raw: string, parsed: ReleaseMonths): Promise<boolean> {
  if (current && parsed.builtAtMs < current.builtAtMs) return false
  const local = join(host.localDir, RELEASE_MONTHS_FILE)
  await writeFile(`${local}.tmp`, raw)
  await rename(`${local}.tmp`, local)
  current = parsed
  host.log(`[release-months] adopted homemini's release months (${parsed.months.length} months, ${parsed.tracks.length} songs, ${parsed.pending} albums still to date)`)
  return true
}

/** Log a problem once per change of problem, not every 10-minute tick. */
function problem(host: ReleaseMonthsHost, what: string): false {
  if (what !== lastProblem) host.log(`[release-months] homemini copy unavailable: ${what}`)
  lastProblem = what
  return false
}

/** GET /api/release-months from homemini (304 while nothing moved). */
export async function pullReleaseMonthsOnce(host: ReleaseMonthsHost): Promise<boolean> {
  const base = host.hubBase?.()
  if (!base) return false
  const headers: Record<string, string> = { accept: 'application/json' }
  if (lastEtag) headers['If-None-Match'] = lastEtag
  let res: Response
  let raw: string
  try {
    res = await (host.fetchImpl ?? fetch)(`${base}/api/release-months`, withCompanionInit({ headers, signal: AbortSignal.timeout(30_000) }))
    if (res.status === 304) { lastProblem = ''; return false }
    if (!res.ok) return problem(host, `HTTP ${res.status}`)
    raw = await res.text()
  } catch (err) {
    return problem(host, err instanceof Error ? err.message : String(err))
  }
  lastProblem = ''
  lastEtag = res.headers.get('etag') ?? ''
  const parsed = parseReleaseMonths(raw)
  if (!parsed) { host.log('[release-months] homemini copy is malformed — keeping the current one'); return false }
  return adopt(host, raw, parsed)
}

export function startReleaseMonthsPull(host: ReleaseMonthsHost): void {
  const tick = () => pullReleaseMonthsOnce(host).catch((err) => host.log(`[release-months] pull failed: ${err instanceof Error ? err.message : String(err)}`))
  void loadLocal(host).then(tick)
  setInterval(() => { void tick() }, 10 * 60_000)
}
