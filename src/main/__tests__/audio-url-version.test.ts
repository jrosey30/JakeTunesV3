/**
 * A rewritten song's reload is a new URL (2026-11-14).
 *
 * Measured in Electron 30 (PR #425, scratch app): Chromium keeps a song's
 * bytes per URL across media elements. After a tag write rewrote the file, a
 * reload of the SAME URL never asked for byte 0: it used the old header from
 * memory and read the middle from the new file (PIPELINE_ERROR_DECODE on the
 * reload and on a replay 7 s later, by path). So the renderer marks the URL of
 * a file a tag write rewrote with `?v=<mtime-size>`; main serves a marked URL
 * as its own load, whole, from the new file.
 *
 * The chain here is the real one end to end, short of Chromium: a real file,
 * rewritten by writeVerified, measured by measureLibraryFileSizes with a real
 * lstat, noted by the renderer's map, put on the URL, and served by the hold.
 */
import { test, describe, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileVersion, FILE_VERSION_SHAPE } from '../../common/audio-file-version.ts'
import { measureLibraryFileSizes } from '../../common/library-file-sizes.ts'
import { _resetFileVersions, noteFileVersion, noteMeasuredVersions, withFileVersion } from '../../renderer/audio/audioUrlVersion.ts'
import { createLoadHold, holdKey, serveHeldFile, splitAudioUrl, startsLoad } from '../audio-load-hold.ts'
import { writeVerified } from '../audio-write-guard.ts'

const SRC = join(import.meta.dirname, '..', '..')
const dir = mkdtempSync(join(tmpdir(), 'jt-url-version-'))
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => _resetFileVersions())

const bytes = (tag: number, size: number): Buffer => { const b = Buffer.alloc(size); for (let i = 0; i < size; i++) b[i] = (i * 13 + tag * 71) & 0xff; return b }
/** ipodPathToAudioURL's url, as useAudio.ts builds it (pinned to the source below). */
const urlFor = (colon: string): string => withFileVersion('ipod-audio://' + encodeURIComponent(dir + colon.replace(/:/g, '/')), colon)
const body = async (r: Response): Promise<Buffer> => Buffer.from(await r.arrayBuffer())

describe('the marker', () => {
  test('a song no tag write touched keeps its URL exactly; a rewritten one gets ?v=<mtime-size>', () => {
    const colon = ':iPod_Control:Music:F43:imported_15343.m4a'
    const plain = 'ipod-audio://' + encodeURIComponent(dir + colon.replace(/:/g, '/'))
    assert.equal(urlFor(colon), plain, 'nothing Chromium holds for an unchanged file is thrown away')
    noteFileVersion(colon, fileVersion({ mtimeMs: 1_794_700_219_000, size: 31_457_280 }))
    assert.equal(urlFor(colon), `${plain}?v=${fileVersion({ mtimeMs: 1_794_700_219_000, size: 31_457_280 })}`)
    assert.equal(urlFor(':iPod_Control:Music:F43:other.m4a').includes('?'), false)
  })

  test('only a version-shaped marker is ever put on a URL', () => {
    noteFileVersion(':a.m4a', '../../etc/passwd')
    noteFileVersion(':b.m4a', 'x&y=1')
    assert.equal(withFileVersion('ipod-audio://a', ':a.m4a'), 'ipod-audio://a')
    assert.equal(withFileVersion('ipod-audio://b', ':b.m4a'), 'ipod-audio://b')
    assert.match(fileVersion({ mtimeMs: Date.now(), size: 123456789 }), FILE_VERSION_SHAPE)
  })

  test('both tag-write results mark by id; a result for a song not in the list marks nothing', () => {
    noteMeasuredVersions([{ id: 1, path: ':p1.m4a' }, { id: 2, path: ':p2.m4a' }], [{ id: 2, fileVersion: 'abc-1' }, { id: 9, fileVersion: 'zzz-9' }, { id: 1 }])
    assert.equal(withFileVersion('u', ':p1.m4a'), 'u')
    assert.equal(withFileVersion('u', ':p2.m4a'), 'u?v=abc-1')
  })
})

