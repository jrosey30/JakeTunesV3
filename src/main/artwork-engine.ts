/**
 * artwork-engine — album artwork index, lookup caches, locks, embedded
 * extraction, byte cache. Extracted verbatim from main/index.ts
 * (6.0 Phase 1; the artist-image machinery deliberately stayed behind —
 * it is a different subsystem that merely lived between these blocks).
 */
import { app } from 'electron'
import { createHash } from 'crypto'
import { join } from 'path'
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { normalize } from './normalize'
import { triggerSync } from './sync-orchestrator'

// Artwork helpers
export function getArtworkDir(): string {
  return join(app.getPath('userData'), 'artwork')
}

export function getArtworkIndexPath(): string {
  return join(getArtworkDir(), 'index.json')
}

// 4.4.40: artist photo cache helpers. Photos come from Bandsintown's
// /artists/{name} endpoint (free, app_id auth only). Each artist's photo
// is saved as `${slug}.jpg` and `${slug}.miss` is the tombstone file
// written when Bandsintown has no photo / 404'd — prevents re-querying
// every launch for artists they don't index. Both kinds expire after


export function artworkHash(artist: string, album: string): string {
  return createHash('md5').update(`${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`).digest('hex')
}

// In-memory artwork index — avoids re-reading JSON on every resolve-artwork
// / fetch-album-art / protocol miss. Invalidated on saveArtworkIndex.
/** Assignment seam for the one external writer (load-artwork-map's
 *  sidecar-merge persist) — ESM importers cannot assign an imported let. */
export function setArtworkIndexMem(v: Record<string, string> | null): void { artworkIndexMem = v }
export let artworkIndexMem: Record<string, string> | null = null
// resolve-artwork result cache (exact artist|||album key → hash|null).
export const resolveArtworkCache = new Map<string, string | null>()
/** O(1) normalized key → hash; rebuilt when artwork index changes. */
export let artworkNormIndexMem: Map<string, string> | null = null
/** O(1) normalized artist|||album → hash from sidecars; rebuilt with index. */
export let artworkSidecarNormMem: Map<string, string> | null = null
export let artworkLookupRebuildPromise: Promise<void> | null = null

export function normalizeArtworkPartServer(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*\((?:remaster(?:ed)?|deluxe|bonus|live|expanded|reissue|remix|special|anniversary|edition|mono|stereo)[^)]*\)/g, '')
    .replace(/\s*\[(?:remaster(?:ed)?|deluxe|bonus|live|expanded|reissue|remix|special|anniversary|edition|mono|stereo)[^\]]*\]/g, '')
    .replace(/\s*\((?:feat\.?|featuring|with|prod\.?|produced by)[^)]+\)/g, '')
    .replace(/\s*\[(?:feat\.?|featuring|with)[^\]]+\]/g, '')
    .replace(/\s+-\s+(?:remaster(?:ed)?|deluxe|bonus|live|expanded|reissue|remix|special|anniversary|edition|mono|stereo)[^-]*$/g, '')
    .replace(/[^a-z0-9]+/g, '')
}

export async function rebuildArtworkLookupCaches(index: Record<string, string>): Promise<void> {
  const normIndex = new Map<string, string>()
  for (const [k, v] of Object.entries(index)) {
    const [ka, kal] = k.split('|||')
    const kn = `${normalizeArtworkPartServer(ka || '')}|||${normalizeArtworkPartServer(kal || '')}`
    if (!normIndex.has(kn)) normIndex.set(kn, v)
  }
  artworkNormIndexMem = normIndex

  const sidecarIndex = new Map<string, string>()
  try {
    const { readdir } = await import('fs/promises')
    const dir = getArtworkDir()
    const entries = await readdir(dir)
    for (const name of entries) {
      if (!name.endsWith('.meta.json')) continue
      try {
        const sidecar = JSON.parse(await readFile(join(dir, name), 'utf-8')) as { artist?: string; album?: string }
        const sa = normalizeArtworkPartServer(sidecar.artist || '')
        const sal = normalizeArtworkPartServer(sidecar.album || '')
        if (sa && sal) {
          sidecarIndex.set(`${sa}|||${sal}`, name.replace(/\.meta\.json$/, ''))
        }
      } catch { /* malformed sidecar */ }
    }
  } catch { /* readdir failed */ }
  artworkSidecarNormMem = sidecarIndex
}

