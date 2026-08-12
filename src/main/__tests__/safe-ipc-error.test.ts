import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeIpcError } from '../safe-ipc-error.ts'

test('passes through short stable codes', () => {
  assert.equal(safeIpcError('refused-sender'), 'refused-sender')
  assert.equal(safeIpcError('path-not-allowed'), 'path-not-allowed')
})

test('passes through known AI/TTS phrases', () => {
  assert.equal(
    safeIpcError('ANTHROPIC_API_KEY missing — Cynthia is on break.'),
    'ANTHROPIC_API_KEY missing — Cynthia is on break.',
  )
  assert.equal(
    safeIpcError('TTS rate limit — try again in a moment.'),
    'TTS rate limit — try again in a moment.',
  )
})

test('strips filesystem paths to stable codes', () => {
  assert.equal(
    safeIpcError(new Error('ENOENT: no such file or directory, open \'/Users/jake/Music/x.mp3\'')),
    'io-failed',
  )
  assert.equal(
    safeIpcError('restore_from_xml.py exited with code 1: Traceback… /tmp/foo'),
    'tool-failed',
  )
  assert.equal(
    safeIpcError('DB write failed (code 1): /Volumes/JACOBROSENB/iPod_Control/iTunes/iTunesDB'),
    'io-failed',
  )
  assert.equal(
    safeIpcError('spawn python3 ENOENT /opt/homebrew/bin/python3'),
    'io-failed',
  )
})

test('passes through newly allowlisted tooling phrases', () => {
  assert.equal(safeIpcError('Python 3 is not installed.'), 'Python 3 is not installed.')
  assert.equal(safeIpcError('No iPod detected'), 'No iPod detected')
  assert.equal(safeIpcError('mobile backend unreachable'), 'mobile backend unreachable')
})

test('classifies API / rate-limit failures', () => {
  assert.equal(safeIpcError('429 Too Many Requests'), 'rate-limited')
  assert.equal(safeIpcError(new Error('fetch failed')), 'api-failed')
  assert.equal(safeIpcError('{"detail":"voice not found"}'), 'api-failed')
})

test('empty / unknown falls back', () => {
  assert.equal(safeIpcError(''), 'unknown')
  assert.equal(safeIpcError(null), 'unknown')
  assert.equal(safeIpcError(new Error('something weird happened today')), 'unknown')
})
