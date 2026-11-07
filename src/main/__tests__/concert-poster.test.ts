/**
 * The poster rule's words, frame and matte (src/common/concert-poster.ts), and the
 * wiring that keeps a poster off the album's key. The expected words are the ones in
 * the Posters mock Jake approved on 2026-11-06.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  builtPosterSpec, edgeMatte, isMatteColour, isPosterSource, mergedAlbumArtworkKey, POSTER_FRAME_H, POSTER_FRAME_W, POSTER_GROUND,
  posterArtworkKey, posterMatte, posterTitle, posterWords, showKeyOfMergedAlbumKey, titleNamesVenue,
} from '../../common/concert-poster.ts'
import { coverFileName, md5Hex, posterArtworkHash, withPosterKeys } from '../concert-poster.ts'

const SRC = join(import.meta.dirname, '..', '..')
const read = (p: string): string => readFileSync(join(SRC, p), 'utf-8')

describe('the one frame', () => {
  test('is the 961:1292 of the real Forest Hills poster', () => {
    assert.equal(POSTER_FRAME_W, 961)
    assert.equal(POSTER_FRAME_H, 1292)
  })
  test('a show with a measured matte uses it; anything else is the ground', () => {
    assert.equal(posterMatte({ posterMatte: '#dfcd46' }), '#dfcd46')
    assert.equal(posterMatte({ posterMatte: 'yellow' }), POSTER_GROUND)
    assert.equal(posterMatte({}), POSTER_GROUND)
    assert.equal(posterMatte(undefined), POSTER_GROUND)
  })
  test('only the four sources exist', () => {
    for (const s of ['jake-pick', 'gig-poster', 'film-one-sheet', 'built']) assert.ok(isPosterSource(s))
    assert.ok(!isPosterSource('ai-art'))
    assert.ok(!isPosterSource(undefined))
    assert.ok(isMatteColour('#0B0B0A'))
    assert.ok(!isMatteColour('#0B0B0'))
  })
})

describe('a poster has its own artwork key, never the album\'s', () => {
  const ALBUM = 'nirvana|||mtv unplugged in new york'
  test('the key names the show, with exactly one separator like every other key', () => {
    assert.equal(posterArtworkKey(ALBUM), 'concert poster|||nirvana · mtv unplugged in new york')
    assert.equal(posterArtworkKey(ALBUM).split('|||').length, 2, 'code across the app splits artwork keys on |||')
  })
  test('its file is a different file from the album\'s', () => {
    assert.notEqual(posterArtworkHash(ALBUM), md5Hex(ALBUM))
    assert.equal(posterArtworkHash(ALBUM), md5Hex(posterArtworkKey(ALBUM)))
    assert.match(posterArtworkHash(ALBUM), /^[0-9a-f]{32}$/, 'GET /artwork/:hash takes a bare md5')
  })
  test('the merged row\'s key points at the poster, and leads back to the show', () => {
    assert.equal(mergedAlbumArtworkKey(ALBUM), `${ALBUM} (live set)`)
    assert.equal(showKeyOfMergedAlbumKey(`${ALBUM} (live set)`), ALBUM)
    assert.equal(showKeyOfMergedAlbumKey(ALBUM), null)
  })
  test('withPosterKeys sets the poster and the merged row and leaves the album alone', () => {
    const before = { [ALBUM]: 'cover_1' }
    const after = withPosterKeys(before, { key: posterArtworkKey(ALBUM), aliasKey: mergedAlbumArtworkKey(ALBUM), versioned: 'p_2' })
    assert.equal(after[ALBUM], 'cover_1')
    assert.equal(after[posterArtworkKey(ALBUM)], 'p_2')
    assert.equal(after[mergedAlbumArtworkKey(ALBUM)], 'p_2')
    assert.deepEqual(before, { [ALBUM]: 'cover_1' }, 'the caller\'s index is not mutated')
  })
  test('a cover file name drops the version', () => {
    assert.equal(coverFileName('abc_1791593715538'), 'abc.jpg')
    assert.equal(coverFileName('abc'), 'abc.jpg')
    assert.equal(coverFileName(undefined), null)
  })
})

describe('a poster\'s own edge colour', () => {
  /** w×h pixels of `fill`, then `paint` over them. */
  function image(w: number, h: number, fill: [number, number, number], paint?: (x: number, y: number) => [number, number, number] | null): Uint8Array {
    const out = new Uint8Array(w * h * 3)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = paint?.(x, y) ?? fill
      out.set(c, (y * w + x) * 3)
    }
    return out
  }
  test('a plain border is that colour', () => {
    assert.equal(edgeMatte(image(40, 60, [0xdf, 0xcd, 0x46]), 40, 60), '#dfcd46')
  })
  test('the middle of the poster has no say', () => {
    const img = image(40, 60, [10, 20, 30], (x, y) => (x > 3 && x < 36 && y > 3 && y < 56 ? [255, 255, 255] : null))
    assert.equal(edgeMatte(img, 40, 60), '#0a141e')
  })
  test('a median: the Geese poster\'s black top strip loses to the yellow on the other three sides', () => {
    const img = image(100, 134, [0xdf, 0xcd, 0x46], (_x, y) => (y < 2 ? [0x10, 0x10, 0x10] : null))
    assert.equal(edgeMatte(img, 100, 134), '#dfcd46', 'a mean would have read a muddy #9c923d (measured on the real poster)')
  })
  test('refuses bytes that are not the size it was told', () => {
    assert.throws(() => edgeMatte(new Uint8Array(5), 40, 60))
  })
})

