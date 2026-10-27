/**
 * album-art:// (album-art-serve.ts) — including the regression for the
 * workmini Live Concerts page, 2026-10-19: Nirvana x2, Rush, Talking Heads and
 * Led Zeppelin rows "don't look right" while the now-playing art for the same
 * show was right. Harness-proven cause: the SAME hash at two tiers. The rows
 * draw `?s=320` thumbs; workmini's were generated Jul 10 from the covers the
 * posters replaced Sep 2, and the handler served any thumb that existed. After
 * the thumbs were deleted, nothing regenerated because Chromium never asked
 * again (immutable image, same URL) — the r= revision is the renderer's fix.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAlbumArtServer, parseAlbumArtUrl, pregenerateThumbs, type MakeThumb } from '../album-art-serve.ts'
import { albumArtUrl, artRevision, bumpArtRevisions } from '../../renderer/artRevision.ts'

const RUSH = '6d1e807b3183a35fba8cce9fff2a1054'
const RUSH_V = `${RUSH}_1788390804464`
const makeThumb: MakeThumb = (full, width) => (full.toString().startsWith('CMYK') ? null : Buffer.from(`thumb${width}<${full.toString()}>`))

async function store(): Promise<{ dir: string; thumbs: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'album-art-'))
  const thumbs = join(dir, 'thumbs')
  await mkdir(thumbs, { recursive: true })
  return { dir, thumbs }
}

function server(dir: string) {
  const cache = new Map<string, ArrayBuffer>()
  const handler = createAlbumArtServer({
    artworkDir: () => dir,
    getCached: (k) => cache.get(k),
    putCached: (k, b) => { cache.set(k, b) },
    makeThumb,
    log: () => {},
  })
  const get = async (url: string) => {
    const res = await handler(new Request(url))
    return { status: res.status, source: res.headers.get('x-art-source'), body: Buffer.from(await res.arrayBuffer()).toString() }
  }
  return { get, cache }
}

/** The handler persists a built thumb with a fire-and-forget writeAtomic;
 *  wait for that rename to land before touching the thumb (bounded, ~2 s). */
async function thumbLanded(path: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    try { await stat(path); return } catch { await new Promise((r) => setTimeout(r, 5)) }
  }
  throw new Error(`thumb never landed: ${path}`)
}

const JUL10 = new Date('2026-07-10T12:00:00Z')

describe('album-art:// URL parsing', () => {
  it('strips the version, reads s=, ignores r=, refuses paths', () => {
    assert.deepEqual(parseAlbumArtUrl(`album-art://${RUSH_V}.jpg?s=320`), { hash: RUSH, size: 320, cacheKey: `${RUSH}@320` })
    assert.deepEqual(parseAlbumArtUrl(`album-art://${RUSH_V}.jpg?s=320&r=3`), { hash: RUSH, size: 320, cacheKey: `${RUSH}@320` })
    assert.deepEqual(parseAlbumArtUrl(`album-art://${RUSH}.jpg?r=1`), { hash: RUSH, size: 0, cacheKey: RUSH })
    assert.equal(parseAlbumArtUrl('album-art://..%2F..%2Fsecret.jpg'), null)
  })
})

