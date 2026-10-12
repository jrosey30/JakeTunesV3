/**
 * Cover vault and artwork provenance.
 *
 * scripts/cover-vault.mjs freezes the covers in the artwork cache that
 * came out of a downloaded file's own tags (sidecar `source: 'embedded'`,
 * untouched since). It runs here against a fixture data dir, never the
 * real one. fetch-album-art now writes a `fetched` sidecar, so a forced
 * re-fetch can no longer pass as an original.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchedArtworkSidecar } from '../artwork-provenance.ts'

const exec = promisify(execFile)
const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'cover-vault.mjs')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9])
const HTML = Buffer.from('<html>404 Not Found</html>')

const keyOf = (artist: string, album: string) => `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`
const md5 = (s: string) => createHash('md5').update(s).digest('hex')
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

interface Cover { artist: string; album: string; bytes: Buffer; source?: string; stampOffsetMs?: number; sidecarKey?: string; sidecarBytes?: number }

async function fixture(covers: Cover[], tracks: Array<{ id: number; artist: string; album: string }>): Promise<string> {
  const app = await mkdtemp(join(tmpdir(), 'jt-vault-app-'))
  const art = join(app, 'artwork')
  await mkdir(art)
  const index: Record<string, string> = {}
  const extractedAt = Date.parse('2026-08-01T12:00:00.000Z')
  for (const c of covers) {
    const key = keyOf(c.artist, c.album)
    const hash = md5(key)
    await writeFile(join(art, `${hash}.jpg`), c.bytes)
    if (c.source) {
      await writeFile(join(art, `${hash}.meta.json`), JSON.stringify({
        artist: c.artist, album: c.album, key: c.sidecarKey ?? key, source: c.source,
        bytes: c.sidecarBytes ?? c.bytes.length, importedAt: new Date(extractedAt).toISOString(),
      }))
    }
    index[key] = `${hash}_${extractedAt + (c.stampOffsetMs ?? 1200)}`
  }
  await writeFile(join(art, 'index.json'), JSON.stringify(index))
  await writeFile(join(app, 'library.json'), JSON.stringify({
    tracks: tracks.map((t) => ({ ...t, title: `t${t.id}`, path: `:iPod_Control:Music:F01:imported_${t.id}.m4a`, audioFingerprint: `sha1:${t.id}|1000` })),
  }))
  return app
}

async function run(app: string, out?: string): Promise<string> {
  const args = [SCRIPT, '--app-dir', app, ...(out ? ['--apply', '--out', out] : [])]
  const { stdout } = await exec(process.execPath, args, { maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

async function newestManifest(out: string): Promise<{ albums: Array<{ key: string; sha256: string; cover: string; tracks: Array<{ id: number }>; note?: string }> }> {
  const names = (await readdir(join(out, 'manifests'))).filter((n) => n.endsWith('.json')).sort()
  return JSON.parse(await readFile(join(out, 'manifests', names[names.length - 1]), 'utf8'))
}

describe('cover vault', () => {
  test('only untouched embedded originals are vaulted, with their tracks', async () => {
    const app = await fixture([
      { artist: 'Probe', album: 'Original', bytes: JPEG, source: 'embedded' },
      { artist: 'Probe', album: 'Png Original', bytes: PNG, source: 'embedded' },
      { artist: 'Probe', album: 'Refetched', bytes: Buffer.concat([JPEG, JPEG]), source: 'embedded', stampOffsetMs: 3_600_000 },
      { artist: 'Probe', album: 'Fetched', bytes: JPEG, source: 'fetched' },
      { artist: 'Probe', album: 'Picked', bytes: JPEG, source: 'user-custom' },
      { artist: 'Probe', album: 'No Sidecar', bytes: JPEG },
      { artist: 'Probe', album: 'Error Page', bytes: HTML, source: 'embedded' },
      { artist: 'Probe', album: 'Short', bytes: JPEG, source: 'embedded', sidecarBytes: 999 },
      { artist: 'Probe', album: 'Old Name (Remastered)', bytes: JPEG, source: 'embedded' },
    ], [
      { id: 1, artist: 'Probe', album: 'Original' },
      { id: 2, artist: 'probe', album: 'ORIGINAL ' },
      { id: 3, artist: 'Probe', album: 'Png Original' },
      { id: 4, artist: 'Probe', album: 'Refetched' },
      { id: 5, artist: 'Probe', album: 'Fetched' },
      { id: 6, artist: 'Probe', album: 'Old Name' },
    ])

    const dry = await run(app)
    assert.match(dry, /vaultable: 3 albums \(1 renamed or removed\)/)
    assert.match(dry, /rewritten after extraction/)
    assert.match(dry, /not a JPEG or PNG/)
    assert.match(dry, /size differs from sidecar/)

    const out = join(await mkdtemp(join(tmpdir(), 'jt-vault-out-')), 'vault')
    await run(app, out)
    const m = await newestManifest(out)
    assert.deepEqual(m.albums.map((a) => a.key).sort(), [
      'probe|||old name (remastered)', 'probe|||original', 'probe|||png original',
    ])
    const original = m.albums.find((a) => a.key === 'probe|||original')!
    assert.deepEqual(original.tracks.map((t) => t.id).sort(), [1, 2])
    assert.equal(original.cover, `covers/${sha256(JPEG)}.jpg`)
    assert.deepEqual(await readFile(join(out, original.cover)), JPEG)
    const png = m.albums.find((a) => a.key === 'probe|||png original')!
    assert.equal(png.cover, `covers/${sha256(PNG)}.png`)
    // A renamed album keeps its original cover, with no guessed tracks.
    const renamed = m.albums.find((a) => a.key === 'probe|||old name (remastered)')!
    assert.deepEqual(renamed.tracks, [])
    assert.match(renamed.note || '', /renamed or removed/)
  })

  test('a re-run adds, never rewrites, and keeps albums whose cache entry is gone', async () => {
    const app = await fixture([{ artist: 'Probe', album: 'Original', bytes: JPEG, source: 'embedded' }], [{ id: 1, artist: 'Probe', album: 'Original' }])
    const out = join(await mkdtemp(join(tmpdir(), 'jt-vault-out-')), 'vault')
    await run(app, out)
    const coverPath = join(out, 'covers', `${sha256(JPEG)}.jpg`)
    const before = await readFile(coverPath)

    // The cache entry is then re-fetched: new bytes, `fetched` sidecar.
    const hash = md5('probe|||original')
    await writeFile(join(app, 'artwork', `${hash}.jpg`), PNG)
    await writeFile(join(app, 'artwork', `${hash}.meta.json`), JSON.stringify(fetchedArtworkSidecar('Probe', 'Original', 'deezer', 'https://example.invalid/x.jpg', PNG.length)))
    await new Promise((r) => setTimeout(r, 5))
    const second = await run(app, out)
    assert.match(second, /covers copied this run: 0/)
    assert.deepEqual(await readFile(coverPath), before)
    const m = await newestManifest(out)
    assert.equal(m.albums.length, 1, 'the earlier original is still listed')
    assert.equal(m.albums[0].sha256, sha256(JPEG))
    const sums = (await readdir(join(out, 'manifests'))).filter((n) => n.endsWith('.sha256'))
    assert.equal(sums.length, 2)
  })
})

describe('fetched artwork provenance', () => {
  test('a fetched cover is labelled fetched, with where it came from', () => {
    const at = new Date('2026-10-12T00:00:00.000Z')
    assert.deepEqual(fetchedArtworkSidecar(' Probe ', 'Masters ', 'coverartarchive', 'https://coverartarchive.org/release/x/front', 1234, at), {
      artist: 'Probe',
      album: 'Masters',
      key: 'probe|||masters',
      source: 'fetched',
      provider: 'coverartarchive',
      url: 'https://coverartarchive.org/release/x/front',
      bytes: 1234,
      importedAt: '2026-10-12T00:00:00.000Z',
    })
  })

  test('fetch-album-art writes the sidecar right after it replaces the image', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'ipc', 'artwork-ipc.ts'), 'utf8')
    const handler = src.slice(src.indexOf("ipc.handle('fetch-album-art'"), src.indexOf("ipc.handle('fetch-album-art'") + 6000)
    const imageWrite = handler.indexOf('await writeFile(filePath, imgBuf)')
    const sidecarWrite = handler.indexOf('fetchedArtworkSidecar(')
    assert.ok(imageWrite > 0, 'fetch-album-art still writes the image')
    assert.ok(sidecarWrite > imageWrite, 'and labels it fetched right after')
    assert.ok(sidecarWrite < handler.indexOf('saveArtworkIndex(index)'), 'before the index points at it')
  })
})
