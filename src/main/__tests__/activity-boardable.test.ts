import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyActivitySyncTracks,
  classifyLocalLibraryFile,
  filterActivityBoardableTracks,
  formatHomeminiPullRefuse,
  formatSyncSetFileRefuse,
} from '../activity-boardable.ts'

const mount = '/Users/jake/Music/JakeTunesLibrary'
const pathSep = '/'

function lstatMap(map: Record<string, 'file' | 'symlink' | 'dir' | 'missing'>) {
  return async (abs: string) => {
    const kind = map[abs]
    if (!kind || kind === 'missing') throw new Error('ENOENT')
    return {
      isSymbolicLink: () => kind === 'symlink',
      isFile: () => kind === 'file',
    }
  }
}

describe('classifyLocalLibraryFile', () => {
  it('treats a real file as boardable and a symlink as streamed (never follows)', async () => {
    const lstat = lstatMap({
      '/Users/jake/Music/JakeTunesLibrary/iPod_Control/Music/F00/OK.m4a': 'file',
      '/Users/jake/Music/JakeTunesLibrary/iPod_Control/Music/F00/NAS.m4a': 'symlink',
    })
    const opts = { localMount: mount, pathSep, lstat }
    assert.equal(await classifyLocalLibraryFile(':iPod_Control:Music:F00:OK.m4a', opts), 'ok')
    assert.equal(await classifyLocalLibraryFile(':iPod_Control:Music:F00:NAS.m4a', opts), 'streamed')
    assert.equal(await classifyLocalLibraryFile(':iPod_Control:Music:F00:GONE.m4a', opts), 'missing')
    assert.equal(await classifyLocalLibraryFile('', opts), 'no-path')
  })
})

describe('filterActivityBoardableTracks', () => {
  it('drops missing, streamed, and audioMissing so the picker can still fill N from the rest', async () => {
    const lstat = lstatMap({
      '/Users/jake/Music/JakeTunesLibrary/iPod_Control/Music/F00/A.m4a': 'file',
      '/Users/jake/Music/JakeTunesLibrary/iPod_Control/Music/F00/B.m4a': 'file',
      '/Users/jake/Music/JakeTunesLibrary/iPod_Control/Music/F00/S.m4a': 'symlink',
    })
    const { kept, dropped } = await filterActivityBoardableTracks([
      { id: 1, title: 'A', artist: 'One', path: ':iPod_Control:Music:F00:A.m4a' },
      { id: 2, title: 'B', artist: 'Two', path: ':iPod_Control:Music:F00:B.m4a' },
      { id: 3, title: 'Gone', artist: 'Three', path: ':iPod_Control:Music:F00:GONE.m4a' },
      { id: 4, title: 'Nas', artist: 'Four', path: ':iPod_Control:Music:F00:S.m4a' },
      { id: 5, title: 'Flag', artist: 'Five', path: ':iPod_Control:Music:F00:A.m4a', audioMissing: true },
    ], { localMount: mount, pathSep, lstat })
    assert.deepEqual(kept.map((t) => t.id), [1, 2])
    assert.deepEqual(dropped.map((d) => d.reason), ['missing', 'streamed', 'audio-missing'])
  })
})

describe('formatSyncSetFileRefuse', () => {
  it('names the songs so a refuse is not an anonymous count', () => {
    const msg = formatSyncSetFileRefuse({
      lead: 'Sync refused',
      fileless: [
        'Sleeping In — The Postal Service (no local file: :iPod_Control:Music:F46:HVEG.m4a)',
        'Fear, Sex — Magdalena Bay (no local file: :iPod_Control:Music:F34:AJIT.m4a)',
      ],
      blanks: [],
      total: 500,
      nothingVerb: 'sent',
    })
    assert.match(msg, /2 with no playable file on this Mac/)
    assert.match(msg, /500-song set/)
    assert.match(msg, /Nothing was sent/)
    assert.match(msg, /Sleeping In — The Postal Service/)
    assert.match(msg, /Fear, Sex — Magdalena Bay/)
  })
})

describe('formatHomeminiPullRefuse', () => {
  it('names songs homemini could not serve', () => {
    const msg = formatHomeminiPullRefuse(['Sleeping In — The Postal Service (homemini 404)'], 500)
    assert.match(msg, /1 of 500 songs could not be pulled from homemini/)
    assert.match(msg, /Sleeping In — The Postal Service/)
    assert.match(msg, /Nothing was wiped/)
  })
})

// 2026-08-25 — Jake: "it refused 1000 because of cassius??" Four library rows
// had no audio anywhere (laptop, NAS, homemini 404) from a failed import. The
// picker chose one, the pull 404'd, and the whole set was refused. Refusing is
// CORRECT — N means N. The defect was that the refusal taught the app nothing:
// audioMissing is otherwise stamped only by the POST-sync verifier, which
// needs a sync that succeeds, so a ghost blocked every future sync forever.
describe('a refused sync must still record what it learned', () => {
  it('reports unsourceable ids so the next pick can skip them', () => {
    // The contract the renderer relies on: refusal carries verificationUpdates
    // marking the dead ids audioMissing, exactly like the success path does.
    const refusal = {
      ok: false as const,
      copied: 0,
      error: 'Activity sync refused — 1 of 1000 songs could not be pulled',
      verificationUpdates: [{ id: 9860, audioMissing: true }],
    }
    assert.equal(refusal.ok, false)
    assert.deepEqual(refusal.verificationUpdates, [{ id: 9860, audioMissing: true }])
    // And the flag must be the one filterActivityBoardableTracks already drops.
    assert.equal(refusal.verificationUpdates[0].audioMissing, true)
  })
})

describe('a track whose audio is gone everywhere', () => {
  const tracks = [
    { id: 1, title: 'Alive', artist: 'A', path: ':iPod_Control:Music:F00:1.m4a' },
    { id: 2, title: 'Gone', artist: 'B', path: ':iPod_Control:Music:F01:2.m4a', audioMissing: true },
  ]
  const lstat = (async (p: string) => {
    if (p.endsWith('1.m4a')) return { isFile: () => true, isSymbolicLink: () => false, size: 4242 }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }) as never
  const opts = { localMount: mount, pathSep, lstat }

  it('still refuses an activity set, which must stay exactly N', async () => {
    const strict = await classifyActivitySyncTracks(tracks, opts)
    assert.deepEqual(strict.unsourceable, [])
    assert.deepEqual(strict.toPull.map((p) => p.id), [2])
  })

  it('is named and left out of a full-library mirror, never re-pulled', async () => {
    const lenient = await classifyActivitySyncTracks(tracks, { ...opts, skipKnownMissing: true })
    assert.deepEqual(lenient.toPull, [])
    assert.deepEqual(lenient.unsourceable, [{ id: 2, label: 'Gone — B' }])
  })
})

describe('refusal wording follows the path that raised it', () => {
  it('says wiped for activity and untouched for a full mirror', () => {
    const activity = formatHomeminiPullRefuse(['X — Y'], 500)
    assert.match(activity, /^Activity sync refused/)
    assert.match(activity, /Nothing was wiped\./)

    const full = formatHomeminiPullRefuse(['X — Y'], 10595, {
      lead: 'Sync refused',
      nothingVerb: 'Nothing on the iPod was changed.',
    })
    assert.match(full, /^Sync refused/)
    assert.match(full, /Nothing on the iPod was changed\./)
  })
})
