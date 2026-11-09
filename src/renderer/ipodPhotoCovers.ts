// Photo covers (2026-11-09; common/ipod-photo-covers.ts, main/ipod-photo-covers.ts).
// Jake, with a photo of his real Original iPod mini: "for top 1000 ipod. use
// this photo". The Top 1000 and any iPod list can wear a photo over its drawn
// iPod: "Use a photo…" / "Use the drawing" on its sidebar row and its header.
//
// Same module-store idiom as ipodLists.ts: one answer per key from main, kept
// here so a remount never flashes the drawing first.
import { useEffect, useSyncExternalStore } from 'react'
import { photoKeyForPlaylist } from '../common/ipod-photo-covers'
import top1000Photo from './assets/playlist-covers/top-1000-photo.jpg'

type Shown = 'kept' | 'bundled' | 'drawing'
interface Entry { shown: Shown; url: string | null }

let snap: Record<string, Entry> = {}
const listeners = new Set<() => void>()
const asked = new Set<string>()
let synced: Promise<void> | null = null

const emit = () => { for (const l of listeners) l() }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const getSnapshot = () => snap

async function ask(key: string): Promise<void> {
  const r = await window.electronAPI.ipodPhotoGet?.(key).catch(() => null)
  if (!r?.ok) return
  snap = { ...snap, [key]: { shown: r.shown, url: r.url } }
  emit()
}

/** Follow homemini's photos once per launch (and after the 5-minute retry main runs on its own). */
function syncOnce(): Promise<void> {
  if (!synced) {
    synced = (async () => {
      await window.electronAPI.ipodPhotoSync?.().catch(() => null)
      await Promise.all([...asked].map(ask))
    })()
  }
  return synced
}

/** The photo an iPODS playlist wears, or null (it wears its drawn iPod). */
export function useIpodPhotoCover(playlistId: string | null | undefined): string | null {
  const key = photoKeyForPlaylist(playlistId)
  const all = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    if (!key || asked.has(key)) return
    asked.add(key)
    void ask(key).then(() => syncOnce())
  }, [key])
  if (!key) return null
  const e = all[key]
  if (!e) return null
  if (e.shown === 'kept') return e.url
  if (e.shown === 'bundled') return top1000Photo
  return null
}

/** Does this playlist wear a photo right now (for the menu: "Use the drawing" only then). */
export function useHasIpodPhoto(playlistId: string | null | undefined): boolean {
  return useIpodPhotoCover(playlistId) !== null
}

export type PhotoChoice = { ok: true; line: string } | { ok: false; line: string | null }

/** "Use a photo…": main opens the picker; the cover changes when main has kept the file. */
export async function chooseIpodPhoto(playlistId: string, name: string): Promise<PhotoChoice> {
  const key = photoKeyForPlaylist(playlistId)
  if (!key) return { ok: false, line: null }
  const r = await window.electronAPI.ipodPhotoChoose?.(key).catch((err: unknown) => ({ ok: false as const, cancelled: false, error: err instanceof Error ? err.message : 'couldn’t use that photo' }))
  await ask(key)
  if (!r) return { ok: false, line: 'Photos need a newer JakeTunes.' }
  if (!r.ok) return { ok: false, line: r.cancelled ? null : (r.error ?? 'couldn’t use that photo') }
  return { ok: true, line: r.homemini === 'saved' ? `${name} wears your photo, here and on the phone.` : `${name} wears your photo. The phone gets it when homemini answers.` }
}

/** "Use the drawing": the photo goes, the drawn iPod comes back. */
export async function backToIpodDrawing(playlistId: string, name: string): Promise<PhotoChoice> {
  const key = photoKeyForPlaylist(playlistId)
  if (!key) return { ok: false, line: null }
  const r = await window.electronAPI.ipodPhotoDrawing?.(key).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'couldn’t go back to the drawing' }))
  await ask(key)
  if (!r) return { ok: false, line: 'Photos need a newer JakeTunes.' }
  if (!r.ok) return { ok: false, line: r.error }
  return { ok: true, line: r.homemini === 'saved' ? `${name} wears its drawing again.` : `${name} wears its drawing again. The phone follows when homemini answers.` }
}
