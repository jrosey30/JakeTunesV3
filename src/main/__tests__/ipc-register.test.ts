/**
 * createIpcRegistrar defaults to refuseIfNotMainWindow; public: true opts out.
 * Option validation is tested here without Electron's ipcMain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertIpcRegisterOptions, REFUSED_SENDER } from '../ipc-register.ts'

test('REFUSED_SENDER is the shared ok:false shape', () => {
  assert.deepEqual(REFUSED_SENDER, { ok: false, error: 'refused-sender' })
})

test('guarded channel requires refuse value', () => {
  assert.throws(
    () => assertIpcRegisterOptions('needs-refuse'),
    /must pass \{ refuse \} or \{ public: true \}/,
  )
  assert.throws(
    () => assertIpcRegisterOptions('needs-refuse', {}),
    /must pass \{ refuse \} or \{ public: true \}/,
  )
})

test('refuse value satisfies the default-deny rule', () => {
  assert.deepEqual(
    assertIpcRegisterOptions('save-library', { refuse: REFUSED_SENDER }),
    { public: false },
  )
})

test('refuse: undefined is valid for void handlers', () => {
  assert.deepEqual(
    assertIpcRegisterOptions('set-library-context', { refuse: undefined }),
    { public: false },
  )
})

test('public: true opts out of the sender guard', () => {
  assert.deepEqual(
    assertIpcRegisterOptions('get-app-version', { public: true }),
    { public: true },
  )
})