describe('the built poster\'s words (the Posters mock)', () => {
  test('Cameron Winter: the title has the venue, so it is not repeated', () => {
    const w = posterWords({ band: 'Cameron Winter', show: 'Live at Carnegie Hall', venue: 'Carnegie Hall', city: 'New York, NY', date: 'December 11, 2025', year: 2026 })
    assert.deepEqual(w, { band: 'Cameron Winter', title: 'Live at Carnegie Hall', details: ['New York, NY', '2025'] })
  })
  test('Geese: no venue in the title, so it prints, without "Recording Studio", and the date\'s note goes', () => {
    const w = posterWords({ band: 'Geese', show: 'Alive & In Person', venue: 'The Diamond Mine Recording Studio', city: 'Queens, NY', date: '2023 (exact date not published)', year: 2024 })
    assert.deepEqual(w, { band: 'Geese', title: 'Alive & In Person', details: ['The Diamond Mine', 'Queens, NY', '2023'] })
  })
  test('Queens of the Stone Age: "Catacombs" is the venue\'s name once its city is set aside', () => {
    const w = posterWords({ band: 'Queens of the Stone Age', show: 'Alive in the Catacombs', venue: 'The Catacombs of Paris', city: 'Paris, France', date: 'July 2024', year: 2025 })
    assert.deepEqual(w, { band: 'Queens of the Stone Age', title: 'Alive in the Catacombs', details: ['Paris, France', '2024'] })
  })
  test('the show\'s own year wins; the release year only stands in when the date has none', () => {
    assert.deepEqual(posterWords({ band: 'B', show: 'S', year: 1999 }).details, ['1999'])
    assert.deepEqual(posterWords({ band: 'B', show: 'S', date: 'June 1, 2001', year: 1999 }).details, ['2001'])
  })
  test('nothing is invented: a show with no facts prints only its band and title', () => {
    assert.deepEqual(posterWords({ band: 'B', show: 'S' }), { band: 'B', title: 'S', details: [] })
  })
  test('a live tag on the title goes, the words of the title stay', () => {
    assert.equal(posterTitle('Getting Killed Again (Live at Forest Hills, New York, Oct 3rd, 2026)'), 'Getting Killed Again')
    assert.equal(posterTitle("All The World's A Stage [Live]"), "All The World's A Stage")
    assert.equal(posterTitle('Alive 2007 (Live Set)'), 'Alive 2007')
    assert.equal(posterTitle('Live at Carnegie Hall'), 'Live at Carnegie Hall')
    assert.equal(posterTitle('Stop Making Sense'), 'Stop Making Sense')
  })
  test('a generic word alone does not name a venue', () => {
    assert.equal(titleNamesVenue('The Hall of Mirrors', 'Albert Hall'), false)
    assert.equal(titleNamesVenue('A Night at the Stadium', 'The Stadium'), false)
    assert.equal(titleNamesVenue('Live at Forest Hills', 'Forest Hills Stadium'), true)
  })
})

describe('the built poster\'s drawing', () => {
  const spec = builtPosterSpec({ band: 'Geese', title: 'Alive & In Person', details: ['Queens, NY', '2023'] })
  test('is the frame, on the ground, with one orange rule', () => {
    assert.equal(spec.w, 961)
    assert.equal(spec.h, 1292)
    assert.equal(spec.ground, '#0B0B0A')
    assert.equal(spec.rule.color, '#FD5601')
  })
  test('is the mock\'s 170-wide drawing at 961', () => {
    const k = 961 / 170
    assert.equal(spec.band.size, Math.round(16 * k))
    assert.equal(spec.band.lineHeight, Math.round(19 * k))
    assert.equal(spec.pad.top, Math.round(11 * k))
    assert.equal(spec.pad.left, Math.round(12 * k))
    assert.equal(spec.rule.w, Math.round(22 * k))
    assert.equal(spec.rule.h, Math.round(2 * k))
    assert.equal(spec.lines.size, Math.round(8 * k))
  })
  test('prints in capitals, like the mock\'s text-transform', () => {
    assert.equal(spec.band.text, 'GEESE')
    assert.equal(spec.lines.title, 'ALIVE & IN PERSON')
    assert.deepEqual(spec.lines.details, ['QUEENS, NY', '2023'])
  })
})

