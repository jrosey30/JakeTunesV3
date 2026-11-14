/**
 * The catalog writer at 5,000 songs (2026-11-13).
 *
 * Jake: "we will raise punkpod capacity to 5000 songs. it is 256 GB. lets use
 * it." Until now no iPod carried more than 1,000, so the writer
 * (core/db_reader.py write_itunesdb) had never been run past that. This runs
 * the real writer the way the sync does (the --write CLI, tracks on stdin) on
 * 5,000 fixture songs spread over F00..F49, and reads the file back with a
 * reader that shares no code with it: the walker below (TypeScript, written
 * from the iTunesDB layout: mhbd > mhsd > mhlt/mhlp > mhit/mhyp > mhod/mhip),
 * and the app's own plug-in reader (sync-engine/roundtrip.ts parseCatalogPaths).
 *
 * What must hold at 5,000, each a way a big catalog could go wrong:
 *   • every length field adds up (the file, each section, each record)
 *   • 5,000 song records, none lost, none twice, every title and path intact
 *   • 5,000 different record ids and 5,000 different 64-bit ids
 *   • the master playlist names all 5,000 once, by ids that exist
 *   • each Music-menu sort index is a full permutation of 0..4999
 *   • a 5,000-song playlist and a 3-song playlist both land whole
 *
 * Never reads or writes an iPod: a temp folder and a template built here.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPOD_LIST_MAX } from '../../common/ipod-list-doc.ts'
import { parseCatalogPaths } from '../sync-engine/roundtrip.ts'

const coreDir = join(import.meta.dirname, '../../../core')
const N = IPOD_LIST_MAX

/** A catalog with a song list and nothing in it: what a freshly wiped card has. */
function emptyTemplate(): Buffer {
  const mhlt = Buffer.alloc(92)
  mhlt.write('mhlt', 0, 'latin1'); mhlt.writeUInt32LE(92, 4); mhlt.writeUInt32LE(0, 8)
  const mhsd = Buffer.alloc(96)
  mhsd.write('mhsd', 0, 'latin1'); mhsd.writeUInt32LE(96, 4); mhsd.writeUInt32LE(96 + mhlt.length, 8); mhsd.writeUInt32LE(1, 12)
  const mhbd = Buffer.alloc(104)
  mhbd.write('mhbd', 0, 'latin1'); mhbd.writeUInt32LE(104, 4); mhbd.writeUInt32LE(104 + 96 + mhlt.length, 8); mhbd.writeUInt32LE(1, 20)
  return Buffer.concat([mhbd, mhsd, mhlt])
}

interface Fixture { id: number; title: string; artist: string; album: string; genre: string; path: string; duration: number; codec: string; fileSize: number; year: number; trackNumber: number }

function fixtures(n: number): Fixture[] {
  // Names that collide, sort oddly, and aren't ASCII: 250 artists, 20 songs each.
  const words = ['Ångström', 'the', 'Þorn', '!!!', 'Zed', 'alpha', '日本', 'Ébène', 'The The', '99']
  return Array.from({ length: n }, (_, i) => {
    const id = 100_000 + i
    const artist = `${words[i % words.length]} Band ${i % 250}`
    return {
      // Titles are plain ASCII: the writer folds what the mini's font can't draw (fold_for_ipod), on purpose.
      id, title: `Song ${String(i).padStart(4, '0')} ${['zulu', 'The', 'alpha', '99'][(i * 7) % 4]}`, artist,
      album: `Record ${i % 500}`, genre: ['Punk', 'Hardcore', 'Ska', 'Post-Punk'][i % 4],
      path: `:iPod_Control:Music:F${String(i % 50).padStart(2, '0')}:imported_${id}.m4a`,
      duration: 120_000 + (i % 200) * 1000, codec: 'alac', fileSize: 20_000_000 + i, year: 1977 + (i % 40), trackNumber: 1 + (i % 12),
    }
  })
}

const tag = (b: Buffer, p: number): string => b.toString('latin1', p, p + 4)
const u32 = (b: Buffer, p: number): number => b.readUInt32LE(p)

