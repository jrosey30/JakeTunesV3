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
  musicStreamActive, nightlyTrainerActive, untilMs, redescribeCandidates, candidateDescriptors, promoteNext,
  staleStaged, PROMPT_VERSION, stockHits, formulaOpener, stockScore, needsRetry, pickDescriptor,
  describePrompt, describeTrack, audioFacts, cleanDescriptor, bpmKeyWorkerActive, nextFilePath,
} from '../../../scripts/brain-redescribe.mjs'

const PV = PROMPT_VERSION

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
    const desc = { 1: { d: 'x', gm: 'gemma4:12b', pv: PV }, 2: { d: 'y', gm: 'gemma3:4b' }, 3: { d: 'z' } }
    const next = { 2: { d: 'y2', gm: 'gemma4:12b', pv: PV } }
    assert.deepEqual(redescribeCandidates(tracks, desc, next, 'gemma4:12b').map(t => t.id), [3])
  })
  it('redoes entries staged by an older prompt (night 1 had no pv), and does them FIRST', () => {
    const desc = {}
    const next = {
      3: { d: 'Gritty, mid-tempo glam rock', gm: 'gemma4:12b' },          // night 1: no pv
      2: { d: 'Gritty, mid-tempo funk-rock', gm: 'gemma4:12b', pv: PV - 1 },
    }
    assert.deepEqual(redescribeCandidates(tracks, desc, next, 'gemma4:12b').map(t => t.id), [2, 3, 1])
  })
  it('a live entry from the same model but an older prompt is still to-do', () => {
    const desc = { 1: { d: 'x', gm: 'gemma4:12b' }, 2: { d: 'y', gm: 'gemma4:12b', pv: PV }, 3: { d: 'z', gm: 'gemma4:12b', pv: PV } }
    assert.deepEqual(redescribeCandidates(tracks, desc, {}, 'gemma4:12b').map(t => t.id), [1])
  })
  it('the redo keeps the stale entry in the file until its replacement is written', () => {
    const next = { 1: { d: 'old', gm: 'gemma4:12b' } }
    redescribeCandidates(tracks, {}, next, 'gemma4:12b')
    assert.deepEqual(next, { 1: { d: 'old', gm: 'gemma4:12b' } })
  })
})

describe('the candidate the eval scores', () => {
  const desc = { 1: { d: 'old one' }, 2: { d: 'old two' }, 3: { m: 'meaning only' } }
  const next = { 2: { d: 'new two', gm: 'gemma4:12b', pv: PV }, 4: { d: 'new four', gm: 'gemma4:12b', pv: PV }, 1: { d: 'stale one', gm: 'gemma4:12b' } }
  it('lays current-prompt staged descriptors over the live ones; stale-prompt ones are not scored', () => {
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
    const changed = promoteNext(desc, { 7: { d: 'new', gm: 'gemma4:12b', pv: PV, at: 't1' } })
    assert.deepEqual(changed, ['7'])
    assert.deepEqual(desc[7], { d: 'new', gm: 'gemma4:12b', pv: PV, m: 'about loss', te: 3, teb: 120, artist: 'X', title: 'Y', at: 't1' })
  })
  it('ignores empty or non-string staged descriptors and unchanged ones', () => {
    const desc: Record<string, Record<string, unknown>> = { 1: { d: 'same', gm: 'g', pv: PV } }
    assert.deepEqual(promoteNext(desc, { 1: { d: 'same', gm: 'g', pv: PV }, 2: { d: '', pv: PV }, 3: { d: 5, pv: PV } as never }), [])
    assert.equal(desc[2], undefined)
  })
  it('refuses entries staged by an older prompt and reports them', () => {
    const desc: Record<string, Record<string, unknown>> = { 5: { d: 'live', gm: 'gemma3:4b' } }
    const next = {
      5: { d: 'Gritty, mid-tempo funk-rock', gm: 'gemma4:12b', at: 't1' },          // night 1, no pv
      6: { d: 'Hushed acoustic ballad', gm: 'gemma4:12b', pv: PV - 1, at: 't1' },
      8: { d: 'Fresh line', gm: 'gemma4:12b', pv: PV, at: 't2' },
    }
    assert.deepEqual(promoteNext(desc, next), ['8'])
    assert.deepEqual(desc[5], { d: 'live', gm: 'gemma3:4b' })
    assert.equal(desc[6], undefined)
    assert.deepEqual(staleStaged(next), ['5', '6'])
  })
})

