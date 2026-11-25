/**
 * ONE KEYBOARD (V7). Every global shortcut in the app is in this table, and
 * this file decides who gets each key.
 *
 * Before V7 about 29 window keydown listeners fought by capture order: Space
 * was handled by two global handlers in App.tsx, ⌘I and ⌘L were wired in the
 * menu AND in App.tsx, and ↑/↓ meant volume on some pages and selection on
 * others. Now:
 *
 *   • Each shortcut has exactly ONE wiring (`wiring` below):
 *       menu    a registered menu accelerator. The menu sends a menu-action
 *               and the renderer never looks at the key itself. Only for keys
 *               that are safe in a text field: on macOS a menu accelerator
 *               fires even while typing.
 *       keymap  the renderer's keyboard host (renderer/keyboard.ts) handles
 *               it, and the menu never carries it as an accelerator (on macOS
 *               Electron registers a menu accelerator even with
 *               registerAccelerator: false, so a menu "Space" would toggle
 *               the music while typing a space). Used for keys that depend
 *               on focus: Space, ⌘←/⌘→, ⌘↑/⌘↓, ⌘[ ⌘], ⌘T, Escape, ⌘Z outside a
 *               field. A keymap shortcut may name one `menuAccelerator`, a
 *               key that is safe anywhere (F7/F8/F9): that one is the
 *               menu's, and the host leaves it alone.
 *       role    a native menu role (copy, paste, hide, minimize…).
 *       page    a key a page or list owns while it's on screen (↑/↓ on a song
 *               list). Listed so the Keyboard Shortcuts sheet can show it;
 *               the page claims it through renderer/keyboard.ts.
 *   • ↑/↓ always move the selection. Skip and volume are ⌘←/⌘→ and ⌘↑/⌘↓.
 *   • Space is play/pause unless a text field, or a page that claimed it, has
 *     the key.
 *   • Escape closes the top-most panel, sheet or dialog. In a text field
 *     outside a dialog it first lets go of the field.
 *   • ⌘Z goes to the latest Undo toast when no text field has focus.
 *
 * Pure and import-free: main builds the menu from it (main/app-menu.ts), the
 * renderer routes keys with it, and node tests read it directly
 * (src/main/__tests__/keymap.test.ts).
 */

export type ShortcutSection = 'Playback' | 'Go' | 'Library' | 'Panels' | 'Lists' | 'Editing' | 'Window'
export type Wiring = 'menu' | 'keymap' | 'role' | 'page'

export interface Shortcut {
  id: string
  /** What the menu and the sheet call it. */
  label: string
  section: ShortcutSection
  /** Electron accelerator syntax. The first is the one the menu shows. */
  keys: readonly string[]
  wiring: Wiring
  /** menu wiring: the menu-action the renderer receives. */
  action?: string
  /** role wiring: the Electron menu role. */
  role?: string
  /** keymap wiring: also fires while a text field has focus. */
  whileTyping?: boolean
  /** keymap wiring: the one key (of `keys`) the menu registers instead, because it is safe in a text field. */
  menuAccelerator?: string
  /** Shown in the sheet under the label. */
  note?: string
  /** Kept out of the sheet (developer keys). */
  hidden?: boolean
}

