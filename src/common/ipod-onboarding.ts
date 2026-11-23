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

export type IpodHardware =
  | 'mini-1g' | 'mini-2g' | 'mini' | '3g' | '4g' | 'classic'
  // The colour iPods the album-cover table knows (core/ipod_artwork_models.json), 2026-11-23.
  | 'photo' | 'video' | 'nano-1g' | 'nano-2g'
  | 'other' | 'unknown'

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
// USB product ids (Apple, vendor 0x05ac) for the disk-mode device. Each id is in the
// linux-usb.org usb.ids database (version 2026.06.26, vendor 05ac): 1201 "3G iPod",
// 1203 "iPod 4.Gen Grayscale 40G", 1204 "iPod [Photo]", 1205 "iPod Mini 1.Gen/2.Gen",
// 1209 "iPod Video", 120a "iPod Nano", 1260 "iPod Nano 2.Gen", 1261 "iPod Classic".
// The colour ones are also each model's USB_PRODUCT_ID in Rockbox's
// firmware/export/config/ipod{color,video,nano1g,nano2g}.h. 0x1260 was measured on
// Jake's "Indie Sleaze" nano (ioreg idProduct 4704, 2026-11-23), whose SysInfo was empty:
// before this the app couldn't tell it was a nano and its first sync wrote no covers.
// 0x1204 is the iPod photo and the iPod with colour display (one family in the cover table).
const USB_PRODUCTS: ReadonlyMap<number, IpodHardware> = new Map([
  [0x1201, '3g'], [0x1203, '4g'], [0x1204, 'photo'], [0x1205, 'mini'],
  [0x1209, 'video'], [0x120a, 'nano-1g'], [0x1260, 'nano-2g'], [0x1261, 'classic'],
])

/** The hardware a USB product id names, or null for an id this file doesn't know. */
export function hardwareForUsb(productId: number | null | undefined): IpodHardware | null {
  return productId != null ? USB_PRODUCTS.get(productId) ?? null : null
}

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
    case 'photo': return 'iPod photo'
    case 'video': return 'iPod Video'
    case 'nano-1g': return 'iPod nano (1st generation)'
    case 'nano-2g': return 'iPod nano (2nd generation)'
    case 'other': return 'a kind of iPod JakeTunes hasn’t synced before'
    case 'unknown': return 'an unknown iPod'
  }
}

/** The drawing a list wears for this hardware (common/ipod-covers.ts); null = no matching drawing. */
export function coverModelFor(hw: IpodHardware): IpodModel | null {
  if (hw === 'mini' || hw === 'mini-1g' || hw === 'mini-2g') return 'mini'
  if (hw === '3g') return '3g'
  if (hw === 'classic') return 'classic'
  return null
}

/**
 * The album-cover family (core/ipod_artwork_models.json `family`) for this hardware: a colour
 * family, 'none' for an iPod with no colour screen, or null when this file can't say (the
 * Classic, which the cover table doesn't know; 'other'; 'unknown'). core/ipod_artwork.py still
 * reads SysInfo first; this answers only when the iPod itself names nothing.
 */
export function artworkFamilyFor(hw: IpodHardware): string | null {
  switch (hw) {
    case 'photo': case 'video': case 'nano-1g': case 'nano-2g': return hw
    case 'mini': case 'mini-1g': case 'mini-2g': case '3g': case '4g': return 'none'
    default: return null
  }
}
/** Every colour family artworkFamilyFor can answer (the test holds them to the cover table). */
export const ARTWORK_FAMILIES_BY_HARDWARE: readonly string[] = ['photo', 'video', 'nano-1g', 'nano-2g']

/**
 * Must Jake say which iPod this is before its first sync? Only when nothing else will: the
 * hardware gives no cover family, SysInfo names no model (core/ipod_artwork.py decides from it
 * when it does, covers or none), nothing is remembered or answered, and it isn't the Classic
 * (stopped by its own check). Jake, 2026-11-23, after a nano's first sync wrote no covers:
 * "thats the whole point of the ipod set up. to prevent things like this!!"
 */
