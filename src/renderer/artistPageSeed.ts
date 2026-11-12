/**
 * What the artist page needs for its first frame, fetched once after the
 * library loads (2026-11-10): every cached artist profile, and which artists
 * have a photo on this Mac's disk. Both are disk-only in main — no network —
 * and land in the renderer's memory (artistProfileStore, diskArtistPhotos)
 * long before an artist is clicked. Until this existed the page asked for
 * each after its first paint, on every first visit after a launch.
 *
 * A failure here costs nothing but the head start: the page falls back to
 * asking main when it opens, as it always did.
 */
import type { ArtistLibraryIndex } from './artistLibraryIndex'
import { canonicalArtist } from './utils/artistAlias'
import { diskArtistPhotos, diskArtistNoPhoto, artistPhotoVersions } from './utils/artistPortrait'
import { artistProfileStore } from './artistProfile'

let started = false

export function primeArtistPage(index: ArtistLibraryIndex): void {
  if (started) return
  started = true
  const api = window.electronAPI
  void (async () => {
    try {
      const r = await api.artistProfileAll?.()
      if (r?.ok && Array.isArray(r.states)) artistProfileStore.seed(r.states, r.complete === true)
    } catch (err) {
      console.warn('[artist-page] profile seed failed:', err instanceof Error ? err.message : err)
    }
  })()
  void (async () => {
    try {
      // As tagged AND as the page asks (canonical): the page looks a photo up by its canonical name.
      const names = new Set<string>()
      for (const n of index.names) { names.add(n); names.add(canonicalArtist(n)) }
      const r = await api.artistPhotosKnown?.([...names])
      if (!r?.ok) return
      for (const [name, slug] of Object.entries(r.slugs ?? {})) diskArtistPhotos.set(name, slug)
      for (const [slug, v] of Object.entries(r.versions ?? {})) artistPhotoVersions.set(slug, v)
      for (const name of r.none ?? []) diskArtistNoPhoto.add(name)
    } catch (err) {
      console.warn('[artist-page] photo seed failed:', err instanceof Error ? err.message : err)
    }
  })()
}