interface ReadSong { recordId: number; dbid: bigint; fileSize: number; title: string; path: string }
interface ReadPlaylist { master: boolean; name: string; trackRefs: number[]; sortIndexes: Map<number, number[]> }
interface ReadCatalog { songs: ReadSong[]; playlistSections: ReadPlaylist[][] }

/** A string child (mhod types under 15): UTF-16LE, length at +28, text at +40. */
function mhodString(b: Buffer, p: number): string {
  return b.toString('utf16le', p + 40, p + 40 + u32(b, p + 28))
}

/** Walk the whole file by its own length fields; every step is checked against the bytes. */
function readCatalog(b: Buffer): ReadCatalog {
  assert.equal(tag(b, 0), 'mhbd')
  assert.equal(u32(b, 8), b.length, 'the file is as long as its header says')
  const out: ReadCatalog = { songs: [], playlistSections: [] }
  let pos = u32(b, 4)
  const sections = u32(b, 20)
  for (let s = 0; s < sections; s++) {
    assert.equal(tag(b, pos), 'mhsd', `section ${s} starts where the last one ended`)
    const end = pos + u32(b, pos + 8)
    assert.ok(end <= b.length, `section ${s} ends inside the file`)
    const type = u32(b, pos + 12)
    const list = pos + u32(b, pos + 4)
    if (type === 1) {
      assert.equal(tag(b, list), 'mhlt')
      let p = list + u32(b, list + 4)
      for (let i = 0; i < u32(b, list + 8); i++) {
        assert.equal(tag(b, p), 'mhit', `song record ${i}`)
        const song: ReadSong = { recordId: u32(b, p + 0x10), dbid: b.readBigUInt64LE(p + 0x70), fileSize: u32(b, p + 0x24), title: '', path: '' }
        let m = p + u32(b, p + 4)
        for (let k = 0; k < u32(b, p + 12); k++) {
          assert.equal(tag(b, m), 'mhod', `song record ${i}, child ${k}`)
          const kind = u32(b, m + 12)
          if (kind === 1) song.title = mhodString(b, m)
          if (kind === 2) song.path = mhodString(b, m)
          m += u32(b, m + 8)
        }
        assert.equal(m, p + u32(b, p + 8), `song record ${i} is as long as it says`)
        out.songs.push(song)
        p = m
      }
      assert.equal(p, end, 'the song list fills its section exactly')
    } else if (type === 2 || type === 3) {
      assert.equal(tag(b, list), 'mhlp')
      const playlists: ReadPlaylist[] = []
      let p = list + u32(b, list + 4)
      for (let i = 0; i < u32(b, list + 8); i++) {
        assert.equal(tag(b, p), 'mhyp', `playlist ${i}`)
        const pl: ReadPlaylist = { master: u32(b, p + 0x14) !== 0, name: '', trackRefs: [], sortIndexes: new Map() }
        let c = p + u32(b, p + 4)
        for (let k = 0; k < u32(b, p + 0x0c); k++) {
          assert.equal(tag(b, c), 'mhod', `playlist ${i}, child ${k}`)
          const kind = u32(b, c + 12)
          if (kind === 1) pl.name = mhodString(b, c)
          if (kind === 52) {
            // Library index: which menu at +24, how many at +28, the positions from +72.
            const count = u32(b, c + 28)
            pl.sortIndexes.set(u32(b, c + 24), Array.from({ length: count }, (_, j) => u32(b, c + 72 + j * 4)))
            assert.ok(72 + count * 4 <= u32(b, c + 8), 'a sort index fits inside its record')
          }
          c += u32(b, c + 8)
        }
        for (let k = 0; k < u32(b, p + 0x10); k++) {
          assert.equal(tag(b, c), 'mhip', `playlist ${i}, entry ${k}`)
          pl.trackRefs.push(u32(b, c + 0x18))
          c += u32(b, c + 8)
        }
        assert.equal(c, p + u32(b, p + 8), `playlist ${i} is as long as it says`)
        playlists.push(pl)
        p = c
      }
      assert.equal(p, end, 'the playlists fill their section exactly')
      out.playlistSections.push(playlists)
    }
    pos = end
  }
  assert.equal(pos, b.length, 'the sections fill the file exactly')
  return out
}

