/**
 * Where the shop remembers a song that wasn't found (Brief 257): one small
 * JSON file in the app's data dir, pruned to a week and NOT_FOUND_CAP rows on
 * every write. Keys are the request's own words (common/not-found-memory.ts);
 * the file never leaves this Mac and nothing here is logged.
 */
import { app } from 'electron'
import { join } from 'path'
import { readFile, rename, writeFile } from 'fs/promises'
import type { IpcRegistrar } from './ipc-register.ts'
import { forgetNotFound, noteNotFound, pruneNotFound, remembered, type NotFoundEntry, type NotFoundMemory } from '../common/not-found-memory.ts'

const file = (): string => join(app.getPath('userData'), 'shop-not-found.json')

let mem: NotFoundMemory | null = null
let writing: Promise<void> = Promise.resolve()

async function load(): Promise<NotFoundMemory> {
  if (mem) return mem
  try {
    const raw = JSON.parse(await readFile(file(), 'utf-8')) as unknown
    mem = raw && typeof raw === 'object' && !Array.isArray(raw) ? pruneNotFound(raw as NotFoundMemory, Date.now()) : {}
  } catch { mem = {} }
  return mem
}

function save(next: NotFoundMemory): Promise<void> {
  mem = next
  // One write at a time, temp + rename: a crash leaves the old file or the new one.
  writing = writing.then(async () => {
    const tmp = `${file()}.tmp`
    await writeFile(tmp, JSON.stringify(mem), 'utf-8')
    await rename(tmp, file())
  }).catch(() => { /* a memory, not a record: losing it costs one more search */ })
  return writing
}

const okKey = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && k.length < 600

export function registerNotFoundMemory(ipc: IpcRegistrar): void {
  ipc.handle('shop-not-found:check', async (_e, key: unknown): Promise<NotFoundEntry | null> => (okKey(key) ? remembered(await load(), key, Date.now()) : null),
    { refuse: null })
  ipc.handle('shop-not-found:note', async (_e, key: unknown, outcome: unknown): Promise<{ ok: boolean }> => {
    if (!okKey(key) || (outcome !== 'not-found' && outcome !== 'exact-not-found')) return { ok: false }
    await save(noteNotFound(await load(), key, outcome, Date.now()))
    return { ok: true }
  }, { refuse: { ok: false } })
  ipc.handle('shop-not-found:forget', async (_e, key: unknown): Promise<{ ok: boolean }> => {
    if (!okKey(key)) return { ok: false }
    const cur = await load()
    const next = forgetNotFound(cur, key)
    if (next !== cur) await save(next)
    return { ok: true }
  }, { refuse: { ok: false } })
}
