/**
 * The small iPods carry smaller files (Jake, 2026-11-24: "gen 1 ipod has a 10 gb max,
 * indie sleaze ipod has a 8 gb max and y2kpod has a 40 gb max … sync my ipod playlists as
 * they are to AAC/high end mp3 only for those 3 ipods").
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  convertOptionsForIpod, ipodAudioFormat, GEN1_IPOD_ID, Y2K_IPOD_ID, INDIE_SLEAZE_IPOD_ID,
} from '../../common/ipod-audio-format.ts'

const PUNK = '0d8fc490-74d1-4232-9a35-1801a66f4fde'

describe('each small iPod carries its own format', () => {
  it('Gen 1 is MP3 at 320; Y2KPod and IndieSleaze are AAC at 256; the rest have none', () => {
    assert.deepEqual(ipodAudioFormat(GEN1_IPOD_ID), { codec: 'mp3', kbps: 320 })
    assert.deepEqual(ipodAudioFormat(Y2K_IPOD_ID), { codec: 'aac', kbps: 256 })
    assert.deepEqual(ipodAudioFormat(INDIE_SLEAZE_IPOD_ID), { codec: 'aac', kbps: 256 })
    assert.equal(ipodAudioFormat(PUNK), null)
    assert.equal(ipodAudioFormat('original-58ebb78e'), null)
    assert.equal(ipodAudioFormat(undefined), null)
  })

  it('the iPod’s format wins over the Device page setting', () => {
    const off = { enabled: false, targetKbps: 128 as const }
    assert.deepEqual(convertOptionsForIpod(GEN1_IPOD_ID, off), { enabled: true, targetKbps: 320, codec: 'mp3' })
    assert.deepEqual(convertOptionsForIpod(Y2K_IPOD_ID, undefined), { enabled: true, targetKbps: 256, codec: 'aac' })
  })

  it('every other iPod gets exactly what the Device page passed, the same object', () => {
    const on = { enabled: true, targetKbps: 192 as const }
    assert.equal(convertOptionsForIpod(PUNK, on), on)
    assert.equal(convertOptionsForIpod(undefined, on), on)
    assert.equal(convertOptionsForIpod(PUNK, undefined), undefined)
  })

  it('the sync applies it once it knows which iPod is plugged in, for both sync paths', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'sync-engine', 'index.ts'), 'utf-8')
    const body = src.slice(src.indexOf('async function runSyncToIpod('))
    const at = body.indexOf('convertOptionsForIpod(ipod.device?.id, convertOptions)')
    assert.ok(at > 0, 'runSyncToIpod asks for the iPod’s own format')
    assert.ok(at > body.indexOf('resolveIpodState(gateMount'), 'after the iPod is identified')
    assert.ok(at < body.indexOf("syncOpts?.origin === 'activity-click'"), 'before either engine runs')
  })
})