describe('the Concerts-page discrepancy (workmini, 2026-10-19)', () => {
  it('the row tier never serves a thumb older than its art; the now-playing tier serves the art', async () => {
    const { dir, thumbs } = await store()
    // Jul 10: thumb generated from the old album cover…
    await writeFile(join(thumbs, `${RUSH}_320.jpg`), 'thumb320<old-album-cover>')
    await utimes(join(thumbs, `${RUSH}_320.jpg`), JUL10, JUL10)
    // …Sep 2 the concert poster replaced the art (arrives here later by copy).
    await writeFile(join(dir, `${RUSH}.jpg`), 'massey-hall-poster')
    const { get } = server(dir)
    const nowPlaying = await get(`album-art://${RUSH_V}.jpg`)
    assert.equal(nowPlaying.body, 'massey-hall-poster')
    const row = await get(`album-art://${RUSH_V}.jpg?s=320`)
    assert.equal(row.body, 'thumb320<massey-hall-poster>', 'the row draws the poster, not the Jul 10 cover (mutation: serve-if-exists fails here)')
    assert.equal(row.source, 'thumb-built')
    // Rebuilt atomically on disk; the next cold read uses it.
    await new Promise((r) => setTimeout(r, 30))
    assert.equal((await readFile(join(thumbs, `${RUSH}_320.jpg`))).toString(), 'thumb320<massey-hall-poster>')
    assert.deepEqual((await readdir(thumbs)).filter((f) => f.endsWith('.tmp')), [])
    const fresh = await server(dir).get(`album-art://${RUSH_V}.jpg?s=320`)
    assert.equal(fresh.source, 'thumb')
  })

  it('a replaced jpg must be invalidated in the byte cache: the cache answers before the disk', async () => {
    const { dir, thumbs } = await store()
    await writeFile(join(dir, `${RUSH}.jpg`), 'poster-v1')
    const s = server(dir)
    assert.equal((await s.get(`album-art://${RUSH_V}.jpg?s=320`)).body, 'thumb320<poster-v1>')
    // The v1 thumb lands in the background: let it, then backdate it before v2
    // is written. Otherwise it can land AFTER v2 (or share v2's mtime tick on a
    // fast CI disk) and thumbIsFresh's `>=` hands the v1 thumb back (PR #267 CI).
    await thumbLanded(join(thumbs, `${RUSH}_320.jpg`))
    await utimes(join(thumbs, `${RUSH}_320.jpg`), JUL10, JUL10)
    await writeFile(join(dir, `${RUSH}.jpg`), 'poster-v2')
    const cached = await s.get(`album-art://${RUSH_V}.jpg?s=320&r=1`)
    assert.equal(cached.source, 'memory', 'without invalidation the old bytes keep coming (why the mirror calls invalidateArtBytes)')
    for (const k of [...s.cache.keys()]) if (k.startsWith(RUSH)) s.cache.delete(k)
    assert.equal((await s.get(`album-art://${RUSH_V}.jpg?s=320&r=1`)).body, 'thumb320<poster-v2>')
  })

  it('a byte change under the same name gives the renderer a NEW url (Chromium keeps immutable images for the session)', () => {
    const before = albumArtUrl(RUSH_V, 320, artRevision(RUSH_V))
    assert.equal(before, `album-art://${RUSH_V}.jpg?s=320`)
    bumpArtRevisions([RUSH])
    const after = albumArtUrl(RUSH_V, 320, artRevision(RUSH_V))
    assert.notEqual(after, before)
    assert.equal(parseAlbumArtUrl(after)?.cacheKey, parseAlbumArtUrl(before)?.cacheKey, 'same file, same main-side cache key')
  })

  it('undecodable art (CMYK, an HTML page saved as .jpg) falls back to the original bytes, never a 404', async () => {
    const { dir } = await store()
    await writeFile(join(dir, `${RUSH}.jpg`), 'CMYK-jpeg')
    const row = await server(dir).get(`album-art://${RUSH}.jpg?s=320`)
    assert.equal(row.status, 200)
    assert.equal(row.source, 'full-fallback')
    assert.equal((await server(dir).get('album-art://ffffffffffffffffffffffffffffffff.jpg?s=320')).status, 404)
  })
})

describe('320px pregeneration', () => {
  it('builds missing AND stale thumbs, reports undecodable covers, and logs where main.log can see it', async () => {
    const { dir, thumbs } = await store()
    await writeFile(join(dir, `${RUSH}.jpg`), 'poster')
    await writeFile(join(thumbs, `${RUSH}_320.jpg`), 'old')
    await utimes(join(thumbs, `${RUSH}_320.jpg`), JUL10, JUL10)               // stale
    await writeFile(join(dir, `${'a'.repeat(32)}.jpg`), 'cover')               // missing thumb
    await writeFile(join(dir, `${'c'.repeat(32)}.jpg`), 'CMYK')                // undecodable
    await writeFile(join(dir, `${'f'.repeat(32)}.jpg`), 'fresh')
    await writeFile(join(thumbs, `${'f'.repeat(32)}_320.jpg`), 'thumb320<fresh>')  // fresh: skipped
    const lines: string[] = []
    const r = await pregenerateThumbs({ artworkDir: () => dir, makeThumb, sleep: async () => {}, log: (m) => lines.push(m) })
    assert.deepEqual({ todo: r.todo, made: r.made, undecodable: r.undecodable }, { todo: 3, made: 2, undecodable: ['c'.repeat(32)] })
    assert.equal((await readFile(join(thumbs, `${RUSH}_320.jpg`))).toString(), 'thumb320<poster>')
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /\[art-thumbs\] built 2\/3 .* 1 cover\(s\) nativeImage can't decode/)
    // `only` = freshly mirrored art.
    const again = await pregenerateThumbs({ artworkDir: () => dir, makeThumb, sleep: async () => {}, log: () => {}, only: [RUSH] })
    assert.equal(again.todo, 0)
  })
})
