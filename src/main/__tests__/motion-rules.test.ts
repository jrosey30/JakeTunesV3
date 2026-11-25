/**
 * V7 motion rules — the plan's "Motion" section as a machine gate.
 *
 *   Three speeds (instant, normal, slow) on one curve, all named from
 *   src/renderer/styles/motion.css. A stylesheet or an inline style that
 *   writes its own duration or curve fails here.
 *   Nothing loops forever unless it means something: every `infinite` names
 *   a keyframe listed, with its reason, in src/renderer/motion.ts.
 *   With Reduce Motion on, everything just appears.
 *   What V7 cut stays cut.
 *
 * The scanners are pure and are tested on their own first (the "catches"
 * blocks), so a scanner that can no longer fail is itself a failure.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  MOTION_MS, MOTION_EASE, MOTION_PERIOD_MS, MOTION_STAGGER_MS,
  MEANINGFUL_LOOPS, MEANINGFUL_SCRIPT_LOOPS, MOTION_EXEMPT_FILES, MOTION_EXEMPT_SELECTOR, MOTION_CUT,
} from '../../renderer/motion.ts'

const REPO = join(import.meta.dirname, '../../..')
const RENDERER = join(REPO, 'src/renderer')

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') out.push(...walk(p, exts)) }
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
  }
  return out
}

// ── the scanners (pure) ─────────────────────────────────────────────────

/** Comments become spaces (lines kept), so positions still match the file. */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

const TIME = /(?<![\w.$-])-?(\d*\.?\d+)(ms|s)\b/g
const EASE_WORD = /(?<![\w-])(ease|ease-in|ease-out|ease-in-out)(?![\w-])/
const NOT_A_NAME = new Set(['infinite', 'both', 'forwards', 'backwards', 'none', 'alternate', 'alternate-reverse', 'reverse', 'normal', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'running', 'paused', 'step-start', 'step-end'])

function rawTimes(value: string): string[] {
  return [...value.matchAll(TIME)].filter((m) => Number(m[1]) !== 0).map((m) => m[0])
}

function splitTop(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out
}

function keyframeName(layer: string): string | null {
  const words = layer.replace(/[a-z-]+\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean)
  return words.find((w) => /^[a-zA-Z_][\w-]*$/.test(w) && !NOT_A_NAME.has(w)) ?? null
}

interface Decl { prop: string; value: string; selector: string; block: string; line: number }

function declarations(css: string): Decl[] {
  const t = blankComments(css)
  const out: Decl[] = []
  const re = /(?<![-\w])(transition|animation|transition-duration|transition-delay|transition-timing-function|animation-duration|animation-delay|animation-timing-function|animation-iteration-count|animation-name|--[\w-]+)\s*:\s*([^;{}]*)/g
  for (const m of t.matchAll(re)) {
    const at = m.index ?? 0
    const open = t.lastIndexOf('{', at)
    const before = Math.max(t.lastIndexOf('}', open), t.lastIndexOf(';', open), t.lastIndexOf('{', open - 1))
    const close = t.indexOf('}', at)
    out.push({
      prop: m[1],
      value: m[2].trim(),
      selector: t.slice(before + 1, open).replace(/\s+/g, ' ').trim(),
      block: t.slice(open, close === -1 ? undefined : close),
      line: t.slice(0, at).split('\n').length,
    })
  }
  return out
}

