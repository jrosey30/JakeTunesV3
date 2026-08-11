/**
 * Assembling a persona prompt.
 *
 * These builders were the last thing holding the personas inside index.ts.
 * An earlier attempt to move them had to be reverted, and the reason is the
 * thing this file exists to prevent: the builders read MUTABLE state, and if
 * that state is captured at registration time instead of read at call time,
 * it freezes. A frozen activeHost means Jake switches his host to Megan and
 * keeps getting Music Man — with no error, no warning, nothing in the log.
 *
 * So the central test here is not "does it build a prompt". It is "does it
 * still follow the state after the state changes". Everything else is detail.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  initPersonaPrompts, buildMusicManPrompt, buildCynthiaPrompt, withLibraryDigest,
  MUSIC_MAN_CORE, MEGAN_CORE, CYNTHIA_CORE,
} from '../personas.ts'
import { refreshLibraryDigest, setLibraryContext } from '../library-digest.ts'
import {
  initPersonaMemory, noteMusicManUtterance, noteCynthiaUtterance,
  loadMusicManMemory, loadCynthiaMemory,
} from '../persona-memory.ts'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const textOf = (blocks: { text: string }[]) => blocks.map(b => b.text).join('\n---\n')

describe('persona prompts', () => {
  let host: 'mm' | 'megan'
  let taste: string

  beforeEach(async () => {
    host = 'mm'
    taste = ''
    initPersonaPrompts({ activeHost: () => host, tasteProfile: () => taste })
    setLibraryContext('')
    refreshLibraryDigest([])

    // The memories are singletons and init only swaps dependencies — it does
    // not clear what is already remembered. Loading empty state is the only
    // thing that does, and without it one test's utterance leaks into the next
    // test's prompt.
    const dir = await mkdtemp(join(tmpdir(), 'pp-'))
    await writeFile(join(dir, 'cynthia-memory.json'), '[]', 'utf-8')
    initPersonaMemory({ cache: { get: async () => [], set: () => {} }, userDataDir: dir })
    await loadMusicManMemory()
    await loadCynthiaMemory()
  })

  test('follows the active host AFTER it changes', () => {
    // The regression that reverted the first attempt. Build once as Music Man,
    // flip the host, build again — the second prompt must be Megan's.
    assert.ok(textOf(buildMusicManPrompt()).includes(MUSIC_MAN_CORE.slice(0, 60)))

    host = 'megan'
    const after = textOf(buildMusicManPrompt())
    assert.ok(after.includes(MEGAN_CORE.slice(0, 60)), 'switched to Megan')
    assert.ok(!after.includes(MUSIC_MAN_CORE.slice(0, 60)), 'and left Music Man behind')
  })

  test('picks up a taste profile that appears later', () => {
    assert.ok(!textOf(buildMusicManPrompt()).includes('plays Nirvana constantly'))
    taste = 'plays Nirvana constantly'
    assert.ok(textOf(buildMusicManPrompt()).includes('plays Nirvana constantly'))
  })

  test('without init it degrades to Music Man and no taste profile', () => {
    // Documenting the fallback rather than pretending it can't happen: if the
    // wiring is ever dropped, this is what Jake would get — a working but
    // less-informed persona, which is precisely why it needs a test and not
    // a silent default.
    initPersonaPrompts({ activeHost: () => 'mm', tasteProfile: () => '' })
    const blocks = buildMusicManPrompt()
    assert.ok(textOf(blocks).includes(MUSIC_MAN_CORE.slice(0, 60)))
    assert.equal(blocks.length, 1, 'no dynamic block when there is nothing dynamic')
  })

  test('the stable half is marked for prompt caching', () => {
    // Money, not style. The persona core plus the digest is the large,
    // unchanging part of every character call; losing cache_control means
    // paying full price for it on every single request.
    taste = 'some history'
    const blocks = buildMusicManPrompt('mode text')
    assert.equal(blocks[0].cache_control?.type, 'ephemeral')
    assert.equal(blocks[1]?.cache_control, undefined, 'the changing half is not cached')
  })

  test('splits stable from dynamic on the right seam', () => {
    setLibraryContext('9000 tracks')
    refreshLibraryDigest([{ artist: 'The Beatles', album: 'Revolver', genre: 'Rock', year: 1966 }])
    taste = 'listens late at night'
    noteMusicManUtterance('dj', 'said something earlier')

    const [stable, dynamic] = buildMusicManPrompt('be brief')
    // Stable: things that only change when the library does.
    assert.ok(stable.text.includes('9000 tracks'))
    assert.ok(stable.text.includes('LIBRARY DIGEST'))
    // Dynamic: things that change call to call.
    assert.ok(dynamic.text.includes('be brief'))
    assert.ok(dynamic.text.includes('listens late at night'))
    assert.ok(dynamic.text.includes('said something earlier'))
    assert.ok(!stable.text.includes('be brief'), 'mode text must not poison the cached half')
  })

  test('Stephen Hands gets the digest appended, or the core untouched', () => {
    assert.equal(withLibraryDigest('CORE'), 'CORE', 'no digest, no change')
    refreshLibraryDigest([{ artist: 'X', album: 'Y', genre: 'Rock', year: 1990 }])
    assert.ok(withLibraryDigest('CORE').startsWith('CORE\n\n'))
    assert.ok(withLibraryDigest('CORE').includes('LIBRARY DIGEST'))
  })

  test('Cynthia gets her core, the context, and her recent jobs', () => {
    setLibraryContext('the whole library')
    noteCynthiaUtterance('fixed 3 covers')
    const p = buildCynthiaPrompt('scan for duplicates')
    assert.ok(p.startsWith(CYNTHIA_CORE))
    assert.ok(p.includes('scan for duplicates'))
    assert.ok(p.includes('the whole library'))
    assert.ok(p.includes('fixed 3 covers'))
  })

  test('Cynthia with nothing to add is just her core', () => {
    assert.equal(buildCynthiaPrompt(), CYNTHIA_CORE)
  })
})