export function scheduleArtworkLookupRebuild(index: Record<string, string>): void {
  artworkLookupRebuildPromise = rebuildArtworkLookupCaches(index).catch((err) => {
    console.warn('[artwork-index] lookup cache rebuild failed:', err instanceof Error ? err.message : err)
  })
}
// LRU byte cache for album-art:// protocol — skips repeated readFile for
// the same cover when scrolling grids / revisiting views.
export const ART_BYTES_CACHE = new Map<string, ArrayBuffer>()
export const ART_BYTES_CACHE_MAX = 400

export function bareArtHash(hash: string): string {
  return hash.replace(/_\d+$/, '')
}

export function invalidateArtBytes(hash: string): void {
  const bare = bareArtHash(hash)
  ART_BYTES_CACHE.delete(bare)
  // Thumbnail tier: sweep every size variant from memory AND disk, or a
  // replaced cover would keep serving its old thumb forever (the URL
  // cache-bust only reaches the browser cache, not our stores).
  for (const key of [...ART_BYTES_CACHE.keys()]) {
    if (key.startsWith(`${bare}@`)) ART_BYTES_CACHE.delete(key)
  }
  void (async () => {
    try {
      const thumbDir = join(getArtworkDir(), 'thumbs')
      const entries = await readdir(thumbDir).catch(() => [] as string[])
      await Promise.all(entries
        .filter((f) => f.startsWith(`${bare}_`))
        .map((f) => unlink(join(thumbDir, f)).catch(() => {})))
    } catch { /* best-effort */ }
  })()
}

export function getCachedArtBytes(hash: string): ArrayBuffer | undefined {
  const key = bareArtHash(hash)
  const hit = ART_BYTES_CACHE.get(key)
  if (!hit) return undefined
  // Refresh LRU position
  ART_BYTES_CACHE.delete(key)
  ART_BYTES_CACHE.set(key, hit)
  return hit
}

export function putArtBytes(hash: string, body: ArrayBuffer): void {
  const key = bareArtHash(hash)
  if (ART_BYTES_CACHE.has(key)) ART_BYTES_CACHE.delete(key)
  while (ART_BYTES_CACHE.size >= ART_BYTES_CACHE_MAX) {
    const oldest = ART_BYTES_CACHE.keys().next().value
    if (oldest === undefined) break
    ART_BYTES_CACHE.delete(oldest)
  }
  ART_BYTES_CACHE.set(key, body)
}

export async function loadArtworkIndex(): Promise<Record<string, string>> {
  if (artworkIndexMem) return artworkIndexMem
  try {
    const data = await readFile(getArtworkIndexPath(), 'utf-8')
    artworkIndexMem = JSON.parse(data) as Record<string, string>
    scheduleArtworkLookupRebuild(artworkIndexMem)
    return artworkIndexMem
  } catch {
    artworkIndexMem = {}
    artworkNormIndexMem = new Map()
    artworkSidecarNormMem = new Map()
    return artworkIndexMem
  }
}

