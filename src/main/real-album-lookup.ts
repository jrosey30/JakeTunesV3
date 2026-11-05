/**
 * Asking MusicBrainz for a song's real album (common/real-album.ts is the rule), for the download
 * that needs it, on the app's shared throttle. Any trouble is null, inside a bound: an API hiccup
 * must never brick a download. The ladder then goes on what the row says, as it always has.
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/realAlbumLookup.ts.
 */
import { allRecordings, pickRealAlbum, realAlbumQuery, type MbRecordingPage, type RealAlbum } from '../common/real-album.ts'

const TIMEOUT_MS = 8_000
/** Every page, a retry, and a turn in the throttle for each. */
const DEADLINE_MS = 30_000

async function askPage(url: string, deps: { throttle: () => Promise<void>; userAgent: string }): Promise<MbRecordingPage> {
  let trouble = 'busy'
  for (let attempt = 0; attempt < 2; attempt++) {
    await deps.throttle()
    try {
      const res = await fetch(url, { headers: { 'User-Agent': deps.userAgent }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.ok) return await res.json() as MbRecordingPage
      if (res.status !== 503 && res.status !== 429) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } }
      trouble = e.cause?.code ?? e.message
    }
  }
  throw new Error(trouble)
}

export async function lookUpRealAlbum(
  title: string,
  artist: string,
  durationsSec: number[],
  owned: (album: string) => boolean,
  deps: { throttle: () => Promise<void>; userAgent: string; onTrouble?: (why: string) => void },
): Promise<RealAlbum | null> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('too slow')), DEADLINE_MS) })
  try {
    const query = encodeURIComponent(realAlbumQuery(title, artist))
    const ask = allRecordings((offset, limit) => askPage(`https://musicbrainz.org/ws/2/recording/?fmt=json&limit=${limit}&offset=${offset}&query=${query}`, deps))
    const recordings = await Promise.race([ask, late])
    return pickRealAlbum(recordings, { title, artist, durationsSec, owned })
  } catch (err) {
    deps.onTrouble?.((err as Error).message)
    return null
  } finally {
    clearTimeout(timer)
  }
}
