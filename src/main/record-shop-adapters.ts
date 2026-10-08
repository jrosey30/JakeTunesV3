/** Main-only bridge: the shop consumes the existing ownership decision.
 * No renderer matcher and no change to the downloader's ownership semantics.
 */
import { matchLibraryOwnership, type LibraryTrackLite, type RequestedAlbum } from './album-identity.ts'
import { shopSnapshot, type ShopOwnership, type ShopSelection, type Snapshot } from '../common/record-shop.ts'

export function assessShopReleaseOwnership(
  selection: Snapshot<Extract<ShopSelection, { kind: 'release' }>>,
  library: LibraryTrackLite[],
  libraryRevision: string,
): Snapshot<ShopOwnership> {
  const req = selection.request
  const expected = req.trackCount ?? req.tracks.length
  // An empty or truncated catalogue list cannot establish album completion.
  if (!selection.revision || !libraryRevision || !expected || req.tracks.length !== expected) return { status: 'unknown' }
  // structuredClone returns a new mutable object at runtime; TypeScript keeps
  // its input's readonly annotation. The legacy matcher takes mutable DTOs.
  const verdict = matchLibraryOwnership(structuredClone(req) as RequestedAlbum, library)
  if (verdict.owned.some((m) => !Number.isSafeInteger(m.track.id) || (m.track.id ?? 0) <= 0)) return { status: 'unknown' }
  return shopSnapshot({
    status: verdict.ownedCount === expected ? 'complete' : verdict.ownedCount === 0 ? 'none' : 'partial',
    selectionRevision: selection.revision, libraryRevision, expected, owned: verdict.ownedCount,
    matches: verdict.owned.map((m) => ({ position: m.index, libraryTrackId: m.track.id! })),
  })
}