export const SHORTCUTS: readonly Shortcut[] = [
  // ── Playback ──
  { id: 'play-pause', label: 'Play / Pause', section: 'Playback', keys: ['Space', 'F8'], menuAccelerator: 'F8', wiring: 'keymap', note: 'Not while typing, or on a page that uses Space itself' },
  { id: 'previous', label: 'Previous Song', section: 'Playback', keys: ['CmdOrCtrl+Left', 'F7'], menuAccelerator: 'F7', wiring: 'keymap' },
  { id: 'next', label: 'Next Song', section: 'Playback', keys: ['CmdOrCtrl+Right', 'F9'], menuAccelerator: 'F9', wiring: 'keymap' },
  { id: 'volume-up', label: 'Volume Up', section: 'Playback', keys: ['CmdOrCtrl+Up'], wiring: 'keymap', note: '5% a press' },
  { id: 'volume-down', label: 'Volume Down', section: 'Playback', keys: ['CmdOrCtrl+Down'], wiring: 'keymap', note: '5% a press' },
  { id: 'show-now-playing', label: 'Go to Current Song', section: 'Playback', keys: ['CmdOrCtrl+L'], wiring: 'menu', action: 'show-now-playing' },
  { id: 'star-current-song', label: 'Star Current Song', section: 'Playback', keys: ['Shift+CmdOrCtrl+S'], wiring: 'menu', action: 'star-current-song' },
  { id: 'radio-mode', label: 'Radio Mode', section: 'Playback', keys: ['Shift+CmdOrCtrl+R'], wiring: 'menu', action: 'toggle-radio-mode' },
  { id: 'dj-mode', label: 'DJ Mode', section: 'Playback', keys: ['Shift+CmdOrCtrl+D'], wiring: 'menu', action: 'toggle-dj-mode' },

  // ── Go ──
  { id: 'go-anywhere', label: 'Go Anywhere…', section: 'Go', keys: ['CmdOrCtrl+K'], wiring: 'menu', action: 'go-anywhere', note: 'Return opens it, ⌘Return plays it' },
  { id: 'back', label: 'Back', section: 'Go', keys: ['CmdOrCtrl+['], wiring: 'keymap' },
  { id: 'forward', label: 'Forward', section: 'Go', keys: ['CmdOrCtrl+]'], wiring: 'keymap' },
  { id: 'go-home', label: 'Home', section: 'Go', keys: ['CmdOrCtrl+1'], wiring: 'menu', action: 'view-home' },
  { id: 'go-songs', label: 'Songs', section: 'Go', keys: ['CmdOrCtrl+2'], wiring: 'menu', action: 'view-songs' },
  { id: 'go-albums', label: 'Albums', section: 'Go', keys: ['CmdOrCtrl+3'], wiring: 'menu', action: 'view-albums' },
  { id: 'go-artists', label: 'Artists', section: 'Go', keys: ['CmdOrCtrl+4'], wiring: 'menu', action: 'view-artists' },
  { id: 'go-concerts', label: 'Live Albums', section: 'Go', keys: ['CmdOrCtrl+5'], wiring: 'menu', action: 'view-concerts' },
  { id: 'go-record-shop', label: 'Record Shop', section: 'Go', keys: ['CmdOrCtrl+6'], wiring: 'menu', action: 'view-record-shop' },
  { id: 'find', label: 'Find', section: 'Go', keys: ['CmdOrCtrl+F'], wiring: 'menu', action: 'find', note: 'The page’s own find bar, or Search' },
  { id: 'search', label: 'Search', section: 'Go', keys: ['/'], wiring: 'keymap' },

  // ── Panels ──
  { id: 'up-next', label: 'Up Next', section: 'Panels', keys: ['Alt+CmdOrCtrl+U'], wiring: 'menu', action: 'toggle-up-next' },
  { id: 'music-man', label: 'The Music Man', section: 'Panels', keys: ['Shift+CmdOrCtrl+M'], wiring: 'menu', action: 'toggle-music-man' },
  { id: 'lyrics', label: 'Lyrics', section: 'Panels', keys: ['Shift+CmdOrCtrl+L'], wiring: 'menu', action: 'toggle-lyrics' },
  { id: 'downloads', label: 'Downloads', section: 'Panels', keys: ['Alt+CmdOrCtrl+L'], wiring: 'menu', action: 'toggle-downloads' },
  { id: 'visualizer', label: 'Visualizer', section: 'Panels', keys: ['CmdOrCtrl+T'], wiring: 'keymap', note: 'Not while typing' },
  { id: 'close-top', label: 'Close', section: 'Panels', keys: ['Escape'], wiring: 'keymap', whileTyping: true, note: 'The top-most panel, sheet or dialog. In a text field it lets go of the field first' },
  { id: 'keyboard-shortcuts', label: 'Keyboard Shortcuts', section: 'Panels', keys: ['CmdOrCtrl+/'], wiring: 'menu', action: 'keyboard-shortcuts' },
  { id: 'preferences', label: 'Preferences…', section: 'Panels', keys: ['CmdOrCtrl+,'], wiring: 'menu', action: 'open-preferences' },

  // ── Library ──
  { id: 'new-playlist', label: 'New Playlist', section: 'Library', keys: ['CmdOrCtrl+N'], wiring: 'menu', action: 'new-playlist' },
  { id: 'import', label: 'Import…', section: 'Library', keys: ['CmdOrCtrl+O'], wiring: 'menu', action: 'import-files' },
  { id: 'import-convert', label: 'Import and Convert…', section: 'Library', keys: ['Shift+CmdOrCtrl+O'], wiring: 'menu', action: 'open-import-convert' },
  { id: 'get-info', label: 'Get Info', section: 'Library', keys: ['CmdOrCtrl+I'], wiring: 'menu', action: 'get-info' },

  // ── Lists (owned by the song list on screen, through the keyboard host) ──
  { id: 'list-move', label: 'Move the selection', section: 'Lists', keys: ['Up', 'Down'], wiring: 'page', note: '⇧ extends it' },
  { id: 'list-play', label: 'Play the selected song', section: 'Lists', keys: ['Return'], wiring: 'page' },
  { id: 'list-select-all', label: 'Select all', section: 'Lists', keys: ['CmdOrCtrl+A'], wiring: 'page' },
  { id: 'list-remove', label: 'Remove or delete the selection', section: 'Lists', keys: ['Backspace'], wiring: 'page' },
  { id: 'list-find', label: 'Jump to a title', section: 'Lists', keys: ['A'], wiring: 'page', note: 'Type its first letters' },
  { id: 'cover-flow', label: 'Flip Cover Flow', section: 'Lists', keys: ['Left', 'Right'], wiring: 'page', note: 'While a Cover Flow is on screen' },

  // ── Editing ──
  { id: 'undo', label: 'Undo', section: 'Editing', keys: ['CmdOrCtrl+Z'], wiring: 'role', role: 'undo', note: 'Outside a text field: the latest Undo toast' },
  { id: 'redo', label: 'Redo', section: 'Editing', keys: ['Shift+CmdOrCtrl+Z'], wiring: 'role', role: 'redo' },
  { id: 'cut', label: 'Cut', section: 'Editing', keys: ['CmdOrCtrl+X'], wiring: 'role', role: 'cut' },
  { id: 'copy', label: 'Copy', section: 'Editing', keys: ['CmdOrCtrl+C'], wiring: 'role', role: 'copy' },
  { id: 'paste', label: 'Paste', section: 'Editing', keys: ['CmdOrCtrl+V'], wiring: 'role', role: 'paste' },
  { id: 'select-all', label: 'Select All', section: 'Editing', keys: ['CmdOrCtrl+A'], wiring: 'role', role: 'selectAll', hidden: true },

  // ── Window ──
  { id: 'hide', label: 'Hide JakeTunes', section: 'Window', keys: ['CmdOrCtrl+H'], wiring: 'role', role: 'hide' },
  { id: 'hide-others', label: 'Hide Others', section: 'Window', keys: ['Alt+CmdOrCtrl+H'], wiring: 'role', role: 'hideOthers' },
  { id: 'minimize', label: 'Minimize', section: 'Window', keys: ['CmdOrCtrl+M'], wiring: 'role', role: 'minimize' },
  { id: 'full-screen', label: 'Enter Full Screen', section: 'Window', keys: ['Ctrl+CmdOrCtrl+F'], wiring: 'role', role: 'togglefullscreen' },
  { id: 'close-window', label: 'Close Window', section: 'Window', keys: ['CmdOrCtrl+W'], wiring: 'role', role: 'close' },
  { id: 'quit', label: 'Quit JakeTunes', section: 'Window', keys: ['CmdOrCtrl+Q'], wiring: 'role', role: 'quit' },
  { id: 'dev-tools', label: 'Toggle Developer Tools', section: 'Window', keys: ['Alt+CmdOrCtrl+I'], wiring: 'role', role: 'toggleDevTools', hidden: true },
]