describe('the stock-word post-check (10/29: "fix the mid tempo/gritty glitch")', () => {
  it('finds the stock words, whatever the hyphen or case', () => {
    assert.deepEqual(stockHits('Gritty, mid-tempo funk-rock with driving drums'), ['gritty', 'mid-tempo', 'driving'])
    assert.deepEqual(stockHits('A Mid Tempo groove for LATE-NIGHT drives'), ['mid-tempo', 'late-night'])
    assert.deepEqual(stockHits('Hushed acoustic guitar and a cracked falsetto'), [])
  })
  it('does not count words that merely contain a stock word', () => {
    assert.deepEqual(stockHits('overdriven guitars'), [])
  })
  it('spots the "Adj, adj …" opener formula and nothing else', () => {
    assert.equal(formulaOpener('Gritty, mid-tempo glam rock featuring distorted guitar'), true)
    assert.equal(formulaOpener('Soulful, jazzy boom-bap'), true)
    assert.equal(formulaOpener('Hushed acoustic guitar, brushed drums and a weary vocal'), false)
    assert.equal(formulaOpener('Melancholic ballad, sparse and slow'), false)
  })
  it('scores the night-1 My Friends line as stock and a clean line as zero', () => {
    const night1 = 'Gritty, mid-tempo funk-rock blending distorted, heavy guitar riffs with syncopated basslines and raw, soulful, melancholic atmosphere.'
    assert.equal(stockScore(night1), 3)
    assert.equal(needsRetry(night1), true)
    assert.equal(needsRetry('A melancholic ballad of weeping guitar and a weary vocal over a sparse arrangement.'), false)
    assert.equal(needsRetry(null), false)
  })
  it('keeps the retry only when it is strictly less stock', () => {
    assert.equal(pickDescriptor('Gritty, mid-tempo rock', 'Hushed acoustic ballad'), 'Hushed acoustic ballad')
    assert.equal(pickDescriptor('Gritty, mid-tempo rock', 'Gritty, mid-tempo blues'), 'Gritty, mid-tempo rock')
    assert.equal(pickDescriptor('Gritty rock', null), 'Gritty rock')
    assert.equal(pickDescriptor(null, 'x line here'), 'x line here')
  })
})

