/**
 * The poster maker's real pixels, with the real tools: osascript, ffmpeg and sips. On
 * a machine without them these skip (the CI Mac has no ffmpeg); the rule itself is
 * covered in concert-poster.test.ts.
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtPosterSpec, posterWords } from '../../common/concert-poster.ts'
import { imageSize, imageToJpeg, isJpegBytes, readEdgeMatte, renderBuiltPoster } from '../concert-poster-render.ts'
import { installPosterImage } from '../concert-poster.ts'

const has = (cmd: string, args: string[]): boolean => {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true } catch { return false }
}
const ready = process.platform === 'darwin' && has('ffmpeg', ['-version']) && has('sips', ['--help'])
const skip = ready ? false : 'needs macOS, ffmpeg and sips'

const DIR = mkdtempSync(join(tmpdir(), 'concert-poster-render-'))
after(() => rmSync(DIR, { recursive: true, force: true }))
const FONT = join(import.meta.dirname, '..', '..', 'renderer', 'assets', 'fonts', 'pixChicago.ttf')

/** A solid `size`×`size` PNG with a marker colour in each corner. */
function coverWithCorners(path: string, size: number): void {
  const b = Math.round(size / 10)
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x808080:s=${size}x${size}`, '-frames:v', '1',
    '-vf', [
      `drawbox=x=0:y=0:w=${b}:h=${b}:c=0xff0000:t=fill`,
      `drawbox=x=iw-${b}:y=0:w=${b}:h=${b}:c=0x00ff00:t=fill`,
      `drawbox=x=0:y=ih-${b}:w=${b}:h=${b}:c=0x0000ff:t=fill`,
      `drawbox=x=iw-${b}:y=ih-${b}:w=${b}:h=${b}:c=0xffff00:t=fill`,
    ].join(','), '-q:v', '1', path])
}

/** Decode a JPEG to RGB and read a pixel. */
function pixels(path: string): (x: number, y: number) => [number, number, number] {
  const size = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path]).toString()
  const w = Number(/pixelWidth:\s*(\d+)/.exec(size)![1])
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 })
  return (x, y) => {
    const i = (y * w + x) * 3
    return [raw[i]!, raw[i + 1]!, raw[i + 2]!]
  }
}
const near = (got: [number, number, number], want: [number, number, number], slack = 24): boolean =>
  got.every((v, i) => Math.abs(v - want[i]!) <= slack)

describe('a built poster, drawn', { skip }, () => {
  test('is a flat 961x1292 JPEG: the ground, the cover whole, one orange rule', async () => {
    const cover = join(DIR, 'cover.jpg')
    coverWithCorners(cover, 600)
    const out = join(DIR, 'geese.jpg')
    const spec = builtPosterSpec(posterWords({ band: 'Geese', show: 'Alive & In Person', venue: 'The Diamond Mine Recording Studio', city: 'Queens, NY', date: '2023 (exact date not published)' }))
    const r = await renderBuiltPoster({ spec, coverPath: cover, outPath: out, fontPath: FONT })
    assert.ok(isJpegBytes(readFileSync(out)))
    assert.deepEqual(await imageSize(out), { w: 961, h: 1292 })
    const at = pixels(out)
    assert.ok(near(at(5, 5), [0x0b, 0x0b, 0x0a], 6), `ground ${at(5, 5)}`)
    assert.ok(near(at(955, 1285), [0x0b, 0x0b, 0x0a], 6), `ground ${at(955, 1285)}`)
    // Whole, never cropped: all four corner markers survive, where the drawing says.
    const c = r.cover!
    assert.ok(c.w === c.h, 'a square cover stays square')
    const inset = Math.round(c.w / 40)
    assert.ok(near(at(c.x + inset, c.y + inset), [255, 0, 0]), `top-left ${at(c.x + inset, c.y + inset)}`)
    assert.ok(near(at(c.x + c.w - inset, c.y + inset), [0, 255, 0]), `top-right ${at(c.x + c.w - inset, c.y + inset)}`)
    assert.ok(near(at(c.x + inset, c.y + c.h - inset), [0, 0, 255]), `bottom-left ${at(c.x + inset, c.y + c.h - inset)}`)
    assert.ok(near(at(c.x + c.w - inset, c.y + c.h - inset), [255, 255, 0]), `bottom-right ${at(c.x + c.w - inset, c.y + c.h - inset)}`)
    // The rule, just under the cover at the left margin: the logo orange.
    const ruleY = c.y + c.h + spec.rule.gap + Math.floor(spec.rule.h / 2)
    assert.ok(near(at(spec.pad.left + 20, ruleY), [0xfd, 0x56, 0x01], 30), `rule ${at(spec.pad.left + 20, ruleY)}`)
    // The details break between facts, never leaving a separator to start a line.
    assert.deepEqual(r.printed, ['ALIVE & IN PERSON', 'THE DIAMOND MINE · QUEENS, NY', '2023'])
  })

  test('a long name never clips: the size comes down until its longest word fits', async () => {
    const out = join(DIR, 'long.jpg')
    const spec = builtPosterSpec(posterWords({ band: 'Godspeedyoublackemperorandfriends', show: 'S' }))
    const r = await renderBuiltPoster({ spec, coverPath: null, outPath: out, fontPath: FONT })
    assert.ok(r.bandSize < spec.band.size, `${r.bandSize} should be under ${spec.band.size}`)
  })

  test('no cover is still a poster, not a failure', async () => {
    const out = join(DIR, 'nocover.jpg')
    const r = await renderBuiltPoster({ spec: builtPosterSpec({ band: 'B', title: 'T', details: [] }), coverPath: null, outPath: out, fontPath: FONT })
    assert.equal(r.cover, null)
    assert.deepEqual(await imageSize(out), { w: 961, h: 1292 })
  })

  test('a cover that will not decode fails loudly instead of printing a hole', async () => {
    const bad = join(DIR, 'bad.jpg')
    writeFileSync(bad, 'this is not an image')
    await assert.rejects(renderBuiltPoster({ spec: builtPosterSpec({ band: 'B', title: 'T', details: [] }), coverPath: bad, outPath: join(DIR, 'x.jpg'), fontPath: FONT }))
  })

  test('with no font file it falls back to a bold system face instead of failing', async () => {
    const out = join(DIR, 'nofont.jpg')
    await renderBuiltPoster({ spec: builtPosterSpec({ band: 'B', title: 'T', details: [] }), coverPath: null, outPath: out, fontPath: null })
    assert.deepEqual(await imageSize(out), { w: 961, h: 1292 })
  })
})

describe('the matte, from a real file', { skip }, () => {
  test('reads the poster\'s edge', async () => {
    const f = join(DIR, 'yellow.jpg')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xdfcd46:s=300x400', '-frames:v', '1', '-q:v', '1', f])
    const matte = await readEdgeMatte(f)
    const [r, g, b] = [matte.slice(1, 3), matte.slice(3, 5), matte.slice(5, 7)].map((h) => parseInt(h, 16))
    assert.ok(near([r!, g!, b!], [0xdf, 0xcd, 0x46], 6), matte)
  })
})

describe('putting an image in the store', { skip }, () => {
  test('a JPEG goes in byte for byte: a poster is never re-encoded', async () => {
    const src = join(DIR, 'poster.jpg')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x112233:s=300x400', '-frames:v', '1', src])
    const dest = join(DIR, 'copy.jpg')
    await imageToJpeg(src, dest)
    assert.ok(readFileSync(src).equals(readFileSync(dest)))
  })
  test('anything else becomes a JPEG', async () => {
    const src = join(DIR, 'poster.png')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x112233:s=300x400', '-frames:v', '1', src])
    const dest = join(DIR, 'fromPng.jpg')
    await imageToJpeg(src, dest)
    assert.ok(isJpegBytes(readFileSync(dest)))
  })
  test('install measures the matte and records the source', async () => {
    const src = join(DIR, 'pick.jpg')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x204060:s=300x400', '-frames:v', '1', '-q:v', '1', src])
    const artworkDir = join(DIR, 'store')
    const got = await installPosterImage({ artworkDir, albumKey: 'a|||b', imagePath: src, source: 'jake-pick', now: 1234 })
    assert.equal(got.key, 'concert poster|||a · b')
    assert.equal(got.versioned, `${got.hash}_1234`)
    assert.equal(got.aliasKey, 'a|||b (live set)')
    assert.equal(got.fields.posterSource, 'jake-pick')
    assert.equal(got.fields.poster, got.hash)
    assert.match(got.fields.posterMatte, /^#[0-9a-f]{6}$/)
    const meta = JSON.parse(readFileSync(join(artworkDir, `${got.hash}.meta.json`), 'utf-8')) as Record<string, unknown>
    assert.equal(meta.key, got.key, 'a replica merges the key from this sidecar')
    assert.equal(meta.posterSource, 'jake-pick')
    assert.equal(meta.albumKey, 'a|||b')
    assert.ok(readFileSync(src).equals(readFileSync(join(artworkDir, 'locked-backup', `${got.hash}.jpg`))), 'a lost poster comes back on the next launch')
  })
})
