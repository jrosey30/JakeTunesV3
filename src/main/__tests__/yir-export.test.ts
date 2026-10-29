/**
 * Year in Review → Instagram Story files (src/main/yir-export.ts): the frame loop against a
 * fake page — a still per card at the end of its entrance, a 30 fps clip per card, the whole year
 * as one clip per card, and stills alone when there is no encoder.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportYirStory, ffmpegStoryArgs, YIR_CARD_SECONDS, YIR_RUN_SECONDS, YIR_STILL_MS, YIR_STORY_FPS, type ExportPage } from '../yir-export.ts'

function fakePage(count: number): { page: ExportPage; seeks: Array<[number, number]>; closed: () => boolean } {
  const seeks: Array<[number, number]> = []
  let closed = false
  return {
    seeks,
    closed: () => closed,
    page: {
      async run<T>(js: string): Promise<T> {
        if (js.includes('__yirReady')) return true as T
        if (js.includes('__yirCount')) return count as T
        if (js.includes('__yirSettled')) return 'stable' as T
        const m = /__yirSeek\((\d+), (\d+)\)/.exec(js)
        if (m) { seeks.push([Number(m[1]), Number(m[2])]); return true as T }
        return undefined as T
      },
      async capture() { return Buffer.from('png') },
      close() { closed = true },
    },
  }
}

describe('the Story export', () => {
  it('one card: a still at the end of its entrance and a 6 s, 30 fps clip', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'yir-export-'))
    const f = fakePage(5)
    const encoded: string[] = []
    const r = await exportYirStory({ open: async () => f.page, outDir, encode: async (_d, out) => { encoded.push(out); return true } }, [2])
    assert.deepEqual(r.stills.map((p) => p.split('/').pop()), ['yir-03.png'])
    assert.deepEqual(r.videos.map((p) => p.split('/').pop()), ['yir-03.mp4'])
    assert.ok(f.seeks.some(([k, ms]) => k === 2 && ms === YIR_STILL_MS), 'the still is the finished card')
    const frames = f.seeks.slice(f.seeks.findIndex(([, ms]) => ms === 0))
    assert.equal(frames.length, YIR_CARD_SECONDS * YIR_STORY_FPS)
    assert.deepEqual(frames.slice(0, 3).map(([, ms]) => ms), [0, 33, 67], 'frames step 1/30 s')
    assert.ok(f.closed(), 'the hidden window is always closed')
    assert.deepEqual((await readdir(outDir)).sort(), ['yir-03.png'])
  })

  it('the whole year: every card in order, one 4 s clip each (a Story clip is at most 20 s)', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'yir-export-'))
    const f = fakePage(3)
    const r = await exportYirStory({ open: async () => f.page, outDir, encode: async () => true }, 'all')
    assert.equal(r.stills.length, 3)
    assert.equal(r.videos.length, 3)
    const card0 = f.seeks.filter(([k]) => k === 0)
    assert.equal(card0.slice(card0.findIndex(([, ms]) => ms === 0)).length, YIR_RUN_SECONDS * YIR_STORY_FPS)
    assert.deepEqual([...new Set(f.seeks.map(([k]) => k))], [0, 1, 2], 'in order')
    assert.ok(YIR_RUN_SECONDS * YIR_STORY_FPS / YIR_STORY_FPS <= 20 && YIR_CARD_SECONDS <= 20)
  })

  it('no ffmpeg: the stills are still saved, and the result says why there is no video', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'yir-export-'))
    const r = await exportYirStory({ open: async () => fakePage(1).page, outDir, encode: async () => false }, [0])
    assert.equal(r.stills.length, 1)
    assert.equal(r.videos.length, 0)
    assert.match(String(r.note), /ffmpeg/)
  })

  it('ffmpeg makes silent H.264 yuv420p at the frame rate', () => {
    const a = ffmpegStoryArgs('/tmp/f', '/tmp/o.mp4', 30)
    for (const x of ['libx264', 'yuv420p', '-an', '+faststart']) assert.ok(a.includes(x), x)
    assert.equal(a[a.indexOf('-framerate') + 1], '30')
  })
})
