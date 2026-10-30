/**
 * Album notes — the history and the Music Man's take for an album, kept on
 * disk (userData/album-notes.json) so a page reads the same words every time
 * it opens (Jake 2026-10-30: "once the AI comes up with something, it should
 * stay there" — they lived in memory before and were regenerated every
 * launch). Only finished text goes in: a reply that ran out of tokens is
 * shown trimmed to whole sentences once and asked again next time
 * (ipc/ai-ipc.ts).
 */
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from './atomic-write.ts'

export type AlbumNoteKind = 'blurbs' | 'takes'
type AlbumNotesFile = { v: 1; blurbs: Record<string, string>; takes: Record<string, string> }

export interface AlbumNotesStore {
  get(kind: AlbumNoteKind, key: string): Promise<string | undefined>
  /** Empty text is never kept. Writes are queued and atomic; a failed write is one warning, never a throw. */
  set(kind: AlbumNoteKind, key: string, text: string): Promise<void>
}

export function albumNotesKey(artist: string, album: string, year?: string): string {
  const base = `${(artist || '').toLowerCase().trim()}|${(album || '').toLowerCase().trim()}`
  return year ? `${base}|${year}` : base
}

export function createAlbumNotesStore(path: string, warn: (msg: string) => void = (m) => console.warn(m)): AlbumNotesStore {
  let notes: AlbumNotesFile | null = null
  let loading: Promise<AlbumNotesFile> | null = null
  let writes: Promise<void> = Promise.resolve()

  const load = (): Promise<AlbumNotesFile> => {
    if (notes) return Promise.resolve(notes)
    if (!loading) {
      loading = (async () => {
        let loaded: AlbumNotesFile = { v: 1, blurbs: {}, takes: {} }
        try {
          const raw = JSON.parse(await readFile(path, 'utf-8')) as Partial<AlbumNotesFile> | null
          if (raw && typeof raw === 'object') {
            loaded = { v: 1, blurbs: { ...(raw.blurbs || {}) }, takes: { ...(raw.takes || {}) } }
          }
        } catch (err) {
          // No file yet is the first launch; anything else is worth one line.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') warn(`[album-notes] unreadable, starting empty: ${(err as Error).message}`)
        }
        notes = loaded
        return loaded
      })()
    }
    return loading
  }

  return {
    async get(kind, key) {
      const n = await load()
      return n[kind][key] || undefined
    },
    async set(kind, key, text) {
      const t = (text || '').trim()
      if (!t) return
      const n = await load()
      n[kind][key] = t
      const snapshot: AlbumNotesFile = { v: 1, blurbs: { ...n.blurbs }, takes: { ...n.takes } }
      writes = writes
        .then(() => writeJsonAtomic(path, snapshot))
        .catch((err) => warn(`[album-notes] not saved: ${(err as Error).message}`))
      return writes
    },
  }
}