/** Every way a stylesheet can step outside the tokens. Exempt files/rules are the caller's business. */
function cssViolations(css: string): string[] {
  const bad: string[] = []
  for (const d of declarations(css)) {
    if (d.selector.startsWith('@keyframes') || /^(from|to|\d+%)/.test(d.selector)) continue
    if (MOTION_EXEMPT_SELECTOR.test(d.selector)) continue
    const where = `line ${d.line} (${d.selector.slice(0, 50)})`
    if (d.prop.startsWith('--')) {
      // A local knob is fine if it points at the tokens; a raw time is not.
      const raw = rawTimes(d.value)
      if (raw.length) bad.push(`${where}: ${d.prop} holds a raw time (${raw.join(', ')}); point it at var(--motion-*)`)
      continue
    }
    const raw = rawTimes(d.value)
    if (raw.length && d.prop !== 'animation-iteration-count') {
      bad.push(`${where}: raw time ${raw.join(', ')} in ${d.prop}; use var(--motion-instant|normal|slow) or a loop period`)
    }
    if (/cubic-bezier\(/.test(d.value)) bad.push(`${where}: a curve of its own in ${d.prop}; use var(--motion-ease)`)
    const loopRule = /infinite/.test(d.block)
    if (d.prop === 'transition' || d.prop === 'animation') {
      for (const layer of splitTop(d.value)) {
        const looping = /infinite/.test(layer)
        if (!looping && EASE_WORD.test(layer)) bad.push(`${where}: "${layer.trim()}" uses a stock curve; use var(--motion-ease)`)
        if (looping && d.prop === 'animation') {
          const name = keyframeName(layer)
          if (!name || !(name in MEANINGFUL_LOOPS)) bad.push(`${where}: "${name}" loops for ever and means nothing listed in motion.ts MEANINGFUL_LOOPS`)
        }
      }
    }
    if (d.prop.endsWith('timing-function') && !loopRule && EASE_WORD.test(d.value)) {
      bad.push(`${where}: a stock curve in ${d.prop}; use var(--motion-ease)`)
    }
    if (d.prop === 'animation-iteration-count' && /infinite/.test(d.value)) {
      const named = /animation(?:-name)?\s*:\s*([^;]*)/.exec(d.block)
      const name = named ? keyframeName(named[1]) : null
      if (!name || !(name in MEANINGFUL_LOOPS)) bad.push(`${where}: "${name}" loops for ever and means nothing listed in motion.ts MEANINGFUL_LOOPS`)
    }
  }
  return bad
}

/** Inline styles in TS/TSX: a raw time or curve in a transition/animation string; a WAAPI loop. */
function scriptViolations(src: string, file: string): string[] {
  const bad: string[] = []
  const line = (i: number): number => src.slice(0, i).split('\n').length
  const re = /(?:\b(?:transition|animation)(?:Duration|Delay|TimingFunction)?\s*:|\.style\.(?:transition|animation)\w*\s*=)\s*([`'"])([^`'"]*)\1/g
  for (const m of src.matchAll(re)) {
    const v = m[2]
    const raw = rawTimes(v.replace(/\$\{[^}]*\}/g, ' '))
    if (raw.length || /\}m?s\b/.test(v)) bad.push(`line ${line(m.index ?? 0)}: raw time in "${v}"; use var(--motion-*) (motion.ts motionTransition)`)
    if (/cubic-bezier\(/.test(v) || EASE_WORD.test(v)) bad.push(`line ${line(m.index ?? 0)}: a curve of its own in "${v}"; use var(--motion-ease)`)
  }
  if (/iterations\s*:\s*Infinity/.test(src) && !(file in MEANINGFUL_SCRIPT_LOOPS)) {
    bad.push(`a script animation loops for ever (iterations: Infinity) and is not in motion.ts MEANINGFUL_SCRIPT_LOOPS`)
  }
  return bad
}

function rootVars(css: string): Map<string, string> {
  const t = blankComments(css)
  const start = t.indexOf(':root {')
  const body = t.slice(start, t.indexOf('}', start))
  const vars = new Map<string, string>()
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1], m[2].trim())
  return vars
}

// ── the scanners catch what they must (mutation checks) ─────────────────

describe('the motion scanners catch what they must', () => {
  test('a raw duration, a stock curve, a curve of its own', () => {
    assert.equal(cssViolations('.a { transition: opacity 120ms ease; }').length, 2)
    assert.equal(cssViolations('.a { transition: opacity var(--motion-instant) cubic-bezier(0.2, 0, 0, 1); }').length, 1)
    assert.equal(cssViolations('.a { transition: opacity 0.2s; }').length, 1)
    assert.equal(cssViolations('.a {\n  transition:\n    opacity 0.2s var(--motion-ease),\n    color var(--motion-instant) var(--motion-ease);\n}').length, 1)
    assert.equal(cssViolations('.a { animation-delay: 60ms; }').length, 1)
    assert.equal(cssViolations('.a { --knob: 240ms; }').length, 1)
    assert.equal(cssViolations('.a { animation-duration: var(--x, 420ms); }').length, 1)
    assert.equal(cssViolations('.a { animation-timing-function: ease-in-out; }').length, 1)
  })
  test('a loop that means nothing, either way it is written', () => {
    assert.equal(cssViolations('.a { animation: shimmy var(--motion-pulse) ease-in-out infinite; }').length, 1)
    assert.equal(cssViolations('.a { animation: shimmy var(--motion-pulse) linear both; animation-iteration-count: infinite; }').length, 1)
    assert.equal(cssViolations('.a { animation-name: shimmy; animation-iteration-count: infinite; }').length, 1)
  })
  test('script styles: raw times, template times, stock curves, endless WAAPI', () => {
    assert.equal(scriptViolations(`<div style={{ transition: 'opacity 0.15s' }} />`, 'x.tsx').length, 1)
    assert.equal(scriptViolations('el.style.transition = \'opacity 200ms ease\'', 'x.ts').length, 2)
    assert.equal(scriptViolations('style={{ animationDelay: `${i * 40}ms` }}', 'x.tsx').length, 1)
    assert.equal(scriptViolations('el.animate(f, { duration: 900, iterations: Infinity })', 'x.ts').length, 1)
  })
  test('what the tokens allow passes', () => {
    assert.deepEqual(cssViolations('.a { transition: opacity var(--motion-instant) var(--motion-ease), left var(--motion-normal) linear; }'), [])
    assert.deepEqual(cssViolations('.a { animation: dj-pulse var(--motion-pulse) ease-in-out infinite; }'), [])
    assert.deepEqual(cssViolations('.a { animation-delay: calc(var(--i, 0) * var(--motion-stagger)); transition: none; }'), [])
    assert.deepEqual(cssViolations('.a { animation: x var(--motion-normal) var(--motion-ease) 0ms both; }'), [])
    assert.deepEqual(scriptViolations(`style={{ transition: 'opacity var(--motion-instant) var(--motion-ease)' }}`, 'x.tsx'), [])
  })
})

