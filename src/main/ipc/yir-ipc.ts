/**
 * Year in Review IPC (2026-10-12). 'yir:get' hands the renderer the mirrored
 * facts for a year (src/main/yir-mirror.ts); the mirror refreshes shortly
 * after boot and then every 30 minutes (the facts change once a night).
 */
import { app, nativeImage } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { photoDetail, photoPasses, toGray, PHOTO_SAMPLE, type PhotoQuality } from '../../common/yir-photo.ts'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { refreshYirMirror, readYirMirror } from '../yir-mirror.ts'
import { nasAvailable, NAS_STATE_DIR_PATH } from '../state-dir'
import { MOBILE_BACKEND_URL } from './recommendations-ipc.ts'

const refresh = (year: number): Promise<'http' | 'nas' | null> => refreshYirMirror({
  year,
  localDir: app.getPath('userData'),
  nasDir: NAS_STATE_DIR_PATH,
  backendUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, ''),
  nasAvailable,
}).catch(() => null)

/** An artist-image:// slug (artist-photo.ts artistSlug / photoCacheSlug): no path tricks. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/

const quality = new Map<string, { mtimeMs: number; q: PhotoQuality & { ok: boolean } }>()

/** The Review's photo check on a saved artist photo (common/yir-photo.ts): measured here,
 *  where the file is, because a renderer canvas can't read pixels from artist-image://. */
async function photoQuality(slug: string): Promise<(PhotoQuality & { ok: boolean }) | null> {
  if (!SLUG.test(slug)) return null
  const file = join(app.getPath('userData'), 'artist-images', `${slug}.jpg`)
  const st = await stat(file).catch(() => null)
  if (!st) return null
  const hit = quality.get(slug)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.q
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  const scale = PHOTO_SAMPLE / Math.max(width, height)
  const small = scale < 1 ? img.resize({ width: Math.max(3, Math.round(width * scale)), height: Math.max(3, Math.round(height * scale)), quality: 'good' }) : img
  const sz = small.getSize()
  const { detail, focus } = photoDetail(toGray(small.toBitmap(), sz.width, sz.height, 'bgra'), sz.width, sz.height)
  const q = { width, height, detail, focus, ok: false }
  q.ok = photoPasses(q)
  quality.set(slug, { mtimeMs: st.mtimeMs, q })
  return q
}

export function registerYirIpc(ipc: IpcRegistrar): void {
  ipc.handle('yir:photo-quality', async (_e, slug: unknown) => (typeof slug === 'string' ? photoQuality(slug).catch(() => null) : null), { refuse: REFUSED_SENDER })
  const thisYear = (): number => new Date().getFullYear()
  ipc.handle('yir:get', async (_e, year?: number) => {
    const y = Number.isInteger(year) ? Number(year) : thisYear()
    let facts = await readYirMirror(app.getPath('userData'), y)
    // First look on a machine that has never mirrored them: fetch now.
    if (!facts && (await refresh(y))) facts = await readYirMirror(app.getPath('userData'), y)
    return facts
  }, { refuse: REFUSED_SENDER })
  setTimeout(() => { void refresh(thisYear()) }, 8_000)
  setInterval(() => { void refresh(thisYear()) }, 30 * 60_000)
}