export function needsArtworkAnswer(facts: Pick<IpodDeviceFacts, 'sysInfo' | 'usb' | 'artworkFamily'>): boolean {
  if (facts.artworkFamily) return false
  if (facts.sysInfo?.modelNumStr?.trim()) return false
  const hw = detectHardware(facts.sysInfo, facts.usb)
  if (hw === 'classic') return false
  return artworkFamilyFor(hw) === null
}

/** The biggest disk Apple shipped in it. Anything well past that is a modded card. */
const STOCK_MAX_GB: Partial<Record<IpodHardware, number>> = {
  'mini-1g': 4, 'mini-2g': 6, mini: 6, '3g': 40, '4g': 60, photo: 60, video: 80, 'nano-1g': 4, 'nano-2g': 8,
}
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
  /**
   * The drive's own identity as the SYSTEM reports it (volume UUID, the device's serial, its
   * size), never its path or its name: two blank iPods at the same path are two drives.
   * null = the system wouldn't say, and then nothing is written.
   */
  driveId: string | null
  /** The song database: there at all, readable, how many songs it lists, the name it gives the
   *  iPod, and the artists with the most songs on it (for "this is what will be replaced"). */
  catalog: { present: boolean; readable: boolean; songs: number | null; name?: string | null; artists?: string[] }
  /** Why this unmarked iPod looks like the Original (looksLikeOriginal), or null. */
  originalEvidence?: string | null
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
  /** Which iPod this is for album covers, as Jake answered it during set-up or this Mac
   *  remembers it (main/ipod-artwork.ts): a cover family or 'none'. Absent/null = no answer. */
  artworkFamily?: string | null
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
export type OnboardingEvent = 'set-up' | 'set-up-again' | 'moved-to-another-list' | 'released' | 'checked' | 'new-card-or-body'

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
const HARDWARE = new Set<IpodHardware>(['mini-1g', 'mini-2g', 'mini', '3g', '4g', 'classic', 'photo', 'video', 'nano-1g', 'nano-2g', 'other', 'unknown'])
const EVENTS = new Set<OnboardingEvent>(['set-up', 'set-up-again', 'moved-to-another-list', 'released', 'checked', 'new-card-or-body'])
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
  if (hw === 'classic') add('model', 'stop', 'JakeTunes can’t sync an iPod Classic yet.')
  else if (hw === 'unknown') add('model', 'unknown', 'Couldn’t tell which iPod model this is.')
  else if (hw === 'other' || hw === '4g') add('model', 'warn', `This is ${hardwareName(hw)}. JakeTunes has only synced minis so far.`)
  else add('model', 'ok', `${hardwareName(hw)}${facts.sysInfo?.modelNumStr ? `, model ${facts.sysInfo.modelNumStr}` : ''}.`)

  // Album covers: an iPod nothing names could have a colour screen, and its first sync would
  // write no covers (2026-11-23). Jake answers here, before that sync; 'No colour screen' counts.
  if (needsArtworkAnswer(facts)) add('covers', 'stop', 'Which iPod is this?')

  // Firmware
  const fw = facts.sysInfo?.firmware ?? null
  if (facts.rockbox) add('firmware', 'stop', 'This iPod runs Rockbox. Remove Rockbox first.')
  else if (!fw) add('firmware', 'unknown', 'Couldn’t tell which software the iPod runs.')
  else if (hw === '3g' && compareFirmware(fw, THIRD_GEN_LOSSLESS_FIRMWARE) === -1) add('firmware', 'warn', `Software ${fw} won’t play lossless songs. Update the iPod to ${THIRD_GEN_LOSSLESS_FIRMWARE} or later.`)
  else if ((hw === 'mini-1g' || hw === 'mini-2g' || hw === 'mini') && fw !== MINI_KNOWN_FIRMWARE) add('firmware', 'warn', `Software ${fw}. Your other minis run ${MINI_KNOWN_FIRMWARE}.`)
  else add('firmware', 'ok', `Software ${fw}.`)

  // The drive itself
  if (!facts.driveId) add('drive', 'stop', 'Unplug the iPod, plug it back in, and check again.')

  // Format
  if (facts.fs === null) add('format', 'stop', 'Unplug the iPod, plug it back in, and check again.')
  else if (facts.fs === 'fat32') add('format', 'ok', 'Formatted right.')
  // A Mac-formatted iPod runs on HFS+ natively and the Mac writes it, so nothing has to be erased
  // (2026-11-14). Converting one to FAT32 is not a reformat of the data partition: the partition
  // map changes and the firmware partition moves, which a mistake turns into a dead iPod.
  else if (facts.fs === 'hfs') add('format', 'warn', 'Formatted for a Mac. That works; its first sync is the test.')
  else add('format', 'stop', 'This iPod needs erasing first. Restore it in Finder, then plug it back in.')

  // Storage
  if (facts.totalBytes === null) add('storage', 'unknown', 'Couldn’t read the iPod’s size.')
  else {
    const modded = isModdedStorage(hw, facts.totalBytes)
    const recorded = `${gb(facts.totalBytes)}${facts.freeBytes !== null ? `, ${gb(facts.freeBytes)} free` : ''}`
    if (modded) add('storage', 'warn', `${recorded}. A replacement card; the first sync checks it.`)
    else add('storage', 'ok', `${recorded}.`)
  }

  // Connection
  if (!facts.stable) add('connection', 'unknown', 'Checking the connection…')
  else if (facts.stable.ok < facts.stable.tried || facts.stable.tried < STABLE_READS_NEEDED) {
    add('connection', 'stop', 'The iPod keeps dropping off. Plug it straight into the Mac and check again.')
  } else add('connection', 'ok', 'Connection is steady.')

  // Write test
  if (!facts.writeTest) add('write-test', 'unknown', 'Testing the iPod’s card…')
  else if (!facts.writeTest.ok) add('write-test', 'stop', 'The iPod’s card didn’t keep a test file. Replace the card first.')
  else add('write-test', 'ok', 'Card works.')

  // What's on it now
  const songsOn = facts.catalog.songs ?? 0
  const filesOn = facts.musicFiles ?? 0
  if (facts.catalog.present && !facts.catalog.readable) add('contents', 'warn', 'The iPod’s songs can’t be read. The first sync replaces them.')
  else if (songsOn > 0 || filesOn > 0) add('contents', 'warn', `The iPod already has ${count(Math.max(songsOn, filesOn), 'song')} on it. The first sync replaces them with the list. You’ll be asked to confirm.`)
  else add('contents', 'ok', 'The iPod is empty.')

  // The list fits
  if (target?.kind === 'list') {
    if (target.songs === 0) add('fits', 'warn', `${target.listName} has no songs yet.`)
    else if (target.bytes === null || facts.totalBytes === null) add('fits', 'unknown', `Couldn’t tell if ${count(target.songs, 'song')} fit.`)
    else if (target.bytes + CARD_HEADROOM_BYTES > facts.totalBytes) add('fits', 'stop', `${target.listName} needs ${gb(target.bytes)}; this iPod holds ${gb(facts.totalBytes)}.`)
    else add('fits', 'ok', `${count(target.songs, 'song')} fit.`)
  }

  // Things no iPod of these years reports over USB
  // Battery and disk health can't be read over USB on these iPods: nothing to say or do.
  return out
}

