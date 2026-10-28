/**
 * The staged re-describe (scripts/brain-redescribe.mjs): a model upgrade
 * never touches the live descriptors until it has been scored and promoted,
 * and the yield rule tells music streams from the cable channels.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  musicStreamActive, untilMs, redescribeCandidates, candidateDescriptors, promoteNext,
} from '../../../scripts/brain-redescribe.mjs'

const CABLE = '/opt/homebrew/bin/ffmpeg -nostdin -hide_banner -loglevel warning -re -ss 0.33 -t 2518.15 -i /Volumes/JakeShared/Cable Library/The Outer Limits/ep.mp4 -vf scale=1920:1080:force_original_aspect_ratio=decrease -c:v h264_videotoolbox -f mpegts pipe:1'
const MUSIC = '/opt/homebrew/bin/ffmpeg -nostdin -hide_banner -loglevel error -i /Volumes/JakeShared/Music/a.flac -vn -c:a aac -b:a 256k -f adts pipe:1'

describe('the yield rule', () => {
  it('ignores the cable channels: six video ffmpegs are not music (10/27: pgrep -x ffmpeg was always true on homemini)', () => {
    const ps = ['COMMAND', '/sbin/launchd', CABLE, CABLE, CABLE, CABLE, CABLE, CABLE, 'node server.js'].join('\n')
    assert.equal(musicStreamActive(ps), false)
  })
  it('yields to a music transcode (-vn), even alongside the cable channels', () => {
    assert.equal(musicStreamActive([CABLE, MUSIC, CABLE].join('\n')), true)
  })
  it('treats an ffmpeg with neither -vn nor -vf as music (conservative)', () => {
    assert.equal(musicStreamActive('ffmpeg -i x.m4a -f wav pipe:1'), true)
  })
  it('does not mistake other processes that mention ffmpeg for one', () => {
    assert.equal(musicStreamActive('/usr/bin/grep ffmpeg\nnode /tmp/ffmpeg-watch.js'), false)
    assert.equal(musicStreamActive(''), false)
  })
})

describe('--until', () => {
  const at = (h: number, m: number) => { const d = new Date(2026, 9, 28, h, m, 0, 0); return d.getTime() }
  it('ends tonight\'s window later the same night', () => {
    assert.equal(untilMs('07:00', at(2, 30)), at(7, 0))
  })
  it('rolls to tomorrow once the time has passed', () => {
    assert.equal(untilMs('07:00', at(8, 0)), at(7, 0) + 24 * 3600 * 1000)
  })
  it('refuses a malformed time instead of running forever', () => {
    for (const bad of ['7', '25:00', '07:60', '', 'seven']) assert.throws(() => untilMs(bad, at(2, 0)))
  })
})

describe('what still needs the new model', () => {
  const tracks = [
    { id: 1, artist: 'A', title: 'a' }, { id: 2, artist: 'B', title: 'b' },
    { id: 3, artist: 'C', title: 'c' }, { id: 4, artist: '', title: '' },
  ]
  it('skips tracks already described by the model, live or staged, and nameless rows', () => {
    const desc = { 1: { d: 'x', gm: 'gemma4:12b' }, 2: { d: 'y', gm: 'gemma3:4b' }, 3: { d: 'z' } }
    const next = { 2: { d: 'y2', gm: 'gemma4:12b' } }
    assert.deepEqual(redescribeCandidates(tracks, desc, next, 'gemma4:12b').map(t => t.id), [3])
  })
})

describe('the candidate the eval scores', () => {
  const desc = { 1: { d: 'old one' }, 2: { d: 'old two' }, 3: { m: 'meaning only' } }
  const next = { 2: { d: 'new two', gm: 'gemma4:12b' }, 4: { d: 'new four', gm: 'gemma4:12b' } }
  it('lays staged descriptors over the live ones', () => {
    assert.deepEqual(candidateDescriptors(desc, next), { 1: 'old one', 2: 'new two', 4: 'new four' })
  })
  it('--use-current is the live set alone (the like-for-like baseline)', () => {
    assert.deepEqual(candidateDescriptors(desc, next, { useCurrent: true }), { 1: 'old one', 2: 'old two' })
  })
})

describe('promote', () => {
  it('moves only d/gm/at and keeps meaning and tempo flags', () => {
    const desc: Record<string, Record<string, unknown>> = {
      7: { d: 'old', gm: 'gemma3:4b', m: 'about loss', te: 3, teb: 120, artist: 'X', title: 'Y', at: 't0' },
    }
    const changed = promoteNext(desc, { 7: { d: 'new', gm: 'gemma4:12b', at: 't1' } })
    assert.deepEqual(changed, ['7'])
    assert.deepEqual(desc[7], { d: 'new', gm: 'gemma4:12b', m: 'about loss', te: 3, teb: 120, artist: 'X', title: 'Y', at: 't1' })
  })
  it('ignores empty or non-string staged descriptors and unchanged ones', () => {
    const desc: Record<string, Record<string, unknown>> = { 1: { d: 'same', gm: 'g' } }
    assert.deepEqual(promoteNext(desc, { 1: { d: 'same', gm: 'g' }, 2: { d: '' }, 3: { d: 5 } as never }), [])
    assert.equal(desc[2], undefined)
  })
})

describe('the trainer wiring', () => {
  const src = readFileSync(join(import.meta.dirname, '..', '..', '..', 'scripts', 'brain-trainer.mjs'), 'utf8')
  const block = src.slice(src.indexOf("if (process.argv.includes('--redescribe-all'))"), src.indexOf("const mc = process.argv.indexOf('--mood-candidate')"))
  it('the re-describe never writes the live descriptor store', () => {
    assert.ok(block.length > 500)
    assert.doesNotMatch(block, /renameSync\(DESC \+|writeFileSync\(DESC \+|writeFileSync\(DESC,/)
    assert.match(block, /DESC_NEXT/)
  })
  it('no longer yields on any ffmpeg (the cable channels never stop)', () => {
    assert.doesNotMatch(block, /pgrep/)
    assert.match(block, /musicStreamActive/)
  })
})
