/**
 * Year in Review → Instagram Story files, desktop (2026-10-29, Jake: "this needs to work on ig
 * story too"). The phone posts; the desktop saves the same files: for each card a 1080×1920 PNG
 * (the finished card) and a silent H.264 MP4 of its animation, 30 fps — "Share my whole year"
 * does every card in order, one clip per card (an Instagram Story clip is at most 20 s).
 *
 * How: a hidden, offscreen window renders the story frame page (renderer YirStoryExport.tsx,
 * 540×960 CSS px at zoom 2 = 1080×1920), and this steps it with window.__yirSeek(card, ms),
 * capturing each frame. ffmpeg (on PATH, as the mixtape tools use it) encodes the frames; with no
 * ffmpeg the PNGs are still written and the result says so.
 *
 * Electron-light: the window factory and the encoder are injected, so the frame loop runs in the
 * offscreen harness too.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/YirStoryExport.swift (same frame, bands, lengths).
 */
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const YIR_STORY_FPS = 30
/** Seconds per card when one card is shared, and per card in the whole-year sequence. */
export const YIR_CARD_SECONDS = 6
export const YIR_RUN_SECONDS = 4
/** When the cards' entrances are over (the still is taken here). */
export const YIR_STILL_MS = 3400

export interface ExportPage {
  /** Run JavaScript in the frame page. */
  run<T>(js: string): Promise<T>
  /** The page as a 1080×1920 PNG. */
  capture(): Promise<Buffer>
  close(): void
}

export interface YirExportDeps {
  open(): Promise<ExportPage>
  /** Frames dir (frame-%04d.png) → MP4; false when no encoder is available. */
  encode(framesDir: string, out: string, fps: number): Promise<boolean>
  outDir: string
  progress?: (done: number, total: number) => void
}

export interface YirExportResult { dir: string; stills: string[]; videos: string[]; note?: string }

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Export the given cards (indexes into the story), or all of them. */
export async function exportYirStory(deps: YirExportDeps, which: number[] | 'all'): Promise<YirExportResult> {
  const page = await deps.open()
  try {
    for (let i = 0; i < 200 && !(await page.run<boolean>('!!window.__yirReady')); i++) await wait(150)
    const count = await page.run<number>('window.__yirCount || 0')
    if (!count) throw new Error('no Year in Review to export yet')
    const cards = which === 'all' ? Array.from({ length: count }, (_, k) => k) : which.filter((k) => k >= 0 && k < count)
    const seconds = which === 'all' ? YIR_RUN_SECONDS : YIR_CARD_SECONDS
    const frames = Math.round(seconds * YIR_STORY_FPS)
    await mkdir(deps.outDir, { recursive: true })
    const out: YirExportResult = { dir: deps.outDir, stills: [], videos: [] }
    const total = cards.length * (frames + 1)
    let done = 0
    for (const k of cards) {
      const name = `yir-${String(k + 1).padStart(2, '0')}`
      // Covers and photos load first: seek until the card is on the page, every image has
      // arrived and the count of pictures has held still for half a second (lookups that end in
      // "no photo" settle as placeholders), at most 8 s.
      let last = '', same = 0
      for (let i = 0; i < 80 && same < 4; i++) {
        const ok = await page.run<boolean>(`window.__yirSeek(${k}, ${YIR_STILL_MS})`)
        const now = await page.run<string>('window.__yirSettled || ""')
        same = ok && now === last ? same + 1 : 0
        last = now
        await wait(120)
      }
      const still = join(deps.outDir, `${name}.png`)
      await writeFile(still, await page.capture())
      out.stills.push(still)
      deps.progress?.(++done, total)
      const tmp = join(tmpdir(), `jaketunes-yir-${process.pid}-${k}`)
      await rm(tmp, { recursive: true, force: true })
      await mkdir(tmp, { recursive: true })
      for (let f = 0; f < frames; f++) {
        await page.run(`window.__yirSeek(${k}, ${Math.round((f * 1000) / YIR_STORY_FPS)})`)
        await wait(16)
        await writeFile(join(tmp, `frame-${String(f).padStart(4, '0')}.png`), await page.capture())
        deps.progress?.(++done, total)
      }
      const video = join(deps.outDir, `${name}.mp4`)
      if (await deps.encode(tmp, video, YIR_STORY_FPS)) out.videos.push(video)
      else out.note = 'ffmpeg is not installed, so only the still images were saved.'
      await rm(tmp, { recursive: true, force: true })
    }
    return out
  } finally {
    page.close()
  }
}

/** ffmpeg args: PNG frames → silent H.264, yuv420p (what Instagram and Photos take). */
export function ffmpegStoryArgs(framesDir: string, out: string, fps: number): string[] {
  return ['-nostdin', '-y', '-framerate', String(fps), '-i', join(framesDir, 'frame-%04d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-crf', '18', '-r', String(fps), '-movflags', '+faststart', '-an', out]
}
