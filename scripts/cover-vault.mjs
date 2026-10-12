// Cover vault: freeze the original embedded covers in the artwork cache.
//
// READ-ONLY against the app's data (library.json, artwork/index.json,
// artwork/<hash>.jpg + <hash>.meta.json). Writes only to --out.
//
//   node scripts/cover-vault.mjs                       # dry run: counts only
//   node scripts/cover-vault.mjs --apply --out <dir>   # build or extend a vault
//   --app-dir <dir>   read another JakeTunes data dir (tests use a fixture)
//
// Why (2026-10-12): 94% of library files carry no cover in the file. From
// 5/22 to 10/09 every lossless import was re-encoded by afconvert, which
// drops the picture (fixed for new imports in d1bed0a). For most of those
// albums the artwork cache still holds the exact bytes that were embedded
// in the download, but only there, and a forced re-fetch overwrites them
// (it already did for 51 albums). The vault keeps a copy that nothing in
// the app writes to, plus a manifest mapping every track to its cover, so
// covers can be restored into files later without guessing.
//
// A cover is vaulted only when all of these hold. Anything else is skipped
// and counted by reason.
//   - its sidecar says source 'embedded' (extractAndSaveEmbeddedArtwork
//     is the only writer of that value);
//   - the sidecar's key is the index key that points at it;
//   - the jpg's size equals the sidecar's recorded bytes;
//   - the index entry was written within 5 s of the sidecar (a later
//     fetch rewrites the jpg and the index, not the sidecar);
//   - the bytes are a JPEG or PNG (two cached "covers" are HTML pages).
//
// Layout of --out (additive: a re-run never changes or removes a file):
//   covers/<sha256>.jpg|.png      content-addressed cover bytes
//   manifests/<stamp>.json        every vaulted album and its tracks; each
//                                 run's manifest includes all earlier ones
//   manifests/<stamp>.sha256      `shasum -a 256 -c` list for the covers
//   README.txt

import { createHash } from 'node:crypto'
import { constants as fsc } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const INDEX_STAMP_WINDOW_MS = 5000

const args = process.argv.slice(2)
const argValue = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null)
const apply = args.includes('--apply')
const out = argValue('--out')
const APP = argValue('--app-dir') || join(homedir(), 'Library/Application Support/JakeTunes')
const ART = join(APP, 'artwork')
if (apply && !out) {
  console.error('--apply needs --out <dir>')
  process.exit(2)
}

/** ⚠️ TWIN: src/main/artwork-engine.ts artworkHash (the cache's key). */
function artKey(artist, album) {
  return `${String(artist || '').toLowerCase().trim()}|||${String(album || '').toLowerCase().trim()}`
}

function imageFormat(head) {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg'
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png'
  return null
}

const index = JSON.parse(await readFile(join(ART, 'index.json'), 'utf8'))
const library = JSON.parse(await readFile(join(APP, 'library.json'), 'utf8'))
const tracks = Array.isArray(library) ? library : library.tracks || []

const tracksByKey = new Map()
for (const t of tracks) {
  const k = artKey(t.artist, t.album)
  if (!tracksByKey.has(k)) tracksByKey.set(k, [])
  tracksByKey.get(k).push(t)
}

const skipped = {}
const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1 }
const albums = []

for (const [key, value] of Object.entries(index)) {
  const [hash, stampRaw] = String(value).split('_')
  let meta
  try {
    meta = JSON.parse(await readFile(join(ART, `${hash}.meta.json`), 'utf8'))
  } catch {
    skip('no provenance sidecar')
    continue
  }
  if (meta.source !== 'embedded') { skip(`source ${meta.source || 'unset'}`); continue }
  if (meta.key !== key) { skip('sidecar key differs from index key'); continue }
  const stamp = Number(stampRaw)
  if (!stamp) { skip('index entry has no version stamp'); continue }
  if (Math.abs(stamp - Date.parse(meta.importedAt)) > INDEX_STAMP_WINDOW_MS) { skip('rewritten after extraction'); continue }
  let bytes
  try {
    bytes = await readFile(join(ART, `${hash}.jpg`))
  } catch {
    skip('cover file missing')
    continue
  }
  if (bytes.length !== meta.bytes) { skip('size differs from sidecar'); continue }
  const format = imageFormat(bytes)
  if (!format) { skip('not a JPEG or PNG'); continue }
  // An album renamed after import (e.g. "(Remastered)" stripped) keeps
  // its original key here and matches no track. The cover is still the
  // original; it is vaulted with no track list rather than a guessed one.
  const albumTracks = tracksByKey.get(key) || []
  albums.push({
    key,
    artist: meta.artist,
    album: meta.album,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    format,
    bytes: bytes.length,
    cacheHash: hash,
    cacheIndexValue: String(value),
    extractedAt: meta.importedAt,
    ...(albumTracks.length === 0 ? { note: 'no library track has this artist|album now (renamed or removed)' } : {}),
    srcPath: join(ART, `${hash}.jpg`),
    tracks: albumTracks.map((t) => ({
      id: t.id,
      title: t.title || '',
      artist: t.artist || '',
      discNumber: t.discNumber || 0,
      trackNumber: t.trackNumber || 0,
      path: t.path || '',
      codec: t.codec || '',
      source: t.source || '',
      dateAdded: t.dateAdded || '',
      fileSize: t.fileSize || 0,
      audioFingerprint: t.audioFingerprint || '',
    })),
  })
}