// Self-heal the artwork index from the .meta.json sidecars. Custom art (e.g. a
// concert poster) reaches other machines as <hash>.jpg + <hash>.meta.json — the
// deploy + syncs ship those, but NOT index.json — while the renderer's
// artworkMap is built from index.json. Without this, a synced poster's file is
// present but unmapped, so it never renders. Merge any sidecar whose key isn't
// in the index (bare hash → resolves via bareArtHash). Gated on the artwork
// dir being newer than the index so it only walks meta.json when new art
// actually arrived (not on every boot once merged). Returns whether it changed.
export async function mergeArtworkSidecarsIntoIndex(index: Record<string, string>): Promise<boolean> {
  try {
    const dirStat = await stat(getArtworkDir())
    const idxStat = await stat(getArtworkIndexPath()).catch(() => null)
    if (idxStat && dirStat.mtimeMs <= idxStat.mtimeMs + 1000) return false // nothing new since last merge
  } catch { /* fall through and scan */ }
  let changed = false
  try {
    const { readdir } = await import('fs/promises')
    const dir = getArtworkDir()
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.meta.json')) continue
      try {
        const meta = JSON.parse(await readFile(join(dir, name), 'utf-8')) as { key?: string; artist?: string; album?: string }
        const key = (meta.key || (meta.artist && meta.album ? `${meta.artist.toLowerCase().trim()}|||${meta.album.toLowerCase().trim()}` : '')).trim()
        if (!key || index[key]) continue
        index[key] = name.replace(/\.meta\.json$/, '')
        changed = true
      } catch { /* malformed sidecar */ }
    }
  } catch { /* readdir failed */ }
  return changed
}

// 4.4.12: single-flight + atomic write for the artwork index.
//
// Same class of bug 4.1.1 fixed for metadata-overrides (see
// writeOverridesSerialized). Without this:
//   • Risk 1 (atomic): writeFile in place could be torn by a mid-write
//     crash → next launch loadArtworkIndex catches the parse error and
//     returns {} → every custom-art entry the user ever added is gone.
//   • Risk 2 (single-flight): two concurrent callers (e.g. drag-drop 10
//     tracks from one album, OR user adds art for A while App.tsx's
//     auto-fetch loop finishes B) all do load → mutate → save with stale
//     snapshots → later writes overwrite earlier ones.
//
// Fix: a Promise chain that serializes every save through one writer,
// with a unique tmp filename per write + atomic rename. Mirrors the
// exact pattern used by writeOverridesSerialized.
let artworkWriteChain: Promise<void> = Promise.resolve()
export async function saveArtworkIndex(index: Record<string, string>): Promise<void> {
  const snapshot = { ...index }  // capture the caller's intent immediately
  const job = artworkWriteChain.then(async () => {
    const indexPath = getArtworkIndexPath()
    await mkdir(getArtworkDir(), { recursive: true })
    const tmpPath = `${indexPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`
    await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8')
    const { rename } = await import('fs/promises')
    await rename(tmpPath, indexPath)
    artworkIndexMem = snapshot
    resolveArtworkCache.clear()
    scheduleArtworkLookupRebuild(snapshot)
  }).catch((err) => {
    console.warn('[artwork-index] serialized write failed:', err instanceof Error ? err.message : err)
  })
  artworkWriteChain = job
  return job
}

