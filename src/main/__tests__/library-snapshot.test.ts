// Tests for src/main/library-snapshot.ts.
//
// Run via: npm run test:main
//
// Pure-function tests for the path normalization + envelope shape.
// The atomic-write `writeLibrarySnapshot` is exercised against tmp
// files in a separate test below.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildLibrarySnapshot,
  colonPathToSlashRelative,
  writeLibrarySnapshot,
  LIBRARY_SNAPSHOT_VERSION,
  type SnapshotTrack,
  type SnapshotPlaylist,
} from '../library-snapshot.ts'

function snapTrack(over: Partial<SnapshotTrack> = {}): SnapshotTrack {
  return {
    id: 1,
    title: 't',
    path: ':iPod_Control:Music:F12:ABCD.m4a',
    album: 'a',
    artist: 'r',
    albumArtist: 'r',
    genre: 'g',
    year: 2020,
    duration: 240000,
    dateAdded: '2024-01-01',
    playCount: 0,
    trackNumber: 1,
    trackCount: 10,
    discNumber: 1,
    discCount: 1,
    fileSize: 1234,
    rating: 0,
    ...over,
  }
}

describe('colonPathToSlashRelative', () => {
  test('converts iPod-style colon path', () => {
    assert.equal(
      colonPathToSlashRelative(':iPod_Control:Music:F12:ABCD.m4a'),
      'iPod_Control/Music/F12/ABCD.m4a',
    )
  })

  test('strips leading slash if any', () => {
    assert.equal(colonPathToSlashRelative('/iPod_Control/Music/F12/ABCD.m4a'), 'iPod_Control/Music/F12/ABCD.m4a')
  })

  test('strips multiple leading slashes (defensive)', () => {
    assert.equal(colonPathToSlashRelative('///foo/bar'), 'foo/bar')
  })

  test('idempotent on already-slash-separated paths', () => {
    assert.equal(
      colonPathToSlashRelative('iPod_Control/Music/F12/ABCD.m4a'),
      'iPod_Control/Music/F12/ABCD.m4a',
    )
  })

  test('handles empty input', () => {
    assert.equal(colonPathToSlashRelative(''), '')
  })

  test('handles mixed colons + slashes (paranoid)', () => {
    assert.equal(colonPathToSlashRelative(':a/b:c/d'), 'a/b/c/d')
  })
})

describe('buildLibrarySnapshot', () => {
  test('sets version and exportedAt on every snapshot', () => {
    const snap = buildLibrarySnapshot({ tracks: [], playlists: [] })
    assert.equal(snap.version, LIBRARY_SNAPSHOT_VERSION)
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(snap.exportedAt), 'ISO timestamp')
  })

  test('normalizes every track path (colon → slash, no leading slash)', () => {
    const snap = buildLibrarySnapshot({
      tracks: [
        snapTrack({ id: 1, path: ':iPod_Control:Music:F12:A.m4a' }),
        snapTrack({ id: 2, path: ':iPod_Control:Music:F19:Z.m4a' }),
      ],
      playlists: [],
    })
    assert.equal(snap.tracks[0].path, 'iPod_Control/Music/F12/A.m4a')
    assert.equal(snap.tracks[1].path, 'iPod_Control/Music/F19/Z.m4a')
  })

  test('libraryRootPath defaults to empty string', () => {
    const snap = buildLibrarySnapshot({ tracks: [], playlists: [] })
    assert.equal(snap.libraryRootPath, '')
  })

  test('libraryRootPath honored when provided', () => {
    const snap = buildLibrarySnapshot({
      tracks: [],
      playlists: [],
      libraryRootPath: '/music',
    })
    assert.equal(snap.libraryRootPath, '/music')
  })

  test('does not mutate the input tracks array', () => {
    const t = snapTrack()
    const originalPath = t.path
    buildLibrarySnapshot({ tracks: [t], playlists: [] })
    assert.equal(t.path, originalPath, 'input track.path must be unchanged')
  })

  test('passes playlists through unchanged', () => {
    const playlists: SnapshotPlaylist[] = [{ id: 'p1', name: 'Mix', trackIds: [1, 2] }]
    const snap = buildLibrarySnapshot({ tracks: [], playlists })
    assert.deepEqual(snap.playlists, playlists)
  })
})

describe('writeLibrarySnapshot', () => {
  test('writes a parseable snapshot atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-snap-'))
    try {
      const dest = join(dir, 'library.json')
      const result = await writeLibrarySnapshot(dest, {
        tracks: [snapTrack({ id: 1, path: ':iPod_Control:Music:F12:A.m4a' })],
        playlists: [],
      })
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.trackCount, 1)
        assert.ok(result.bytes > 0)
      }
      const raw = await readFile(dest, 'utf-8')
      const parsed = JSON.parse(raw)
      assert.equal(parsed.version, LIBRARY_SNAPSHOT_VERSION)
      assert.equal(parsed.tracks[0].path, 'iPod_Control/Music/F12/A.m4a')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('creates parent directories if missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-snap-'))
    try {
      const dest = join(dir, 'sub', 'sub2', 'library.json')
      const result = await writeLibrarySnapshot(dest, { tracks: [], playlists: [] })
      assert.equal(result.ok, true)
      const raw = await readFile(dest, 'utf-8')
      assert.ok(raw.length > 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns ok=false on unwritable path', async () => {
    // /dev/null is a character device, not a directory — mkdir of a
    // child path under it fails fast with ENOTDIR (vs hanging on
    // /proc pseudo-fs paths in some kernels).
    const result = await writeLibrarySnapshot('/dev/null/jt-test/bar.json', {
      tracks: [],
      playlists: [],
    })
    assert.equal(result.ok, false)
  })
})
