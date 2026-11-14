/**
 * Setting up a new iPod (Jake, 2026-11-13: "we need an ipod onboarding
 * protocol, when a new ipod is plugged in for a specific ipod in the ipod
 * section ... so that the ipod can be functioning properly, syncing perfectly,
 * and working the way it was designed").
 *
 * punkPod was set up by hand over two days (2026-09-07 and 2026-11-07/08) and
 * every step below is one that bit then: it arrived running Rockbox, its drive
 * name could hold 11 characters, the card had no song database, the mount
 * dropped in and out, and "About" had to read the list's count before anyone
 * believed the sync. This file is those lessons as rules: what the app knows
 * about the device (facts) goes in, the next step or a plain refusal comes out.
 *
 * The binding: an iPod carries a list when the ID file on its card
 * (common/ipod-identity.ts) has the LIST'S id. homemini keeps the lists, so a
 * planned list ("1980's", no iPod yet) is taken over by writing its id onto the
 * new iPod. Jake picks the list; nothing here guesses a list from a model.
 *
 * Nothing in this file touches a disk. Pure — node --test loads it.
 */
import type { IpodDeviceMarker } from './ipod-identity.ts'
import { FAT_LABEL_MAX, checkIpodName } from './ipod-name.ts'
import type { IpodModel } from './ipod-covers.ts'

// ── What kind of iPod ────────────────────────────────────────────────────────

export type IpodHardware = 'mini-1g' | 'mini-2g' | 'mini' | '3g' | '4g' | 'classic' | 'other' | 'unknown'

/** iPod_Control/Device/SysInfo, the fields this needs. Every one may be missing. */
export interface IpodSysInfo {
  boardHwName: string | null
  modelNumStr: string | null
  serial: string | null
  firewireGuid: string | null
  /** "1.4.1", from visibleBuildID. */
  firmware: string | null
  ipodFamily: number | null
}

/** SysInfo is "Key: value" lines. A missing or empty file is all nulls. */
export function parseSysInfo(text: string | null | undefined): IpodSysInfo {
  const kv = new Map<string, string>()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$/.exec(line)
    if (m && m[2]) kv.set(m[1].toLowerCase(), m[2])
  }
  const get = (k: string): string | null => kv.get(k.toLowerCase()) ?? null
  const fam = get('iPodFamily')
  const famN = fam === null ? NaN : Number(fam)
  return {
    boardHwName: get('BoardHwName'),
    modelNumStr: get('ModelNumStr'),
    serial: get('pszSerialNumber'),
    firewireGuid: get('FirewireGuid'),
    firmware: firmwareFromBuildId(get('visibleBuildID')),
    ipodFamily: Number.isInteger(famN) ? famN : null,
  }
}

