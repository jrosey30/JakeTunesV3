/**
 * The import queue never makes one caller's format everyone's (V7 steady,
 * 2026-11-24). The queue kept ONE format for the whole queue and nothing
 * cleared it: once a live set was declared (liveSetDeclare queues the merged
 * concert as 'alac'), every later drag-and-drop, File › Import, Import and
 * Convert and inbox import sent 'alac', so main skipped Settings › Library's
 * format until restart. The format now rides on each queue item.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

type Call = { srcPath: string; id: number; format: string | undefined }
const calls: Call[] = []
let nextTrackId = 1000

;(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    importResolvePaths: async (paths: string[]) => ({ ok: true, paths }),
    importTrack: async (srcPath: string, id: number, format?: string) => {
      calls.push({ srcPath, id, format })
      return { ok: true, track: { id: nextTrackId++, title: srcPath } }
    },
    deleteInboxSource: async () => ({ ok: true }),
  },
}

const { enqueueFiles, getQueueState } = await import('../../renderer/importQueue.ts')

async function idle(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = getQueueState()
    if (!s.workerRunning && !s.items.some((it) => it.status === 'pending' || it.status === 'running')) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('queue never went idle')
}

test('a live set as alac, then ordinary imports send no format (main uses Settings)', async () => {
  await enqueueFiles(['/tmp/live-set-merged.m4a'], 'alac', { quiet: true })
  await idle()
  await enqueueFiles(['/tmp/dropped-a.flac', '/tmp/dropped-b.flac'])
  await idle()
  await enqueueFiles(['/tmp/inbox-c.flac'], undefined, { deleteSourceOnSuccess: true })
  await idle()
  assert.deepEqual(calls.map((c) => [c.srcPath, c.format]), [
    ['/tmp/live-set-merged.m4a', 'alac'],
    ['/tmp/dropped-a.flac', undefined],
    ['/tmp/dropped-b.flac', undefined],
    ['/tmp/inbox-c.flac', undefined],
  ])
  assert.equal('format' in getQueueState(), false, 'no queue-wide format')
})
