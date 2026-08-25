import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
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
