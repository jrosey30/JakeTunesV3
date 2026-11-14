/**
 * A month's or a year's cover from homemini (2026-11-13, common/period-covers.ts),
 * kept on this Mac in <stateDir>/period-covers/<id>.jpg so the sidebar has it
 * with homemini away. Unlike an iPod's cover this picture changes (the current
 * month follows its records), so homemini is asked again, at most every half
 * hour per cover; an answer with the same bytes writes nothing.
 *
 * Deps injected so node --test runs it without homemini.
 */
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { join } from 'path'
import { isPeriodCoverRemoteId, periodCoverPath } from '../common/period-covers.ts'

export const PERIOD_COVER_DIR = 'period-covers'
/** homemini's size tier: big enough for the playlist header, small for a data: URL. */
export const PERIOD_COVER_TIER = 640
export const PERIOD_COVER_RECHECK_MS = 30 * 60_000

export interface PeriodCoverCacheDeps {
  stateDir: string
  fetchCover: (path: string) => Promise<{ bytes: Buffer } | null>
  now?: () => number
}

const inFlight = new Map<string, Promise<string | null>>()
const askedAt = new Map<string, number>()

/** A data: URL of homemini's cover for `remoteId`; the kept copy when homemini is away; null when there is neither. */
export function periodCoverDataUrl(deps: PeriodCoverCacheDeps, remoteId: unknown): Promise<string | null> {
  if (!isPeriodCoverRemoteId(remoteId)) return Promise.resolve(null)
  const now = deps.now ?? Date.now
  const file = join(deps.stateDir, PERIOD_COVER_DIR, `${remoteId}.jpg`)
  const toUrl = (b: Buffer) => `data:image/jpeg;base64,${b.toString('base64')}`
  const running = inFlight.get(file)
  if (running) return running
  const job = (async () => {
    const kept = await readFile(file).catch(() => null)
    const asked = askedAt.get(file)
    if (kept && asked !== undefined && now() - asked < PERIOD_COVER_RECHECK_MS) return toUrl(kept)
    const got = await deps.fetchCover(`${periodCoverPath(remoteId)}?s=${PERIOD_COVER_TIER}`).catch(() => null)
    if (!got) return kept ? toUrl(kept) : null                 // away: what we have; asked again next time
    askedAt.set(file, now())
    if (kept && kept.equals(got.bytes)) return toUrl(kept)
    await mkdir(join(deps.stateDir, PERIOD_COVER_DIR), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, got.bytes)
    await rename(tmp, file)
    return toUrl(got.bytes)
  })().finally(() => { inFlight.delete(file) })
  inFlight.set(file, job)
  return job
}

/** The cover changed by Jake's own decision: ask homemini the next time, not in half an hour. */
export function forgetPeriodCover(remoteId: string): void {
  for (const k of [...askedAt.keys()]) if (k.endsWith(`/${remoteId}.jpg`)) askedAt.delete(k)
}

/** Tests only. */
export function _resetPeriodCoverCache(): void { inFlight.clear(); askedAt.clear() }
