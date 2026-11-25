/**
 * Each iPod's own audio format, as a stored profile (Brief 265 Part 2; Jake's table,
 * 2026-11-24). Seeds: both Minis ALAC, Y2KPod ALAC, iBANDCAMP ALAC, IndieSleaze AAC 256,
 * Gen 1 MP3 320.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  adoptProfile, carryProfileOnMove, convertOptionsForIpod, convertOptionsForProfile, parseProfileStore, resolveIpodAudioProfile, serialProfileKey,
  GEN1_IPOD_ID, IBANDCAMP_IPOD_ID, INDIE_SLEAZE_IPOD_ID, PUNK_IPOD_ID, Y2K_IPOD_ID,
} from '../../common/ipod-audio-format.ts'
import { planSwap, type SwapCandidate, type SwapManifestRow } from '../ipod-swap-sync.ts'

const PUNK = PUNK_IPOD_ID

describe('profile resolution', () => {
  it('seeds are Jake\'s table: Minis ALAC, Y2KPod ALAC, IndieSleaze AAC 256, Gen 1 MP3 320', () => {
    assert.deepEqual(resolveIpodAudioProfile({}, { deviceId: GEN1_IPOD_ID }), { codec: 'mp3', kbps: 320, enabled: true })
    assert.deepEqual(resolveIpodAudioProfile({}, { deviceId: Y2K_IPOD_ID }), { codec: 'alac', enabled: true })
    assert.deepEqual(resolveIpodAudioProfile({}, { deviceId: INDIE_SLEAZE_IPOD_ID }), { codec: 'aac', kbps: 256, enabled: true })
    assert.deepEqual(resolveIpodAudioProfile({}, { deviceId: PUNK }), { codec: 'alac', enabled: true })
    assert.deepEqual(resolveIpodAudioProfile({}, { deviceId: 'original-58ebb78e', primary: true }), { codec: 'alac', enabled: true })
  })

  it('iBANDCAMP is ALAC, as it is today (Jake: "stays as it is")', () => {
    assert.deepEqual(resolveIpodAudioProfile({}, { deviceId: IBANDCAMP_IPOD_ID }), { codec: 'alac', enabled: true })
  })

  it('an unknown iPod has no seed: it follows the Device page as today', () => {
    assert.equal(resolveIpodAudioProfile({}, { deviceId: 'someone-new' }), null)
    assert.equal(resolveIpodAudioProfile({}, {}), null)
    const on = { enabled: true, targetKbps: 192 as const }
    assert.equal(convertOptionsForProfile(null, on), on, 'the same object: nothing changed')
  })

  it('AAC 320 is a valid profile (IndieSleaze may move to it): one stored value, no code change', () => {
    const store = parseProfileStore({ [INDIE_SLEAZE_IPOD_ID]: { codec: 'aac', kbps: 320, enabled: true } })
    assert.deepEqual(convertOptionsForProfile(resolveIpodAudioProfile(store, { deviceId: INDIE_SLEAZE_IPOD_ID }), undefined),
      { enabled: true, targetKbps: 320, codec: 'aac' })
  })

  it('a stored profile wins over the seed', () => {
    const store = parseProfileStore({ [Y2K_IPOD_ID]: { codec: 'aac', kbps: 192, enabled: true } })
    assert.deepEqual(resolveIpodAudioProfile(store, { deviceId: Y2K_IPOD_ID }), { codec: 'aac', kbps: 192, enabled: true })
  })

  it('a profile switched off follows the Device page', () => {
    const store = parseProfileStore({ [INDIE_SLEAZE_IPOD_ID]: { codec: 'aac', kbps: 256, enabled: false } })
    const off = { enabled: false, targetKbps: 128 as const }
    assert.equal(convertOptionsForProfile(resolveIpodAudioProfile(store, { deviceId: INDIE_SLEAZE_IPOD_ID }), off), off)
  })

  it('malformed stored values are dropped, never synced', () => {
    assert.deepEqual(parseProfileStore({ a: { codec: 'flac' }, b: { codec: 'aac', kbps: 999 }, c: 'x', d: { codec: 'alac' } }),
      { d: { codec: 'alac', enabled: true } })
    assert.deepEqual(parseProfileStore(null), {})
    assert.deepEqual(parseProfileStore([1, 2]), {})
  })
})

describe('what a sync converts', () => {
  it('ALAC converts nothing, whatever the Device page says', () => {
    const on = { enabled: true, targetKbps: 256 as const }
    assert.deepEqual(convertOptionsForIpod(Y2K_IPOD_ID, on), { enabled: false, targetKbps: 256 })
    const off = { enabled: false, targetKbps: 128 as const }
    assert.equal(convertOptionsForIpod(Y2K_IPOD_ID, off), off, 'already off: the same object')
  })
  it('AAC and MP3 iPods convert at their own bitrate', () => {
    const off = { enabled: false, targetKbps: 128 as const }
    assert.deepEqual(convertOptionsForIpod(GEN1_IPOD_ID, off), { enabled: true, targetKbps: 320, codec: 'mp3' })
    assert.deepEqual(convertOptionsForIpod(INDIE_SLEAZE_IPOD_ID, undefined), { enabled: true, targetKbps: 256, codec: 'aac' })
  })
  it('an iPod with no profile gets exactly what the Device page passed, the same object', () => {
    const on = { enabled: true, targetKbps: 192 as const }
    assert.equal(convertOptionsForIpod('someone-new', on), on)
    assert.equal(convertOptionsForIpod(undefined, on), on)
    assert.equal(convertOptionsForIpod('someone-new', undefined), undefined)
  })
})

describe('the profile follows the physical iPod (its serial), not the list', () => {
  // Real shapes: the ID file's id IS the homemini list id; the serial is the set-up record's.
  const LIST = Y2K_IPOD_ID
  const SERIAL_A = '00577CC6'
  const SERIAL_B = '8K6251ZPV9M'
  it('a profile under the serial wins over the list id and the seed', () => {
    const store = parseProfileStore({ 'serial:00577CC6': { codec: 'aac', kbps: 320, enabled: true }, [LIST]: { codec: 'mp3', kbps: 320, enabled: true } })
    assert.deepEqual(resolveIpodAudioProfile(store, { serial: SERIAL_A, deviceId: LIST }), { codec: 'aac', kbps: 320, enabled: true })
    assert.equal(serialProfileKey(' 00577cc6 '), 'serial:00577CC6')
  })
  it('a list-id profile is moved onto the serial the first time both are known, never copied', () => {
    const store = parseProfileStore({ [LIST]: { codec: 'aac', kbps: 192, enabled: true } })
    const next = adoptProfile(store, { serial: SERIAL_A, deviceId: LIST })
    assert.deepEqual(next, { 'serial:00577CC6': { codec: 'aac', kbps: 192, enabled: true } })
    assert.equal(adoptProfile(next!, { serial: SERIAL_A, deviceId: LIST }), null, 'twice is a no-op')
    assert.equal(adoptProfile(store, { deviceId: LIST }), null, 'no serial: nothing to adopt onto')
  })
  it('two cards on one list never share a profile: the second card gets the seed, not the first card\'s', () => {
    const adopted = adoptProfile(parseProfileStore({ [LIST]: { codec: 'aac', kbps: 192, enabled: true } }), { serial: SERIAL_A, deviceId: LIST })!
    assert.deepEqual(resolveIpodAudioProfile(adopted, { serial: SERIAL_A, deviceId: LIST }), { codec: 'aac', kbps: 192, enabled: true })
    assert.deepEqual(resolveIpodAudioProfile(adopted, { serial: SERIAL_B, deviceId: LIST }), { codec: 'alac', enabled: true }, 'card B: the Y2KPod seed')
  })
  it('a renamed or recreated list keeps the card\'s profile (keyed by serial)', () => {
    const store = parseProfileStore({ 'serial:00577CC6': { codec: 'aac', kbps: 256, enabled: true } })
    assert.deepEqual(resolveIpodAudioProfile(store, { serial: SERIAL_A, deviceId: 'list-recreated-0001' }), { codec: 'aac', kbps: 256, enabled: true })
  })
  it('a card moved to another list: a serial profile stays with it; a list-keyed one is carried to the new list id', () => {
    const bySerial = parseProfileStore({ 'serial:00577CC6': { codec: 'aac', kbps: 256, enabled: true } })
    assert.equal(carryProfileOnMove(bySerial, { fromId: LIST, toId: INDIE_SLEAZE_IPOD_ID, serial: SERIAL_A }), null)
    assert.deepEqual(resolveIpodAudioProfile(bySerial, { serial: SERIAL_A, deviceId: INDIE_SLEAZE_IPOD_ID }), { codec: 'aac', kbps: 256, enabled: true })
    const byList = parseProfileStore({ [LIST]: { codec: 'aac', kbps: 192, enabled: true } })
    assert.deepEqual(carryProfileOnMove(byList, { fromId: LIST, toId: INDIE_SLEAZE_IPOD_ID }), { [INDIE_SLEAZE_IPOD_ID]: { codec: 'aac', kbps: 192, enabled: true } })
    // With a serial and a list-keyed profile, the move puts it under the serial.
    assert.deepEqual(carryProfileOnMove(byList, { fromId: LIST, toId: INDIE_SLEAZE_IPOD_ID, serial: SERIAL_A }), { 'serial:00577CC6': { codec: 'aac', kbps: 192, enabled: true } })
  })
})

describe('ALAC on an ALAC profile is never re-copied (Y2KPod, iBANDCAMP)', () => {
  // The shapes of their real last syncs, checked against this Mac's library (2026-11-24):
  // Y2KPod 370 masters as is + 45 iPod-safe ALAC rescues; iBANDCAMP 3,984 + 1,376. 0 differ.
  for (const [name, id, asIs, rescues] of [['Y2KPod', Y2K_IPOD_ID, 370, 45], ['iBANDCAMP', IBANDCAMP_IPOD_ID, 3984, 1376]] as const) {
    it(`${name}: with convert off the copy is the master (or the same rescue), its size is the card's, every song stays`, () => {
      const rows = new Map<number, SwapManifestRow>()
      const candidates: SwapCandidate[] = []
      for (let i = 1; i <= asIs + rescues; i++) {
        const rescue = i > asIs
        const master = 30_000_000 + i
        const onCard = rescue ? 20_000_000 + i : master
        rows.set(i, { id: i, destPath: `:iPod_Control:Music:F01:${i}.m4a`, identity: `fp:sha1:${i.toString(16).padStart(16, '0')}|200000`, size: onCard, sourceSize: master })
        candidates.push({ id: i, destPath: `:iPod_Control:Music:F01:${i}.m4a`, identity: `fp:sha1:${i.toString(16).padStart(16, '0')}|200000`, copySize: onCard, sourceSize: master })
      }
      const opts = convertOptionsForIpod(id, { enabled: true, targetKbps: 256 as const })
      assert.equal(opts?.enabled, false, 'the ALAC profile turns conversion off even with the Device page toggle on')
      const plan = planSwap(candidates, rows)
      assert.equal(plan.stay.size, asIs + rescues)
      assert.deepEqual(plan.arrive, [])
      assert.deepEqual(plan.leave, [])
    })
  }
})

describe('the sync', () => {
  it('applies the profile once it knows which iPod is plugged in, for both sync paths', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'sync-engine', 'index.ts'), 'utf-8')
    const body = src.slice(src.indexOf('async function runSyncToIpod('))
    const at = body.indexOf('const ownFormat = convertOptionsForProfile(audioProfile, convertOptions)')
    assert.ok(at > 0, 'runSyncToIpod asks for the iPod\'s own profile')
    const read = body.indexOf('await profileForSync(profileStorePath(STATE_DIR)')
    assert.ok(read > body.indexOf('resolveIpodState(gateMount'), 'after the iPod is identified')
    assert.ok(at < body.indexOf("syncOpts?.origin === 'activity-click'"), 'before either engine runs')
    assert.match(body, /serial: setupRecord\?\.serial \?\? null, deviceId: ipod\.device\?\.id, primary: !!ipod\.device\?\.primary/)
    // An unreadable profile file refuses the sync before the card is read or written.
    const refuse = body.indexOf('profileStoreRefusal(resolved.reason)')
    assert.ok(refuse > read && refuse < body.indexOf('securePlaysBeforeSync('))
  })

  it('a whole-library sync of an MP3-only iPod is refused before anything is touched', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'sync-engine', 'index.ts'), 'utf-8')
    const body = src.slice(src.indexOf('async function runSyncToIpod('))
    const refuse = body.indexOf("ownFormat?.codec === 'mp3' && syncOpts?.origin !== 'activity-click'")
    assert.ok(refuse > 0)
    assert.match(body, /is set to get MP3 files\. Use Sync to fill it\./, 'describes the profile, not the firmware')
    assert.ok(refuse < body.indexOf('securePlaysBeforeSync('), 'before the card is read or written')
  })

  it('the MP3 converter asks the file, never the library label', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf-8')
    const body = src.slice(src.indexOf('async function buildMp3Mirror('), src.indexOf('async function buildIpodSafeAlacMirror('))
    assert.doesNotMatch(body, /codecByAbsPath/)
    assert.match(body, /endsWith\('\.mp3'\)\) return null/)
  })
})
