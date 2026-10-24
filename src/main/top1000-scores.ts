/**
 * The Top 1000 Quiz's standings on the desktop (2026-10-24, Jake: "use the data
 * you have to make the overall jaketunes experience better. playlist
 * suggestions … music man knowledge etc").
 *
 * homemini owns the quiz (JakeTunesMobile backend/src/routes/top1000.ts). Its
 * GET /api/top1000/scores serves every song's standing — pct (1 = the song he
 * loves most), pIn (the chance it is above the seat line), asked (answers it
 * was in) — plus what Music Man should know. This module polls it with an ETag
 * (one download per change), keeps the last good copy in the local state dir
 * so a homemini outage costs nothing, and serves it to the suggestion strip's
 * taste term (src/renderer/utils/playlistSuggest.ts) and the listener profile
 * (listener-profile.ts buildTasteProfile).
 *
 * Usable while < 7 days old. Unlike taste-state there is no promotion gate: the
 * quiz is Jake's own verdicts on 5,000+ questions (hints AUC 0.95 on held-out
 * answers), never worse than stars + plays.
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/routes/top1000.ts GET /scores (shape +
 * ETag revalidation).
 */
import { join } from 'path'
import { readFile, writeFile, rename } from 'fs/promises'
import { withCompanionInit } from './hub-companion.ts'

export const TOP1000_SCORES_FILE = 'top1000-scores.json'
export const TOP1000_SCORES_FRESH_MS = 7 * 24 * 3600 * 1000

export interface Top1000Knowledge {
  /** artist → seats in his 1000, most first */
  artists: Array<[string, number]>
  /** the songs he confirmed most emphatically himself (in the 1000 on 2+ answers, not pinned) */
  confirmed: Array<{ title: string; artist: string }>
  /** the songs he put OUT although every other clue said he loved them */
  outs: Array<{ title: string; artist: string }>
}

export interface Top1000Scores {
  builtAtMs: number
  answered: number
  /** how sure the ranking is of its 1000 (mean chance of the seated songs), 0..1 */
  sure: number
  /** song id → [pct 0..1 (1 = most loved), pIn 0..1, answers it was in] */
  tracks: Map<string, [number, number, number]>
  knowledge: Top1000Knowledge
}

const named = (x: unknown): x is { title: string; artist: string } =>
  !!x && typeof x === 'object' && typeof (x as { title?: unknown }).title === 'string' && typeof (x as { artist?: unknown }).artist === 'string'

/** Pure: parse + validate. Null on anything malformed. */
export function parseTop1000Scores(raw: string): Top1000Scores | null {
  let o: unknown
  try { o = JSON.parse(raw) } catch { return null }
  const s = o as { v?: unknown; builtAt?: unknown; answered?: unknown; sure?: unknown; scores?: unknown; knowledge?: unknown }
  if (!s || s.v !== 1 || typeof s.builtAt !== 'string' || !s.scores || typeof s.scores !== 'object') return null
  const builtAtMs = Date.parse(s.builtAt)
  if (!Number.isFinite(builtAtMs)) return null
  const tracks = new Map<string, [number, number, number]>()
  for (const [id, row] of Object.entries(s.scores as Record<string, unknown>)) {
    if (!Array.isArray(row)) continue
    const [pct, pIn, asked] = [Number(row[0]), Number(row[1]), Number(row[2] ?? 0)]
    if (Number.isFinite(pct) && pct >= 0 && pct <= 1 && Number.isFinite(pIn) && pIn >= 0 && pIn <= 1) tracks.set(id, [pct, pIn, Number.isFinite(asked) ? asked : 0])
  }
  const k = (s.knowledge ?? {}) as { artists?: unknown; confirmed?: unknown; outs?: unknown }
  const knowledge: Top1000Knowledge = {
    artists: (Array.isArray(k.artists) ? k.artists : [])
      .filter((a): a is [string, number] => Array.isArray(a) && typeof a[0] === 'string' && Number.isFinite(Number(a[1])))
      .map(([a, n]) => [a, Number(n)]),
    confirmed: (Array.isArray(k.confirmed) ? k.confirmed : []).filter(named),
    outs: (Array.isArray(k.outs) ? k.outs : []).filter(named),
  }
  const sure = Number(s.sure)
  return { builtAtMs, answered: Math.max(0, Number(s.answered) || 0), sure: Number.isFinite(sure) ? Math.min(1, Math.max(0, sure)) : 0, tracks, knowledge }
}