// ── the tree ────────────────────────────────────────────────────────────

const rel = (p: string): string => relative(REPO, p)

describe('V7 motion — the app', () => {
  test('motion.css and motion.ts hold the same numbers (⚠️ TWIN)', () => {
    const vars = rootVars(readFileSync(join(RENDERER, 'styles/motion.css'), 'utf-8'))
    assert.equal(vars.get('--motion-instant'), `${MOTION_MS.instant}ms`)
    assert.equal(vars.get('--motion-normal'), `${MOTION_MS.normal}ms`)
    assert.equal(vars.get('--motion-slow'), `${MOTION_MS.slow}ms`)
    assert.equal(vars.get('--motion-ease'), MOTION_EASE)
    assert.equal(vars.get('--motion-stagger'), `${MOTION_STAGGER_MS}ms`)
    assert.equal(vars.get('--motion-spin'), `${MOTION_PERIOD_MS.spin}ms`)
    assert.equal(vars.get('--motion-blink'), `${MOTION_PERIOD_MS.blink}ms`)
    assert.equal(vars.get('--motion-pulse'), `${MOTION_PERIOD_MS.pulse}ms`)
    // a fifth of a second for pages and dialogs; three speeds in order
    assert.ok(MOTION_MS.instant < MOTION_MS.normal && MOTION_MS.normal < MOTION_MS.slow)
    assert.ok(Math.abs(MOTION_MS.normal - 200) <= 20)
  })

  test('no stylesheet steps outside the tokens or loops for nothing', () => {
    const problems: string[] = []
    for (const f of walk(RENDERER, ['.css'])) {
      if (rel(f) in MOTION_EXEMPT_FILES) continue
      for (const p of cssViolations(readFileSync(f, 'utf-8'))) problems.push(`${rel(f)} ${p}`)
    }
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`)
  })

  test('no inline style steps outside the tokens; no script loop for nothing', () => {
    const problems: string[] = []
    for (const f of walk(RENDERER, ['.ts', '.tsx'])) {
      const r = rel(f)
      if (r in MOTION_EXEMPT_FILES || r.startsWith('src/renderer/components/yir/') || r === 'src/renderer/motion.ts') continue
      for (const p of scriptViolations(readFileSync(f, 'utf-8'), r)) problems.push(`${r} ${p}`)
    }
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`)
  })

  test('every listed loop still exists (the list can only describe real loops)', () => {
    const css = walk(RENDERER, ['.css']).map((f) => readFileSync(f, 'utf-8')).join('\n')
    const stale = Object.keys(MEANINGFUL_LOOPS).filter((k) => !new RegExp(`@keyframes\\s+${k}\\b`).test(css))
    assert.deepEqual(stale, [], `listed in MEANINGFUL_LOOPS but no such @keyframes: ${stale.join(', ')}`)
  })

  test('Reduce Motion: everything just appears, following the OS', () => {
    const css = blankComments(readFileSync(join(RENDERER, 'styles/motion.css'), 'utf-8'))
    for (const gate of ["@media (prefers-reduced-motion: reduce)", ":root[data-motion='reduce']"]) {
      const at = css.indexOf(gate)
      assert.ok(at >= 0, `motion.css has no ${gate} block`)
      const block = css.slice(at, at + 900)
      for (const rule of ['animation-duration: 0.01ms !important', 'animation-iteration-count: 1 !important', 'transition-duration: 0.01ms !important', 'animation-delay: 0ms !important']) {
        assert.ok(block.includes(rule), `${gate} must set ${rule}`)
      }
    }
    const main = readFileSync(join(RENDERER, 'main.tsx'), 'utf-8')
    assert.match(main, /^initMotion\(\)/m, 'main.tsx must call initMotion() so <html data-motion> follows the OS live')
  })

  test('what V7 cut stays cut', () => {
    const css = walk(RENDERER, ['.css']).map((f) => readFileSync(f, 'utf-8')).join('\n')
    const back = Object.keys(MOTION_CUT).filter((k) => new RegExp(`(@keyframes\\s+|animation(-name)?\\s*:[^;]*\\b)${k}\\b`).test(css))
    assert.deepEqual(back, [], `cut in V7 and back again: ${back.map((k) => `${k} (${MOTION_CUT[k]})`).join(', ')}`)
  })
})
