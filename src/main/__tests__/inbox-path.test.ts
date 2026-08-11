/**
 * Inbox path allowlist — stops save-app-settings + delete-inbox-source
 * from turning an arbitrary root into a mass-delete surface.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isAllowedInboxPath, resolveInboxPath, getDefaultInboxPath } from '../inbox-watcher.ts'

test('default inbox path is allowed', () => {
  assert.equal(isAllowedInboxPath(getDefaultInboxPath()), true)
  assert.equal(isAllowedInboxPath(resolveInboxPath('')), true)
})

test('children of Music / Downloads / Desktop / Documents are allowed', () => {
  const home = homedir()
  assert.equal(isAllowedInboxPath(join(home, 'Music', '_inbox')), true)
  assert.equal(isAllowedInboxPath(join(home, 'Downloads', 'qobuz-drops')), true)
  assert.equal(isAllowedInboxPath(join(home, 'Desktop', 'inbox')), true)
  assert.equal(isAllowedInboxPath(join(home, 'Documents', 'drops')), true)
  assert.equal(isAllowedInboxPath(join(home, 'Music2', 'other')), true)
})

test('home, / , and shallow roots are refused', () => {
  assert.equal(isAllowedInboxPath(homedir()), false)
  assert.equal(isAllowedInboxPath('/'), false)
  assert.equal(isAllowedInboxPath(join(homedir(), 'Music')), false)
  assert.equal(isAllowedInboxPath(join(homedir(), 'Downloads')), false)
  assert.equal(isAllowedInboxPath('/etc'), false)
  assert.equal(isAllowedInboxPath('/tmp/evil'), false)
})
