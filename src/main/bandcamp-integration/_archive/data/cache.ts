// ════════════════════════════════════════════════════════════════════════
//  Tiny JSON+TTL cache (Brief 036 v2.2, Layer 3)
//  Mirrors the existing per-feature pattern (e.g. discogs-collection.json):
//  one JSON file per cache under userData, with a wrapper timestamp.
// ════════════════════════════════════════════════════════════════════════

import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir, unlink } from 'fs/promises'

function pathFor(name: string): string {
  return join(app.getPath('userData'), name)
}

export async function readJSON<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(pathFor(name), 'utf-8')) as T
  } catch {
    return null
  }
}

export async function writeJSON(name: string, data: unknown): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(pathFor(name), JSON.stringify(data))
}

export async function removeJSON(name: string): Promise<void> {
  await unlink(pathFor(name)).catch(() => {})
}

interface TtlWrapper<T> { ts: number; data: T }

/** Returns cached data only if younger than ttlMs; else null. */
export async function readFresh<T>(name: string, ttlMs: number): Promise<T | null> {
  const wrap = await readJSON<TtlWrapper<T>>(name)
  if (!wrap || typeof wrap.ts !== 'number') return null
  if (Date.now() - wrap.ts > ttlMs) return null
  return wrap.data
}

export async function writeFresh<T>(name: string, data: T): Promise<void> {
  await writeJSON(name, { ts: Date.now(), data } satisfies TtlWrapper<T>)
}