const distinct = new Map(albums.map((a) => [a.sha256, a.bytes]))
const coverBytes = [...distinct.values()].reduce((s, b) => s + b, 0)
const trackCount = albums.reduce((s, a) => s + a.tracks.length, 0)
console.log(`index entries: ${Object.keys(index).length}`)
const unmatched = albums.filter((a) => a.tracks.length === 0).length
console.log(`vaultable: ${albums.length} albums (${unmatched} renamed or removed), ${trackCount} tracks, ${distinct.size} distinct covers, ${(coverBytes / 1e6).toFixed(1)} MB`)
console.log('skipped:')
for (const [reason, n] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${reason}`)

if (!apply) {
  console.log('\ndry run. Re-run with --apply --out <dir> to write the vault.')
  process.exit(0)
}

const coversDir = join(out, 'covers')
const manifestsDir = join(out, 'manifests')
await mkdir(coversDir, { recursive: true })
await mkdir(manifestsDir, { recursive: true })

// Union with earlier manifests: an album vaulted before stays listed even
// if its cache entry has since been overwritten.
const entries = new Map()
for (const name of (await readdir(manifestsDir)).filter((n) => n.endsWith('.json')).sort()) {
  const prior = JSON.parse(await readFile(join(manifestsDir, name), 'utf8'))
  for (const a of prior.albums || []) entries.set(`${a.key}\n${a.sha256}`, a)
}
const priorCount = entries.size

let copied = 0
for (const a of albums) {
  const rel = `covers/${a.sha256}.${a.format}`
  const dest = join(out, rel)
  try {
    await copyFile(a.srcPath, dest, fsc.COPYFILE_EXCL)
    copied++
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  // Same name means same content; prove it rather than assume it.
  const onDisk = createHash('sha256').update(await readFile(dest)).digest('hex')
  if (onDisk !== a.sha256) throw new Error(`${dest} does not hash to its name`)
  const { srcPath, ...entry } = a
  entries.set(`${a.key}\n${a.sha256}`, { ...entry, cover: rel })
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const all = [...entries.values()].sort((x, y) => x.key.localeCompare(y.key))
const manifest = {
  schema: 1,
  builtAt: new Date().toISOString(),
  builder: 'JakeTunesV3 scripts/cover-vault.mjs',
  rule: 'artwork cache entries whose sidecar says source "embedded", unchanged since extraction',
  albums: all,
}
await writeFile(join(manifestsDir, `${stamp}.json`), JSON.stringify(manifest, null, 2), { flag: 'wx' })
const sums = [...new Set(all.map((a) => a.cover))].sort().map((rel) => {
  const a = all.find((x) => x.cover === rel)
  return `${a.sha256}  ${rel}`
})
await writeFile(join(manifestsDir, `${stamp}.sha256`), `${sums.join('\n')}\n`, { flag: 'wx' })

const readme = join(out, 'README.txt')
try {
  await stat(readme)
} catch {
  await writeFile(readme, [
    'JakeTunes cover vault',
    '',
    'Original album covers that were embedded in downloaded files, copied',
    'from the JakeTunes artwork cache before anything could overwrite them.',
    'Built by JakeTunesV3 scripts/cover-vault.mjs. Nothing in the app reads',
    'or writes this folder.',
    '',
    'covers/      one file per cover, named by the SHA-256 of its bytes',
    'manifests/   newest <stamp>.json lists every album, its cover, and its',
    '             tracks (id, path, audioFingerprint, fileSize at vault time)',
    '',
    'Check integrity (from this folder):',
    '  shasum -a 256 -c manifests/<newest>.sha256',
    '',
    'Files and folders are read-only on purpose (on homemini they are also',
    'locked with chflags uchg). To add covers: re-run the script into a copy',
    'of this folder, unlock, copy in only the new files, and lock again.',
    '',
  ].join('\n'))
}

console.log(`\nvault: ${out}`)
console.log(`covers copied this run: ${copied} (others already present)`)
console.log(`manifest: manifests/${stamp}.json, ${all.length} album entries (${priorCount} from earlier runs)`)
