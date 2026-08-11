/**
 * A lock on what is allowed to touch Jake's music on its way to the speakers.
 *
 * Jake, 2026-08-10, after the muffled-audio night: "it sounds fine but it can
 * go off the rails im worried."
 *
 * He is worried about the right thing. The bug that caused that night was not
 * a stage someone added — it was a stage that had existed for months, called
 * itself "always-on", and had never actually run. Every playback Howl was
 * html5:false, and attachHowlToEq early-returns on those because there is no
 * <audio> element to tap. When an unrelated playback fix flipped those Howls
 * to html5:true, a saturator, a glue compressor, +1.8 dB of makeup and a
 * limiter switched themselves on across the whole library, and nothing in the
 * codebase noticed or could have noticed.
 *
 * That is the class of failure this file exists to catch: not "someone wrote
 * bad DSP" but "the signal path changed and no one meant it to." So this test
 * reads the source and asserts the SHAPE of the graph. It deliberately does
 * not import eq.ts — that module reaches for Howler and a real AudioContext,
 * neither of which exist under `node --test`. Reading the text is the point
 * anyway: the question is what the code is wired to do, not what it does on
 * one run.
 *
 * If this test fails, that is not necessarily a bug — it means the audible
 * path changed. Listen to the result, decide on purpose, and update the
 * allow-list below in the same commit.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '../../renderer/audio')
const eq = readFileSync(join(SRC, 'eq.ts'), 'utf-8')
const enhance = readFileSync(join(SRC, 'audioEnhance.ts'), 'utf-8')

/** The body of a top-level `function name(...)` declaration, brace-matched. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name}() not found — did it get renamed?`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  assert.fail(`unbalanced braces in ${name}()`)
}

describe('the music signal path', () => {
  test('buildChain creates only gain, EQ biquads and the analyser', () => {
    // Everything music flows through is built here. A compressor, a
    // waveshaper, a convolver or a delay appearing in this list means
    // something is now processing every song Jake plays.
    const ALLOWED = new Set(['createGain', 'createBiquadFilter', 'createAnalyser'])
    const found = new Set(bodyOf(eq, 'buildChain').match(/create[A-Z]\w+/g) || [])
    const unexpected = [...found].filter(n => !ALLOWED.has(n))
    assert.deepEqual(unexpected, [],
      `new node type(s) in the music path: ${unexpected.join(', ')}. ` +
      'Every song now goes through them. Confirm that is intended, listen to it, then update ALLOWED.')
  })

  test('the Enhance mastering stage stays out of the path', () => {
    // Bypassed, not deleted — the DSP is fine, it just must not be a default
    // that arrives as a side effect of something else. Const-false also lets
    // the bundler drop it from the app entirely.
    assert.match(eq, /const ENHANCE_IN_PATH = false/,
      'ENHANCE_IN_PATH is not const-false — the saturator, glue compressor and limiter are back on Jake\'s music.')
  })

  test('the EQ bands are flat until the user enables EQ', () => {
    // applySettings zeroes every band gain unless currentSettings.enabled.
    // Without this an unrelated default change could bake in a tone curve.
    assert.match(eq, /f\.gain\.value = currentSettings\.enabled \? \(currentSettings\.bands\[i\] \|\| 0\) : 0/,
      'EQ band gains are no longer gated on currentSettings.enabled.')
  })

  test('broadcast FX reach the announcer only, never music', () => {
    // ensureBroadcastFx builds the convolver + a hard compressor for Radio
    // Mode station IDs. One caller, and it takes an HTMLAudioElement — if it
    // ever gets called from buildChain or attachHowlToEq, music inherits a
    // radio-processing chain.
    const callers = (eq.match(/^\s*ensureBroadcastFx\(\)/gm) || []).length
    assert.equal(callers, 1, `ensureBroadcastFx() has ${callers} call sites; only attachAnnouncerToBroadcast may call it.`)
    assert.doesNotMatch(bodyOf(eq, 'buildChain'), /ensureBroadcastFx/, 'broadcast FX wired into the music path')
    assert.doesNotMatch(bodyOf(eq, 'attachHowlToEq'), /ensureBroadcastFx/, 'broadcast FX wired into the music path')
  })
})

describe('width and crossfeed are opt-in', () => {
  test('both default to off', () => {
    // These are genuinely nice and Jake can switch them on in Settings. What
    // matters is that they are off until he does — widthLow 0.0 collapses all
    // bass to mono and widthHigh 1.6 is a large widening, so silently-on
    // would be very audible.
    const defaults = enhance.slice(enhance.indexOf('ENHANCE_DEFAULTS'), enhance.indexOf('XOVER_LOW_HZ'))
    assert.match(defaults, /widthOn: false/, 'stereo width now defaults ON')
    assert.match(defaults, /crossfeedOn: false/, 'crossfeed now defaults ON')
  })

  test('the graph splices in only when one of them is on', () => {
    // This is the pattern eq.ts's Enhance stage should have followed and
    // didn't: the processing is not merely neutral when disabled, it is not
    // in the graph at all.
    assert.match(enhance, /const wantInsert = cfg\.widthOn \|\| cfg\.crossfeedOn/,
      'audioEnhance no longer gates insertion on width/crossfeed being enabled.')
  })

  test('only the user can turn them on', () => {
    // setEnhanceConfig must stay reachable from settings restore + the
    // Settings modal only. A persona, a mixtape or a per-track rule calling
    // it would change Jake's sound without him touching anything.
    const ALLOWED_CALLERS = ['App.tsx', 'SettingsModal.tsx', 'audioEnhance.ts']
    const root = join(import.meta.dirname, '../../renderer')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && readFileSync(p, 'utf-8').includes('setEnhanceConfig(')) hits.push(e.name)
      }
    }
    walk(root)
    const rogue = hits.filter(f => !ALLOWED_CALLERS.includes(f))
    assert.deepEqual(rogue, [], `setEnhanceConfig() called from ${rogue.join(', ')} — Jake's sound can now change without him asking.`)
  })
})
