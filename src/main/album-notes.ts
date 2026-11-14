/**
 * Album notes — the history and the Music Man's take for an album, kept on
 * disk (userData/album-notes.json) so a page reads the same words every time
 * it opens (Jake 2026-10-30: "once the AI comes up with something, it should
 * stay there" — they lived in memory before and were regenerated every
 * launch). Only finished text goes in: a reply that ran out of tokens is
 * shown trimmed to whole sentences once and asked again next time
 * (ipc/ai-ipc.ts).
 *
 * TAKES (2026-11-13): no page writes or shows a take any more: the Music Man
 * gives his opinion when Jake asks (ipc/music-man-ask-ipc.ts). The takes
 * already in the file stay, for homemini's merge tool, except the ones that
 * said he didn't know the record ("I don't know Twisted Teens…", 9 of 35 on
 * the MacBook): those are dropped the first time the file is read.
 */
import { readFile } from 'node:fs/promises'
import { stripStageDirections } from '../common/stage-directions.ts'
import { isNonAnswer } from '../common/non-answer.ts'
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
            const before = Object.keys(loaded.takes).length
            for (const [k, v] of Object.entries(loaded.takes)) if (typeof v !== 'string' || isNonAnswer(v, k.split('|').slice(0, 2))) delete loaded.takes[k]
            const dropped = before - Object.keys(loaded.takes).length
            if (dropped > 0) {
              const snapshot: AlbumNotesFile = { v: 1, blurbs: { ...loaded.blurbs }, takes: { ...loaded.takes } }
              writes = writes
                .then(() => writeJsonAtomic(path, snapshot))
                .then(() => warn(`[album-notes] dropped ${dropped} take(s) that said he didn't know the record`))
                .catch((err) => warn(`[album-notes] not saved: ${(err as Error).message}`))
            }
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
      // A saved take can carry the voice's "[softer]": it's read here, never spoken.
      const text = n[kind][key]
      return text ? stripStageDirections(text) : undefined
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
