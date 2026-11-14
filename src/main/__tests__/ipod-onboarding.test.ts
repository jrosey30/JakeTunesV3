/** Setting up a new iPod — the rules (common/ipod-onboarding.ts): facts in, the next step or a refusal out. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  QUICK_TEST_BYTES, STABLE_READS_NEEDED, bpmLine, buildOnboardingRecord, cardTestPlan, compareFirmware, confirmationMatches,
  confirmationPhrase, coverMismatch, detectHardware, deviceSerial, firmwareFromBuildId, firstSyncEstimate, ipodHealthCheck,
  isModdedStorage, onboardedLine, onboardingChecks, onboardingStep, onboardingWriteRefusal, parseOnboardingDoc, parseSysInfo,
  proofChecklist, recordForWipedIpod,
  type IpodDeviceFacts, type IpodOnboardingRecord, type OnboardingInput, type OnboardingProgress, type OnboardingTarget,
} from '../../common/ipod-onboarding.ts'
import type { IpodDeviceMarker } from '../../common/ipod-identity.ts'

// SysInfo as Jake's own two minis report it (the board, model and software lines), and a 3rd generation.
const SYS_MINI_2G = 'BoardHwName: iPod Q22B\npszSerialNumber: JQ5123ABCDE\nModelNumStr: M9803\nFirewireGuid: 0x000A27001234ABCD\nvisibleBuildID: 0x01418000 (1.4.1)\niPodFamily: 3\nupdaterFamily: 7\n'
const SYS_MINI_1G = 'BoardHwName: iPod Q22\nModelNumStr: P9160\nvisibleBuildID: 0x01418000 (1.4.1)\niPodFamily: 3\n'
const SYS_3G = 'BoardHwName: iPod Q14\npszSerialNumber: JQ3456ZZZZZ\nModelNumStr: M9245\nFirewireGuid: 0x000A270000001111\nvisibleBuildID: 0x02308000 (2.3)\niPodFamily: 2\n'

const GB = 1e9
const EIGHTIES = '5e7f7a64-f770-48bd-a3dc-58bca2a6b716'
const Y2K = '842f4c4f-14f2-45b4-9c5d-32c1295604da'
const BANDCAMP = 'a7f82840-2f4a-4efc-9707-28fc08b7a8f3'

function facts(over: Partial<IpodDeviceFacts> = {}): IpodDeviceFacts {
  return {
    volumeLabel: 'IPOD', fs: 'fat32', totalBytes: 249.5 * GB, freeBytes: 249 * GB,
    sysInfo: parseSysInfo(SYS_MINI_2G), usb: { vendor: 'Apple Inc.', productId: 0x1205, serial: '000A27001234ABCD' },
    marker: null, catalog: { present: false, readable: false, songs: null }, musicFiles: 0, firmwareFiles: true, rockbox: false,
    stable: { tried: STABLE_READS_NEEDED, ok: STABLE_READS_NEEDED }, writeTest: { ok: true, bytes: QUICK_TEST_BYTES },
    otherIpods: 0, syncInFlight: false, role: 'hub', ...over,
  }
}
const list = (over: Partial<Extract<OnboardingTarget, { kind: 'list' }>> = {}): OnboardingTarget =>
  ({ kind: 'list', listId: EIGHTIES, listName: "1980's", songs: 193, bytes: 6 * GB, model: '3g', color: null, ...over })
const noProgress: OnboardingProgress = { firstSync: null, listSongs: null, playlists: 'not-built-yet', bpm: null }
const input = (over: Partial<OnboardingInput> = {}): OnboardingInput =>
  ({ facts: facts(), target: null, name: null, typed: null, records: [], progress: noProgress, ...over })
const marker = (over: Partial<IpodDeviceMarker> = {}): IpodDeviceMarker =>
  ({ version: 1, id: EIGHTIES, name: "1980's", color: null, purpose: null, primary: false, createdAt: '2026-11-20T15:00:00.000Z', ...over })
const record = (over: Partial<IpodOnboardingRecord> = {}): IpodOnboardingRecord => ({
  ...buildOnboardingRecord({ listId: EIGHTIES, name: "1980's", facts: facts(), now: '2026-11-20T15:00:00.000Z' }), ...over,
})

describe('which iPod is this', () => {
  test('SysInfo of the red mini, the Original and a 3rd generation', () => {
    const red = parseSysInfo(SYS_MINI_2G)
    assert.equal(red.boardHwName, 'iPod Q22B')
    assert.equal(red.firmware, '1.4.1')
    assert.equal(detectHardware(red, null), 'mini-2g')
    assert.equal(detectHardware(parseSysInfo(SYS_MINI_1G), null), 'mini-1g')
    assert.equal(detectHardware(parseSysInfo(SYS_3G), null), '3g')
    assert.equal(parseSysInfo(SYS_3G).firmware, '2.3')
  })
  test('no SysInfo: the USB product says mini, 3rd generation or Classic; nothing at all is unknown', () => {
    assert.equal(detectHardware(null, { vendor: null, productId: 0x1205, serial: null }), 'mini')
    assert.equal(detectHardware(null, { vendor: null, productId: 0x1201, serial: null }), '3g')
    assert.equal(detectHardware(null, { vendor: null, productId: 0x1261, serial: null }), 'classic')
    assert.equal(detectHardware(parseSysInfo(''), null), 'unknown')
    assert.equal(detectHardware(parseSysInfo('ModelNumStr: MZZZZ\n'), null), 'other')
  })
  test('a model number alone is enough, engraved (P) or not', () => {
    assert.equal(detectHardware(parseSysInfo('ModelNumStr: P9160'), null), 'mini-1g')
    assert.equal(detectHardware(parseSysInfo('ModelNumStr: M8976'), null), '3g')
    assert.equal(detectHardware(parseSysInfo('ModelNumStr: MC297'), null), 'classic')
  })
  test('software version from the build id, with or without the words', () => {
    assert.equal(firmwareFromBuildId('0x01418000 (1.4.1)'), '1.4.1')
    assert.equal(firmwareFromBuildId('0x01418000'), '1.4.1')
    assert.equal(firmwareFromBuildId('0x02308000'), '2.3')
    assert.equal(firmwareFromBuildId('junk'), null)
    assert.equal(compareFirmware('2.1', '2.2'), -1)
    assert.equal(compareFirmware('2.3', '2.2'), 1)
    assert.equal(compareFirmware('1.4.1', '1.4.1'), 0)
    assert.equal(compareFirmware(null, '2.2'), null)
  })
  test('a 249.5 GB card in a mini is a replacement card; 4 GB is stock; an unknown model says nothing', () => {
    assert.equal(isModdedStorage('mini-2g', 249.5 * GB), true)
    assert.equal(isModdedStorage('mini-1g', 4 * GB), false)
    assert.equal(isModdedStorage('3g', 40 * GB), false)
    assert.equal(isModdedStorage('unknown', 249.5 * GB), null)
  })
  test('the body is known by its USB serial; the card’s SysInfo only when there is no other', () => {
    assert.deepEqual(deviceSerial(facts()), { serial: '000A27001234ABCD', source: 'usb' })
    assert.deepEqual(deviceSerial(facts({ usb: null })), { serial: '000A27001234ABCD', source: 'card' })
    assert.equal(deviceSerial(facts({ usb: null, sysInfo: null })), null)
  })
})

describe('refusals: nothing is written, and it says so', () => {
  test('homemini’s and workmini’s apps never set up an iPod', () => {
    const s = onboardingStep(input({ facts: facts({ role: 'replica' }) }))
    assert.equal(s.step, 'refused')
    assert.equal(s.step === 'refused' && s.why, 'not-the-hub')
  })
  test('no iPod, two iPods, a sync running', () => {
    assert.equal((onboardingStep(input({ facts: null })) as { why: string }).why, 'no-ipod')
    const two = onboardingStep(input({ facts: facts({ otherIpods: 1 }) }))
    assert.equal(two.step === 'refused' && two.why, 'two-ipods')
    assert.match(two.step === 'refused' ? two.line : '', /Nothing on it was changed/)
    assert.equal((onboardingStep(input({ facts: facts({ syncInFlight: true }) })) as { why: string }).why, 'sync-running')
  })
  test('the Original is never set up as anything else, whatever list is picked', () => {
    const original = marker({ id: 'original-1a2b3c4d', name: 'Original', primary: true })
    for (const target of [null, list(), { kind: 'new' } as OnboardingTarget]) {
      const s = onboardingStep(input({ facts: facts({ marker: original }), target, typed: "replace 1980's" }))
      assert.equal(s.step === 'refused' && s.why, 'the-original')
    }
  })
  test('a drive that gives no sign of being an iPod is refused', () => {
    const blank = facts({ sysInfo: null, usb: null, firmwareFiles: false })
    const s = onboardingStep(input({ facts: blank, target: list() }))
    assert.equal(s.step === 'refused' && s.why, 'cannot-identify')
    // The files Apple's software leaves on a formatted card are sign enough.
    assert.equal(onboardingStep(input({ facts: { ...blank, firmwareFiles: true } })).step, 'choose-list')
  })
})

describe('the steps, in order', () => {
  test('a new iPod: which list is this?', () => {
    const s = onboardingStep(input())
    assert.equal(s.step, 'choose-list')
    assert.equal(s.step === 'choose-list' && s.suggestListId, null)
  })
  test('the list is Jake’s pick, never the model’s: a 3rd generation takes the list drawn as a mini, and the picture is offered', () => {
    const third = facts({ sysInfo: parseSysInfo(SYS_3G), usb: null, totalBytes: 40 * GB, freeBytes: 39 * GB })
    const y2k = list({ listId: Y2K, listName: 'Y2K', model: 'mini', songs: 352, bytes: 11 * GB })
    assert.equal(onboardingStep(input({ facts: third, target: y2k })).step, 'prepare')
    const offer = coverMismatch(y2k, third)
    assert.equal(offer?.model, '3g')
    assert.match(offer?.line ?? '', /Y2K is drawn as an iPod mini; this is iPod \(3rd generation\)/)
    // The 1980's list is saved as a 3rd generation: on a 3rd generation there is nothing to offer.
    assert.equal(coverMismatch(list(), third), null)
    // A mini taking a list with no picture yet.
    assert.equal(coverMismatch(list({ model: 'default' }), facts())?.model, 'mini')
  })
  test('the two checks that write or wait run before anything else', () => {
    const s = onboardingStep(input({ facts: facts({ stable: null, writeTest: null }), target: list() }))
    assert.equal(s.step, 'checks')
    assert.equal(s.step === 'checks' && s.blocked, false)
  })
  test('an empty mini with every check passed goes straight to set-up: no confirmation is asked', () => {
    const s = onboardingStep(input({ target: list() }))
    assert.equal(s.step, 'prepare')
    assert.ok(s.step === 'prepare' && s.actions.some((a) => /blank song database/.test(a)))
    assert.ok(s.step === 'prepare' && s.actions.some((a) => a === "Name the drive 1980's (the Mac shows 1980'S)."))
    assert.ok(s.step === 'prepare' && s.actions.some((a) => a.includes("this iPod is 1980's and carries 1980's on every plug-in")))
  })
  test('a list name the drive can’t hold asks for a short name, and takes one', () => {
    const bandcamp = list({ listId: BANDCAMP, listName: 'Best of Bandcamp', songs: 888, bytes: 30 * GB, model: 'classic' })
    const ask = onboardingStep(input({ target: bandcamp }))
    assert.equal(ask.step, 'name')
    assert.match(ask.step === 'name' ? ask.line : '', /too long for an iPod’s drive name \(11 characters at most\)/)
    assert.equal(onboardingStep(input({ target: bandcamp, name: 'Bandcamp' })).step, 'prepare')
    const bad = onboardingStep(input({ target: bandcamp, name: 'Best of Bandcamp' }))
    assert.match(bad.step === 'name' ? bad.line : '', /16 characters/)
  })
  test('songs already on it: the typed confirmation names the device, and only the exact words pass', () => {
    const used = facts({ catalog: { present: true, readable: true, songs: 10727 }, musicFiles: 10727 })
    const base = { facts: used, target: list({ listName: 'Eighties' }) }
    const ask = onboardingStep(input(base))
    assert.equal(ask.step, 'confirm')
    assert.equal(ask.step === 'confirm' && ask.phrase, 'replace Eighties')
    assert.match(ask.step === 'confirm' ? ask.why[0] : '', /10,727 songs on this iPod now will be replaced/)
    for (const typed of ['', 'yes', 'replace', 'Replace Eighties', 'replace Y2K', 'replace eighties']) {
      assert.equal(onboardingStep(input({ ...base, typed })).step, 'confirm', typed)
    }
    assert.equal(onboardingStep(input({ ...base, typed: 'replace Eighties' })).step, 'prepare')
    assert.equal(confirmationMatches('Eighties', ' replace  Eighties '), true)
    assert.equal(confirmationPhrase(' punk  Pod '), 'replace punk Pod')
  })
  test('a list that already has an iPod: taking it for another one is said and confirmed', () => {
    const other = record({ serial: 'FFFF000011112222', name: 'Eighties' })
    const s = onboardingStep(input({ target: list({ listName: 'Eighties' }), records: [other] }))
    assert.equal(s.step, 'confirm')
    assert.match(s.step === 'confirm' ? s.why.join(' ') : '', /already on another iPod \(Eighties, set up Nov 20, 2026\)/)
  })
  test('the same iPod wiped and plugged back in is offered its list, with nothing to confirm', () => {
    const rec = record({ name: 'Eighties' })
    assert.equal(recordForWipedIpod(facts(), [rec])?.listId, EIGHTIES)
    const ask = onboardingStep(input({ records: [rec] }))
    assert.equal(ask.step === 'choose-list' && ask.suggestListId, EIGHTIES)
    assert.match(ask.step === 'choose-list' ? ask.line : '', /looks like Eighties, wiped/)
    assert.equal(onboardingStep(input({ records: [rec], target: list({ listName: 'Eighties' }) })).step, 'prepare')
    // A released record (the iPod was moved to another list) is not offered.
    assert.equal(recordForWipedIpod(facts(), [{ ...rec, released: true }]), null)
  })
  test('moving an iPod that carries one list to another is confirmed by name', () => {
    const y2k = marker({ id: Y2K, name: 'Y2K' })
    const used = facts({ marker: y2k, catalog: { present: true, readable: true, songs: 352 }, musicFiles: 352 })
    const s = onboardingStep(input({ facts: used, target: list({ listName: 'Eighties' }) }))
    assert.equal(s.step, 'confirm')
    assert.ok(s.step === 'confirm' && s.why.some((w) => /will stop being Y2K and become Eighties/.test(w)))
  })
  test('after set-up: first sync, then the checklist on the iPod, then done', () => {
    const mine = facts({ marker: marker({ name: 'Eighties' }), catalog: { present: true, readable: true, songs: 0 } })
    const first = onboardingStep(input({ facts: mine, target: list({ listName: 'Eighties' }) }))
    assert.equal(first.step, 'first-sync')
    assert.match(first.step === 'first-sync' ? first.line : '', /Press Sync Eighties/)
    assert.match(first.step === 'first-sync' ? first.estimate ?? '' : '', /193 songs, 6 GB: about \d+ minutes to \d+ minutes/)

    const synced = { ...noProgress, firstSync: { songs: 193, at: '2026-11-20T16:00:00.000Z' } }
    const proof = onboardingStep(input({ facts: mine, records: [record({ name: 'Eighties' })], progress: synced }))
    assert.equal(proof.step, 'proof')
    assert.equal(proof.step === 'proof' && proof.checklist[0], 'Settings > About: Songs reads 193.')

    const sealed = record({ name: 'Eighties', sealedAt: '2026-11-20T17:00:00.000Z', lastSyncedAt: '2026-11-20T16:00:00.000Z' })
    const done = onboardingStep(input({ facts: mine, records: [sealed], progress: { ...synced, bpm: { checked: 183, total: 193 } } }))
    assert.equal(done.step, 'done')
    assert.match(done.step === 'done' ? done.lines.join('\n') : '', /183 of 193 songs on Eighties are checked/)
  })
})

describe('the checks', () => {
  const status = (f: IpodDeviceFacts, id: string, t: OnboardingTarget | null = list()) => onboardingChecks(f, t).find((c) => c.id === id)!
  const blocked = (f: IpodDeviceFacts, t: OnboardingTarget = list()) => {
    const s = onboardingStep(input({ facts: f, target: t }))
    return s.step === 'checks' && s.blocked
  }
  test('a mini on 1.4.1, FAT32, steady, test passed: nothing stops', () => {
    assert.deepEqual(onboardingChecks(facts(), list()).filter((c) => c.status === 'stop'), [])
    assert.equal(status(facts(), 'storage').status, 'warn', 'a 249.5 GB card is said to be a replacement card')
    assert.equal(status(facts(), 'fits').status, 'ok')
  })
  test('a Classic stops: its database must be signed', () => {
    const classic = facts({ sysInfo: null, usb: { vendor: 'Apple Inc.', productId: 0x1261, serial: 'C' } })
    assert.equal(status(classic, 'model').status, 'stop')
    assert.equal(blocked(classic), true)
  })
  test('Rockbox stops, and says Apple’s software is still there', () => {
    assert.equal(status(facts({ rockbox: true }), 'firmware').status, 'stop')
    assert.match(status(facts({ rockbox: true }), 'firmware').line, /only you can run in Terminal/)
    assert.equal(blocked(facts({ rockbox: true })), true)
  })
  test('a Mac-formatted iPod stops; JakeTunes never formats', () => {
    const hfs = status(facts({ fs: 'hfs' }), 'format')
    assert.equal(hfs.status, 'stop')
    assert.match(hfs.line, /erases the iPod, and JakeTunes doesn’t do that for you\. Nothing was changed\./)
    assert.equal(blocked(facts({ fs: 'exfat' })), true)
  })
  test('a 3rd generation on old software is warned about lossless; on 2.3 it is fine', () => {
    const old = facts({ sysInfo: parseSysInfo(SYS_3G.replace('0x02308000 (2.3)', '0x02108000 (2.1)')), usb: null, totalBytes: 40 * GB })
    assert.equal(status(old, 'firmware').status, 'warn')
    assert.match(status(old, 'firmware').line, /plays Apple Lossless from 2\.2 on/)
    assert.equal(status(facts({ sysInfo: parseSysInfo(SYS_3G), usb: null, totalBytes: 40 * GB }), 'firmware').status, 'ok')
  })
  test('a connection that dropped even once in eight looks stops the set-up', () => {
    const flappy = facts({ stable: { tried: 8, ok: 7 } })
    assert.equal(status(flappy, 'connection').status, 'stop')
    assert.match(status(flappy, 'connection').line, /dropped off the Mac 1 time in 8 looks/)
    assert.equal(blocked(flappy), true)
    assert.equal(status(facts({ stable: { tried: 3, ok: 3 } }), 'connection').status, 'stop', 'three looks is not enough')
  })
  test('a card that didn’t keep the test file stops', () => {
    const bad = facts({ writeTest: { ok: false, bytes: QUICK_TEST_BYTES, reason: 'test file 1 of 1 came back different 12 MB in' } })
    assert.equal(status(bad, 'write-test').status, 'stop')
    assert.equal(blocked(bad), true)
  })
  test('a list bigger than the iPod stops; an empty list only warns', () => {
    const stock = facts({ totalBytes: 4 * GB, freeBytes: 3.9 * GB })
    assert.equal(status(stock, 'fits').status, 'stop')
    assert.match(status(stock, 'fits').line, /needs 6 GB and this iPod holds 4 GB/)
    assert.equal(status(facts(), 'fits', list({ songs: 0, bytes: null })).status, 'warn')
  })
  test('battery and disk health are said to be unreadable, never guessed', () => {
    assert.equal(status(facts(), 'battery').status, 'unknown')
  })
})

describe('every later plug-in', () => {
  const mine = facts({ marker: marker({ name: 'Eighties' }), catalog: { present: true, readable: true, songs: 193 }, freeBytes: 30 * GB })
  const rec = record({ name: 'Eighties', lastSyncedAt: '2026-11-21T10:00:00.000Z' })
  const last = { sealed: true, songs: 193 }
  const verdict = (f: IpodDeviceFacts, r: IpodOnboardingRecord | null = rec, l: { sealed: boolean; songs: number } | null = last) =>
    ipodHealthCheck({ facts: f, record: r, list: { name: "1980's", songs: 193 }, lastSync: l })

  test('the same iPod, readable, room, last sync sealed: ok', () => {
    const h = verdict(mine)
    assert.equal(h.verdict, 'ok')
    assert.match(h.checks[0].line, /Eighties\. Set up Nov 20, 2026 · last synced Nov 21, 2026\./)
  })
  test('the card in a different iPod body stops', () => {
    const h = verdict({ ...mine, usb: { vendor: 'Apple Inc.', productId: 0x1205, serial: 'AAAA0000BBBB1111' } })
    assert.equal(h.verdict, 'stop')
    assert.match(h.checks[0].line, /it is in a different iPod than the one set up on Nov 20, 2026/)
  })
  test('a drive of a different size is a different card', () => {
    assert.equal(verdict({ ...mine, totalBytes: 128 * GB }).verdict, 'stop')
  })
  test('a database that lists a different count than the last sync is said; one that can’t be read stops', () => {
    const drift = verdict({ ...mine, catalog: { present: true, readable: true, songs: 103 } })
    assert.equal(drift.verdict, 'warn')
    assert.match(drift.checks.find((c) => c.id === 'database')!.line, /lists 103 songs; the last sync put 193 on/)
    assert.equal(verdict({ ...mine, catalog: { present: true, readable: false, songs: null } }).verdict, 'stop')
    assert.equal(verdict({ ...mine, catalog: { present: false, readable: false, songs: null } }).verdict, 'stop')
  })
  test('no room, an unfinished sync, no ID file', () => {
    assert.equal(verdict({ ...mine, freeBytes: 50 * 1024 * 1024 }).verdict, 'stop')
    assert.equal(verdict(mine, rec, { sealed: false, songs: 0 }).verdict, 'warn')
    assert.equal(verdict({ ...mine, marker: null }).verdict, 'stop')
  })
  test('the list grew since the last sync: ok, and ready to sync', () => {
    const h = ipodHealthCheck({ facts: mine, record: rec, list: { name: "1980's", songs: 200 }, lastSync: last })
    assert.equal(h.verdict, 'ok')
    assert.match(h.checks.find((c) => c.id === 'last-sync')!.line, /193 on the iPod, 200 on the list/)
  })
})

describe('the write guard', () => {
  const original = marker({ id: 'original-1a2b3c4d', name: 'Original', primary: true })
  test('the Original on the card stops every write, whatever the checks saw', () => {
    for (const at of [null, original, marker()]) {
      assert.match(onboardingWriteRefusal({ markerNow: original, markerAtChecks: at, otherIpods: 0, syncInFlight: false }) ?? '', /your Original/)
    }
  })
  test('a card whose ID changed since the checks, a second iPod, a running sync', () => {
    assert.match(onboardingWriteRefusal({ markerNow: marker({ id: Y2K }), markerAtChecks: null, otherIpods: 0, syncInFlight: false }) ?? '', /changed since it was checked/)
    assert.match(onboardingWriteRefusal({ markerNow: null, markerAtChecks: marker(), otherIpods: 0, syncInFlight: false }) ?? '', /changed since it was checked/)
    assert.match(onboardingWriteRefusal({ markerNow: null, markerAtChecks: null, otherIpods: 1, syncInFlight: false }) ?? '', /Two iPods/)
    assert.match(onboardingWriteRefusal({ markerNow: null, markerAtChecks: null, otherIpods: 0, syncInFlight: true }) ?? '', /sync is running/)
    assert.equal(onboardingWriteRefusal({ markerNow: null, markerAtChecks: null, otherIpods: 0, syncInFlight: false }), null)
    assert.equal(onboardingWriteRefusal({ markerNow: marker(), markerAtChecks: marker(), otherIpods: 0, syncInFlight: false }), null)
  })
})

describe('the record and the words', () => {
  test('a record survives the disk and the wire; junk is dropped, a list is never there twice', () => {
    const rec = record()
    const back = parseOnboardingDoc(JSON.parse(JSON.stringify({ version: 1, devices: [rec, rec, { listId: 'x' }, null, 'nope'] })))
    assert.deepEqual(back, [rec])
    assert.equal(rec.hardware, 'mini-2g')
    assert.equal(rec.firmware, '1.4.1')
    assert.equal(rec.serialSource, 'usb')
    assert.equal(rec.history[0].event, 'set-up')
    assert.deepEqual(parseOnboardingDoc({ devices: 'no' }), [])
  })
  test('setting the same list up again keeps its history', () => {
    const again = buildOnboardingRecord({ listId: EIGHTIES, name: "1980's", facts: facts(), now: '2026-12-01T00:00:00.000Z', previous: record() })
    assert.deepEqual(again.history.map((h) => h.event), ['set-up', 'set-up-again'])
    assert.equal(again.sealedAt, null, 'a set-up again has to be checked again')
  })
  test('the line every Mac and the phone can show', () => {
    assert.equal(onboardedLine(null), 'No iPod carries this list yet')
    assert.equal(onboardedLine(record()), 'Set up Nov 20, 2026 · not synced yet')
    assert.equal(onboardedLine(record({ lastSyncedAt: '2026-11-21T10:00:00.000Z' })), 'Set up Nov 20, 2026 · last synced Nov 21, 2026')
    assert.equal(onboardedLine(record({ released: true })), 'No iPod carries this list yet')
  })
  test('the checklist, the estimate, the BPM line', () => {
    const c = proofChecklist('Eighties', 1193, 'on-the-ipod')
    assert.equal(c[0], 'Settings > About: Songs reads 1,193.')
    assert.match(c[1], /Eighties’s list is first, then the default playlists/)
    assert.match(c[2], /very last song/)
    assert.equal(firstSyncEstimate(0, 5), null)
    assert.equal(firstSyncEstimate(10, null), null)
    assert.match(firstSyncEstimate(829, 28 * GB) ?? '', /829 songs, 28 GB: about 39 minutes to 2 hours/)
    assert.equal(bpmLine('Y2K', null), 'BPM and key check for Y2K: not known yet.')
    assert.equal(bpmLine('Y2K', { checked: 352, total: 352 }), 'BPM and key check: all 352 songs on Y2K are checked.')
  })
  test('the card test: the quick one is 64 MB; the full one fills the free space in files FAT32 can hold', () => {
    const quick = cardTestPlan(249 * GB, { quick: true })
    assert.equal(quick?.totalBytes, QUICK_TEST_BYTES)
    const full = cardTestPlan(249 * GB)
    assert.equal(full?.fileBytes, 1024 ** 3)
    assert.ok(full && full.totalBytes <= 249 * GB - 300 * 1024 * 1024 && full.totalBytes > 247 * GB)
    assert.match(full?.line ?? '', /Songs already on the iPod are not touched/)
    assert.equal(cardTestPlan(100 * 1024 * 1024), null, 'no room to test is said, not attempted')
  })
})
