/**
 * The activity brief must stop presenting itself as "live" once it's old.
 *
 * Regression: a run brief from 2026-07-25 was still being injected into every
 * Music Man prompt nine days later, so the mic button talked about the run
 * instead of the song that was playing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatActivityContextForPrompt,
  activityContextAgeMs,
  ACTIVITY_CONTEXT_TTL_MS,
} from '../activity-context-core.ts'

const NOW = Date.parse('2026-08-03T20:00:00Z')

const ctx = (updatedAt: string) => ({
  brief: {
    activity: 'run' as const,
    intensity: 'easy' as const,
    setting: 'city' as const,
    social: 'solo' as const,
    place: 'Brooklyn, NY',
    note: 'y2k throwbacks',
    target: 250,
    updatedAt,
  },
  weather: null,
  setName: 'Brooklyn Drift',
  setCommentary: 'Easy miles through brownstone blocks.',
  updatedAt,
}) as never

test('a fresh brief is rendered', () => {
  const out = formatActivityContextForPrompt(ctx('2026-08-03T18:00:00Z'), NOW)
  assert.match(out, /ACTIVITY CONTEXT/)
  assert.match(out, /Brooklyn/)
})

test('the exact real-world regression: a nine-day-old run is dropped', () => {
  const out = formatActivityContextForPrompt(ctx('2026-07-25T16:51:04Z'), NOW)
  assert.equal(out, '', 'stale brief must not reach the prompt')
})

test('boundary: just inside the window renders, just outside does not', () => {
  const inside = new Date(NOW - ACTIVITY_CONTEXT_TTL_MS + 60_000).toISOString()
  const outside = new Date(NOW - ACTIVITY_CONTEXT_TTL_MS - 60_000).toISOString()
  assert.notEqual(formatActivityContextForPrompt(ctx(inside), NOW), '')
  assert.equal(formatActivityContextForPrompt(ctx(outside), NOW), '')
})

test('a brief built the night before a morning run still counts', () => {
  const lastNight = new Date(NOW - 10 * 60 * 60 * 1000).toISOString()
  assert.notEqual(formatActivityContextForPrompt(ctx(lastNight), NOW), '')
})

test('missing context or missing brief yields nothing', () => {
  assert.equal(formatActivityContextForPrompt(null, NOW), '')
  assert.equal(formatActivityContextForPrompt({ weather: null, updatedAt: '' } as never, NOW), '')
})

test('a context with no parseable timestamp is treated as stale, not fresh', () => {
  // Fail closed: an undated brief is more likely leftover than current.
  const undated = { brief: { activity: 'run', intensity: 'easy', setting: 'city', social: 'solo' } } as never
  assert.equal(activityContextAgeMs(undated, NOW), Number.POSITIVE_INFINITY)
  assert.equal(formatActivityContextForPrompt(undated, NOW), '')
})