export function shortcut(id: string): Shortcut {
  const s = SHORTCUTS.find((x) => x.id === id)
  if (!s) throw new Error(`keymap: no shortcut "${id}"`)
  return s
}

// ── accelerators ─────────────────────────────────────────────────────────

/** An accelerator reduced to what a key event can be compared with. */
export interface Chord {
  cmd: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

/** 'Shift+CmdOrCtrl+Left' → { cmd, shift, key: 'Left' }. 'Ctrl+CmdOrCtrl+F' keeps both. */
export function parseAccelerator(accel: string): Chord {
  const parts = accel.split('+')
  // '+' itself would be an empty last part; nothing here uses it.
  const key = parts.pop() || ''
  const c: Chord = { cmd: false, ctrl: false, alt: false, shift: false, key: key.length === 1 ? key.toUpperCase() : key }
  for (const p of parts) {
    if (p === 'CmdOrCtrl' || p === 'CommandOrControl' || p === 'Cmd' || p === 'Command') c.cmd = true
    else if (p === 'Ctrl' || p === 'Control') c.ctrl = true
    else if (p === 'Alt' || p === 'Option') c.alt = true
    else if (p === 'Shift') c.shift = true
  }
  return c
}

/** What the keydown reports, as far as the keymap reads it (testable without a DOM). */
export interface KeyEventLike {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  defaultPrevented?: boolean
  isComposing?: boolean
}

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Slash: '/', Comma: ',', Period: '.', Backquote: '`', Minus: '-', Equal: '=',
}
const NAMED_KEYS: Record<string, string> = {
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space', Spacebar: 'Space',
  Enter: 'Return', Escape: 'Escape', Esc: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab',
}

