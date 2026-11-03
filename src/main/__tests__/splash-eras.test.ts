import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ERA_FADE_MS,
  ERA_HOLD_MS,
  ERA_STEP_MS,
  LINEAGE_MS,
  SPLASH_ERAS,
  eraAt,
} from '../../common/splash-eras.ts'
import { readFileSync } from 'node:fs'

// The intro page walks every JakeTunes logo, oldest first, and lands on the
// one that ships (2026-11-02). The timeline is pure; SplashScreen.tsx draws it.

test('five marks, oldest first, the shipping pixel note last', () => {
  assert.deepEqual(SPLASH_ERAS.map((e) => e.key), ['portrait', 'cream-note', 'brush-j', 'pixel-ipod', 'pixel-note'])
})

test('the whole lineage is just over two seconds', () => {
  assert.equal(ERA_STEP_MS, ERA_FADE_MS + ERA_HOLD_MS)
  assert.equal(LINEAGE_MS, 4 * ERA_STEP_MS + ERA_FADE_MS)
  assert.ok(LINEAGE_MS >= 2000 && LINEAGE_MS <= 2600, `lineage ${LINEAGE_MS} ms`)
})

test('before it starts, the first mark has not begun', () => {
  assert.deepEqual(eraAt(-50), { index: 0, blend: 0, under: null, done: false })
  assert.deepEqual(eraAt(0), { index: 0, blend: 0, under: null, done: false })
})

test('the first mark dissolves in from nothing, then holds', () => {
  assert.deepEqual(eraAt(ERA_FADE_MS / 2), { index: 0, blend: 0.5, under: null, done: false })
  assert.deepEqual(eraAt(ERA_FADE_MS), { index: 0, blend: 1, under: null, done: false })
  assert.deepEqual(eraAt(ERA_STEP_MS - 1), { index: 0, blend: 1, under: null, done: false })
})

test('each later mark dissolves in over the one before it', () => {
  const t = ERA_STEP_MS + ERA_FADE_MS / 4
  assert.deepEqual(eraAt(t), { index: 1, blend: 0.25, under: 0, done: false })
  assert.deepEqual(eraAt(3 * ERA_STEP_MS + ERA_FADE_MS), { index: 3, blend: 1, under: null, done: false })
})

test('the last mark lands and stays', () => {
  const last = SPLASH_ERAS.length - 1
  assert.deepEqual(eraAt(LINEAGE_MS - 1).done, false)
  assert.deepEqual(eraAt(LINEAGE_MS), { index: last, blend: 1, under: null, done: true })
  assert.deepEqual(eraAt(LINEAGE_MS + 60_000), { index: last, blend: 1, under: null, done: true })
})

test('no caption under the logos (Jake, 2026-11-03)', () => {
  const splash = readFileSync(new URL('../../renderer/components/SplashScreen.tsx', import.meta.url), 'utf-8')
  const css = readFileSync(new URL('../../renderer/styles/app.css', import.meta.url), 'utf-8')
  assert.equal(splash.includes('app-splash-era'), false, 'the splash renders no era caption')
  assert.equal(css.includes('.app-splash-era'), false, 'and keeps no style for one')
})
