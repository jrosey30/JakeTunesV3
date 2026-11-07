/**
 * scripts/concert/concert-posters.mts as a person runs it: a scratch --app-dir, the
 * real tools, no network (--no-web), no ssh (--audio-root). Skips where the tools are
 * missing (the CI Mac has no ffmpeg).
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const has = (cmd: string, args: string[]): boolean => {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true } catch { return false }
}
const skip = process.platform === 'darwin' && has('ffmpeg', ['-version']) && has('sips', ['--help']) ? false : 'needs macOS, ffmpeg and sips'

const REPO = join(import.meta.dirname, '..', '..', '..')
const ROOT = mkdtempSync(join(tmpdir(), 'concert-posters-cli-'))
after(() => rmSync(ROOT, { recursive: true, force: true }))
const md5 = (s: string): string => createHash('md5').update(s).digest('hex')

const SHOW = 'cameron winter|||live at carnegie hall'
const PICK = 'nirvana|||mtv unplugged in new york'

function makeApp(name: string): { app: string; review: string; audio: string } {
  const app = join(ROOT, name, 'app')
  const art = join(app, 'artwork')
  const audio = join(ROOT, name, 'audio')
  mkdirSync(art, { recursive: true })
  mkdirSync(join(audio, 'iPod_Control', 'Music'), { recursive: true })
  const jpg = (file: string, colour: string): void => {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=300x400`, '-frames:v', '1', file])
  }
  jpg(join(art, `${md5(SHOW)}.jpg`), '0x884422')
  jpg(join(art, `${md5(PICK)}.jpg`), '0x224488')
  writeFileSync(join(art, 'index.json'), JSON.stringify({ [SHOW]: `${md5(SHOW)}_1`, [PICK]: `${md5(PICK)}_1` }))
  writeFileSync(join(art, 'user-locked.json'), JSON.stringify([PICK]))
  const cue = (id: number, artist: string) => ({ trackId: id, title: 'Song', artist, startMs: 0, durationMs: 1000 })
  writeFileSync(join(app, 'live-sets.json'), JSON.stringify({
    [SHOW]: { mergedTrackId: 1, cues: [cue(11, 'Cameron Winter')], totalDurationMs: 1000, concert: { venue: 'Carnegie Hall', city: 'New York, NY', date: 'December 11, 2025' } },
    [PICK]: { mergedTrackId: 2, cues: [cue(21, 'Nirvana')], totalDurationMs: 1000, concert: { venue: 'Sony Music Studios' } },
  }, null, 2))
  writeFileSync(join(app, 'library.json'), JSON.stringify({ tracks: [
    { id: 1, artist: 'Cameron Winter', album: 'Live at Carnegie Hall (Live Set)', path: ':iPod_Control:Music:1.m4a' },
    { id: 11, artist: 'Cameron Winter', album: 'Live at Carnegie Hall', path: ':iPod_Control:Music:11.m4a' },
    { id: 2, artist: 'Nirvana', album: 'MTV Unplugged In New York (Live Set)', path: ':iPod_Control:Music:2.m4a' },
    { id: 21, artist: 'Nirvana', album: 'MTV Unplugged In New York', path: ':iPod_Control:Music:21.m4a' },
  ] }))
  return { app, review: join(ROOT, name, 'review'), audio }
}

function run(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/concert/concert-posters.mts', ...args], { cwd: REPO, encoding: 'utf-8' })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

describe('concert-posters.mts', { skip }, () => {
  test('a dry run prints the plan, changes nothing, and leaves the built poster for review', () => {
    const w = makeApp('dry')
    const before = readFileSync(join(w.app, 'live-sets.json'))
    const r = run(['migrate', '--app-dir', w.app, '--review-dir', w.review, '--audio-root', w.audio, '--no-web'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /DRY RUN/)
    assert.match(r.out, /"CAMERON WINTER" \/ "LIVE AT CARNEGIE HALL" \/ "NEW YORK, NY · 2025"/)
    assert.match(r.out, /no cover in the files or on the web/)
    assert.ok(readFileSync(join(w.app, 'live-sets.json')).equals(before))
    assert.ok(existsSync(join(w.review, 'built', 'cameron-winter-live-at-carnegie-hall.jpg')))
    assert.ok(!existsSync(join(w.app, 'backups')))
  })

  test('--apply on a scratch app dir does it, says how to undo it, and a second run does nothing', () => {
    const w = makeApp('apply')
    run(['migrate', '--app-dir', w.app, '--review-dir', w.review, '--audio-root', w.audio, '--no-web'])
    const first = run(['migrate', '--apply', '--app-dir', w.app, '--review-dir', w.review])
    assert.equal(first.code, 0, first.out)
    assert.match(first.out, /Backed up \d+ files/)
    assert.match(first.out, /A second plan finds nothing left to do/)
    assert.match(first.out, /migrate --restore/)
    assert.match(first.out, /jaketunes-homemini-sync\.sh --homemini-only/)
    const sets = JSON.parse(readFileSync(join(w.app, 'live-sets.json'), 'utf-8')) as Record<string, { concert: { posterSource?: string; poster?: string } }>
    assert.equal(sets[SHOW]!.concert.posterSource, 'built')
    assert.equal(sets[PICK]!.concert.posterSource, 'jake-pick')
    assert.ok(existsSync(join(w.app, 'artwork', `${sets[SHOW]!.concert.poster}.jpg`)))

    const second = run(['migrate', '--apply', '--app-dir', w.app, '--review-dir', w.review])
    assert.equal(second.code, 0, second.out)
    assert.match(second.out, /Nothing to do: no file was touched and no backup was made/)
  })

  test('--restore undoes a run', () => {
    const w = makeApp('restore')
    const before = readFileSync(join(w.app, 'live-sets.json'))
    run(['migrate', '--app-dir', w.app, '--review-dir', w.review, '--audio-root', w.audio, '--no-web'])
    const applied = run(['migrate', '--apply', '--app-dir', w.app, '--review-dir', w.review])
    const dir = /migrate --restore "([^"]+)"/.exec(applied.out)![1]!
    const r = run(['migrate', '--restore', dir, '--app-dir', w.app])
    assert.equal(r.code, 0, r.out)
    assert.ok(readFileSync(join(w.app, 'live-sets.json')).equals(before))
  })

  test('--apply refuses the rehearsal flags: only the real store can be applied to', () => {
    const w = makeApp('refuse')
    const r = run(['migrate', '--apply', '--app-dir', w.app, '--review-dir', w.review, '--images', '/some/copy'])
    assert.equal(r.code, 1)
    assert.match(r.out, /works on the real store only/)
  })

  test('build refuses a show with a real poster, and draws one for a show without', () => {
    const w = makeApp('build')
    const out = join(ROOT, 'build', 'poster.jpg')
    const made = run(['build', '--app-dir', w.app, '--album-key', SHOW, '--out', out])
    assert.equal(made.code, 0, made.out)
    assert.match(made.out, /Dry run: rendered/)
    assert.ok(existsSync(out))

    const installed = run(['build', '--app-dir', w.app, '--album-key', SHOW, '--apply'])
    assert.equal(installed.code, 0, installed.out)
    const again = run(['build', '--app-dir', w.app, '--album-key', SHOW, '--apply'])
    assert.equal(again.code, 1)
    assert.match(again.out, /already has its built poster/)

    const sets = JSON.parse(readFileSync(join(w.app, 'live-sets.json'), 'utf-8')) as Record<string, { concert: Record<string, unknown> }>
    sets[PICK]!.concert = { poster: 'abc', posterSource: 'jake-pick' }
    writeFileSync(join(w.app, 'live-sets.json'), JSON.stringify(sets))
    const pick = run(['build', '--app-dir', w.app, '--album-key', PICK, '--rebuild', '--apply'])
    assert.equal(pick.code, 1)
    assert.match(pick.out, /Jake's pick, always/)
  })
})
