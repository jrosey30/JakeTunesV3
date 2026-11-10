// dx.nav (2026-11-10) — one row per page navigation, through the existing
// renderer → flight-recorder pipe, behind a flag that is off by default. The
// diagnosis could time the parts of an artist page opening but not the whole;
// these rows are the whole, from Jake's own use.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createNavDx, NAV_DX_TAG, type NavDxRow } from '../../renderer/navDx.ts'

const make = (enabled = true) => {
  let clock = 1000
  const rows: Array<{ tag: string; row: NavDxRow }> = []
  const dx = createNavDx({ now: () => clock, emit: (tag, row) => rows.push({ tag, row }), enabled: () => enabled })
  return { dx, rows, tick: (ms: number) => { clock += ms }, at: () => clock }
}
const nav = (tClick: number | null) => ({ from: 'kept:artists', to: 'artist:Geese', how: 'click' as const, kind: 'arrive' as const, remount: true, tClick })

describe('dx.nav: one row per navigation', () => {
  it('click → commit → paint → settled, each in milliseconds from the click', () => {
    const { dx, rows, tick, at } = make()
    const click = at()
    tick(12); dx.begin(nav(click)); dx.mark('commit')
    tick(20); dx.mark('paint')
    tick(200); dx.settle(0)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].tag, NAV_DX_TAG)
    const r = rows[0].row
    assert.deepEqual({ from: r.from, to: r.to, how: r.how, kind: r.kind, remount: r.remount }, { from: 'kept:artists', to: 'artist:Geese', how: 'click', kind: 'arrive', remount: true })
    assert.deepEqual(r.t, { click: 0, commit: 12, paint: 32, settled: 232 })
  })

  it('no pointer went down (⌘[, a menu) or it was long ago: timed from the commit, and it says so', () => {
    const { dx, rows, tick, at } = make()
    dx.begin({ ...nav(null), how: 'back', kind: 'return' }); dx.mark('commit'); tick(40); dx.settle(900)
    assert.deepEqual(rows[0].row.t, { click: null, commit: 0, paint: null, settled: 40 })
    const stale = at() - 60_000
    dx.begin(nav(stale)); dx.mark('commit'); dx.settle(null)
    assert.equal(rows[1].row.t.click, null, 'a click a minute ago did not cause this navigation')
  })

  it("the artist page's asks: how long each took and where its answer came from", () => {
    const { dx, rows } = make()
    dx.begin(nav(null))
    dx.source('profile-cache', 0, 'memory')
    dx.source('profile-refresh', 14.4, 'homemini')
    dx.source('photo', 0, 'memory')
    dx.source('wiki', 3, 'main')
    dx.source('related', 1512, 'homemini')
    dx.source('discography', 6001, 'main')
    dx.settle(0)
    assert.deepEqual(rows[0].row.src['profile-refresh'], { ms: 14, from: 'homemini' })
    assert.deepEqual(Object.keys(rows[0].row.src), ['profile-cache', 'profile-refresh', 'photo', 'wiki', 'related', 'discography'])
  })

  it('every change of the header picture is counted, with its time (the swaps of defect 1)', () => {
    const { dx, rows, tick } = make()
    dx.begin(nav(null))
    dx.hero('album-art://cover.jpg'); tick(30); dx.hero('artist-image://geese.jpg'); tick(400); dx.hero('artist-image://ap-hero-1.jpg')
    dx.settle(0)
    assert.deepEqual(rows[0].row.hero, [{ t: 0, src: 'album-art://cover.jpg' }, { t: 30, src: 'artist-image://geese.jpg' }, { t: 430, src: 'artist-image://ap-hero-1.jpg' }])
  })

  it('images (scheme, size asked, natural size, ms from src to load), layout shifts, long tasks, scroll', () => {
    const { dx, rows } = make()
    dx.begin(nav(null))
    dx.image({ scheme: 'album-art', size: 480, natural: [480, 480], ms: 12 })
    dx.image({ scheme: 'artist-image', size: 480, natural: [480, 600], ms: 31 })
    dx.image({ scheme: 'artist-image', size: 0, natural: [2160, 2700], ms: 140 })
    dx.shift(0.0123); dx.shift(0.2)
    dx.longTask(88.4)
    dx.scroll({ saved: 2400 }); dx.scroll({ restored: 2400 })
    dx.settle(2399.6)
    const r = rows[0].row
    assert.equal(r.img.n, 3)
    assert.deepEqual(r.img.byScheme, { 'album-art': 1, 'artist-image': 2 })
    assert.deepEqual(r.img.slow[0], { scheme: 'artist-image', size: 0, natural: [2160, 2700], ms: 140 }, 'slowest first')
    assert.deepEqual(r.shift, { n: 2, score: 0.2123 })
    assert.deepEqual(r.long, { n: 1, ms: 88 })
    assert.deepEqual(r.scroll, { saved: 2400, restored: 2400, settled: 2400 })
  })

  it('a page left before it settled still gets its row; nothing is recorded with no navigation open', () => {
    const { dx, rows } = make()
    dx.source('photo', 5, 'main'); dx.hero('x'); dx.settle(0)
    assert.equal(rows.length, 0)
    dx.begin(nav(null)); dx.hero('a')
    dx.begin({ ...nav(null), to: 'artist:Fat Dog' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].row.to, 'artist:Geese')
    assert.equal(dx.open(), true)
  })

  it("the row always fits main's 2,000-character cap for one dx detail (a longer one is dropped there)", () => {
    const { dx, rows, tick } = make()
    dx.begin({ from: 'x'.repeat(500), to: `artist:${'Godspeed You! Black Emperor '.repeat(20)}`, how: 'swipe', kind: 'return', remount: true, tClick: null })
    dx.mark('commit'); dx.mark('paint')
    for (let i = 0; i < 40; i++) { tick(7); dx.hero(`artist-image://${'very-long-slug-'.repeat(12)}${i}.jpg`) }
    for (let i = 0; i < 300; i++) dx.image({ scheme: `scheme-number-${i}-with-a-long-name`, size: 1024, natural: [21600, 27000], ms: 12345.678 + i })
    for (let i = 0; i < 40; i++) dx.source(`source-with-a-very-long-name-${i}`, 99999.9, 'a-very-long-origin-name-indeed')
    for (let i = 0; i < 500; i++) { dx.shift(0.123456789); dx.longTask(123.456) }
    dx.scroll({ saved: 123456.789, restored: 123456.789 })
    dx.settle(123456.789)
    const size = JSON.stringify(rows[0].row).length
    assert.ok(size < 2000, `row is ${size} characters`)
    assert.ok(rows[0].row.hero.length <= 6)
    assert.equal(rows[0].row.img.n, 300, 'the count is whole even though only the slowest are listed')
  })
})