/**
 * The key name an event carries, in accelerator spelling. Letters, digits and
 * brackets come from the physical `code`: with ⌥ held, macOS reports ⌥⌘L as
 * key '¬', and ⇧⌘/ as '?'.
 */
export function eventKeyName(e: KeyEventLike): string {
  const code = e.code || ''
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]
  if (CODE_KEYS[code]) return CODE_KEYS[code]
  if (NAMED_KEYS[e.key]) return NAMED_KEYS[e.key]
  if (/^F\d{1,2}$/.test(e.key)) return e.key
  return e.key.length === 1 ? e.key.toUpperCase() : e.key
}

/**
 * Does this event press this accelerator? ⌘ and Ctrl both stand for
 * CmdOrCtrl (as the app always read them), unless the accelerator names Ctrl
 * on its own as well.
 */
export function eventMatches(e: KeyEventLike, accel: string): boolean {
  const c = parseAccelerator(accel)
  if (eventKeyName(e) !== c.key) return false
  if (e.altKey !== c.alt || e.shiftKey !== c.shift) return false
  if (c.ctrl && c.cmd) return e.ctrlKey && e.metaKey
  if (c.ctrl) return e.ctrlKey && !e.metaKey
  if (c.cmd) return (e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey)
  return !e.metaKey && !e.ctrlKey
}

/** The renderer-wired shortcut this event presses, if any. */
export function keymapShortcutFor(e: KeyEventLike): Shortcut | null {
  for (const s of SHORTCUTS) {
    if (s.wiring !== 'keymap' && s.id !== 'undo') continue
    // The menu's own key (F8 …) fires from the menu; answering it here too would be twice.
    if (s.keys.some((k) => k !== s.menuAccelerator && eventMatches(e, k))) return s
  }
  return null
}

// ── who gets the key ─────────────────────────────────────────────────────

/**
 * Where focus is, as the routing reads it:
 *   none             nothing that types
 *   field            a text field, select or contenteditable outside a dialog
 *   field-in-overlay a text field inside an open dialog / sheet / menu
 */
export type FocusState = 'none' | 'field' | 'field-in-overlay'

export interface RouteContext {
  focus: FocusState
  /** A page holds a static claim on this key code (claimKeys). Covers the unmodified key only. */
  claimed: (code: string) => boolean
  /** Open panels / sheets / dialogs that Escape can close, oldest first. */
  escape: readonly { id: string }[]
  /** Live Undo toasts, oldest first. */
  undo: readonly { id: string }[]
}

export type Route =
  | { to: 'escape'; id: string }
  | { to: 'let-go' }
  | { to: 'clear-search' }
  | { to: 'undo'; id: string }
  | { to: 'shortcut'; id: string }
  | { to: 'native' }

/**
 * The global decision for a key nothing on the page took first. The keyboard
 * host has already offered it to the claiming layers (lists, pages, dialogs)
 * and the on-screen Cover Flow; this is what's left.
 */
export function routeKey(e: KeyEventLike, ctx: RouteContext): Route {
  if (e.isComposing || e.defaultPrevented) return { to: 'native' }
  const name = eventKeyName(e)

  if (name === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    // A field outside any dialog: Escape lets go of it (and clears Search),
    // and never closes a panel behind it.
    if (ctx.focus === 'field') return { to: 'let-go' }
    const top = ctx.escape[ctx.escape.length - 1]
    if (top) return { to: 'escape', id: top.id }
    if (ctx.focus === 'field-in-overlay') return { to: 'let-go' }
    return { to: 'clear-search' }
  }

  const s = keymapShortcutFor(e)
  if (!s || s.id === 'close-top') return { to: 'native' }
  const typing = ctx.focus !== 'none'

  if (s.id === 'undo') {
    // In a field ⌘Z is the field's own undo (the Edit menu's role).
    if (typing) return { to: 'native' }
    const top = ctx.undo[ctx.undo.length - 1]
    return top ? { to: 'undo', id: top.id } : { to: 'native' }
  }
  if (typing && !s.whileTyping) return { to: 'native' }
  // A claim holds the plain key (Space, ←): ⌘→ still skips in the Supreme Court room.
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
  if (plain && e.code && ctx.claimed(e.code)) return { to: 'native' }
  return { to: 'shortcut', id: s.id }
}

