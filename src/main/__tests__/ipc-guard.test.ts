import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertTrustedMainSender } from '../ipc-guard.ts'

test('assertTrustedMainSender rejects missing main window', () => {
  const event = { sender: {} } as never
  const r = assertTrustedMainSender(event, null)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, 'no-main-window')
})

test('assertTrustedMainSender accepts matching webContents', () => {
  const wc = { isDestroyed: () => false }
  const win = { isDestroyed: () => false, webContents: wc }
  const event = { sender: wc }
  const r = assertTrustedMainSender(event as never, win as never)
  assert.equal(r.ok, true)
})

test('assertTrustedMainSender rejects foreign webContents', () => {
  const mainWc = { isDestroyed: () => false }
  const otherWc = { isDestroyed: () => false }
  const win = { isDestroyed: () => false, webContents: mainWc }
  const event = { sender: otherWc }
  const r = assertTrustedMainSender(event as never, win as never)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, 'untrusted-sender')
})
