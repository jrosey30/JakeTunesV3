/**
 * One shop, one name for each thing (Jake approved the Record Shop picture,
 * 2026-11-24): the sidebar's STORE is the Record Shop and Downloads, the shop
 * is a title, one search box and four tabs, and no screen says a retired name
 * ("Listen List", "The Racks", "Bandcamp Store", "Get all", "your list").
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { RETIRED_SHOP_NAMES, SHOP_TAB_LABELS, STORE_ROWS, LIST_MARK, retiredNamesIn } from '../../common/shop-names.ts'
import { SHOP_TABS } from '../../renderer/views/discoveryTab.ts'
import { getShopQuery, setShopQuery, shopQueryHow, setShopSearching, shopSearching, subscribeShopQuery, typingOpensSearch } from '../../renderer/views/DownloadStore/shopQuery.ts'
import { markLine } from '../../common/shop-search.ts'

const SRC = join(import.meta.dirname, '..', '..')
const src = (p: string): string => readFileSync(join(SRC, p), 'utf-8')

/** The code with its comments taken out; strings and JSX text stay. */
function withoutComments(code: string): string {
  let out = ''
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i]
    const d = code[i + 1]
    if (c === '/' && d === '/') { while (i < n && code[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { const end = code.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue }
    if (c === '"' || c === "'" || c === '`') {
      // A string, kept whole (a quote or a line end closes a plain one).
      let j = i + 1
      while (j < n && code[j] !== c && (c === '`' || code[j] !== '\n')) j += code[j] === '\\' ? 2 : 1
      out += code.slice(i, j + 1)
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== '_archive') out.push(...filesUnder(p)); continue }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
  return out
}

describe('the retired names', () => {
  it('are found as whole words, with their case', () => {
    assert.deepEqual(retiredNamesIn('Add it to the Listen List'), ['Listen List'])
    assert.deepEqual(retiredNamesIn('Listen to the List'), ['Listen to the List'])
    assert.deepEqual(retiredNamesIn('already on your list.'), ['your list'])
    assert.deepEqual(retiredNamesIn('For You · The Racks'), ['The Racks'])
    assert.deepEqual(retiredNamesIn('Bandcamp Store'), ['Bandcamp Store'])
    assert.deepEqual(retiredNamesIn('Get all'), ['Get all'])
  })
  it('leave the words that only look like them alone', () => {
    assert.deepEqual(retiredNamesIn('On your Listening List'), [])
    assert.deepEqual(retiredNamesIn('12 fixed by your lists'), [])
    assert.deepEqual(retiredNamesIn('Listen to this'), [])
    assert.deepEqual(retiredNamesIn('Bandcamp'), [])
    assert.deepEqual(retiredNamesIn('Get allergies'), [])
  })
  it('the list mark says the list by its name', () => {
    assert.equal(LIST_MARK, 'On your Listening List')
    assert.equal(markLine({ owned: null, listed: true }), LIST_MARK)
  })
})

describe('no screen says a retired name', () => {
  const files = [...filesUnder(join(SRC, 'renderer')), ...filesUnder(join(SRC, 'common'))]
    .filter((p) => !p.endsWith(join('common', 'shop-names.ts')))
  it('reads the renderer and the shared words (comments are not read)', () => {
    assert.ok(files.length > 200, `only ${files.length} files`)
    assert.equal(retiredNamesIn(withoutComments('// the Listen List\n/* The Racks */\nconst a = 1')).length, 0)
    assert.deepEqual(retiredNamesIn(withoutComments('const a = "the Listen List" // ok')), ['Listen List'])
    assert.deepEqual(retiredNamesIn(withoutComments('<h1>The Racks</h1>')), ['The Racks'])
    assert.deepEqual(retiredNamesIn(withoutComments("const u = 'https://x.y/' + `Get all ${n}`")), ['Get all'])
  })
  it('in any of them', () => {
    const hits: string[] = []
    for (const p of files) {
      const lines = withoutComments(readFileSync(p, 'utf-8')).split('\n')
      lines.forEach((line, i) => { for (const name of retiredNamesIn(line)) hits.push(`${relative(SRC, p)}:${i + 1} says “${name}”`) })
    }
    assert.deepEqual(hits, [], `retired names (common/shop-names.ts): ${RETIRED_SHOP_NAMES.join(', ')}`)
  })
})

describe('STORE is the Record Shop and Downloads', () => {
  const sidebar = src('renderer/components/sidebar/Sidebar.tsx')
  const store = sidebar.slice(sidebar.indexOf("['store', ("), sidebar.indexOf(')],', sidebar.indexOf("['store', (")))
  it('the rows are STORE_ROWS, in order, and nothing else', () => {
    assert.deepEqual([...STORE_ROWS], ['Record Shop', 'Downloads'])
    assert.ok(store.length > 0, 'the STORE section is found')
    const labels = [...withoutComments(store).matchAll(/<SidebarItem\s+label=\{?([^\n}]+)\}?/g)].map((m) => m[1].trim())
    assert.deepEqual(labels, ['STORE_ROWS[0]', 'STORE_ROWS[1]'])
  })
  it('Bandcamp has no row of its own; the Record Shop row is lit on every tab', () => {
    assert.doesNotMatch(withoutComments(store), /Bandcamp|requestDiscoveryTab/)
    assert.match(store, /selected=\{state\.currentView === 'discovery' \|\|/)
  })
})

describe('the shop: a title, one search box, four tabs', () => {
  it('the tabs are For You, Search, Listening List and Bandcamp, ids unchanged', () => {
    assert.deepEqual([...SHOP_TAB_LABELS], ['For You', 'Search', 'Listening List', 'Bandcamp'])
    assert.deepEqual(SHOP_TABS.map((t) => t.label), [...SHOP_TAB_LABELS])
    assert.deepEqual(SHOP_TABS.map((t) => t.id), ['new-for-you', 'browse', 'your-list', 'bandcamp'])
  })
  it('the shop draws its tabs from SHOP_TABS, with its name and the box above them', () => {
    const dv = withoutComments(src('renderer/views/DiscoveryView.tsx'))
    assert.match(dv, /SHOP_TABS\.map\(/)
    assert.doesNotMatch(dv, />(For You|Search|Listening List|Bandcamp)</, 'no tab label written by hand')
    assert.match(dv, /<h1 className="discovery-title">\{SHOP_WORDS\.shop\}<\/h1>/)
    assert.ok(dv.indexOf('className="dl-input"') > 0 && dv.indexOf('className="dl-input"') < dv.indexOf('SHOP_TABS.map('), 'the box is above the tabs')
  })
  it('there is one box: the Search tab has none of its own, and reads the shop’s', () => {
    const view = withoutComments(src('renderer/views/DownloadStore/DownloadView.tsx'))
    assert.doesNotMatch(view, /className="dl-input"/)
    assert.match(view, /useSyncExternalStore\(subscribeShopQuery, getShopQuery\)/)
    assert.doesNotMatch(view, /useState\(pageCache\.query\)/)
    assert.doesNotMatch(withoutComments(src('renderer/views/NewForYouView.tsx')), /<h1 className="store-title">/, 'For You does not say the shop’s name a second time')
  })
})

describe('the box', () => {
  it('typing brings Search forward; clearing the box does not', () => {
    assert.equal(typingOpensSearch('p'), true)
    assert.equal(typingOpensSearch('pink floyd'), true)
    assert.equal(typingOpensSearch(''), false)
    assert.equal(typingOpensSearch('   '), false)
  })
  it('keeps the words and how they came, and tells its watchers once per change', () => {
    let told = 0
    const stop = subscribeShopQuery(() => { told++ })
    setShopQuery('pink floyd', 'typed')
    assert.equal(getShopQuery(), 'pink floyd')
    assert.equal(shopQueryHow(), 'typed')
    setShopQuery('pink floyd', 'typed')
    assert.equal(told, 1, 'the same words are not news')
    setShopQuery('Animals Pink Floyd', 'list')
    assert.equal(shopQueryHow(), 'list')
    setShopSearching(true); setShopSearching(true)
    assert.equal(shopSearching(), true)
    assert.equal(told, 3)
    setShopSearching(false)
    stop()
    setShopQuery('', 'typed')
    assert.equal(told, 4, 'a watcher that left is not told')
  })
})
