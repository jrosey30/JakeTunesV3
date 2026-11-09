/**
 * A custom-colour iPod cover (2026-11-09, common/ipod-covers.ts). The named
 * colours ship with the app; a custom one ("iPod color…" → Custom) is drawn by
 * homemini and kept here, in <stateDir>/ipod-covers/<key>.jpg, for good: the
 * art for a (model, colour) never changes, so one fetch per colour, ever.
 * Only homemini's EXACT picture is kept; while it is still drawing it answers
 * with the nearest named colour, which the renderer already has bundled.
 *
 * Deps injected so node --test runs it without homemini.
 */
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { join } from 'path'
import { ipodCoverPath, parseIpodCoverKey, isNamedIpodColor } from '../common/ipod-covers.ts'

export const IPOD_COVER_DIR = 'ipod-covers'
/** homemini's size tier: big enough for the playlist header, small for a data: URL. */
export const IPOD_COVER_TIER = 640

export interface IpodCoverCacheDeps {
  stateDir: string
  fetchCover: (path: string) => Promise<{ bytes: Buffer; exact: boolean } | null>
}

const inFlight = new Map<string, Promise<string | null>>()

/** A data: URL of the exact picture for `key`, or null (not a custom key, or homemini hasn't drawn it / is away). */
export function ipodCoverDataUrl(deps: IpodCoverCacheDeps, key: unknown): Promise<string | null> {
  const look = parseIpodCoverKey(key)
  if (!look || isNamedIpodColor(look.color)) return Promise.resolve(null)
  const file = join(deps.stateDir, IPOD_COVER_DIR, `${key as string}.jpg`)
  const toUrl = (b: Buffer) => `data:image/jpeg;base64,${b.toString('base64')}`
  const running = inFlight.get(file)
  if (running) return running
  const job = (async () => {
    try {
      return toUrl(await readFile(file))
    } catch { /* not kept yet: ask homemini */ }
    const got = await deps.fetchCover(`${ipodCoverPath(look)}?s=${IPOD_COVER_TIER}`).catch(() => null)
    if (!got) return null
    if (!got.exact) return null
    await mkdir(join(deps.stateDir, IPOD_COVER_DIR), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, got.bytes)
    await rename(tmp, file)
    return toUrl(got.bytes)
  })().finally(() => { inFlight.delete(file) })
  inFlight.set(file, job)
  return job
}