/** The picture homemini has for the list against the iPod actually plugged in. */
export function coverMismatch(target: OnboardingTarget | null, facts: IpodDeviceFacts): { line: string; model: IpodModel } | null {
  if (target?.kind !== 'list') return null
  const real = coverModelFor(detectHardware(facts.sysInfo, facts.usb))
  if (!real || target.model === real) return null
  const had = target.model && target.model !== 'default' ? `drawn as ${target.model === '3g' ? 'a 3rd-generation iPod' : target.model === 'mini' ? 'an iPod mini' : 'an iPod Classic'}` : 'not drawn as any iPod yet'
  return { model: real, line: 'Change the picture to match this iPod' }
}

// ── The iPod's own name ──────────────────────────────────────────────────────

/**
 * A short name for the iPod itself, in punkPod's pattern (Jake, 2026-11-14:
 * "figure out a cool looking name"). It is what the drive and the iPod's About
 * screen say; the list keeps the name Jake gave it. A suggestion only: he can
 * type another. null = nothing to suggest (he names it).
 */
export function suggestedIpodName(listName: string): string | null {
  const n = listName.toLowerCase()
  const pick = /sle[ae]ze/.test(n) ? 'sleezePod'
    : /bandcamp/.test(n) ? 'campPod'
      : /y2k|2000/.test(n) ? 'y2kPod'
        : /punk/.test(n) ? 'punkPod'
          : (/\b(?:19)?([2-9]0)[’']?s\b/.exec(n)?.[1] ?? null)
  if (pick && /^\d0$/.test(pick)) return `${pick}sPod`
  if (pick) return pick
  return checkIpodName(listName).ok ? listName.replace(/\s+/g, ' ').trim() : null
}

// ── The Original without its ID file ─────────────────────────────────────────

/**
 * An unmarked iPod that is really the Original (its ID file was lost: a restore, a
 * card repair). It must never be offered as a new iPod. Evidence, any one:
 *   • its serial is the one recorded for the Original;
 *   • at least half of the songs in its database (and at least 20) are songs the
 *     Original's last sync put on;
 *   • its database carries the Original's name AND the drive is the recorded size.
 * Returns the reason in plain words, or null.
 */
export function looksLikeOriginal(input: {
  marker: IpodDeviceMarker | null
  /** The Original as this Mac knows it; null = no Original registered here. */
  original: { name: string; serial: string | null; capacityBytes: number | null } | null
  serial: string | null
  totalBytes: number | null
  catalogName: string | null
  /** Colon paths in the card's database / in the Original's last sync. */
  cardPaths: readonly string[]
  lastSyncPaths: readonly string[]
}): string | null {
  if (input.marker || !input.original) return null
  const o = input.original
  if (o.serial && input.serial && o.serial === input.serial) return `it has ${o.name}’s serial number`
  const norm = (p: string) => p.trim().toLowerCase()
  const last = new Set(input.lastSyncPaths.filter(Boolean).map(norm))
  const card = input.cardPaths.filter(Boolean).map(norm)
  if (last.size && card.length) {
    let shared = 0
    for (const p of card) if (last.has(p)) shared++
    if (shared >= 20 && shared >= 0.5 * Math.min(card.length, last.size)) return `${shared.toLocaleString('en-US')} of the songs on it are songs ${o.name}’s last sync put there`
  }
  const sameSize = !!o.capacityBytes && !!input.totalBytes && Math.abs(o.capacityBytes - input.totalBytes) <= o.capacityBytes * 0.02
  if (sameSize && input.catalogName && input.catalogName.trim().toLowerCase() === o.name.trim().toLowerCase()) return `it calls itself ${o.name} and its drive is ${o.name}’s size`
  return null
}

// ── The typed confirmation ───────────────────────────────────────────────────

/** What Jake must type, exactly, before anything is replaced. It names what will be REPLACED. */
export function confirmationPhrase(replaced: string): string {
  return `replace ${replaced.replace(/\s+/g, ' ').trim()}`
}

/** The name of what is on the iPod now: its JakeTunes name, else the name its own database gives it, else the drive's. */
export function replacedLabel(facts: IpodDeviceFacts): string {
  const name = facts.marker?.name || facts.catalog.name?.trim() || facts.volumeLabel?.trim()
  return name ? name.slice(0, 40) : 'this iPod'
}

/** What is on the iPod now, in the lines the confirmation shows. Empty when nothing is. */
export function whatIsOnIt(facts: IpodDeviceFacts): string[] {
  const songs = Math.max(facts.catalog.songs ?? 0, facts.musicFiles ?? 0)
  const out: string[] = []
  if (facts.marker) out.push(`It’s ${facts.marker.name}.`)
  else if (facts.catalog.name?.trim()) out.push(`It’s called “${facts.catalog.name.trim()}”.`)
  if (songs > 0) out.push(`${count(songs, 'song')} on it.`)
  if (facts.catalog.artists?.length) out.push(`Mostly: ${facts.catalog.artists.slice(0, 5).join(', ')}.`)
  if (facts.catalog.present && !facts.catalog.readable) out.push('Its songs can’t be read.')
  return out
}
export function confirmationMatches(replaced: string, typed: unknown): boolean {
  return typeof typed === 'string' && typed.replace(/\s+/g, ' ').trim() === confirmationPhrase(replaced)
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
  | { step: 'confirm'; phrase: string; why: string[]; onIt: string[] }
  | { step: 'prepare'; actions: string[]; name: string }
  | { step: 'first-sync'; line: string; estimate: string | null }
  | { step: 'proof'; checklist: string[]; line: string }
  | { step: 'done'; lines: string[] }

export type OnboardingRefusal =
  | 'not-the-hub' | 'no-ipod' | 'two-ipods' | 'sync-running' | 'the-original' | 'looks-like-the-original' | 'cannot-identify'

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
  if (on > 0) why.push(`The ${count(on, 'song')} on it will be replaced.`)
  if (facts.catalog.present && !facts.catalog.readable && on === 0) why.push('What’s on it will be replaced.')
  if (facts.marker && !facts.marker.primary) {
    const to = target.kind === 'list' ? target.listName : 'a new list'
    why.push(`It stops being ${facts.marker.name} and becomes ${to}.`)
  }
  if (target.kind === 'list') {
    const held = records.find((r) => r.listId === target.listId && !r.released)
    const ser = deviceSerial(facts)
    if (held && !(ser && held.serial === ser.serial)) why.push(`${held.name} stops being ${target.listName}.`)
  }
  return why
}

/** About how long the first copy takes. iPods of these years copy slowly; this is a range, not a promise. */
export function firstSyncEstimate(songs: number, bytes: number | null): string | null {
  if (!songs || bytes === null || bytes <= 0) return null
  const fast = Math.max(1, Math.round(bytes / (12 * 1e6) / 60))
  const slow = Math.max(fast + 1, Math.round(bytes / (4 * 1e6) / 60))
  const span = (m: number) => (m >= 90 ? `${Math.round(m / 6) / 10} hours` : `${m} minutes`)
  return `It takes about ${span(fast)} to ${span(slow)}. Keep the Mac awake.`
}

/** The shortest honest proof (Jake, 2026-11-14: "less red tape the better, but ensure success"):
 *  the count the iPod's own software indexed, and the last song written, played. */
export function proofChecklist(_name: string, songs: number, _playlists: OnboardingProgress['playlists']): string[] {
  // One check, said in the proof step's own line (Jake, 2026-11-19: "it needs to be simple").
  return [`Settings › About should say ${songs.toLocaleString('en-US')}.`]
}

export function bpmLine(listName: string, bpm: OnboardingProgress['bpm']): string {
  if (!bpm || bpm.total === 0) return ''
  if (bpm.checked >= bpm.total) return ''
  return `The BPM playlists for ${listName} fill in overnight.`
}

/**
 * The whole protocol: facts in, the next step out. Called again after every
 * step with fresh facts, so nothing is remembered that the device could have
 * changed underneath (a replug, a different iPod in the same port).
 */
export function onboardingStep(input: OnboardingInput): OnboardingStep {
  const { facts, target, records, progress } = input
  const refuse = (why: OnboardingRefusal, line: string): OnboardingStep => ({ step: 'refused', why, line })

  if (facts?.role === 'replica') return refuse('not-the-hub', 'Sync iPods on the MacBook.')
  if (!facts) return refuse('no-ipod', 'Plug in the iPod.')
  if (facts.otherIpods > 0) return refuse('two-ipods', 'Two iPods are plugged in. Unplug one.')
  if (facts.syncInFlight) return refuse('sync-running', 'Wait for the sync to finish.')
  if (facts.marker?.primary) return refuse('the-original', `This is ${facts.marker.name}, your Original.`)
  if (facts.originalEvidence) return refuse('looks-like-the-original', 'This looks like your Original.')
  if (!isIdentifiable(facts)) return refuse('cannot-identify', 'This doesn’t look like an iPod. If it is, let it start up, then plug it in again.')

  const wiped = recordForWipedIpod(facts, records)
  const boundHere = facts.marker ? records.find((r) => r.listId === facts.marker!.id && !r.released) ?? null : null

  // Already carrying a list, and not being moved to another one: only the tail of the protocol is left.
  if (facts.marker && (!target || (target.kind === 'list' && target.listId === facts.marker.id))) {
    const name = facts.marker.name
    if (!progress.firstSync) {
      const bytes = target?.kind === 'list' ? target.bytes : null
      const songs = target?.kind === 'list' ? target.songs : progress.listSongs ?? 0
      return { step: 'first-sync', line: `${name} is set up. Press Sync ${name}.`, estimate: firstSyncEstimate(songs, bytes) }
    }
    if (!boundHere?.sealedAt) {
      return {
        step: 'proof',
        line: `Synced ${count(progress.firstSync.songs, 'song')}. On the iPod, Settings › About should say ${progress.firstSync.songs.toLocaleString('en-US')}.`,
        // The check is in the line; the list stays for older callers and is not shown.
        checklist: proofChecklist(name, progress.firstSync.songs, progress.playlists),
      }
    }
    return {
      step: 'done',
      lines: [`${name} is set up.`, bpmLine(name, progress.bpm)].filter((l) => l !== ''),
    }
  }

  if (!target) {
    return {
      step: 'choose-list',
      suggestListId: wiped?.listId ?? null,
      line: wiped
        ? `This looks like ${wiped.name}, erased. Set it up as ${wiped.name} again?`
        : 'Which iPod is this?',
    }
  }

  // The iPod's own name: it is the drive's name too, so 11 characters at most.
  const suggested = target.kind === 'list' ? suggestedIpodName(target.listName) : null
  const nameCheck = checkIpodName(input.name ?? suggested)
  if (!nameCheck.ok) {
    return {
      step: 'name',
      suggestion: suggested,
      line: input.name
        ? nameCheck.error
        : target.kind === 'list'
          ? `Name the iPod (up to ${FAT_LABEL_MAX} letters).`
          : `Name the iPod (up to ${FAT_LABEL_MAX} letters).`,
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
        ? (stops.length === 1 ? 'Fix this first:' : `Fix these ${stops.length} first:`)
        : 'Checking the iPod…',
    }
  }

  const why = destructiveReasons(facts, target, records)
  if (why.length) {
    // The phrase names what is being replaced: what is on this iPod now, or, when this iPod is
    // empty, the other iPod that loses the list.
    const held = target.kind === 'list' ? records.find((r) => r.listId === target.listId && !r.released) : undefined
    const hasContents = Math.max(facts.catalog.songs ?? 0, facts.musicFiles ?? 0) > 0 || !!facts.marker || (facts.catalog.present && !facts.catalog.readable)
    const replaced = hasContents || !held ? replacedLabel(facts) : held.name
    if (!confirmationMatches(replaced, input.typed)) return { step: 'confirm', phrase: confirmationPhrase(replaced), why, onIt: whatIsOnIt(facts) }
  }

  return {
    step: 'prepare',
    name: nameCheck.name,
    actions: [
      `Name it ${nameCheck.name}.`,
      target.kind === 'list' ? `Put the songs from ${target.listName} on it at its first sync.` : 'Make it ready for its first sync.',
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

/**
 * The iPod's body or card is not the one on record. The Original is never held to this: it
 * predates the records and is known by its own ID file.
 */
export function identityChange(
  facts: IpodDeviceFacts,
  record: IpodOnboardingRecord | null,
): { kind: 'body' | 'card'; was: { serial: string | null; bytes: number | null }; now: { serial: string | null; bytes: number | null } } | null {
  if (!record || !facts.marker || facts.marker.primary) return null
  const ser = deviceSerial(facts)
  const out = { was: { serial: record.serial, bytes: record.capacityBytes }, now: { serial: ser?.serial ?? null, bytes: facts.totalBytes } }
  if (record.serialSource === 'usb' && ser?.source === 'usb' && record.serial !== ser.serial) return { kind: 'body', ...out }
  if (record.capacityBytes && facts.totalBytes && Math.abs(record.capacityBytes - facts.totalBytes) > record.capacityBytes * 0.02) return { kind: 'card', ...out }
  return null
}

/** What Jake types to say "this is the same iPod, with a new card or body". It names the iPod. */
export function sameIpodPhrase(name: string): string {
  return `this is ${name.replace(/\s+/g, ' ').trim()}`
}

/**
 * The explicit way forward from a body or card mismatch (a bigger card cloned
 * into punkPod): the old and new identity side by side, and the words to type.
 * null = nothing changed, or this is the Original. Never automatic.
 */
export function sameIpodOffer(facts: IpodDeviceFacts, record: IpodOnboardingRecord | null): { phrase: string; lines: string[] } | null {
  const c = identityChange(facts, record)
  if (!c || !facts.marker) return null
  return {
    phrase: sameIpodPhrase(facts.marker.name),
    lines: [
      `Is this still ${facts.marker.name}, with a new ${c.kind === 'body' ? 'body' : 'card'}?`,
    ],
  }
}

/** The record after Jake confirmed "same iPod, new card or body". */
export function rebindRecord(record: IpodOnboardingRecord, facts: IpodDeviceFacts, now: string): IpodOnboardingRecord {
  const ser = deviceSerial(facts)
  return {
    ...record,
    serial: ser?.serial ?? null,
    serialSource: ser?.source ?? null,
    capacityBytes: facts.totalBytes,
    history: [...record.history, { at: now, event: 'new-card-or-body' as const, note: `was serial ${record.serial ?? '?'}, ${record.capacityBytes ?? '?'} bytes` }].slice(-50),
  }
}

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
  if (!facts.marker) add('identity', 'stop', 'Set up this iPod to sync it.')
  else if (facts.marker.primary) add('identity', 'ok', `${name}, your Original.`)
  else if (!record) add('identity', 'warn', `${name} is new on this Mac.`)
  else {
    const changed = identityChange(facts, record)
    if (changed?.kind === 'body') add('identity', 'stop', `The card for ${name} is in a different iPod. Confirm below if that’s right.`)
    else if (changed?.kind === 'card') add('identity', 'stop', `${name} has a different card now. Confirm below if that’s right.`)
    else add('identity', 'ok', `${name}. ${onboardedLine(record)}.`)
  }

  // Format
  if (facts.fs !== null && facts.fs !== 'fat32' && facts.fs !== 'hfs') add('format', 'stop', `${name} needs erasing. Restore it in Finder, then set it up again.`)

  // Database
  if (!facts.catalog.present) add('database', 'warn', lastSync ? `${name} was erased. The next sync puts everything back.` : `${name} has no songs yet.`)
  // Not a stop: a sync is what rewrites a broken database, and nothing else can (2026-11-14).
  else if (!facts.catalog.readable) add('database', 'warn', `${name}’s songs can’t be read. Sync to fix it.`)
  else if (lastSync?.sealed && facts.catalog.songs !== lastSync.songs) add('database', 'warn', `${name} has ${count(facts.catalog.songs ?? 0, 'song')}, not ${lastSync.songs.toLocaleString('en-US')}. The next sync fixes it.`)
  else add('database', 'ok', `${count(facts.catalog.songs ?? 0, 'song')}.`)

  // Room
  if (facts.freeBytes === null) add('space', 'unknown', 'Couldn’t read free space.')
  else if (facts.freeBytes < HEALTH_MIN_FREE_BYTES) add('space', 'warn', `Only ${gb(facts.freeBytes)} free.`)
  else add('space', 'ok', `${gb(facts.freeBytes)} free.`)

  // Last sync
  if (!lastSync) add('last-sync', 'warn', 'Not synced yet.')
  else if (!lastSync.sealed) add('last-sync', 'warn', 'The last sync didn’t finish. Sync again.')
  else if (list && list.songs !== lastSync.songs) add('last-sync', 'ok', 'New songs are ready to sync.')
  else add('last-sync', 'ok', 'Up to date.')

  if (facts.rockbox) add('firmware', 'warn', `${name} has Rockbox on it.`)

  const verdict = checks.some((c) => c.status === 'stop') ? 'stop' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok'
  return { verdict, checks }
}

// ── One gate for every handler that writes ───────────────────────────────────

export type OnboardingAction = 'test' | 'prepare' | 'seal'

/**
 * May this handler act now? Asked with the step the rules give for the device
 * as it is at this moment — the same step the strip shows. The test file is
 * only written when the checks are what's left and none of them stops; set-up
 * only when the step is 'prepare'; sealing only at the proof. null = go ahead.
 */
export function onboardingActionRefusal(action: OnboardingAction, step: OnboardingStep): string | null {
  if (step.step === 'refused') return step.line
  if (action === 'test') {
    if (step.step === 'checks' && !step.blocked) return null
    if (step.step === 'checks') return 'Fix the problems above first.'
    return 'This iPod isn’t being set up.'
  }
  if (action === 'prepare') {
    if (step.step === 'prepare') return null
    if (step.step === 'checks') return step.blocked ? 'Fix the problems above first.' : 'Wait for the checks to finish.'
    if (step.step === 'name') return step.line
    if (step.step === 'confirm') return `Type “${step.phrase}” to go on.`
    return 'This iPod isn’t ready to set up.'
  }
  if (step.step === 'proof') return null
  return step.step === 'first-sync' ? step.line : 'Nothing to check on this iPod right now.'
}

/** The health check's reason for refusing a sync, or null. A "stop" stops the sync. */
export function healthSyncRefusal(report: HealthReport): string | null {
  const stop = report.checks.find((c) => c.status === 'stop')
  return stop ? stop.line : null
}

/**
 * A health check that couldn't see what it checks is not a pass. null = it saw enough.
 * The format and the size must be readable; and when the iPod is on record by its USB
 * serial, the USB serial must be readable now (the Original has no such hold on it).
 */
export function healthBlindRefusal(facts: IpodDeviceFacts, record: IpodOnboardingRecord | null): string | null {
  const name = facts.marker?.name ?? 'the iPod'
  const blind = facts.fs === null ? 'how the drive is formatted'
    : facts.totalBytes === null ? 'the drive’s size'
      : record?.serialSource === 'usb' && !facts.marker?.primary && !facts.usb?.serial ? 'which iPod body this is'
        : null
  if (blind) console.warn(`[ipod-health] couldn’t read ${blind} for ${name}`)
  return blind ? 'Unplug the iPod, plug it back in, and sync again.' : null
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
  /** Is the drive at this path still the drive the checks ran on (its system identity)? */
  sameDrive: boolean
}): string | null {
  if (!input.sameDrive) return 'The iPod changed. Start again.'
  if (input.markerNow?.primary) return `This is ${input.markerNow.name}, your Original.`
  if (input.otherIpods > 0) return 'Two iPods are plugged in. Unplug one.'
  if (input.syncInFlight) return 'Wait for the sync to finish.'
  if ((input.markerNow?.id ?? null) !== (input.markerAtChecks?.id ?? null)) return 'The iPod changed. Start again.'
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
      /** Body or card changed: the old and new identity and the words that confirm "same iPod". */
      sameIpod?: { phrase: string; lines: string[] } | null
      mounted: boolean
      step: OnboardingStep
      targets: IpodSetupTargetRow[]
      cover: { line: string; model: IpodModel } | null
      health: HealthReport | null
      record: IpodOnboardingRecord | null
    }
  | { ok: false; error: string }