// ── layers: pages, lists and dialogs that claim keys ─────────────────────

export interface LayerInfo {
  id: string
  /** A dialog / sheet / menu: while one is open, pages and lists get no keys. */
  modal: boolean
  /** Offered after the focused element had its turn (bubble), not before it (capture). */
  late?: boolean
  /** Open order; newer wins. */
  seq: number
}

/**
 * Who is offered a key, in order. Dialogs first, newest first; while any
 * dialog is open (`modalOpen`, which also counts a dialog that only closes on
 * Escape) the pages and lists under it get nothing. Otherwise pages and lists,
 * newest first. Escape never goes to a layer: it closes the top-most surface.
 */
export function layerOrder<T extends LayerInfo>(layers: readonly T[], phase: 'early' | 'late', modalOpen: boolean): T[] {
  const inPhase = layers.filter((l) => (phase === 'late') === !!l.late)
  const newestFirst = (a: T, b: T): number => b.seq - a.seq
  const modals = inPhase.filter((l) => l.modal).sort(newestFirst)
  if (modalOpen) return modals
  return [...modals, ...inPhase.filter((l) => !l.modal).sort(newestFirst)]
}

// ── the sheet and the menu ───────────────────────────────────────────────

const MAC_MODS: [keyof Chord, string][] = [['ctrl', '⌃'], ['alt', '⌥'], ['shift', '⇧'], ['cmd', '⌘']]
const MAC_KEYS: Record<string, string> = {
  Left: '←', Right: '→', Up: '↑', Down: '↓', Return: '↩', Escape: 'Esc', Backspace: '⌫', Delete: '⌦', Tab: '⇥', Space: 'Space',
}

/** 'Shift+CmdOrCtrl+L' → '⇧⌘L' (the order macOS menus print). */
export function displayAccelerator(accel: string): string {
  const c = parseAccelerator(accel)
  const mods = MAC_MODS.filter(([k]) => c[k]).map(([, s]) => s).join('')
  return mods + (MAC_KEYS[c.key] ?? c.key)
}

export interface SheetRow { label: string; keys: string[]; note?: string }
export interface SheetSection { title: ShortcutSection; rows: SheetRow[] }

const SECTION_ORDER: ShortcutSection[] = ['Playback', 'Go', 'Panels', 'Lists', 'Library', 'Editing', 'Window']

/** The Keyboard Shortcuts sheet (⌘/), generated from the table. */
export function shortcutSheet(): SheetSection[] {
  return SECTION_ORDER.map((title) => ({
    title,
    rows: SHORTCUTS.filter((s) => s.section === title && !s.hidden).map((s) => ({
      label: s.label,
      keys: s.id === 'list-move' ? ['↑', '↓'] : s.id === 'cover-flow' ? ['←', '→'] : s.id === 'list-find' ? ['A–Z'] : s.keys.map(displayAccelerator),
      ...(s.note ? { note: s.note } : {}),
    })),
  })).filter((sec) => sec.rows.length > 0)
}

/**
 * How a menu item carries a shortcut. A menu-wired or role one registers its
 * accelerator (the menu is its only wiring). A keymap-wired one carries no
 * accelerator at all, or only its `menuAccelerator` (F7/F8/F9): on macOS
 * Electron registers every accelerator a menu item shows, whatever
 * registerAccelerator says, and a registered Space or ⌘← would fire while
 * typing. The sheet (⌘/) shows those keys instead.
 */
export function menuKeys(id: string): { accelerator?: string } {
  const s = shortcut(id)
  if (s.wiring === 'page') throw new Error(`keymap: "${id}" belongs to a page, not the menu`)
  if (s.wiring === 'keymap') return s.menuAccelerator ? { accelerator: s.menuAccelerator } : {}
  return { accelerator: s.keys[0] }
}