describe('dx.nav is off unless asked for', () => {
  it('disabled: nothing is collected and nothing is emitted', () => {
    const { dx, rows } = make(false)
    dx.begin(nav(null)); dx.mark('commit'); dx.hero('a'); dx.image({ scheme: 'x', size: 0, natural: [1, 1], ms: 1 }); dx.settle(0)
    assert.equal(rows.length, 0)
    assert.equal(dx.open(), false)
  })
  it('the page side installs no listener or observer until the flag is found on, and every feed is a no-op before that', () => {
    const dom = readFileSync(join(import.meta.dirname, '../../renderer/navDxDom.ts'), 'utf-8')
    assert.match(dom, /^let on = false$/m)
    const init = dom.slice(dom.indexOf('export async function initNavDx'), dom.indexOf('export function noteNavHow'))
    assert.ok(init.indexOf('if (!ui && !env) return') < init.indexOf('addEventListener'), 'the flag is read before anything is installed')
    assert.ok(init.indexOf('if (!ui && !env) return') < init.indexOf('new MutationObserver'))
    assert.ok(init.indexOf('if (!ui && !env) return') < init.indexOf('PerformanceObserver'))
    assert.match(init, /\.navDx === true/, 'ui-state: "navDx": true')
    for (const fn of ['noteNavHow', 'navDxNavigated']) assert.match(dom.slice(dom.indexOf(`export function ${fn}`)), /^[^\n]*\n(?:[^\n]*\n)?\s*if \(!on/, `${fn} returns at once while off`)
    assert.match(dom, /export const navDxSource = [^\n]*=> \{ if \(on\)/)
    assert.match(dom, /export const navDxHero = [^\n]*=> \{ if \(on\)/)
    assert.match(dom, /if \(!on\) return p/)
  })
  it('JT_NAV_DX=1 is the other switch, and the rows travel the existing dx-record pipe', () => {
    const index = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf-8')
    assert.match(index, /ipc\.handle\('nav-dx:env', async \(\): Promise<boolean> => process\.env\.JT_NAV_DX === '1'/)
    assert.match(index, /ipcMain\.on\('dx-record'/)
    const dom = readFileSync(join(import.meta.dirname, '../../renderer/navDxDom.ts'), 'utf-8')
    assert.match(dom, /api\.dxRecord\?\.\(tag, detail\)/)
    assert.match(readFileSync(join(import.meta.dirname, '../../renderer/App.tsx'), 'utf-8'), /void initNavDx\(\)/)
  })
  it('the page feeds it: navigations, the header picture, each ask, the scroll', () => {
    const r = (...p: string[]): string => readFileSync(join(import.meta.dirname, '../../renderer', ...p), 'utf-8')
    assert.match(r('components', 'MainContent.tsx'), /navDxNavigated\(\{ from, to: activeKey, kind: arrival, remount: !keptActive \}\)/)
    assert.match(r('components', 'artist', 'HeroPhoto.tsx'), /navDxHero\(src\)/)
    assert.match(r('hooks', 'useScrollPersistence.ts'), /navDxScroll\(\{ saved: remembered\?\.top \?\? null \}\)/)
    const view = r('views', 'ArtistDetailView.tsx')
    for (const ask of ["'wiki'", "'photo-ask'", "'related'", "'discography'"]) assert.ok(view.includes(`navDxTimed(${ask}`) || view.includes(`navDxSource(${ask}`), ask)
    assert.match(r('artistProfile.ts'), /createArtistProfileStore\(\(\) => window\.electronAPI, undefined, navDxSource\)/)
    assert.match(r('context', 'NavigationContext.tsx'), /noteNavHow\('back'\)/)
    assert.match(r('context', 'NavigationContext.tsx'), /noteNavHow\('swipe'\)/)
  })
})
