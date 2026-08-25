import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  tsaPassengerIdentity,
  tsaBoardPassenger,
  tsaScreen,
  tsaAllClear,
  tsaActivityOk,
  tsaSealFromScreen,
  parseTsaSeal,
  tsaInspectSeal,
  tsaDestCollisions,
  tsaNormalizeColonPath,
  tsaRelFromColon,
  TSA_ACTIVITY_TARGETS,
} from '../ipod-sync-tsa.ts'

function p(partial: {
  id: number
  path: string
  title?: string
  artist?: string
  fileSize?: number
  audioFingerprint?: string
}) {
  return tsaBoardPassenger({
    id: partial.id,
    path: partial.path,
    destPath: partial.path,
    title: partial.title ?? 'Song',
    artist: partial.artist ?? 'Artist',
    fileSize: partial.fileSize ?? 1000,
    audioFingerprint: partial.audioFingerprint,
  })
}

describe('ipod-sync-tsa — every boarded song clears or the set is held', () => {
  it('identifies by fingerprint, not title', () => {
    assert.equal(
      tsaPassengerIdentity({ audioFingerprint: 'abc', path: ':F00:x.m4a', id: 1 }),
      'fp:abc',
    )
    assert.equal(
      tsaPassengerIdentity({ path: ':F00:x.m4a', id: 1 }),
      'path::F00:x.m4a',
    )
  })

  it('N means N for 100, 250, 500, and 1000 — a shortfall is never all-clear', () => {
    for (const n of TSA_ACTIVITY_TARGETS) {
      assert.equal(tsaAllClear(n, n, 0), true, `${n} cleared is all-clear`)
      assert.equal(tsaAllClear(n, n - 1, 1), false, `${n - 1} of ${n} is a hold`)
      assert.equal(tsaAllClear(n, n - 3, 3), false, `${n - 3} of ${n} is a hold`)
      assert.equal(
        tsaActivityOk({ target: n, boarded: n, cleared: n, held: 0, sealed: true, shortfall: false }),
        true,
        `${n} sealed is success`,
      )
      assert.equal(
        tsaActivityOk({ target: n, boarded: n, cleared: n, held: 0, sealed: false, shortfall: false }),
        false,
        `${n} without a written seal is not success`,
      )
      assert.equal(
        tsaActivityOk({ target: n, boarded: n, cleared: n - 1, held: 1, sealed: true, shortfall: false }),
        false,
        `${n} with a hold is not success even if a seal file exists`,
      )
    }
    assert.equal(tsaAllClear(0, 0, 0), false)
    assert.equal(
      tsaActivityOk({ target: 500, boarded: 492, cleared: 492, held: 0, sealed: true, shortfall: false }),
      false,
      'boarding a short set and sealing it is not 500',
    )
  })

  it('slash and colon dest paths are the same passenger', () => {
    assert.equal(
      tsaNormalizeColonPath('iPod_Control/Music/F00/x.m4a'),
      ':iPod_Control:Music:F00:x.m4a',
    )
    assert.equal(
      tsaNormalizeColonPath(':iPod_Control:Music:F00:x.m4a'),
      ':iPod_Control:Music:F00:x.m4a',
    )
    const slash = p({ id: 1, path: 'iPod_Control/Music/F00/x.m4a', fileSize: 1000, audioFingerprint: 'a' })
    const onCard = new Map([['iPod_Control/Music/F00/x.m4a', 1000]])
    const catalogPaths = new Set(['iPod_Control/Music/F00/x.m4a'])
    const screen = tsaScreen({ boarded: [slash], onCard, catalogPaths })
    assert.equal(screen.cleared.length, 1)
    assert.equal(screen.cleared[0].destPath, ':iPod_Control:Music:F00:x.m4a')
  })

  it('rel path under the mount has no leading slash', () => {
    const destPath = ':iPod_Control:Music:F00:x.m4a'
    const mount = '/Volumes/JAKETUNES'
    assert.equal(tsaRelFromColon(destPath), 'iPod_Control/Music/F00/x.m4a')
    assert.equal(tsaRelFromColon(destPath).startsWith('/'), false)
    assert.equal(join(mount, tsaRelFromColon(destPath)), '/Volumes/JAKETUNES/iPod_Control/Music/F00/x.m4a')
    assert.equal(tsaRelFromColon('iPod_Control/Music/F00/x.m4a', '\\'), 'iPod_Control\\Music\\F00\\x.m4a')
  })

  it('refuses two boarded songs rewriting to the same dest', () => {
    const boarded = [
      p({ id: 1, path: ':F00:foo.flac', audioFingerprint: 'a' }),
      p({ id: 2, path: ':F00:foo.m4a', audioFingerprint: 'b' }),
    ]
    // Boarding does not rewrite ext; the sync engine feeds playable dests.
    const collided = [
      tsaBoardPassenger({ ...boarded[0], destPath: ':F00:foo.m4a' }),
      tsaBoardPassenger({ ...boarded[1], destPath: ':F00:foo.m4a' }),
    ]
    assert.deepEqual(tsaDestCollisions(collided), [':F00:foo.m4a'])
    assert.deepEqual(tsaDestCollisions(boarded), [])
  })

  it('holds a missing file, a size mismatch, a catalog miss, and an unlistable row', () => {
    const boarded = [
      p({ id: 1, path: ':F00:a.m4a', fileSize: 1000, audioFingerprint: 'a' }),
      p({ id: 2, path: ':F00:b.m4a', fileSize: 2000, audioFingerprint: 'b' }),
      p({ id: 3, path: ':F00:c.m4a', fileSize: 3000, audioFingerprint: 'c' }),
      p({ id: 4, path: ':F00:d.0i4zLU', fileSize: 4000, title: 'Temp', artist: 'X', audioFingerprint: 'd' }),
    ]
    const onCard = new Map([
      [':F00:a.m4a', 1000],
      [':F00:b.m4a', 1999],
      [':F00:d.0i4zLU', 4000],
    ])
    const catalogPaths = new Set([':F00:a.m4a', ':F00:b.m4a', ':F00:d.0i4zLU'])
    const screen = tsaScreen({ boarded, onCard, catalogPaths })
    assert.equal(screen.cleared.length, 1)
    assert.equal(screen.cleared[0].id, 1)
    assert.deepEqual(screen.held.map((h) => h.reason), [
      'size-mismatch',
      'missing-file',
      'unlistable',
    ])
    assert.equal(tsaAllClear(boarded.length, screen.cleared.length, screen.held.length), false)
    assert.equal(tsaSealFromScreen(screen, '2026-08-15T00:00:00.000Z'), null)
  })

  it('seals only a fully cleared set, and inspect reports later drift', () => {
    const boarded = [
      p({ id: 1, path: ':F00:a.m4a', fileSize: 1000, audioFingerprint: 'a' }),
      p({ id: 2, path: ':F00:b.m4a', fileSize: 2000, audioFingerprint: 'b' }),
    ]
    const onCard = new Map([
      [':F00:a.m4a', 1000],
      [':F00:b.m4a', 2000],
    ])
    const catalogPaths = new Set([':F00:a.m4a', ':F00:b.m4a'])
    const screen = tsaScreen({ boarded, onCard, catalogPaths })
    assert.equal(tsaAllClear(2, screen.cleared.length, screen.held.length), true)
    const seal = tsaSealFromScreen(screen, '2026-08-15T22:00:00.000Z')
    assert.ok(seal)
    assert.equal(seal!.target, 2)
    const roundTrip = parseTsaSeal(JSON.parse(JSON.stringify(seal)))
    assert.equal(roundTrip?.target, 2)

    const stillThere = tsaInspectSeal(seal!, onCard)
    assert.equal(stillThere.present, 2)
    assert.equal(stillThere.missing.length, 0)

    onCard.delete(':F00:b.m4a')
    const drifted = tsaInspectSeal(seal!, onCard)
    assert.equal(drifted.present, 1)
    assert.equal(drifted.missing.length, 1)
    assert.equal(drifted.missing[0].reason, 'missing-file')
  })
})
