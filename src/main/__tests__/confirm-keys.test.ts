/**
 * spec-03: Enter never deletes by surprise. ConfirmDialog used to confirm on
 * every Enter while it focused Cancel, so a reflexive Enter on "Delete
 * this?" deleted. Enter now presses the button that has focus; a destructive
 * dialog opens on Cancel.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { defaultButton, enterPresses } from '../../renderer/confirm-keys.ts'

describe('Enter in a confirm dialog', () => {
  it('a delete dialog opens on Cancel, and Enter there cancels', () => {
    assert.equal(defaultButton(true, false), 'cancel')
    assert.equal(enterPresses('cancel', true, false), 'cancel')
  })

  it('Enter deletes only once you have moved to Delete', () => {
    assert.equal(enterPresses('confirm', true, false), 'confirm')
  })

  it('with focus on neither button, a delete dialog still cancels', () => {
    assert.equal(enterPresses(null, true, false), 'cancel')
  })

  it('a dialog that destroys nothing opens on its confirm button, and Enter confirms', () => {
    assert.equal(defaultButton(false, false), 'confirm')
    assert.equal(enterPresses(null, false, false), 'confirm')
    assert.equal(enterPresses('confirm', false, false), 'confirm')
    // …unless you moved to Cancel.
    assert.equal(enterPresses('cancel', false, false), 'cancel')
  })

  it('an informational dialog (no Cancel) is dismissed by Enter', () => {
    assert.equal(defaultButton(true, true), 'confirm')
    assert.equal(enterPresses(null, true, true), 'confirm')
    assert.equal(enterPresses('cancel', true, true), 'confirm', 'a hidden Cancel cannot be pressed')
  })
})
