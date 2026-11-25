/**
 * The Mac menu bar (V7: "real Mac menus"). Every shortcut on it comes from
 * the keymap (../common/keymap.ts) through menuKeys(), which is also where
 * each shortcut's ONE wiring is decided: a menu-wired key registers its
 * accelerator here and the renderer never listens for it; a keymap-wired key
 * (Space, ⌘←/⌘→, ⌘↑/⌘↓, ⌘[ ⌘]) is NOT on the menu as an accelerator at all,
 * because on macOS Electron registers whatever accelerator an item shows,
 * registerAccelerator: false or not, and it would fire while typing. Those
 * items still work with the mouse, and the ⌘/ sheet shows their keys.
 * keymap.test.ts builds this with stubs and checks that no key is wired twice.
 *
 * Built from deps so it can be tested without Electron: index.ts passes the
 * About item (it writes its window from main's own state), the menu-action
 * sender and the offload runner.
 */
import type { MenuItemConstructorOptions } from 'electron'
import { menuKeys, shortcut } from '../common/keymap.ts'

export interface AppMenuDeps {
  about: MenuItemConstructorOptions
  send: (action: string) => void
  hubOffload: (mode: 'dry-run' | 'start' | 'rehydrate') => void
}

/** A menu item for a keymap shortcut: its label, its keys, its one wiring. */
function item(id: string, send: (action: string) => void, label?: string): MenuItemConstructorOptions {
  const s = shortcut(id)
  const base: MenuItemConstructorOptions = { label: label ?? s.label, ...menuKeys(id) }
  if (s.wiring === 'role') return { ...base, role: s.role as MenuItemConstructorOptions['role'] }
  // keymap-wired: the click is the menu's own (a mouse pick, or its F-key), the key is the renderer's.
  const action = s.action ?? KEYMAP_MENU_ACTIONS[id]
  if (!action) throw new Error(`app-menu: "${id}" has no menu action`)
  return { ...base, click: () => send(action) }
}

/** What a mouse pick of a keymap-wired item sends (the key itself never reaches main). */
const KEYMAP_MENU_ACTIONS: Record<string, string> = {
  'play-pause': 'play-pause',
  previous: 'prev-track',
  next: 'next-track',
  'volume-up': 'volume-up',
  'volume-down': 'volume-down',
  back: 'history-back',
  forward: 'history-forward',
  visualizer: 'toggle-visualizer',
}

const sep: MenuItemConstructorOptions = { type: 'separator' }

export function buildAppMenu(d: AppMenuDeps): MenuItemConstructorOptions[] {
  const i = (id: string, label?: string): MenuItemConstructorOptions => item(id, d.send, label)
  return [
    {
      label: 'JakeTunes',
      submenu: [
        d.about,
        sep,
        i('preferences'),
        sep,
        { role: 'services' },
        sep,
        i('hide'),
        i('hide-others'),
        { label: 'Show All', role: 'unhide' },
        sep,
        i('quit'),
      ],
    },
    {
      label: 'File',
      submenu: [
        i('new-playlist'),
        i('import'),
        i('import-convert'),
        sep,
        i('get-info'),
        sep,
        {
          label: 'Library',
          submenu: [
            // (V7 steady: "Fix iPod Compatibility…" is gone. It re-encoded the
            // library's own hi-res ALAC masters down to 16-bit, in place.
            // Sync already makes iPod-safe copies in its cache
            // (buildIpodSafeAlacMirror), so the tool could only damage
            // masters. master-never-reencoded.test.ts keeps it gone.)
            // 4.1: ALAC play-cache management. Replaces the launch-time
            // prewarm scanner with explicit user actions.
            { label: 'Prepare ALAC Songs for Instant Play…', click: () => d.send('prepare-alac-cache') },
            { label: 'Prune Play-Cache…', click: () => d.send('prune-alac-cache') },
            { label: 'Clean Orphan Files…', click: () => d.send('clean-orphan-files') },
            // Surface library entries that share artist+title+album so the
            // user can pick which copies to remove. Per-row delete only —
            // never bulk, never auto.
            { label: 'Show Duplicates…', click: () => d.send('show-duplicates') },
            sep,
            // Brief 020: push the user-edited override fields into the audio
            // files' embedded tags (the one-shot backfill; per-edit
            // write-back fires inside save-metadata-override).
            { label: 'Apply Overrides to Files…', click: () => d.send('apply-overrides-to-files') },
            // Brief 016 commit 2: one-shot retrofit of stale library.json
            // fileSize values. Audio files themselves are NOT modified.
            { label: 'Refresh File Sizes…', click: () => d.send('refresh-file-sizes') },
            sep,
            { label: 'Offload Audio — Dry Run', click: () => d.hubOffload('dry-run') },
            { label: 'Offload Audio — Start', click: () => d.hubOffload('start') },
            { label: 'Undo Offload (pull audio back)', click: () => d.hubOffload('rehydrate') },
          ],
        },
        sep,
        i('close-window'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // ⌘Z: the role is a text field's undo; outside a field the keyboard
        // host sends it to the latest Undo toast (common/keymap.ts routeKey).
        i('undo'),
        i('redo'),
        sep,
        i('cut'),
        i('copy'),
        i('paste'),
        i('select-all'),
        sep,
        i('find', 'Find…'),
      ],
    },
    {
      label: 'Controls',
      submenu: [
        i('play-pause'),
        i('previous'),
        i('next'),
        sep,
        i('volume-up'),
        i('volume-down'),
        sep,
        i('show-now-playing'),
        i('star-current-song'),
        sep,
        i('radio-mode'),
        i('dj-mode'),
      ],
    },
    {
      label: 'View',
      submenu: [
        i('up-next'),
        i('music-man'),
        i('lyrics'),
        i('downloads'),
        sep,
        i('visualizer'),
        sep,
        i('full-screen'),
        sep,
        i('dev-tools'),
      ],
    },
    {
      label: 'Go',
      submenu: [
        i('back'),
        i('forward'),
        sep,
        i('go-home'),
        i('go-songs'),
        i('go-albums'),
        i('go-artists'),
        i('go-concerts'),
        i('go-record-shop'),
        { label: 'Genres', click: () => d.send('view-genres') },
        sep,
        i('go-anywhere'),
      ],
    },
    {
      label: 'Window',
      role: 'windowMenu',
      submenu: [
        i('minimize'),
        { label: 'Zoom', role: 'zoom' },
        sep,
        { label: 'Bring All to Front', role: 'front' },
      ],
    },
    {
      label: 'Help',
      role: 'help',
      submenu: [
        i('keyboard-shortcuts'),
      ],
    },
  ]
}
