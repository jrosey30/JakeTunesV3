/**
 * The install gate with a weekly release (2026-11-14). Runs the shipped script in the same temp
 * world as install-gate.test.ts (install-gate-world.ts). What these prove:
 *  - a release file makes the marker v 2: label, kind, notes and offeredAt beside the v 1 fields
 *  - nothing installs on idle: a Mac left alone for minutes keeps its build until the app says go
 *  - the app's go-file still installs at once, and the audio hard stop still holds it
 *  - "skip <sha>" ends the gate with exit 5 and nothing changed; both markers go
 *  - a newer release's marker ends the older gate with exit 6, and its marker stays
 *  - a release file the gate can't read is an ABORT before any wait
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { finished, makeWorld, NEW_ASAR, NOTE, OLD_ASAR, readMarker, SHA, sleep } from './install-gate-world.ts'
import { waitFor } from './wait-for.ts'

const RELEASE = { label: 'This week’s fixes', kind: 'weekly', notes: ['Album pages open faster', 'Say "hi" to the new iPod page'] }

function releaseFile(root: string, body: unknown = RELEASE): string {
  const p = join(root, 'release.json')
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
  return p
}

describe('install gate — a weekly release waits for a decision', () => {
  it('writes a v 2 marker with the release, and never installs on idle', async () => {
    const w = makeWorld({ idleS: 900 })
    try {
      const g = w.run({ sha: SHA, note: NOTE, release: releaseFile(w.root) })
      await waitFor(() => existsSync(w.marker), 'update-ready.json')
      const m = readMarker(w.marker)
      assert.equal(m['v'], 2)
      assert.equal(m['sha'], SHA)
      assert.equal(m['label'], RELEASE.label)
      assert.equal(m['kind'], 'weekly')
      assert.deepEqual(m['notes'], RELEASE.notes, 'the notes come through as a list, quotes and all')
      assert.equal(m['gatePid'], g.child.pid)
      assert.ok(Number.isFinite(Date.parse(String(m['offeredAt']))))
      await waitFor(() => /waiting: a decision in the app/.test(g.out()), 'the decision wait line')
      // Idle for 15 minutes, nothing playing: the v 1 gate would have installed long ago.
      await sleep(1500)
      assert.equal(g.child.exitCode, null, 'still waiting')
      assert.doesNotMatch(w.calls(), /^osascript /m, 'the app was never asked to quit')
      assert.doesNotMatch(w.calls(), /^pmset /m, 'no heavy check before a decision')
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
      g.child.kill('SIGTERM')
      await finished(g)
      assert.ok(!existsSync(w.marker))
    } finally { w.cleanup() }
  })

  it('the app\'s go-file installs; the audio hard stop holds it until the music stops', async () => {
    const w = makeWorld({ idleS: 0, audio: 'assertion' })
    try {
      const g = w.run({ sha: SHA, note: NOTE, release: releaseFile(w.root) })
      await waitFor(() => /waiting: a decision in the app/.test(g.out()), 'the decision wait line')
      w.writeGo(SHA)
      await waitFor(() => /waiting: playing audio/.test(g.out()), 'the audio stop')
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR, 'not while the music plays')
      w.setAudio('none')
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.match(g.out(), /gate clear \(install clicked in the app, no audio\)/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
      assert.ok(!existsSync(w.marker) && !existsSync(w.goFile), 'both markers removed')
    } finally { w.cleanup() }
  })

  it('"skip <sha>" ends the gate: exit 5, nothing installed, both markers gone', async () => {
    const w = makeWorld({ idleS: 900 })
    try {
      const g = w.run({ sha: SHA, note: NOTE, release: releaseFile(w.root) })
      await waitFor(() => /waiting: a decision in the app/.test(g.out()), 'the decision wait line')
      w.writeGo(`skip ${SHA}`)
      const r = await finished(g)
      assert.equal(r.code, 5, g.out())
      assert.match(g.out(), /skipped on this Mac in the app — nothing changed/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
      assert.doesNotMatch(w.calls(), /^osascript /m)
      assert.ok(!existsSync(w.marker), 'marker removed')
      assert.ok(!existsSync(w.goFile), 'the skip is removed with it')
    } finally { w.cleanup() }
  })

  it('a skip for another build is not ours: it is cleared and the wait goes on', async () => {
    const w = makeWorld({ idleS: 900 })
    try {
      const g = w.run({ sha: SHA, note: NOTE, release: releaseFile(w.root) })
      await waitFor(() => /waiting: a decision in the app/.test(g.out()), 'the decision wait line')
      w.writeGo('skip ffffffffffffffffffffffffffffffffffffffff')
      await waitFor(() => /ignoring update-go for another build/.test(g.out()), 'the other build\'s go-file ignored')
      assert.equal(g.child.exitCode, null, 'still waiting')
      w.writeGo(SHA)
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
    } finally { w.cleanup() }
  })

  it('a newer release\'s marker ends the older gate (exit 6) and is left in place', async () => {
    const w = makeWorld({ idleS: 900 })
    try {
      const g = w.run({ sha: SHA, note: NOTE, release: releaseFile(w.root) })
      await waitFor(() => /waiting: a decision in the app/.test(g.out()), 'the decision wait line')
      const next = { ...readMarker(w.marker), sha: 'abcabcabcabcabcabcabcabcabcabcabcabcabca', gatePid: 999999 }
      writeFileSync(w.marker, `${JSON.stringify(next).replace('"gatePid":999999', '"gatePid": 999999')}\n`)
      const r = await finished(g)
      assert.equal(r.code, 6, g.out())
      assert.match(g.out(), /a newer release's gate took over the offer/)
      assert.equal(readMarker(w.marker)['gatePid'], 999999, 'the newer gate\'s marker survives the older gate\'s exit')
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
    } finally { w.cleanup() }
  })

  it('a release file it can\'t read is an ABORT before any wait', async () => {
    for (const body of ['{"label": "x", "kind": "weekly"', JSON.stringify({ ...RELEASE, kind: 'someday' }), JSON.stringify({ label: 'x', kind: 'fix', notes: 'one string' })]) {
      const w = makeWorld({ idleS: 900 })
      try {
        const g = w.run({ sha: SHA, note: NOTE, release: releaseFile(w.root, body) })
        const r = await finished(g)
        assert.equal(r.code, 1, `${body}\n${g.out()}`)
        assert.match(g.out(), /ABORT: (the release|release kind)/)
        assert.ok(!existsSync(w.marker), 'no offer was made')
        assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
      } finally { w.cleanup() }
    }
  })

  it('a no-decision timeout is exit 3 and changes nothing', async () => {
    const w = makeWorld({ idleS: 900 })
    try {
      const g = w.run({ sha: SHA, note: NOTE, release: releaseFile(w.root), maxMin: 0 })
      const r = await finished(g)
      assert.equal(r.code, 3, g.out())
      assert.match(g.out(), /ABORT: no decision in 0 min — nothing changed/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
      assert.ok(!existsSync(w.marker))
    } finally { w.cleanup() }
  })
})