// 4.4.57 — user-uploaded artwork is sacred: once the user sets their
// own cover for an album, NOTHING auto-fetches over it (not the online
// fetcher, not embedded-art extraction, not even a forced re-fetch).
// Tracked in a separate locks file (key = `${artist}|||${album}`,
// lowercased) so the index format stays untouched. set-custom-artwork
// adds a lock; remove-artwork clears it; every auto-fetch path checks it.
export function getArtworkLocksPath(): string {
  return join(getArtworkDir(), 'user-locked.json')
}
// 4.5.0-80 — defense-in-depth backup dir for user-locked JPGs. Every
// set-custom-artwork ALSO writes a copy here. Startup self-heal
// restores the main file from this dir if anything (accidental
// delete, sync glitch, disk error) wipes it.
export function getArtworkLockedBackupDir(): string {
  return join(getArtworkDir(), 'locked-backup')
}
export async function loadArtworkLocks(): Promise<Set<string>> {
  try {
    const data = await readFile(getArtworkLocksPath(), 'utf-8')
    const arr = JSON.parse(data)
    return new Set(Array.isArray(arr) ? (arr as string[]) : [])
  } catch {
    return new Set()
  }
}
// 4.5.0-80 — startup self-heal for the user-locked artwork set.
//
// The user-locked.json file is now the LEAST authoritative source —
// it's a cache of what can be derived from disk truth:
//   - Each user-set cover writes a ${hash}.meta.json sidecar with
//     `source: 'user-custom'` (set in set-custom-artwork since 4.5.0-55).
//   - Each user-set cover also writes a copy to locked-backup/${hash}.jpg
//     (4.5.0-80).
//
// On launch we scan both, rebuild user-locked.json to the UNION of
// (locks already in the file) ∪ (keys with `source: 'user-custom'`
// sidecars) ∪ (keys with a copy in locked-backup/). Any locked key
// whose main JPG is missing but the backup exists gets restored.
//
// Net effect: even if user-locked.json is accidentally deleted or
// corrupted, the next launch reconstructs it from the JPGs + sidecars
// that travel with the artwork. Your hand-picked covers persist.
export async function selfHealUserLockedArtwork(): Promise<void> {
  const dir = getArtworkDir()
  const backupDir = getArtworkLockedBackupDir()
  try { await mkdir(dir, { recursive: true }) } catch { /* ignore */ }
  try { await mkdir(backupDir, { recursive: true }) } catch { /* ignore */ }

  const { readdir, copyFile: cf, stat: statFn } = await import('fs/promises')

  // Sources of truth: sidecars marked user-custom + JPGs in backup dir.
  const lockedKeys = new Set<string>(await loadArtworkLocks())
  let reconstructedFromSidecar = 0
  let reconstructedFromBackup = 0
  let restoredJpg = 0

  // Scan sidecars.
  let sidecarEntries: string[] = []
  try { sidecarEntries = await readdir(dir) } catch { /* nothing */ }
  for (const name of sidecarEntries) {
    if (!name.endsWith('.meta.json')) continue
    try {
      const raw = await readFile(join(dir, name), 'utf-8')
      const meta = JSON.parse(raw) as { artist?: string; album?: string; source?: string; key?: string }
      if (meta.source !== 'user-custom') continue
      const key = meta.key || (meta.artist && meta.album
        ? `${meta.artist.toLowerCase().trim()}|||${meta.album.toLowerCase().trim()}`
        : '')
      if (!key) continue
      if (!lockedKeys.has(key)) {
        lockedKeys.add(key)
        reconstructedFromSidecar++
      }
    } catch { /* malformed sidecar, skip */ }
  }

  // Scan backup dir — any JPG here is from a user-locked cover.
  let backupEntries: string[] = []
  try { backupEntries = await readdir(backupDir) } catch { /* nothing */ }
  for (const name of backupEntries) {
    if (!name.endsWith('.jpg')) continue
    const hash = name.replace(/\.jpg$/, '')
    // Find the (artist, album) for this hash via the sidecar.
    try {
      const sidecarPath = join(dir, `${hash}.meta.json`)
      const raw = await readFile(sidecarPath, 'utf-8')
      const meta = JSON.parse(raw) as { artist?: string; album?: string; key?: string }
      const key = meta.key || (meta.artist && meta.album
        ? `${meta.artist.toLowerCase().trim()}|||${meta.album.toLowerCase().trim()}`
        : '')
      if (key && !lockedKeys.has(key)) {
        lockedKeys.add(key)
        reconstructedFromBackup++
      }
      // If the main JPG is missing but the backup exists, restore.
      const mainJpg = join(dir, `${hash}.jpg`)
      let mainExists = false
      try { await statFn(mainJpg); mainExists = true } catch { /* missing */ }
      if (!mainExists) {
        try {
          await cf(join(backupDir, name), mainJpg)
          restoredJpg++
        } catch (err) {
          console.warn(`[artwork-heal] failed to restore ${hash}.jpg from backup:`, err instanceof Error ? err.message : err)
        }
      }
    } catch { /* no sidecar — backup orphan, skip */ }
  }

  // Persist the reconstructed lock set if it grew.
  const original = await loadArtworkLocks()
  if (lockedKeys.size !== original.size) {
    const locksPath = getArtworkLocksPath()
    const tmpPath = `${locksPath}.${process.pid}.${Date.now()}.heal.tmp`
    try {
      await writeFile(tmpPath, JSON.stringify([...lockedKeys].sort(), null, 2), 'utf-8')
      const { rename } = await import('fs/promises')
      await rename(tmpPath, locksPath)
    } catch (err) {
      console.warn('[artwork-heal] failed to persist healed locks:', err instanceof Error ? err.message : err)
    }
  }

  if (reconstructedFromSidecar + reconstructedFromBackup + restoredJpg > 0) {
    console.log(`[artwork-heal] reconstructed locks from sidecars: ${reconstructedFromSidecar}, from backups: ${reconstructedFromBackup}; restored ${restoredJpg} missing JPGs from locked-backup/`)
  }
}