describe("Jake's story, end to end short of Chromium", () => {
  test('edit → rewrite → measured → marked URL → the new file whole; the old URL\'s load keeps the old file', async () => {
    const colon = ':iPod_Control:Music:F43:imported_15343.m4a'
    const abs = dir + colon.replace(/:/g, '/')
    mkdirSync(dirname(abs), { recursive: true })
    const A = bytes(1, 300_000), B = bytes(2, 360_000)                 // mutagen grew the tags: the audio moved
    writeFileSync(abs, A)
    const hold = createLoadHold({ open: (p) => open(p, 'r') })
    const request = async (url: string, range: string | null): Promise<Response> => {
      const { base, version } = splitAudioUrl(url)
      if (!startsLoad(range)) { const h = hold.continue(holdKey(base, version), range); if (h) return h }
      return serveHeldFile(hold, { url, path: decodeURIComponent(base.replace('ipod-audio://', '')), source: colon, range, contentType: 'audio/mp4', label: 'local' })
    }
    const before = urlFor(colon)
    assert.deepEqual(await body(await request(before, 'bytes=0-')), A)  // 19:09:25 onplay

    // The write the line made once the song was done: a copy renamed over it.
    assert.equal((await writeVerified(abs, async (tmp) => { writeFileSync(tmp, B); return { ok: true } }, { check: async () => ({ ok: true }) })).ok, true)
    // index.ts measures the written file and sends it ('tag-writeback:file-changed'); App.tsx notes it.
    const { measured } = await measureLibraryFileSizes([{ id: 15343, path: colon, duration: 312_000 }], () => abs, () => true, lstat)
    assert.equal(measured[0].fileVersion, fileVersion(statSync(abs)))
    noteMeasuredVersions([{ id: 15343, path: colon }], measured)

    // The reload (stuck recovery, or any later play): a new URL.
    const after = urlFor(colon)
    assert.notEqual(after, before)
    const reload = await request(after, 'bytes=0-')
    assert.equal(reload.headers.get('Content-Range'), `bytes 0-${B.length - 1}/${B.length}`)
    assert.deepEqual(await body(reload), B, 'the new file whole: no old header, no old byte')
    assert.deepEqual(await body(await request(after, 'bytes=200000-209999')), B.subarray(200000, 210000))
    // A piece for the OLD URL (an element still on it) is still the old file.
    assert.deepEqual(await body(await request(before, 'bytes=200000-209999')), A.subarray(200000, 210000))
  })
})

describe('the renderer side is wired', () => {
  const useAudio = readFileSync(join(SRC, 'renderer/hooks/useAudio.ts'), 'utf8')
  const fn = useAudio.slice(useAudio.indexOf('function ipodPathToAudioURL('), useAudio.indexOf('// Module-level singleton so all components share the same Howl'))

  test('ipodPathToAudioURL puts the marker on every URL it builds, and nothing else in it changed', () => {
    assert.match(fn, /const url = withFileVersion\('ipod-audio:\/\/' \+ encodeURIComponent\(fsPath\), ipodPath\)/)
    assert.equal(fn.match(/ipod-audio:\/\//g)?.length, 1, 'one URL built, and it is the marked one')
    assert.match(useAudio, /import \{ withFileVersion \} from '\.\.\/audio\/audioUrlVersion'/)
  })

  test('both tag-write results reach the map (per edit, and the nightly check)', () => {
    const app = readFileSync(join(SRC, 'renderer/App.tsx'), 'utf8')
    assert.match(app, /if \(updates\.length\) dispatch\(\{ type: 'UPDATE_TRACKS', updates \}\)\s*\n\s*noteMeasuredVersions\(libTracksRef\.current, \[m\]\)/)
    assert.match(app, /noteMeasuredVersions\(libTracksRef\.current, measured\)/)
  })

  test('the seam scheduler reads the path without the marker (ffprobe gets a file, not "…m4a?v=…")', async () => {
    const seam = readFileSync(join(SRC, 'renderer/audio/seamScheduler.ts'), 'utf8')
    const body = seam.slice(seam.indexOf('function fsPathFromAudioUrl('), seam.indexOf('/** How far into this buffer'))
    const fsPathFromAudioUrl = new Function('url', body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'))) as (u: string) => string | null
    assert.equal(fsPathFromAudioUrl('ipod-audio://' + encodeURIComponent('/m/a?b.m4a') + '?v=abc-1'), '/m/a?b.m4a')
    assert.equal(fsPathFromAudioUrl('ipod-audio://' + encodeURIComponent('/m/a.m4a')), '/m/a.m4a')
  })
})
