/**
 * A rip that didn't finish never reaches the library (2026-11-05): a slow link's clock killed `rip`,
 * and "02. MJ Lenderman - Joker Lips" arrived with no artist and 28 seconds missing.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRipProgress, cutShort, decodedSecFromStats, finishedRipFiles, RIP_QUIET_LOOKS } from '../streamrip-store/rip-finish.ts'

describe('finishedRipFiles', () => {
  const tags: Record<string, { title: string; artist: string; albumArtist?: string }> = {
    '/s/01. MJ Lenderman - Manning Fireworks.flac': { title: 'Manning Fireworks', artist: 'MJ Lenderman' },
    '/s/02. MJ Lenderman - Joker Lips.flac': { title: '', artist: '' },
    '/s/03.flac': { title: 'Rudolph', artist: '' },
    '/s/04.flac': { title: '', artist: 'MJ Lenderman' },
    '/s/05.flac': { title: 'Compilation Track', artist: '', albumArtist: 'Various Artists' },
  }
  test('a file with no title or no artist never finished', async () => {
    const kept = await finishedRipFiles(Object.keys(tags), async (f) => tags[f]!)
    assert.deepEqual(kept, ['/s/01. MJ Lenderman - Manning Fireworks.flac', '/s/05.flac'])
  })
  test('nothing kept when nothing finished', async () => {
    assert.deepEqual(await finishedRipFiles(['/s/02. MJ Lenderman - Joker Lips.flac'], async (f) => tags[f]!), [])
  })
})

describe('createRipProgress', () => {
  test('a growing file lives on past its clock', async () => {
    let bytes = 100
    const moving = createRipProgress(async () => bytes)
    assert.equal(await moving(), true)
    bytes = 200
    assert.equal(await moving(), true)
    bytes = 300
    assert.equal(await moving(), true)
  })
  test('a stalled file is called dead after the quiet looks, and new bytes reset the count', async () => {
    let bytes = 100
    const moving = createRipProgress(async () => bytes)
    assert.equal(await moving(), true)
    for (let i = 1; i < RIP_QUIET_LOOKS; i++) assert.equal(await moving(), true, 'one quiet look is tagging, not death')
    assert.equal(await moving(), false)
    const again = createRipProgress(async () => bytes)
    await again(); await again()
    bytes = 500
    assert.equal(await again(), true)
  })
  test('a folder it cannot read counts as quiet, never as a crash', async () => {
    const moving = createRipProgress(async () => { throw new Error('gone') })
    assert.equal(await moving(), true)
    assert.equal(await moving(), false)
  })
})

describe('a file cut short with its tags on', () => {
  test('Popstar: 38 s of a 2:47 header is cut short', () => {
    assert.equal(cutShort(167.8, 38.1), true)
  })
  test('a whole file, and a rounding difference, are not', () => {
    assert.equal(cutShort(179.733, 179.73), false)
    assert.equal(cutShort(179.7, 178.5), false)
  })
  test('what can\'t be measured passes', () => {
    assert.equal(cutShort(null, 38), false)
    assert.equal(cutShort(167.8, null), false)
  })
  test('the length comes from the last time ffmpeg printed', () => {
    const stderr = 'size=N/A time=00:00:11.20 bitrate=N/A speed=22x\rsize=N/A time=00:02:33.04 bitrate=N/A speed=40x\n'
    assert.equal(decodedSecFromStats(stderr), 153.04)
    assert.equal(decodedSecFromStats('nothing here'), null)
    assert.equal(decodedSecFromStats('time=00:00:00.00'), null)
  })
})

describe('the wiring', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'streamrip-store', 'index.ts'), 'utf-8')
  test('stageRip refuses a rip the clock stopped and an untagged file', () => {
    assert.match(src, /if \(res\.timedOut\) \{/)
    assert.match(src, /finishedRipFiles\(await collectAudio\(staging\), probeStagedFile\)/)
    assert.match(src, /wholeRipFiles\(/)
  })
})