/** Pure: is it usable right now? */
export function isTop1000Usable(s: Top1000Scores | null, nowMs: number): boolean {
  return !!s && s.tracks.size > 0 && nowMs - s.builtAtMs <= TOP1000_SCORES_FRESH_MS
}

/** The block Music Man's listener profile carries (listener-profile.ts). Pure; '' when unusable. */
export function top1000KnowledgeBlock(s: Top1000Scores | null, nowMs: number): string {
  if (!isTop1000Usable(s, nowMs) || !s) return ''
  const k = s.knowledge
  const song = (t: { title: string; artist: string }) => `"${t.title}" by ${t.artist}`
  const lines = [
    `Top 1000 Quiz — his own verdicts on ${s.answered.toLocaleString('en-US')} questions about his favourite songs; the ranking is ${Math.round(s.sure * 100)}% sure of its 1000. A song in his Top 1000 is a favourite even with few plays.`,
  ]
  if (k.artists.length) lines.push(`Most seats in his Top 1000: ${k.artists.map(([a, n]) => `${a} (${n})`).join(', ')}`)
  if (k.confirmed.length) lines.push(`Songs he confirmed most emphatically: ${k.confirmed.map(song).join(', ')}`)
  if (k.outs.length) lines.push(`Songs he put OUT of his 1000 although the numbers expected them in (he knows them — not discoveries, not favourites): ${k.outs.map(song).join(', ')}`)
  return lines.join('\n')
}

export interface Top1000ScoresHost {
  localDir: string
  /** homemini backend origin (http://homemini:3000). Absent / null = keep the local copy only. */
  hubBase?: () => string | null
  fetchImpl?: typeof fetch
  log(msg: string): void
}

let current: Top1000Scores | null = null
let lastEtag = ''
let lastProblem = ''

export function currentTop1000Scores(): Top1000Scores | null { return current }

async function loadLocal(host: Top1000ScoresHost): Promise<void> {
  try {
    const s = parseTop1000Scores(await readFile(join(host.localDir, TOP1000_SCORES_FILE), 'utf8'))
    if (s) current = s
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') host.log(`[top1000-scores] local copy unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Write a validated copy into the local state dir and use it — unless it is older than the one in use. */
async function adopt(host: Top1000ScoresHost, raw: string, parsed: Top1000Scores): Promise<boolean> {
  if (current && parsed.builtAtMs < current.builtAtMs) return false
  const local = join(host.localDir, TOP1000_SCORES_FILE)
  await writeFile(`${local}.tmp`, raw)
  await rename(`${local}.tmp`, local)
  current = parsed
  host.log(`[top1000-scores] adopted homemini's Top 1000 standings (${parsed.tracks.size} songs, ${parsed.answered} answers, ${Math.round(parsed.sure * 100)}% sure)`)
  return true
}

/** Log a problem once per change of problem, not every 10-minute tick. */
function problem(host: Top1000ScoresHost, what: string): false {
  if (what !== lastProblem) host.log(`[top1000-scores] homemini copy unavailable: ${what}`)
  lastProblem = what
  return false
}

/** GET /api/top1000/scores from homemini (304 while nothing moved). */
export async function pullTop1000ScoresOnce(host: Top1000ScoresHost): Promise<boolean> {
  const base = host.hubBase?.()
  if (!base) return false
  const headers: Record<string, string> = { accept: 'application/json' }
  if (lastEtag) headers['If-None-Match'] = lastEtag
  let res: Response
  let raw: string
  try {
    res = await (host.fetchImpl ?? fetch)(`${base}/api/top1000/scores`, withCompanionInit({ headers, signal: AbortSignal.timeout(30_000) }))
    if (res.status === 304) { lastProblem = ''; return false }
    if (!res.ok) return problem(host, `HTTP ${res.status}`)
    raw = await res.text()
  } catch (err) {
    return problem(host, err instanceof Error ? err.message : String(err))   // homemini unreachable — next tick
  }
  lastProblem = ''
  lastEtag = res.headers.get('etag') ?? ''
  const parsed = parseTop1000Scores(raw)
  if (!parsed) { host.log('[top1000-scores] homemini copy is malformed — keeping the current one'); return false }
  return adopt(host, raw, parsed)
}

export function startTop1000ScoresPull(host: Top1000ScoresHost): void {
  const tick = () => pullTop1000ScoresOnce(host).catch((err) => host.log(`[top1000-scores] pull failed: ${err instanceof Error ? err.message : String(err)}`))
  void loadLocal(host).then(tick)
  setInterval(() => { void tick() }, 10 * 60_000)
}