describe('the wiring', () => {
  test('dropping a poster on the concert page never touches the album\'s key', () => {
    const page = read('renderer/views/ConcertDetailView.tsx')
    assert.match(page, /window\.electronAPI\.setConcertPoster\(albumKey, path\)/)
    assert.doesNotMatch(page, /setCustomArtwork/, 'this call is what replaced Unplugged\'s cover with its poster')
  })
  test('the tile has one frame and no threshold', () => {
    const tile = read('renderer/components/ConcertPosterTile.tsx')
    assert.doesNotMatch(tile, /naturalWidth|POSTER_MIN_RATIO|1\.15|aspectRatio/, 'no measuring: one frame fits every poster')
    assert.match(tile, /fullSet \?/)
  })
  test('the frame is 961:1292, the poster whole, on every desktop surface', () => {
    const css = read('renderer/styles/concert-stage.css')
    const rule = (sel: string): string => new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    for (const frame of ['.cd-poster', '.concert-row-art', '.concert-tile-poster']) {
      assert.match(rule(frame), /aspect-ratio:\s*961 \/ 1292/, frame)
    }
    for (const img of ['.cd-poster-img', '.concert-row-img', '.concert-tile-poster-img', '.concert-tile-made-img']) {
      assert.match(rule(img), /object-fit:\s*contain/, `${img} is whole, never cropped`)
    }
  })
  test('the matte is the show\'s own on the concert page and the list', () => {
    assert.match(read('renderer/views/ConcertDetailView.tsx'), /style=\{\{ background: posterMatte\(c\) \}\}/)
    assert.match(read('renderer/views/ConcertsView.tsx'), /style=\{\{ background: posterMatte\(c\.entry\.concert\) \}\}/)
    assert.match(read('renderer/views/ArtistDetailView.tsx'), /matte=\{tile\.concert\.posterMatte\}/)
  })
  test('declaring a show makes its poster, and that never fails the declare', () => {
    const declare = read('renderer/liveSetDeclare.ts')
    assert.match(declare, /ensureConcertPoster\(album\.albumKey/)
    assert.match(declare, /updateConcertMeta\(album\.albumKey, made\.fields\)/)
    const at = declare.indexOf('ensureConcertPoster')
    assert.ok(declare.lastIndexOf('try {', at) > declare.indexOf('registerLiveSet(album.albumKey'), 'its own try, after the show is registered')
  })
  test('the renderer, the preload and main agree on the two channels', () => {
    const preload = read('preload/index.ts')
    const ipc = read('main/ipc/live-sets-ipc.ts')
    for (const channel of ['set-concert-poster', 'ensure-concert-poster']) {
      assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel}'`))
      assert.match(ipc, new RegExp(`ipc\\.handle\\('${channel}'`))
    }
    assert.match(read('renderer/types.ts'), /setConcertPoster:/)
    assert.match(read('renderer/types.ts'), /ensureConcertPoster:/)
  })
  test('a replica refuses: the next pull from the laptop would undo it', () => {
    const ipc = read('main/ipc/live-sets-ipc.ts')
    const start = ipc.indexOf("ipc.handle('set-concert-poster'")
    assert.match(ipc.slice(start, start + 200), /isReplica\(\)/)
    const ensure = ipc.indexOf("ipc.handle('ensure-concert-poster'")
    assert.match(ipc.slice(ensure, ensure + 500), /isReplica\(\)/)
  })
  test('art dropped on a playing concert is the show\'s poster, not a second image', () => {
    const art = read('main/ipc/artwork-ipc.ts')
    assert.match(art, /showKeyOfMergedAlbumKey\(key\)/)
    assert.match(art, /installPosterImage\(\{ artworkDir: dir, albumKey: showKey, imagePath, source: 'jake-pick' \}\)/)
  })
  test('changing an album\'s cover leaves the show\'s poster alone', () => {
    assert.match(read('main/ipc/artwork-ipc.ts'), /if \(index\[aliasKey\] && !\(await host\.liveSetsCache\.get\(\)\)\[key\]\?\.concert\?\.poster\) index\[aliasKey\] = versionedHash/)
  })
  test('the packaged app carries pixChicago as a real file: osascript cannot read inside the asar', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf-8')) as { build: { extraResources: Array<{ from: string; to: string }> } }
    assert.ok(pkg.build.extraResources.some((r) => r.from === 'src/renderer/assets/fonts/pixChicago.ttf' && r.to === 'fonts/pixChicago.ttf'))
    assert.match(read('main/ipc/live-sets-ipc.ts'), /join\(process\.resourcesPath, 'fonts', 'pixChicago\.ttf'\)/)
  })
})