let artworkLockWriteChain: Promise<void> = Promise.resolve()
export async function setArtworkLock(key: string, locked: boolean): Promise<void> {
  const job = artworkLockWriteChain.then(async () => {
    const locks = await loadArtworkLocks()
    if (locked) locks.add(key)
    else locks.delete(key)
    await mkdir(getArtworkDir(), { recursive: true })
    const locksPath = getArtworkLocksPath()
    const tmpPath = `${locksPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`
    await writeFile(tmpPath, JSON.stringify([...locks], null, 2), 'utf-8')
    const { rename } = await import('fs/promises')
    await rename(tmpPath, locksPath)
  }).catch((err) => {
    console.warn('[artwork-locks] serialized write failed:', err instanceof Error ? err.message : err)
  })
  artworkLockWriteChain = job
  return job
}

// 4.4.12: helper that takes the music-metadata parse result + the
// destination artist/album and saves the embedded front cover into
// the artwork directory using the SAME conventions as set-custom-artwork
// (line ~5067):
//   • key  = `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`
//   • hash = artworkHash(artist, album)
//   • file = `${getArtworkDir()}/${hash}.jpg` (or sips-converted to jpg)
//   • index entry = `${hash}_${Date.now()}` (versioned for renderer cache-bust)
//
// IDENTITY GATE: never overwrites an existing index entry (the user may
// have set custom art previously — embedded-art import should NOT clobber
// that). Gated on `if (!index[key])`, not on text comparison.
//
// Returns the {key, hash} on success so the caller can pass it back to the
// renderer for a single ADD_ARTWORK dispatch (no second IPC round-trip).
// Returns null on any of: no artist, no album, no pictures, picture write
// failed, sips failed. Failures are logged at warn level — they never
// propagate to the import flow (the audio file is the primary artifact;
// art is best-effort).
export interface ParsedPicture {
  format?: string
  type?: string
  data: Buffer | Uint8Array
}
export async function extractAndSaveEmbeddedArtwork(
  pictures: ParsedPicture[] | undefined,
  artist: string,
  album: string,
): Promise<{ key: string; hash: string } | null> {
  if (!pictures || pictures.length === 0) return null
  const cleanArtist = (artist || '').trim()
  const cleanAlbum = (album || '').trim()
  if (!cleanArtist || !cleanAlbum) return null  // no key to store under

  // Prefer the front cover; fall back to the first picture if untagged.
  const pic =
    pictures.find(p => p.type === 'Cover (front)') ??
    pictures[0]
  if (!pic || !pic.data || pic.data.byteLength === 0) return null

  const key = `${cleanArtist.toLowerCase()}|||${cleanAlbum.toLowerCase()}`
  // 4.4.57 — user-uploaded art is sacred: NEVER overwrite a locked key.
  if ((await loadArtworkLocks()).has(key)) return null

  const hash = artworkHash(cleanArtist, cleanAlbum)
  const dir = getArtworkDir()
  const destPath = join(dir, `${hash}.jpg`)
  const sidecarPath = join(dir, `${hash}.meta.json`)
  await mkdir(dir, { recursive: true })

  // 4.5.0-55 — IDENTITY GATE RELAXED. The old rule "if entry exists,
  // never overwrite" guaranteed that a single bad first import poisoned
  // the well forever (Adele Skyfall → orange polygon, May 2026). New
  // rule: an existing entry is replaced ONLY when the new candidate is
  // SUBSTANTIALLY higher quality (≥1.5× byte count). That threshold is
  // wide enough that minor re-encodes of the same image won't thrash
  // the file, but tight enough that a real 1500×1500 cover beats out a
  // garbage 300×300 placeholder. User-locked covers always win (above).
  const newBuf = Buffer.isBuffer(pic.data) ? pic.data : Buffer.from(pic.data)
  const existingIndex = await loadArtworkIndex()
  const hasExistingEntry = !!existingIndex[key]
  let existingSize = 0
  if (hasExistingEntry) {
    try { existingSize = (await stat(destPath)).size } catch { existingSize = 0 }
  }
  const QUALITY_UPGRADE_RATIO = 1.5
  if (hasExistingEntry && existingSize > 0 && newBuf.length < existingSize * QUALITY_UPGRADE_RATIO) {
    // New cover isn't meaningfully bigger than what we have. Keep
    // existing — avoids re-encode thrash on every re-import.
    return null
  }
  // If we're going to write, log it so the user can see in dev console
  // why a cover changed.
  if (hasExistingEntry && existingSize > 0) {
    console.log(`[artwork] upgrading "${key}" — ${existingSize}B → ${newBuf.length}B (${(newBuf.length / existingSize).toFixed(2)}x)`)
  }

  try {
    const fmt = (pic.format || '').toLowerCase()
    invalidateArtBytes(hash)
    if (fmt === 'image/jpeg' || fmt === 'image/jpg') {
      await writeFile(destPath, newBuf)
    } else {
      // Same sips conversion path as set-custom-artwork. Write the
      // embedded blob to a tmp file with an extension sips will recognize,
      // convert, drop the tmp.
      const inferredExt =
        fmt.includes('png') ? '.png' :
        fmt.includes('tiff') ? '.tiff' :
        fmt.includes('bmp') ? '.bmp' :
        fmt.includes('gif') ? '.gif' :
        fmt.includes('webp') ? '.webp' :
        '.img'
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execP = promisify(execFile)
      const tmpPath = destPath + '.tmp' + inferredExt
      await writeFile(tmpPath, newBuf)
      try {
        await execP('sips', ['-s', 'format', 'jpeg', tmpPath, '--out', destPath])
      } finally {
        await unlink(tmpPath).catch(() => {})
      }
    }
  } catch (err) {
    console.warn('[artwork] embedded-art write failed (continuing import):', err instanceof Error ? err.message : err)
    return null
  }

  // 4.5.0-55 — sidecar metadata. Each artwork JPG gets a ${hash}.meta.json
  // next to it carrying the (artist, album, source, importedAt) tuple.
  // Lets us rebuild the index from disk alone if it ever drifts, audit
  // for orphans, and detect cross-key collisions in the future. Best-
  // effort: write failures are logged but don't fail the import.
  try {
    const meta = {
      artist: cleanArtist,
      album: cleanAlbum,
      key,
      source: 'embedded',
      bytes: (await stat(destPath)).size,
      importedAt: new Date().toISOString(),
    }
    await writeFile(sidecarPath, JSON.stringify(meta, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[artwork] sidecar write failed (continuing):', err instanceof Error ? err.message : err)
  }

  // Versioned hash so the renderer's <img src="album-art://${hash}.jpg">
  // cache-busts when the same key+hash gets a fresher file.
  const versionedHash = `${hash}_${Date.now()}`
  // Single-flight save — won't race against concurrent imports / fetches /
  // set-custom-artwork callers. Always update the index entry to the
  // fresh versioned hash so the renderer cache-busts to the new file.
  const index = await loadArtworkIndex()
  index[key] = versionedHash
  // 4.5.0-64: drain any pending artwork-key migrations waiting on THIS
  // key. The race: user edits artist/album in Get Info before the
  // import's artwork extraction finishes. The migration in save-
  // metadata-override fired against an empty index, registered itself
  // as pending, and returned. Now that the original key finally exists,
  // mirror it into the new keys the user already requested. Without
  // this, the renderer asks for the new key, gets nothing, and the
  // album tile renders blank forever (until a manual rescan).
  const pendingTargets = pendingArtworkMigrations.get(key)
  if (pendingTargets && pendingTargets.size > 0) {
    const locks = await loadArtworkLocks()
    const sourceLocked = locks.has(key)
    for (const newKey of pendingTargets) {
      if (!index[newKey]) {
        index[newKey] = versionedHash
        console.log(`[artwork-migrate] drained pending "${key}" → "${newKey}"`)
      }
      // 4.5.0-79 — propagate lock through the drain too.
      if (sourceLocked && !locks.has(newKey)) {
        await setArtworkLock(newKey, true)
        console.log(`[artwork-migrate] propagated lock "${key}" → "${newKey}" (drain)`)
      }
    }
    pendingArtworkMigrations.delete(key)
  }
  await saveArtworkIndex(index)
  // 4.5.0-69 — kick a sync so new artwork lands on homemini within one
  // sync cycle. Pre-fix the sync orchestrator only fired on import /
  // metadata-edit / playlist / safety-net, none of which guarantee the
  // artwork JPG had been written by the time they ran. New artwork
  // could sit on the MacBook for up to 10 minutes (safety-net interval)
  // before reaching Mini — which the mobile app reads from. The new
  // `artwork` reason routes through the same 5s debounce + single-
  // flight as the others, so a 12-track album import producing 12
  // artwork writes (mostly no-ops past the first) still coalesces to
  // one sync run.
  triggerSync('artwork')
  return { key, hash: versionedHash }
}

// 4.5.0-64 — pending-migration registry. When save-metadata-override
// runs an artwork-key migration but the source key isn't in the index
// yet (import still extracting), we record (oldKey -> newKey) here.
// extractAndSaveEmbeddedArtwork drains entries for the key it just
// wrote, so the artwork ends up under the user-edited (artist, album)
// without a manual rescan. In-memory only — the race window is
// seconds long; if the app crashes mid-import the missing artwork is
// recoverable by re-importing the file anyway.
export const pendingArtworkMigrations = new Map<string, Set<string>>()

// Normalize an artist/album string for strict matching: drop edition
// parens/brackets, a leading "the", and collapse whitespace.
export function normalizeArtTerm(s: string): string {
  return s.toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\[.*?\]\s*/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Deezer album art search (shared by artwork fetcher and recommendations).
//
// 4.4.57 — STRICT matching. Rule: "auto-fetched art must be completely
// accurate, or nothing." The old scoring accepted an album-title match
// even when the artist was completely wrong — an exact album-title hit
// scored 20, the pass threshold was 8 — so every "Greatest Hits" /
// "Live" / short common title pulled some random artist's cover. Now
// the artist must match EXACTLY and the album must match exactly (after
// normalization) or be a clean prefix either way. Anything less → null
// → the caller shows a placeholder instead of a wrong cover.
export async function searchDeezerArt(query: string, artistLower: string, albumLower: string): Promise<string | null> {
  const res = await fetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(query)}&limit=10`)
  if (!res.ok) return null
  const data = await res.json() as { data?: { title?: string; artist?: { name?: string }; cover_xl?: string }[] }
  if (!data.data || data.data.length === 0) return null

  const wantArtist = normalizeArtTerm(artistLower)
  const wantAlbum = normalizeArtTerm(albumLower)

  for (const r of data.data) {
    if (!r.cover_xl) continue
    const rArtist = normalizeArtTerm(r.artist?.name || '')
    const rAlbum = normalizeArtTerm(r.title || '')
    // Artist MUST match exactly — a wrong artist is a wrong cover, period.
    if (rArtist !== wantArtist) continue
    // Album: exact, or a clean prefix either way (covers an edition
    // suffix the paren/bracket strip didn't catch).
    const albumOk = rAlbum === wantAlbum
      || (wantAlbum.length >= 3 && (rAlbum.startsWith(wantAlbum) || wantAlbum.startsWith(rAlbum)))
    if (albumOk) return r.cover_xl
  }
  return null
}