test(`the catalog writer at ${N.toLocaleString('en-US')} songs: written by the sync's writer, read back whole by an independent reader`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jt-db-5000-'))
  try {
    const songs = fixtures(N)
    const template = join(dir, 'template')
    const outPath = join(dir, 'iTunesDB')
    writeFileSync(template, emptyTemplate())
    const playlists = [
      { name: 'punkPod', trackIds: songs.map((t) => t.id) },
      { name: 'Three', trackIds: [songs[0].id, songs[2500].id, songs[N - 1].id] },
    ]
    const started = Date.now()
    const run = spawnSync('python3', [join(coreDir, 'db_reader.py'), '--write', outPath, '--template', template, '--ipod-root', dir], {
      input: JSON.stringify({ tracks: songs, playlists, masterName: 'punkPod' }),
      encoding: 'utf-8', env: { ...process.env, HOME: dir }, maxBuffer: 64 * 1024 * 1024,
    })
    const tookMs = Date.now() - started
    assert.equal(run.status, 0, run.stderr?.slice(-2000))
    assert.deepEqual(JSON.parse(run.stdout), { ok: true, count: N })

    const bytes = readFileSync(outPath)
    const db = readCatalog(bytes)

    // Every song once, intact.
    assert.equal(db.songs.length, N)
    assert.deepEqual(db.songs.map((s) => s.path).sort(), songs.map((s) => s.path).sort())
    const titleByPath = new Map(songs.map((s) => [s.path, s.title]))
    const sizeByPath = new Map(songs.map((s) => [s.path, s.fileSize]))
    for (const s of db.songs) {
      assert.equal(s.title, titleByPath.get(s.path), s.path)
      assert.equal(s.fileSize, sizeByPath.get(s.path), s.path)
    }
    // Ids: all different, none zero.
    assert.equal(new Set(db.songs.map((s) => s.recordId)).size, N)
    assert.equal(new Set(db.songs.map((s) => s.dbid)).size, N)
    assert.ok(db.songs.every((s) => s.recordId !== 0 && s.dbid !== 0n))

    // The app's own plug-in reader agrees, record for record.
    assert.deepEqual(parseCatalogPaths(bytes), db.songs.map((s) => s.path))

    // Playlists: the master names every song once; the sort indexes are whole.
    assert.ok(db.playlistSections.length >= 1)
    const recordIds = new Set(db.songs.map((s) => s.recordId))
    const idOfPath = new Map(db.songs.map((s) => [s.path, s.recordId]))
    for (const section of db.playlistSections) {
      const master = section.filter((p) => p.master)
      assert.equal(master.length, 1)
      assert.equal(master[0].name, 'punkPod')
      assert.equal(master[0].trackRefs.length, N)
      assert.equal(new Set(master[0].trackRefs).size, N)
      assert.ok(master[0].trackRefs.every((r) => recordIds.has(r)))
      assert.ok(master[0].sortIndexes.size >= 4, 'Songs, Albums, Artists and Genres each have an index')
      for (const [menu, index] of master[0].sortIndexes) {
        assert.equal(index.length, N, `menu ${menu}`)
        const seen = new Uint8Array(N)
        for (const at of index) { assert.ok(at < N, `menu ${menu}: ${at}`); seen[at] = 1 }
        assert.equal(seen.reduce((a, v) => a + v, 0), N, `menu ${menu} names every song once`)
      }
      const list = section.find((p) => !p.master && p.name === 'punkPod')
      assert.ok(list, 'the 5,000-song playlist is there')
      assert.deepEqual(list.trackRefs, songs.map((s) => idOfPath.get(s.path)), 'in list order')
      const three = section.find((p) => p.name === 'Three')
      assert.deepEqual(three?.trackRefs, [songs[0], songs[2500], songs[N - 1]].map((s) => idOfPath.get(s.path)))
    }

    // What the iPod has to hold in its 32 MB: well under it.
    const mb = bytes.length / (1024 * 1024)
    console.log(`  catalog at ${N} songs: ${mb.toFixed(1)} MB, written in ${(tookMs / 1000).toFixed(1)} s`)
    assert.ok(mb < 16, `the catalog is ${mb.toFixed(1)} MB`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
