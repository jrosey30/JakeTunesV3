/**
 * Where the faces are on a concert card's photo (the framing itself is common/concert-photo-framing.ts).
 *
 * FaceDetector is Chromium's Shape Detection API, on macOS backed by Apple's Vision. It sits behind
 * a Blink flag: the main window turns on that one feature (`enableBlinkFeatures: 'FaceDetector'`,
 * src/main/index.ts), never experimental web platform features. Each picture is read once, as a
 * Blob decoded off the main thread, BEFORE its card shows it: the photo first appears already
 * framed and never jumps. Without the API, or if it fails, the framing's "nothing found" rule
 * applies: a higher crop than the middle.
 */
import { concertPhotoFrame, type ConcertPhotoFrame, type FaceBox } from '../common/concert-photo-framing'

interface DetectedFace {
  boundingBox: DOMRectReadOnly
}
interface FaceDetectorLike {
  detect(image: ImageBitmap): Promise<DetectedFace[]>
}
type FaceDetectorClass = new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => FaceDetectorLike

/** The longest a card's photo stays hidden waiting for its faces (they take ~10 ms, the first ~300). */
const READ_TIMEOUT_MS = 6000

const frames = new Map<string, ConcertPhotoFrame>()
const running = new Map<string, Promise<ConcertPhotoFrame>>()
let detector: FaceDetectorLike | null = null
let warned = false

function warnOnce(...what: unknown[]): void {
  if (!warned) console.warn('[concert photo] no faces, using the higher crop:', ...what)
  warned = true
}

function faceDetector(): FaceDetectorLike | null {
  if (detector) return detector
  const api = (window as unknown as { FaceDetector?: FaceDetectorClass }).FaceDetector
  if (!api) {
    // An Electron upgrade that renames the Blink feature would land here.
    warnOnce('FaceDetector is missing')
    return null
  }
  // fastMode false is the Vision path (true would be the older CIDetector).
  detector = new api({ fastMode: false })
  return detector
}

async function read(slug: string): Promise<ConcertPhotoFrame> {
  const url = `artist-image://${slug}.jpg`
  const reply = await fetch(url)
  if (!reply.ok) throw new Error(`${url}: ${reply.status}`)
  const bitmap = await createImageBitmap(await reply.blob())
  try {
    const size = { width: bitmap.width, height: bitmap.height }
    const found = faceDetector()
    if (!found) return concertPhotoFrame(size, null)
    const faces: FaceBox[] = (await found.detect(bitmap)).map(({ boundingBox: b }) => ({
      x: b.x / size.width, y: b.y / size.height, width: b.width / size.width, height: b.height / size.height,
    }))
    return concertPhotoFrame(size, faces)
  } finally {
    bitmap.close()
  }
}

/** A photo's frame when it has been read already (so a remounted card shows it at once). */
export function concertPhotoFrameCached(slug: string): ConcertPhotoFrame | null {
  return frames.get(slug) ?? null
}

/** A photo's frame: its faces read once, the "nothing found" rule when they cannot be. */
export function concertPhotoFrameOf(slug: string): Promise<ConcertPhotoFrame> {
  const hit = frames.get(slug)
  if (hit) return Promise.resolve(hit)
  let job = running.get(slug)
  if (!job) {
    const timeout = new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error(`no answer in ${READ_TIMEOUT_MS} ms`)), READ_TIMEOUT_MS)
    })
    job = Promise.race([read(slug), timeout])
      .catch((err: unknown) => {
        warnOnce(err)
        return concertPhotoFrame({ width: 1, height: 1 }, null)
      })
      .then((frame) => {
        frames.set(slug, frame)
        running.delete(slug)
        return frame
      })
    running.set(slug, job)
  }
  return job
}
