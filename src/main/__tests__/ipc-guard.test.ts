/**
 * The boundary is "did this come from our own top-level window", because a
 * <webview> showing a remote page shares the session but has its own
 * webContents object.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFromMainWindow, refuseIfNotMainWindow } from '../ipc-guard.ts'

type FakeWin = { webContents: object; isDestroyed: () => boolean }
const win = (destroyed = false): FakeWin => ({ webContents: { tag: 'main' }, isDestroyed: () => destroyed })

test('accepts the main window own frame', () => {
  const w = win()
  assert.equal(isFromMainWindow({ sender: w.webContents } as never, w as never), true)
})

test('refuses a webview (different webContents, same session)', () => {
  const w = win()
  const webview = { tag: 'bandcamp-webview' }
  assert.equal(isFromMainWindow({ sender: webview } as never, w as never), false)
})

test('refuses when there is no main window, or it is destroyed', () => {
  const w = win(true)
  assert.equal(isFromMainWindow({ sender: w.webContents } as never, null), false)
  assert.equal(isFromMainWindow({ sender: w.webContents } as never, w as never), false)
})

test('refuses a missing sender', () => {
  const w = win()
  assert.equal(isFromMainWindow({} as never, w as never), false)
})

test('refuseIfNotMainWindow returns null to let trusted calls through', () => {
  const w = win()
  assert.equal(refuseIfNotMainWindow({ sender: w.webContents } as never, w as never, 'save-library', { ok: false }), null)
})

test('refuseIfNotMainWindow hands back the refusal value, it does not throw', () => {
  const w = win()
  const refusal = { ok: false, error: 'refused' }
  assert.deepEqual(
    refuseIfNotMainWindow({ sender: { tag: 'other' } } as never, w as never, 'save-library', refusal),
    refusal,
    'returning keeps the caller ok:false path working instead of crashing it',
  )
})