/** "0x01418000 (1.4.1)" → "1.4.1"; a bare "0x02308000" → "2.3". */
export function firmwareFromBuildId(raw: string | null | undefined): string | null {
  if (!raw) return null
  const named = /\((\d+(?:\.\d+){1,2})\)/.exec(raw)
  if (named) return named[1]
  const hex = /^0x([0-9a-f]{8})$/i.exec(raw.trim())
  if (!hex) return null
  const v = parseInt(hex[1], 16)
  const major = (v >>> 24) & 0xff
  const minor = (v >>> 20) & 0xf
  const patch = (v >>> 16) & 0xf
  if (major === 0 || major > 9) return null
  return patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`
}

/** -1, 0, 1 for "1.4.1" against "1.4"; null when either isn't a version. */
export function compareFirmware(a: string | null, b: string | null): number | null {
  const parts = (s: string | null) => (s && /^\d+(\.\d+)*$/.test(s) ? s.split('.').map(Number) : null)
  const x = parts(a)
  const y = parts(b)
  if (!x || !y) return null
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

// Board names: Jake's two minis read "iPod Q22" (the 2004 Original, P9160) and
// "iPod Q22B" (the red 2nd-generation, M9803). Q14 is the 3rd generation's
// board and Q21 the 4th's (the iPodLinux hardware tables).
const BOARDS: ReadonlyArray<[RegExp, IpodHardware]> = [
  [/^ipod q22b$/i, 'mini-2g'],
  [/^ipod q22$/i, 'mini-1g'],
  [/^ipod q14/i, '3g'],
  [/^ipod q21/i, '4g'],
]
// Apple's order numbers, without the leading M or P (P = engraved).
const MODEL_NUMBERS: ReadonlyArray<[RegExp, IpodHardware]> = [
  [/^(9160|943[4-7])/, 'mini-1g'],
  [/^980[0-7]/, 'mini-2g'],
  [/^(8946|8948|8976|9244|9245|9460)/, '3g'],
  [/^(9268|9282|9787)/, '4g'],
  [/^(B029|B147|B145|B150|B562|B565|C293|C297)/i, 'classic'],
]
// USB product ids (Apple, vendor 0x05ac) for the disk-mode device.
const USB_PRODUCTS: ReadonlyMap<number, IpodHardware> = new Map([
  [0x1201, '3g'], [0x1203, '4g'], [0x1205, 'mini'], [0x1261, 'classic'],
])

export interface IpodUsbFacts { vendor: string | null; productId: number | null; serial: string | null }

/** Which iPod this is, from the strongest evidence that's there. */
export function detectHardware(sys: IpodSysInfo | null, usb: IpodUsbFacts | null): IpodHardware {
  const board = sys?.boardHwName?.trim()
  if (board) for (const [re, hw] of BOARDS) if (re.test(board)) return hw
  const num = sys?.modelNumStr?.trim().replace(/^[MP]/i, '')
  if (num) for (const [re, hw] of MODEL_NUMBERS) if (re.test(num)) return hw
  const byUsb = usb?.productId != null ? USB_PRODUCTS.get(usb.productId) : undefined
  if (byUsb) return byUsb
  if (sys?.ipodFamily === 3) return 'mini'
  if (board || num || usb?.productId != null) return 'other'
  return 'unknown'
}

export function hardwareName(hw: IpodHardware): string {
  switch (hw) {
    case 'mini-1g': return 'iPod mini (1st generation)'
    case 'mini-2g': return 'iPod mini (2nd generation)'
    case 'mini': return 'iPod mini'
    case '3g': return 'iPod (3rd generation)'
    case '4g': return 'iPod (4th generation)'
    case 'classic': return 'iPod Classic'
    case 'other': return 'an iPod JakeTunes hasn’t worked with'
    case 'unknown': return 'an iPod it can’t name yet'
  }
}

/** The drawing a list wears for this hardware (common/ipod-covers.ts); null = no matching drawing. */
export function coverModelFor(hw: IpodHardware): IpodModel | null {
  if (hw === 'mini' || hw === 'mini-1g' || hw === 'mini-2g') return 'mini'
  if (hw === '3g') return '3g'
  if (hw === 'classic') return 'classic'
  return null
}

/** The biggest disk Apple shipped in it. Anything well past that is a modded card. */
const STOCK_MAX_GB: Partial<Record<IpodHardware, number>> = { 'mini-1g': 4, 'mini-2g': 6, mini: 6, '3g': 40, '4g': 60 }
export function isModdedStorage(hw: IpodHardware, totalBytes: number | null): boolean | null {
  const stock = STOCK_MAX_GB[hw]
  if (stock === undefined || totalBytes === null) return null
  return totalBytes > stock * 1.15 * 1e9
}

// ── Facts ────────────────────────────────────────────────────────────────────

export type IpodFs = 'fat32' | 'hfs' | 'exfat' | 'apfs' | 'other'

/** Everything the app could read off the plugged-in device WITHOUT writing to it. null = couldn't read. */
export interface IpodDeviceFacts {
  /** The drive's name as the Mac shows it. */
  volumeLabel: string | null
  fs: IpodFs | null
  totalBytes: number | null
  freeBytes: number | null
  sysInfo: IpodSysInfo | null
  usb: IpodUsbFacts | null
  /** JakeTunes' ID file on the card. */
  marker: IpodDeviceMarker | null
  /** The song database: there at all, readable, and how many songs it lists. */
  catalog: { present: boolean; readable: boolean; songs: number | null }
  /** Audio files under iPod_Control/Music. */
  musicFiles: number | null
  /** Files Apple's own software leaves in iPod_Control/iTunes when it starts up (iTunesPrefs, iTunesControl). */
  firmwareFiles: boolean
  /** A .rockbox folder, or a USB name that says Rockbox. */
  rockbox: boolean
  /** Asked for the drive `tried` times a moment apart; it answered `ok` times. */
  stable: { tried: number; ok: number } | null
  /** The small write-and-read-back test (main/ipod-onboarding.ts); null = not run yet. */
  writeTest: { ok: boolean; bytes: number; reason?: string } | null
  /** Other iPods plugged in at the same moment. */
  otherIpods: number
  syncInFlight: boolean
  /** Only the MacBook (the hub) works with iPods. */
  role: 'hub' | 'replica'
}

/** Which list this iPod is for. Jake picks; nothing is inferred from the model. */
export type OnboardingTarget =
  | {
      kind: 'list'
      listId: string
      /** The list's name on homemini. */
      listName: string
      songs: number
      /** Bytes those songs take as they'd be copied; null = not known. */
      bytes: number | null
      /** What homemini has saved for the cover. */
      model: IpodModel | null
      color: string | null
    }
  | { kind: 'new' }

/** The best identity for the BODY: the USB serial. SysInfo lives on the card and moves with it. */
export function deviceSerial(f: Pick<IpodDeviceFacts, 'usb' | 'sysInfo'>): { serial: string; source: 'usb' | 'card' } | null {
  const usb = f.usb?.serial?.trim()
  if (usb) return { serial: usb.toUpperCase(), source: 'usb' }
  const card = (f.sysInfo?.firewireGuid || f.sysInfo?.serial || '').trim().replace(/^0x/i, '')
  return card ? { serial: card.toUpperCase(), source: 'card' } : null
}

// ── The record: which physical iPod carries which list ───────────────────────

export const ONBOARDING_FILE = 'ipod-onboarding.json'
export type OnboardingEvent = 'set-up' | 'set-up-again' | 'moved-to-another-list' | 'released' | 'checked'

export interface IpodOnboardingRecord {
  /** The list's id on homemini = the ID file's id on the card. */
  listId: string
  /** The iPod's own name (its drive, its About screen). */
  name: string
  hardware: IpodHardware
  firmware: string | null
  serial: string | null
  serialSource: 'usb' | 'card' | null
  capacityBytes: number | null
  onboardedAt: string
  /** Jake went through the on-device checklist after a sealed first sync. */
  sealedAt: string | null
  lastSyncedAt: string | null
  lastSyncSongs: number | null
  /** No iPod carries this list any more (it was moved to another list). */
  released: boolean
  history: Array<{ at: string; event: OnboardingEvent; note: string }>
}

const ID = /^[a-z0-9-]{6,64}$/
const HARDWARE = new Set<IpodHardware>(['mini-1g', 'mini-2g', 'mini', '3g', '4g', 'classic', 'other', 'unknown'])
const EVENTS = new Set<OnboardingEvent>(['set-up', 'set-up-again', 'moved-to-another-list', 'released', 'checked'])
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/** One record off disk or off the wire; junk is null, never a guess. */
export function parseOnboardingRecord(raw: unknown): IpodOnboardingRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const listId = typeof r.listId === 'string' && ID.test(r.listId) ? r.listId : null
  const name = str(r.name, 40)
  const onboardedAt = str(r.onboardedAt, 40)
  if (!listId || !name || !onboardedAt) return null
  const history = Array.isArray(r.history)
    ? r.history.flatMap((h) => {
        const e = h as Record<string, unknown> | null
        const at = str(e?.at, 40)
        return e && at && EVENTS.has(e.event as OnboardingEvent)
          ? [{ at, event: e.event as OnboardingEvent, note: str(e.note, 300) ?? '' }]
          : []
      }).slice(-50)
    : []
  return {
    listId,
    name,
    hardware: HARDWARE.has(r.hardware as IpodHardware) ? (r.hardware as IpodHardware) : 'unknown',
    firmware: str(r.firmware, 20),
    serial: str(r.serial, 64),
    serialSource: r.serialSource === 'usb' || r.serialSource === 'card' ? r.serialSource : null,
    capacityBytes: num(r.capacityBytes),
    onboardedAt,
    sealedAt: str(r.sealedAt, 40),
    lastSyncedAt: str(r.lastSyncedAt, 40),
    lastSyncSongs: num(r.lastSyncSongs),
    released: r.released === true,
    history,
  }
}

export function parseOnboardingDoc(raw: unknown): IpodOnboardingRecord[] {
  const devices = (raw as { devices?: unknown } | null)?.devices
  if (!Array.isArray(devices)) return []
  const seen = new Set<string>()
  const out: IpodOnboardingRecord[] = []
  for (const d of devices) {
    const rec = parseOnboardingRecord(d)
    if (rec && !seen.has(rec.listId)) { seen.add(rec.listId); out.push(rec) }
  }
  return out
}

/** The record a finished set-up writes. `previous` = this list's earlier record (set up again after a wipe). */
export function buildOnboardingRecord(input: {
  listId: string
  name: string
  facts: IpodDeviceFacts
  now: string
  previous?: IpodOnboardingRecord | null
}): IpodOnboardingRecord {
  const ser = deviceSerial(input.facts)
  const again = !!input.previous && !input.previous.released
  return {
    listId: input.listId,
    name: input.name,
    hardware: detectHardware(input.facts.sysInfo, input.facts.usb),
    firmware: input.facts.sysInfo?.firmware ?? null,
    serial: ser?.serial ?? null,
    serialSource: ser?.source ?? null,
    capacityBytes: input.facts.totalBytes,
    onboardedAt: input.now,
    sealedAt: null,
    lastSyncedAt: null,
    lastSyncSongs: null,
    released: false,
    history: [
      ...(input.previous?.history ?? []),
      { at: input.now, event: again ? 'set-up-again' as const : 'set-up' as const, note: again ? 'the same list, set up again' : '' },
    ].slice(-50),
  }
}

const day = (iso: string | null): string | null => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "Set up Nov 20, 2026 · last synced Nov 21, 2026" — the line every Mac and the phone can show. */
export function onboardedLine(rec: IpodOnboardingRecord | null): string {
  if (!rec || rec.released) return 'No iPod carries this list yet'
  const on = day(rec.onboardedAt)
  const synced = day(rec.lastSyncedAt)
  return `${on ? `Set up ${on}` : 'Set up'} · ${synced ? `last synced ${synced}` : 'not synced yet'}`
}

// ── Checks ───────────────────────────────────────────────────────────────────

export type CheckStatus = 'ok' | 'warn' | 'stop' | 'unknown'
export interface OnboardingCheck { id: string; status: CheckStatus; line: string }

const gb = (bytes: number): string => {
  const g = bytes / 1e9
  return `${g >= 100 ? Math.round(g) : Math.round(g * 10) / 10} GB`
}
const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** How many times the drive must answer in a row before anything is written (the 2026-07 flapping mount). */
export const STABLE_READS_NEEDED = 8
/** The small write test: enough to prove the card keeps what it's given. */
export const QUICK_TEST_BYTES = 64 * 1024 * 1024
/** Room kept free on the card on top of the songs (the song database, the firmware's own files). */
export const CARD_HEADROOM_BYTES = 300 * 1024 * 1024
/** The firmware Jake's two minis run and every catalog rule here was measured on. */
export const MINI_KNOWN_FIRMWARE = '1.4.1'
/** The 3rd generation plays Apple Lossless from 2.2; 2.3 is its last. */
export const THIRD_GEN_LOSSLESS_FIRMWARE = '2.2'

/**
 * The checks, in the order Jake reads them. `stop` = setting up can't go on;
 * `warn` = it can, and here is what to know; `unknown` = couldn't be read.
 */
export function onboardingChecks(facts: IpodDeviceFacts, target: OnboardingTarget | null): OnboardingCheck[] {
  const hw = detectHardware(facts.sysInfo, facts.usb)
  const out: OnboardingCheck[] = []
  const add = (id: string, status: CheckStatus, line: string) => out.push({ id, status, line })

  // Model
  if (hw === 'classic') add('model', 'stop', 'This is an iPod Classic. A Classic only shows songs when the song database is signed for that exact iPod, and JakeTunes can’t sign it yet.')
  else if (hw === 'unknown') add('model', 'unknown', 'The iPod didn’t say which model it is. Setting up can go on, treated as a plain FAT32 iPod; check the picture afterwards.')
  else if (hw === 'other' || hw === '4g') add('model', 'warn', `This is ${hardwareName(hw)}. JakeTunes has only synced minis so far; it will be treated like one.`)
  else add('model', 'ok', `${hardwareName(hw)}${facts.sysInfo?.modelNumStr ? `, model ${facts.sysInfo.modelNumStr}` : ''}.`)

  // Firmware
  const fw = facts.sysInfo?.firmware ?? null
  if (facts.rockbox) add('firmware', 'stop', 'This iPod is running Rockbox, not Apple’s software. Apple’s software is still on it behind Rockbox; removing Rockbox takes two commands that only you can run in Terminal (see the plan). Nothing was changed.')
  else if (!fw) add('firmware', 'unknown', 'The iPod didn’t say which software version it runs. Look at Settings > About on the iPod.')
  else if (hw === '3g' && compareFirmware(fw, THIRD_GEN_LOSSLESS_FIRMWARE) === -1) add('firmware', 'warn', `Software ${fw}. A 3rd-generation iPod plays Apple Lossless from ${THIRD_GEN_LOSSLESS_FIRMWARE} on; on ${fw} lossless songs would be silent. JakeTunes can’t update an iPod’s software.`)
  else if ((hw === 'mini-1g' || hw === 'mini-2g' || hw === 'mini') && fw !== MINI_KNOWN_FIRMWARE) add('firmware', 'warn', `Software ${fw}. Your other minis run ${MINI_KNOWN_FIRMWARE}, the version the song database was tuned on.`)
  else add('firmware', 'ok', `Software ${fw}.`)

  // Format
  if (facts.fs === null) add('format', 'unknown', 'JakeTunes couldn’t read how the drive is formatted.')
  else if (facts.fs === 'fat32') add('format', 'ok', 'Formatted FAT32, the format JakeTunes syncs.')
  else if (facts.fs === 'hfs') add('format', 'stop', 'This iPod is formatted for a Mac (HFS+). JakeTunes syncs FAT32 iPods. Changing the format erases the iPod, and JakeTunes doesn’t do that for you. Nothing was changed.')
  else add('format', 'stop', 'This drive isn’t formatted the way an iPod needs (FAT32). Changing the format erases it, and JakeTunes doesn’t do that for you. Nothing was changed.')

  // Storage
  if (facts.totalBytes === null) add('storage', 'unknown', 'JakeTunes couldn’t read the drive’s size.')
  else {
    const modded = isModdedStorage(hw, facts.totalBytes)
    const recorded = `${gb(facts.totalBytes)}${facts.freeBytes !== null ? `, ${gb(facts.freeBytes)} free` : ''}`
    if (modded) add('storage', 'warn', `The drive says ${recorded}. That’s a replacement card, and some cards claim more than they hold. The first sync reads every song back; the full card test (in the plan) checks the rest.`)
    else add('storage', 'ok', `The drive says ${recorded}.`)
  }

  // Connection
  if (!facts.stable) add('connection', 'unknown', 'The connection hasn’t been checked yet.')
  else if (facts.stable.ok < facts.stable.tried || facts.stable.tried < STABLE_READS_NEEDED) {
    add('connection', 'stop', `The iPod dropped off the Mac ${count(facts.stable.tried - facts.stable.ok, 'time')} in ${facts.stable.tried} looks. Plug it straight into the Mac (no hub), wait for it to settle, and check again. A sync over a connection like this leaves the iPod half-written.`)
  } else add('connection', 'ok', `The connection held for ${facts.stable.tried} looks in a row.`)

  // Write test
  if (!facts.writeTest) add('write-test', 'unknown', `Not run yet: JakeTunes writes a ${Math.round(QUICK_TEST_BYTES / 1048576)} MB test file to the iPod, reads it back, and removes it.`)
  else if (!facts.writeTest.ok) add('write-test', 'stop', `The iPod didn’t keep what was written to it (${facts.writeTest.reason || 'the test file came back different'}). The card or the adapter needs looking at before any music goes on.`)
  else add('write-test', 'ok', 'A test file written to the iPod came back exactly as written.')

  // What's on it now
  const songsOn = facts.catalog.songs ?? 0
  const filesOn = facts.musicFiles ?? 0
  if (facts.catalog.present && !facts.catalog.readable) add('contents', 'warn', 'The iPod has a song database JakeTunes can’t read. Setting up replaces it at the first sync.')
  else if (songsOn > 0 || filesOn > 0) add('contents', 'warn', `The iPod already has ${count(Math.max(songsOn, filesOn), 'song')} on it. The first sync replaces them with the list. You’ll be asked to confirm.`)
  else add('contents', 'ok', facts.catalog.present ? 'The iPod is empty.' : 'The iPod is empty and has no song database yet. Setting up writes a blank one.')

  // The list fits
  if (target?.kind === 'list') {
    if (target.songs === 0) add('fits', 'warn', `${target.listName} has no songs yet. The iPod can be set up now and synced once the list has songs.`)
    else if (target.bytes === null || facts.totalBytes === null) add('fits', 'unknown', `${target.listName} is ${count(target.songs, 'song')}. JakeTunes couldn’t work out whether they fit.`)
    else if (target.bytes + CARD_HEADROOM_BYTES > facts.totalBytes) add('fits', 'stop', `${target.listName} needs ${gb(target.bytes)} and this iPod holds ${gb(facts.totalBytes)}. It won’t fit.`)
    else add('fits', 'ok', `${target.listName} is ${count(target.songs, 'song')}, ${gb(target.bytes)}. It fits with ${gb(facts.totalBytes - target.bytes)} to spare.`)
  }

  // Things no iPod of these years reports over USB
  add('battery', 'unknown', 'Battery and disk health can’t be read from the Mac on these iPods. The play test at the end is the check.')
  return out
}

/** The picture homemini has for the list against the iPod actually plugged in. */
export function coverMismatch(target: OnboardingTarget | null, facts: IpodDeviceFacts): { line: string; model: IpodModel } | null {
  if (target?.kind !== 'list') return null
  const real = coverModelFor(detectHardware(facts.sysInfo, facts.usb))
  if (!real || target.model === real) return null
  const had = target.model && target.model !== 'default' ? `drawn as ${target.model === '3g' ? 'a 3rd-generation iPod' : target.model === 'mini' ? 'an iPod mini' : 'an iPod Classic'}` : 'not drawn as any iPod yet'
  return { model: real, line: `${target.listName} is ${had}; this is ${hardwareName(detectHardware(facts.sysInfo, facts.usb))}. Update the picture to match? The colour stays what you pick.` }
}

// ── The typed confirmation ───────────────────────────────────────────────────

/** What Jake must type, exactly, before anything on the iPod is replaced. It names the device. */
export function confirmationPhrase(deviceName: string): string {
  return `replace ${deviceName.replace(/\s+/g, ' ').trim()}`
}
export function confirmationMatches(deviceName: string, typed: unknown): boolean {
  return typeof typed === 'string' && typed.replace(/\s+/g, ' ').trim() === confirmationPhrase(deviceName)
}

// ── The steps ────────────────────────────────────────────────────────────────

export interface OnboardingProgress {
  /** The first sync's sealed result; null = no sealed sync yet. */
  firstSync: { songs: number; at: string } | null
  /** The list's size now, for the About number. */
  listSongs: number | null
  /** Per-iPod playlists (the defaults and On-The-Go): written by the sync, not built yet, or unknown. */
  playlists: 'on-the-ipod' | 'not-built-yet' | 'unknown'
  /** The nightly BPM and key check for this list (homemini). */
  bpm: { checked: number; total: number } | null
}

export type OnboardingStep =
  /** Nothing to do, or nothing JakeTunes will do. `changed` is always false: a refusal never writes. */
  | { step: 'refused'; why: OnboardingRefusal; line: string }
  | { step: 'choose-list'; line: string; suggestListId: string | null }
  | { step: 'name'; line: string; suggestion: string | null }
  | { step: 'checks'; checks: OnboardingCheck[]; blocked: boolean; line: string }
  | { step: 'confirm'; phrase: string; why: string[] }
  | { step: 'prepare'; actions: string[] }
  | { step: 'first-sync'; line: string; estimate: string | null }
  | { step: 'proof'; checklist: string[]; line: string }
  | { step: 'done'; lines: string[] }

export type OnboardingRefusal =
  | 'not-the-hub' | 'no-ipod' | 'two-ipods' | 'sync-running' | 'the-original' | 'cannot-identify' | 'list-has-an-ipod'

export interface OnboardingInput {
  facts: IpodDeviceFacts | null
  target: OnboardingTarget | null
  /** The iPod's own name (11 characters at most: it is also the drive's name). */
  name: string | null
  /** What Jake typed into the confirmation box. */
  typed: string | null
  records: readonly IpodOnboardingRecord[]
  progress: OnboardingProgress
}

const NOTHING_CHANGED = 'Nothing on it was changed.'

/** Is there enough here to call this device an iPod at all? An unidentifiable drive is never written to. */
export function isIdentifiable(f: IpodDeviceFacts): boolean {
  if (f.marker) return true
  const hw = detectHardware(f.sysInfo, f.usb)
  return hw !== 'unknown' || f.catalog.present || f.firmwareFiles || f.rockbox
}

/** A wiped iPod coming back: no ID file, but the same body or card as a record. */
export function recordForWipedIpod(facts: IpodDeviceFacts, records: readonly IpodOnboardingRecord[]): IpodOnboardingRecord | null {
  if (facts.marker) return null
  const ser = deviceSerial(facts)
  if (!ser) return null
  return records.find((r) => !r.released && r.serial === ser.serial) ?? null
}

function destructiveReasons(facts: IpodDeviceFacts, target: OnboardingTarget, records: readonly IpodOnboardingRecord[]): string[] {
  const why: string[] = []
  const on = Math.max(facts.catalog.songs ?? 0, facts.musicFiles ?? 0)
  if (on > 0) why.push(`The ${count(on, 'song')} on this iPod now will be replaced by the list at the first sync.`)
  if (facts.catalog.present && !facts.catalog.readable) why.push('The song database on it now can’t be read and will be replaced.')
  if (facts.marker && !facts.marker.primary) {
    const to = target.kind === 'list' ? target.listName : 'a new list'
    why.push(`This iPod is ${facts.marker.name} today. It will stop being ${facts.marker.name} and become ${to}.`)
  }
  if (target.kind === 'list') {
    const held = records.find((r) => r.listId === target.listId && !r.released)
    const ser = deviceSerial(facts)
    if (held && !(ser && held.serial === ser.serial)) why.push(`${target.listName} is already on another iPod (${held.name}, set up ${day(held.onboardedAt) ?? 'earlier'}). That iPod will no longer be recognised as ${target.listName}.`)
  }
  return why
}

/** About how long the first copy takes. iPods of these years copy slowly; this is a range, not a promise. */
export function firstSyncEstimate(songs: number, bytes: number | null): string | null {
  if (!songs || bytes === null || bytes <= 0) return null
  const fast = Math.max(1, Math.round(bytes / (12 * 1e6) / 60))
  const slow = Math.max(fast + 1, Math.round(bytes / (4 * 1e6) / 60))
  const span = (m: number) => (m >= 90 ? `${Math.round(m / 6) / 10} hours` : `${m} minutes`)
  return `${count(songs, 'song')}, ${gb(bytes)}: about ${span(fast)} to ${span(slow)}, with the Mac awake and the screen unlocked.`
}

/** The three things to click on the iPod itself, plus the number About must show. */
export function proofChecklist(name: string, songs: number, playlists: OnboardingProgress['playlists']): string[] {
  return [
    `Settings > About: Songs reads ${songs.toLocaleString('en-US')}.`,
    playlists === 'on-the-ipod'
      ? `Music > Playlists: ${name}’s list is first, then the default playlists in their order. Play the first song of the list.`
      : 'Music > Playlists: open the first one and play its first song.',
    'Music > Songs: scroll to the very last song, play it, and skip to the middle of it. It should play without a pause.',
    'Hold the centre button on any song to add it to On-The-Go, then check it is there under Playlists.',
  ]
}

export function bpmLine(listName: string, bpm: OnboardingProgress['bpm']): string {
  if (!bpm || bpm.total === 0) return `BPM and key check for ${listName}: not known yet.`
  if (bpm.checked >= bpm.total) return `BPM and key check: all ${count(bpm.total, 'song')} on ${listName} are checked.`
  return `BPM and key check: ${bpm.checked.toLocaleString('en-US')} of ${count(bpm.total, 'song')} on ${listName} are checked. The rest are checked overnight and stay out of the BPM playlists until then.`
}

/**
 * The whole protocol: facts in, the next step out. Called again after every
 * step with fresh facts, so nothing is remembered that the device could have
 * changed underneath (a replug, a different iPod in the same port).
 */
export function onboardingStep(input: OnboardingInput): OnboardingStep {
  const { facts, target, records, progress } = input
  const refuse = (why: OnboardingRefusal, line: string): OnboardingStep => ({ step: 'refused', why, line })

  if (facts?.role === 'replica') return refuse('not-the-hub', 'Only the MacBook sets up and syncs iPods. On this Mac the iPod lists are playlists.')
  if (!facts) return refuse('no-ipod', 'No iPod is plugged in.')
  if (facts.otherIpods > 0) return refuse('two-ipods', `Two iPods are plugged in. Unplug the one you’re not setting up, so JakeTunes can’t write to the wrong one. ${NOTHING_CHANGED}`)
  if (facts.syncInFlight) return refuse('sync-running', 'A sync is running. Wait for it to finish.')
  if (facts.marker?.primary) return refuse('the-original', `This is ${facts.marker.name}, your Original. It carries the Top 1000 and is never set up as anything else. ${NOTHING_CHANGED}`)
  if (!isIdentifiable(facts)) return refuse('cannot-identify', `JakeTunes can’t tell that this drive is an iPod, so it won’t write to it. If it is one, let it start up fully, then plug it in again. ${NOTHING_CHANGED}`)

  const wiped = recordForWipedIpod(facts, records)
  const boundHere = facts.marker ? records.find((r) => r.listId === facts.marker!.id && !r.released) ?? null : null

  // Already carrying a list, and not being moved to another one: only the tail of the protocol is left.
  if (facts.marker && (!target || (target.kind === 'list' && target.listId === facts.marker.id))) {
    const name = facts.marker.name
    if (!progress.firstSync) {
      const bytes = target?.kind === 'list' ? target.bytes : null
      const songs = target?.kind === 'list' ? target.songs : progress.listSongs ?? 0
      return { step: 'first-sync', line: `${name} is set up. Press Sync ${name} on this page for its first sync.`, estimate: firstSyncEstimate(songs, bytes) }
    }
    if (!boundHere?.sealedAt) {
      return {
        step: 'proof',
        line: `The first sync finished and was read back: ${count(progress.firstSync.songs, 'song')}. Eject ${name}, unplug it, and check these on the iPod itself:`,
        checklist: proofChecklist(name, progress.firstSync.songs, progress.playlists),
      }
    }
    return {
      step: 'done',
      lines: [
        `${name} is set up and checked. ${onboardedLine(boundHere)}.`,
        progress.playlists === 'on-the-ipod'
          ? 'Its default playlists and On-The-Go are on the iPod.'
          : 'Its default playlists arrive with the per-iPod playlists work; On-The-Go lists you build on the iPod come home at each plug-in.',
        bpmLine(name, progress.bpm),
      ],
    }
  }

  if (!target) {
    return {
      step: 'choose-list',
      suggestListId: wiped?.listId ?? null,
      line: wiped
        ? `This looks like ${wiped.name}, wiped. Set it up as ${wiped.name} again, or pick another list.`
        : 'Which iPod is this? Pick the list it will carry, or set it up as a brand-new iPod.',
    }
  }

  // The iPod's own name: it is the drive's name too, so 11 characters at most.
  const suggested = target.kind === 'list' && checkIpodName(target.listName).ok ? target.listName : null
  const nameCheck = checkIpodName(input.name ?? suggested)
  if (!nameCheck.ok) {
    return {
      step: 'name',
      suggestion: suggested,
      line: input.name
        ? nameCheck.error
        : target.kind === 'list'
          ? `“${target.listName}” is too long for an iPod’s drive name (${FAT_LABEL_MAX} characters at most). Give the iPod a short name; the list keeps its own.`
          : 'Give the new iPod a name (11 characters at most: it is the drive’s name too).',
    }
  }

  const checks = onboardingChecks(facts, target)
  const stops = checks.filter((c) => c.status === 'stop')
  const notRun = checks.some((c) => (c.id === 'connection' || c.id === 'write-test') && c.status === 'unknown')
  if (stops.length || notRun) {
    return {
      step: 'checks',
      checks,
      blocked: stops.length > 0,
      line: stops.length
        ? `${count(stops.length, 'thing')} must be fixed before this iPod can be set up. ${NOTHING_CHANGED}`
        : 'Two checks still need to run: the connection, and a small test file that is written, read back and removed.',
    }
  }

  const why = destructiveReasons(facts, target, records)
  if (why.length && !confirmationMatches(nameCheck.name, input.typed)) {
    return { step: 'confirm', phrase: confirmationPhrase(nameCheck.name), why }
  }

  return {
    step: 'prepare',
    actions: [
      'Make the iPod’s folders (they are left alone where they already exist).',
      facts.catalog.present ? 'Keep the song database that’s there; the first sync rewrites it.' : 'Write a blank song database.',
      `Write JakeTunes’ ID file, so this iPod is ${nameCheck.name}${target.kind === 'list' ? ` and carries ${target.listName}` : ''} on every plug-in.`,
      `Name the drive ${nameCheck.name} (the Mac shows ${nameCheck.macShows}).`,
      'Record this iPod (model, software, size, serial) so it is recognised next time, and after a wipe.',
    ],
  }
}

// ── Every later plug-in ──────────────────────────────────────────────────────

export interface HealthInput {
  facts: IpodDeviceFacts
  record: IpodOnboardingRecord | null
  /** homemini's list for this iPod; null = no answer. */
  list: { name: string; songs: number } | null
  /** The last sync as this Mac recorded it. */
  lastSync: { sealed: boolean; songs: number } | null
}
export interface HealthReport { verdict: 'ok' | 'warn' | 'stop'; checks: OnboardingCheck[] }

/** The floor of free space under which a sync is not started. */
export const HEALTH_MIN_FREE_BYTES = 200 * 1024 * 1024

/**
 * The short check on every plug-in of an iPod that has been set up: is it the
 * iPod it says it is, can its song database be read, is there room, and did the
 * last sync finish. `stop` = don't sync until it's looked at.
 */
export function ipodHealthCheck(input: HealthInput): HealthReport {
  const { facts, record, list, lastSync } = input
  const checks: OnboardingCheck[] = []
  const add = (id: string, status: CheckStatus, line: string) => checks.push({ id, status, line })
  const name = facts.marker?.name ?? 'This iPod'

  // Identity
  const ser = deviceSerial(facts)
  if (!facts.marker) add('identity', 'stop', 'This iPod has no JakeTunes ID file. Set it up before it is synced.')
  else if (facts.marker.primary) add('identity', 'ok', `${name}, your Original.`)
  else if (!record) add('identity', 'warn', `${name} has no set-up record on this Mac yet. It is recorded the next time this page is opened.`)
  else if (record.serialSource === 'usb' && ser?.source === 'usb' && record.serial !== ser.serial) {
    add('identity', 'stop', `The card says ${name}, but it is in a different iPod than the one set up on ${day(record.onboardedAt) ?? 'set-up day'}. If you moved the card on purpose, set this iPod up again; otherwise check which iPod this is. ${NOTHING_CHANGED}`)
  } else if (record.capacityBytes && facts.totalBytes && Math.abs(record.capacityBytes - facts.totalBytes) > record.capacityBytes * 0.02) {
    add('identity', 'stop', `${name}’s drive was ${gb(record.capacityBytes)} when it was set up and is ${gb(facts.totalBytes)} now. That is a different card. ${NOTHING_CHANGED}`)
  } else add('identity', 'ok', `${name}. ${onboardedLine(record)}.`)

  // Format
  if (facts.fs !== null && facts.fs !== 'fat32') add('format', 'stop', `${name} is no longer formatted FAT32. ${NOTHING_CHANGED}`)

  // Database
  if (!facts.catalog.present) add('database', lastSync ? 'stop' : 'warn', lastSync ? `${name} has no song database, though it has been synced. It may have been restored; the next sync must be a full copy.` : `${name} has no song database yet.`)
  else if (!facts.catalog.readable) add('database', 'stop', `${name}’s song database can’t be read. The next sync must rewrite it.`)
  else if (lastSync?.sealed && facts.catalog.songs !== lastSync.songs) add('database', 'warn', `${name}’s song database lists ${count(facts.catalog.songs ?? 0, 'song')}; the last sync put ${lastSync.songs.toLocaleString('en-US')} on. Something else wrote to it; the next sync is a full copy.`)
  else add('database', 'ok', `Song database readable: ${count(facts.catalog.songs ?? 0, 'song')}.`)

  // Room
  if (facts.freeBytes === null) add('space', 'unknown', 'Free space couldn’t be read.')
  else if (facts.freeBytes < HEALTH_MIN_FREE_BYTES) add('space', 'stop', `Only ${gb(facts.freeBytes)} free. A sync needs room to write the song database.`)
  else add('space', 'ok', `${gb(facts.freeBytes)} free.`)

  // Last sync
  if (!lastSync) add('last-sync', 'warn', 'Not synced yet.')
  else if (!lastSync.sealed) add('last-sync', 'warn', 'The last sync didn’t finish. The next one is a full copy.')
  else if (list && list.songs !== lastSync.songs) add('last-sync', 'ok', `Last sync finished and was read back. The list has changed since (${lastSync.songs.toLocaleString('en-US')} on the iPod, ${list.songs.toLocaleString('en-US')} on the list): ready to sync.`)
  else add('last-sync', 'ok', 'Last sync finished and was read back.')

  if (facts.rockbox) add('firmware', 'warn', `${name} has a Rockbox folder on it. JakeTunes syncs Apple’s software only.`)

  const verdict = checks.some((c) => c.status === 'stop') ? 'stop' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok'
  return { verdict, checks }
}

// ── The write guard ──────────────────────────────────────────────────────────

/**
 * Asked with the ID file as it is on the card RIGHT NOW, immediately before
 * every write set-up makes. null = go ahead. The Original is never written
 * during a set-up, and a card whose ID changed since the checks is a different
 * card.
 */
export function onboardingWriteRefusal(input: {
  markerNow: IpodDeviceMarker | null
  /** The ID file the checks saw (null = none). */
  markerAtChecks: IpodDeviceMarker | null
  otherIpods: number
  syncInFlight: boolean
}): string | null {
  if (input.markerNow?.primary) return `This is ${input.markerNow.name}, your Original. Setting up another iPod never writes to it. ${NOTHING_CHANGED}`
  if (input.otherIpods > 0) return `Two iPods are plugged in. Unplug the one you’re not setting up. ${NOTHING_CHANGED}`
  if (input.syncInFlight) return 'A sync is running. Wait for it to finish.'
  if ((input.markerNow?.id ?? null) !== (input.markerAtChecks?.id ?? null)) return `The iPod changed since it was checked. Run the checks again. ${NOTHING_CHANGED}`
  return null
}

// ── The full card test (a plan; main/ipod-onboarding.ts runs it) ─────────────

/** FAT32 can't hold a file of 4 GB; test files stay well under. */
export const CARD_TEST_FILE_BYTES = 1024 * 1024 * 1024

/**
 * A card that claims more than it holds wraps around: what is written past its
 * real size lands on top of what was written first. So the test fills the FREE
 * space with files whose contents can be worked out again from their number,
 * and only reads them back once ALL are written. It never touches a file that
 * was already there, and removes its own afterwards.
 */
export function cardTestPlan(freeBytes: number, opts: { quick?: boolean; fileBytes?: number } = {}): { files: number; fileBytes: number; totalBytes: number; line: string } | null {
  const usable = opts.quick ? Math.min(QUICK_TEST_BYTES, freeBytes - CARD_HEADROOM_BYTES) : freeBytes - CARD_HEADROOM_BYTES
  if (!Number.isFinite(usable) || usable < 1024 * 1024) return null
  const fileBytes = Math.min(opts.fileBytes && opts.fileBytes > 0 ? Math.min(opts.fileBytes, CARD_TEST_FILE_BYTES) : CARD_TEST_FILE_BYTES, usable)
  const files = Math.floor(usable / fileBytes)
  const totalBytes = files * fileBytes
  const hours = (totalBytes / (8 * 1e6) / 3600) * 2
  return {
    files,
    fileBytes,
    totalBytes,
    line: opts.quick
      ? `Writes ${Math.round(totalBytes / 1048576)} MB, reads it back, removes it.`
      : `Fills the ${gb(totalBytes)} of free space with test files, reads every one back, then removes them: about ${Math.max(1, Math.round(hours))} hours. Songs already on the iPod are not touched.`,
  }
}

// ── What the set-up strip is told (main/ipc/ipod-onboarding-ipc.ts 'ipod-setup:look') ──

export interface IpodSetupTargetRow {
  listId: string
  listName: string
  songs: number
  model: IpodModel | null
  color: string | null
  /** An iPod already carries this list. */
  hasIpod: boolean
}

export type IpodSetupLook =
  | {
      ok: true
      mounted: boolean
      step: OnboardingStep
      targets: IpodSetupTargetRow[]
      cover: { line: string; model: IpodModel } | null
      health: HealthReport | null
      record: IpodOnboardingRecord | null
    }
  | { ok: false; error: string }