describe('the describe prompt', () => {
  const t = { artist: 'Red Hot Chili Peppers', title: 'My Friends', album: 'One Hot Minute', year: 1995, genre: 'Funk Rock', bpm: 82.8, keyMode: 'minor', duration: 242000 }
  it('has no slot list that invites a tempo word, and asks for THIS recording', () => {
    const p = describePrompt(t)
    assert.doesNotMatch(p, /tempo feel/)
    assert.match(p, /THIS recording/)
    assert.match(p, /Red Hot Chili Peppers — My Friends/)
  })
  it('grounds in the analyser facts (BPM, length) but not the key mode (it got parroted)', () => {
    assert.match(audioFacts(t), /about 83 BPM/)
    assert.match(audioFacts(t), /4:02 long/)
    assert.doesNotMatch(audioFacts(t), /minor/)
    assert.equal(audioFacts({ artist: 'A', title: 'B' }), '')
  })
  it('asks for the feeling as well as the sound (11/08: gemma4 v2 lines lost the emotion words)', () => {
    const p = describePrompt(t)
    assert.match(p, /sounds AND how it feels/)
    assert.match(p, /The sound:/)
    assert.match(p, /The feeling:/)
    assert.match(p, /two or three plain emotion words/)
    assert.match(p, /The energy, honestly: hushed, gentle, relaxed, lively, urgent, intense or ferocious/)
  })
  it('keeps intensity words for songs that really are intense, and says most are not', () => {
    const p = describePrompt(t)
    assert.match(p, /Intensity words \(heavy, aggressive, raw, distorted/)
    assert.match(p, /are for LOUD sound only/)
    assert.match(p, /A soft, acoustic or gentle song never gets them/)
    assert.match(p, /never use "heavy" or "raw" for a sad feeling/)
  })
  it('keeps the anti-cliché rules from v2', () => {
    const p = describePrompt(t)
    for (const w of ['gritty', 'mid-tempo', 'driving', 'shimmering', 'late-night', 'high-octane']) assert.match(p, new RegExp(w))
    assert.match(p, /Never start with a comma-separated pair of adjectives/)
    assert.match(p, /Tempo is stored separately/)
    assert.match(p, /never invent a contrast/)
  })
  it('is prompt v3, so nothing staged by the v2 prompt is ever scored or promoted as v3', () => {
    assert.equal(PROMPT_VERSION, 3)
    assert.deepEqual(promoteNext({}, { 1: { d: 'a v2 line', gm: 'gemma4:12b', pv: 2 } }), [])
  })
  it('the retry nudge names what to drop', () => {
    const p = describePrompt(t, { words: ['gritty', 'mid-tempo'], opener: true })
    assert.match(p, /"gritty", "mid-tempo"/)
    assert.match(p, /pair of adjectives/)
  })
  it('cleans replies with the same 8..400 gate as before', () => {
    assert.equal(cleanDescriptor('  "Hushed  acoustic ballad"  '), 'Hushed acoustic ballad')
    assert.equal(cleanDescriptor('short'), null)
    assert.equal(cleanDescriptor('x'.repeat(401)), null)
  })
})

describe('describeTrack (prompt → post-check → at most one retry)', () => {
  const t = { artist: 'A', title: 'B', genre: 'Rock' }
  const fake = (replies: (string | Error)[]) => {
    const prompts: string[] = []
    const gen = async (p: string) => { prompts.push(p); const r = replies.shift(); if (r instanceof Error) throw r; return r }
    return { gen, prompts }
  }
  it('a clean first draft costs one call', async () => {
    const f = fake(['Hushed acoustic ballad with a cracked falsetto'])
    assert.equal(await describeTrack(t, f.gen), 'Hushed acoustic ballad with a cracked falsetto')
    assert.equal(f.prompts.length, 1)
  })
  it('a stock draft gets exactly one nudged retry, and the cleaner line wins', async () => {
    const f = fake(['Gritty, mid-tempo rock with driving drums', 'Slide guitar and a barked vocal over stomping toms', 'never asked'])
    assert.equal(await describeTrack(t, f.gen), 'Slide guitar and a barked vocal over stomping toms')
    assert.equal(f.prompts.length, 2)
    assert.match(f.prompts[1], /"gritty", "mid-tempo", "driving"/)
  })
  it('keeps the first draft when the retry is no better or fails', async () => {
    assert.equal(await describeTrack(t, fake(['Gritty blues stomp here', 'Gritty blues shuffle here']).gen), 'Gritty blues stomp here')
    assert.equal(await describeTrack(t, fake(['Gritty blues stomp here', new Error('timeout')]).gen), 'Gritty blues stomp here')
  })
  it('a failed first call still throws (the caller counts the fail)', async () => {
    await assert.rejects(describeTrack(t, fake([new Error('gemma 500')]).gen))
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
  it('stamps the prompt version on every staged entry', () => {
    assert.match(block, /next\[String\(t\.id\)\] = \{ d, gm: GEMMA_MODEL, pv: PROMPT_VERSION,/)
  })
  it('the describe call goes through the shared post-checked flow', () => {
    assert.match(src, /return describeTrack\(t, gemmaGenerate\)/)
    assert.doesNotMatch(src, /tempo feel/)
  })
  it('no longer yields on any ffmpeg (the cable channels never stop)', () => {
    assert.doesNotMatch(block, /pgrep/)
    assert.match(block, /musicStreamActive/)
  })
})

describe('stepping aside for the BPM/key worker (19:00-23:55, 02:20-03:00)', () => {
  const WORKER = '/opt/homebrew/bin/node --env-file=.env dist/bpmKeyWorker.js --until 23:55 --wait-lock'
  const MEASURER = '/opt/homebrew/Cellar/python@3.12/3.12.13_2/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python /Users/jakerosenbaumnas/JakeTunesMobile/tools/bpm-key/analyze.py serve'
  it('sees the worker and its measurers (the real homemini ps lines)', () => {
    assert.equal(bpmKeyWorkerActive([CABLE, WORKER].join('\n')), true)
    assert.equal(bpmKeyWorkerActive([CABLE, MEASURER].join('\n')), true)
  })
  it('ignores the cable channels, editors, greps and the shell wrapper alone', () => {
    assert.equal(bpmKeyWorkerActive([CABLE, '/usr/bin/grep bpmKeyWorker.js', 'vim tools/bpm-key/analyze.py'].join('\n')), false)
    assert.equal(bpmKeyWorkerActive(''), false)
  })
  it('the trainer yields to it', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', '..', 'scripts', 'brain-trainer.mjs'), 'utf8')
    assert.match(src, /if \(bpmKeyWorkerActive\(ps\)\) return/)
  })
})

describe('--next-file (a new prompt stages beside the old candidate, never over it)', () => {
  const S = '/state'
  it('defaults to brain-descriptors.next.json', () => {
    assert.equal(nextFilePath(['node', 'brain-trainer.mjs', '--redescribe-all'], S), '/state/brain-descriptors.next.json')
  })
  it('takes a plain .json name in the state dir', () => {
    assert.equal(nextFilePath(['--redescribe-all', '--next-file', 'brain-descriptors.next-v3.json'], S), '/state/brain-descriptors.next-v3.json')
  })
  it('refuses the live store, paths, a missing value and non-json names', () => {
    for (const argv of [
      ['--next-file', 'brain-descriptors.json'],
      ['--next-file', '../brain-descriptors.next.json'],
      ['--next-file', '/tmp/x.json'],
      ['--next-file'],
      ['--next-file', '--until'],
      ['--next-file', 'next.txt'],
    ]) assert.throws(() => nextFilePath(argv, S), argv.join(' '))
  })
  it('every staged-file mode in the trainer goes through it', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', '..', 'scripts', 'brain-trainer.mjs'), 'utf8')
    assert.match(src, /DESC_NEXT = nextFilePath\(process\.argv, STATE_DIR\)/)
    assert.doesNotMatch(src, /join\(STATE_DIR, 'brain-descriptors\.next\.json'\)/)
  })
})

describe('stepping aside for the 02:00 trainer', () => {
  const NODE = '/opt/homebrew/bin/node'
  const TRAINER = `${NODE} /Users/jakerosenbaumnas/JakeTunesV3/scripts/brain-trainer.mjs`
  it('sees the nightly trainer, never its own --redescribe-all process', () => {
    assert.equal(nightlyTrainerActive([CABLE, `${TRAINER} --redescribe-all --until 08:15`].join('\n')), false)
    assert.equal(nightlyTrainerActive([CABLE, `${TRAINER} --redescribe-all --until 08:15`, TRAINER].join('\n')), true)
  })
  it('ignores an editor or grep that merely mentions the file', () => {
    assert.equal(nightlyTrainerActive('/usr/bin/grep brain-trainer.mjs\nvim scripts/brain-trainer.mjs'), false)
    assert.equal(nightlyTrainerActive(''), false)
  })
})
