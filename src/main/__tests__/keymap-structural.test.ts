// V7 ONE KEYBOARD, structurally: the renderer listens to the keyboard on
// window / document in exactly one file (renderer/keyboard.ts). Pages and
// panels claim keys through it (addKeyLayer, claimKeys, addEscape, addUndo
// and the hooks in hooks/useKeyboard.ts). Before V7 about 29 such listeners
// fought by capture order and Space was handled twice.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const RENDERER = join(import.meta.dirname, '..', '..', 'renderer')
const HOST = 'keyboard.ts'

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === '_archive' || name === 'node_modules') continue
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const src = (p: string): string => readFileSync(join(RENDERER, p), 'utf8')

/** A keyboard listener on the window or the document (an element's own listener is fine). */
const GLOBAL_KEY_LISTENER = /\b(?:window|document|globalThis|document\.body)\s*\.\s*addEventListener\s*\(\s*['"`]key(?:down|up|press)['"`]/
const ON_KEY_PROPERTY = /\b(?:window|document)\s*\.\s*onkey(?:down|up|press)\s*=/

describe('one keyboard: only the host listens on window / document', () => {
  const all = files(RENDERER)
  it('found the renderer', () => assert.ok(all.length > 100))
  it('no file but renderer/keyboard.ts adds a window or document key listener', () => {
    const offenders = all
      .filter((p) => relative(RENDERER, p) !== HOST)
      .filter((p) => { const s = readFileSync(p, 'utf8'); return GLOBAL_KEY_LISTENER.test(s) || ON_KEY_PROPERTY.test(s) })
      .map((p) => relative(RENDERER, p))
    assert.deepEqual(offenders, [], 'claim keys through keyboard.ts (addKeyLayer / useKeyLayer, useEscape, claimKeys)')
  })
  it('the host installs them, once, from App', () => {
    const host = src(HOST)
    assert.equal(host.match(/window\.addEventListener\('keydown'/g)?.length, 2, 'one early (capture), one late (bubble)')
    assert.equal(src('App.tsx').match(/installKeyboard\(/g)?.length, 1)
  })
})

describe('one wiring per shortcut: the old duplicates are gone', () => {
  const app = src('App.tsx')
  it('App.tsx no longer reads Space, ⌘I, ⌘L or ⇧⌘S off the keyboard (the menu sends ⌘I / ⌘L / ⇧⌘S)', () => {
    assert.doesNotMatch(app, /e\.code === 'Space'|e\.key === ' '/)
    assert.doesNotMatch(app, /e\.key === 'i'|e\.key === 'l'/)
    assert.doesNotMatch(app, /ArrowUp|ArrowDown|ArrowLeft|ArrowRight/, 'skip / volume keys live in the keymap')
  })
  it('⌘[ / ⌘] are the Go menu only (NavigationContext no longer listens)', () => {
    assert.doesNotMatch(src('context/NavigationContext.tsx'), /e\.key === '\['/)
  })
  it('⌘T is the keymap only (the Visualizer no longer listens)', () => {
    assert.doesNotMatch(src('components/Visualizer.tsx'), /=== 't'/)
  })
  it('the renderer never handles the media keys (main does, in before-input-event)', () => {
    assert.doesNotMatch(app, /MediaPlayPause|MediaTrackNext/)
  })
  it('the iPod setup strip is a dialog only while setting up (the Device page strip is not an overlay)', () => {
    assert.match(src('components/IpodSetupSheet.tsx'), /\.\.\.\(mode === 'setup' \? \{ role: 'dialog'/)
  })
  it('every surface the brief names closes on Escape', () => {
    const want: [string, RegExp][] = [
      ['App.tsx', /useEscape\('up-next', showQueue/],
      ['App.tsx', /useEscape\('music-man', showMusicMan/],
      ['App.tsx', /useEscape\('downloads', showDownloads/],
      ['App.tsx', /useEscape\('lyrics', showLyrics/],
      ['components/SettingsModal.tsx', /useEscape\('settings', true, closeAndRevertAudio\)/],
      ['components/ImportConvertModal.tsx', /useEscape\('import-convert'/],
      ['components/ShowDuplicatesModal.tsx', /useEscape\('show-duplicates'/],
      ['components/OrphanCleanupModal.tsx', /useEscape\('orphan-cleanup'/],
      ['components/SyncHistorySheet.tsx', /useEscape\('sync-history'/],
      ['components/IpodSetupSheet.tsx', /useEscape\('ipod-setup'/],
      ['components/NeedsYouSheet.tsx', /useEscape\('needs-you', true, onClose\)/],   // V7: PlayCacheModal is gone (the nightly check)
      ['components/ConfirmDialog.tsx', /useEscape\('confirm', true, onCancel\)/],
      ['components/GetInfoModal.tsx', /useEscape\('get-info', true, onClose\)/],
      ['components/ContextMenu.tsx', /useEscape\('context-menu'/],
      ['components/Visualizer.tsx', /useEscape\('visualizer', active/],
      ['components/GoAnywhere.tsx', /useEscape\('go-anywhere'/],
      ['components/KeyboardShortcutsSheet.tsx', /useEscape\('keyboard-shortcuts'/],
    ]
    for (const [f, re] of want) assert.match(src(f), re, f)
  })
  it('⌘Z reaches both Undo toasts', () => {
    assert.match(src('components/UndoToast.tsx'), /useUndoShortcut\('undo-toast'/)
    assert.match(src('views/ListenToTheListView.tsx'), /useUndoShortcut\('listen-list-toss', tossing !== null, undoToss\)/)
  })
  it('the song lists keep their keys, through the host (the shared table integrates the same way)', () => {
    assert.match(src('hooks/useTrackListKeys.ts'), /addKeyLayer\('track-list', handleKeyDown\)/)
  })
  it('the title bar has no ‹ › history arrows (the back pill and ⌘[ ⌘] remain)', () => {
    assert.doesNotMatch(app, /titlebar-nav/)
    assert.match(src('components/MainContent.tsx'), /<BackButton label=\{backLabel\} onClick=\{goBack\} \/>/)
  })
})
