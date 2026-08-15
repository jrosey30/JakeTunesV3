import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { remountUnmountArgSets } from '../remount-unmount-args.ts'

describe('remountUnmountArgSets — never force-unmount by default', () => {
  it('clean unmount only: node, then mount point, no force', () => {
    const sets = remountUnmountArgSets('/dev/disk9s2', '/Volumes/JACOBROSENB')
    assert.deepEqual(sets, [
      ['unmount', '/dev/disk9s2'],
      ['unmount', '/Volumes/JACOBROSENB'],
    ])
    assert.ok(!JSON.stringify(sets).includes('force'), 'default remount must not force-unmount (500→33)')
  })

  it('allowForce adds force as a last resort only when the caller opts in', () => {
    const sets = remountUnmountArgSets('/dev/disk9s2', '/Volumes/JACOBROSENB', true)
    assert.deepEqual(sets[sets.length - 1], ['unmount', 'force', '/dev/disk9s2'])
    assert.equal(sets.length, 3)
  })
})
