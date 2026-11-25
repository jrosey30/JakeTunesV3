/**
 * V7 "click opens, ▶ plays" (2026-11-24): the rule table (common/card-rules.ts),
 * and the pages held to it. The page checks read the source: a card that plays
 * on a plain click, a double-click that plays on a card, a hand-made album menu
 * that drifts from the Albums view's, a "See All 24" or a typed "▶ Play" each
 * fails here.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  CARD_KINDS, MENU_FOR, PLAYLIST_ROW_TITLE, PLAY_LABEL, SEE_ALL,
  canDrag, cardAction, playTitle, seeAllShown, songRowAction, type Gesture,
} from '../../common/card-rules.ts'

const SRC = join(import.meta.dirname, '../..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

const GESTURES: Gesture[] = ['click', 'enter', 'space', 'double-click', 'play-button', 'context-menu', 'drag']

describe('the card rule: click opens, ▶ plays', () => {
  it('click, Enter and Space open; only the ▶ plays', () => {
    assert.equal(cardAction('click'), 'open')
    assert.equal(cardAction('enter'), 'open')
    assert.equal(cardAction('space'), 'open')
    assert.equal(cardAction('play-button'), 'play')
    assert.deepEqual(GESTURES.filter((g) => cardAction(g) === 'play'), ['play-button'])
  })
  it('a double-click on a card does nothing extra (the first click already opened it)', () => {
    assert.equal(cardAction('double-click'), 'none')
  })
  it('right-click is the menu, drag is the drag', () => {
    assert.equal(cardAction('context-menu'), 'menu')
    assert.equal(cardAction('drag'), 'drag')
  })
})

describe('song rows keep the song table rule', () => {
  it('a single click never plays a song row; double-click and Enter do', () => {
    assert.equal(songRowAction('click'), 'select')
    assert.equal(songRowAction('double-click'), 'play')
    assert.equal(songRowAction('enter'), 'play')
    assert.deepEqual(GESTURES.filter((g) => songRowAction(g) === 'play').sort(), ['double-click', 'enter'])
  })
})

describe('one menu per kind', () => {
  it('every kind of card has a menu', () => {
    for (const k of CARD_KINDS) assert.ok(MENU_FOR[k], `${k} has no menu`)
    assert.deepEqual(Object.keys(MENU_FOR).sort(), [...CARD_KINDS].sort())
  })
  it('the same thing gets the same menu: chart covers and song cards are songs; Island covers and concerts are albums', () => {
    assert.equal(MENU_FOR.chart, MENU_FOR.song)
    assert.equal(MENU_FOR.island, MENU_FOR.album)
    assert.equal(MENU_FOR.concert, MENU_FOR.album)
    assert.equal(MENU_FOR.mix, MENU_FOR.playlist)
  })
  it('only things in the library drag (a show, a shop item, a Listening List row have no songs yet)', () => {
    assert.deepEqual(CARD_KINDS.filter((k) => !canDrag(k)).sort(), ['reco', 'shop', 'show'])
  })
})

describe('See All and the Play button words', () => {
  it('"See All" is always these words, shown only with a page to open', () => {
    assert.equal(SEE_ALL, 'See All')
    assert.equal(seeAllShown('on-repeat'), true)
    assert.equal(seeAllShown(null), false)
    assert.equal(seeAllShown(''), false)
  })
  it('Play says Play', () => {
    assert.equal(PLAY_LABEL, 'Play')
    assert.equal(playTitle('Abbey Road'), 'Play Abbey Road')
    assert.equal(playTitle('  '), 'Play')
  })
  it("a Home row's name is the sidebar name of the playlist its See All opens", () => {
    const sidebar = read('renderer/components/sidebar/Sidebar.tsx')
    for (const [id, title] of Object.entries(PLAYLIST_ROW_TITLE)) {
      assert.ok(sidebar.includes(`{ label: '${title}', id: '${id}' }`), `${id} is "${title}" in the sidebar`)
    }
    const shelves = read('renderer/components/HomeShelves.tsx')
    for (const id of Object.keys(PLAYLIST_ROW_TITLE)) {
      assert.match(shelves, new RegExp(`title=\\{PLAYLIST_ROW_TITLE\\['${id}'\\]\\}[^\\n]*\\n[^\\n]*id: '${id}'`), `the ${id} row is named for its playlist`)
    }
  })
})

// ── The pages ───────────────────────────────────────────────────────────────

/** Every JSX opening tag that carries `marker` (balanced over braces). */
function openingTags(src: string, marker: RegExp): string[] {
  const out: string[] = []
  const re = new RegExp(marker.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let start = m.index
    while (start > 0 && !(src[start] === '<' && /[A-Za-z]/.test(src[start + 1] ?? ''))) start--
    let depth = 0
    let end = start + 1
    for (; end < src.length; end++) {
      const c = src[end]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0 && src[end - 1] !== '=') break
    }
    out.push(src.slice(start, end + 1))
  }
  return out
}

/** The files whose cards follow the rule. */
const CARD_FILES = [
  'renderer/components/AlbumGrid.tsx',
  'renderer/components/HomeShelves.tsx',
  'renderer/components/MadeForYou.tsx',
  'renderer/components/HomeShows.tsx',
  'renderer/components/IslandAlbumsShelf.tsx',
  'renderer/views/ArtistsView.tsx',
  'renderer/views/ConcertsView.tsx',
  'renderer/views/NewForYouView.tsx',
  'renderer/views/HomeView.tsx',
  'renderer/views/ArtistDetailView.tsx',
  'renderer/views/CoverFlowView.tsx',
]

describe('the shared Card', () => {
  const card = read('renderer/components/Card.tsx')
  it('a click and a key only ever open', () => {
    assert.match(card, /onClick=\{\(\) => act\(cardAction\('click'\)\)\}/)
    const act = card.slice(card.indexOf('const act ='), card.indexOf('const draggable'))
    assert.match(act, /p\.onOpen\(\)/)
    assert.doesNotMatch(act, /onPlay/, 'the card body never plays')
  })
  it('has no double-click', () => {
    assert.doesNotMatch(card, /onDoubleClick/)
  })
  it('the ▶ is the one Play button, and it never also opens the card', () => {
    assert.match(card, /<PlayButton variant="overlay"/)
    const btn = read('renderer/components/PlayButton.tsx')
    assert.match(btn, /e\.stopPropagation\(\); e\.preventDefault\(\); onPlay\(\)/)
    assert.match(btn, /<PlayIcon /, 'a drawn triangle, not a typed character')
  })
})

describe('cards on the pages', () => {
  for (const f of CARD_FILES) {
    const src = read(f)
    it(`${f}: every card opens on click and never plays on one`, () => {
      const cards = openingTags(src, /<Card\b/)
      for (const tag of cards) {
        assert.match(tag, /onOpen=/, `a Card with no onOpen in ${f}`)
        const open = tag.match(/onOpen=\{([\s\S]*?)\}\s*\n/)?.[1] ?? ''
        assert.doesNotMatch(open, /play|toggle|snippet/i, `a Card opens by playing in ${f}: ${open}`)
        assert.doesNotMatch(tag, /\bonClick=|\bonDoubleClick=/, `a Card given its own click in ${f}`)
      }
      // Cards drawn by hand mark themselves data-card-kind; their click opens.
      for (const tag of openingTags(src, /data-card-kind="/)) {
        if (/^<Card\b/.test(tag)) continue
        const click = tag.match(/onClick=\{([\s\S]*?)\}\s*\n/)?.[1] ?? ''
        assert.ok(click, `a hand-drawn card with no click in ${f}`)
        assert.doesNotMatch(click, /play|toggle|snippet/i, `a hand-drawn card plays on click in ${f}: ${click}`)
        // A click handed a name (onClick={open}): read what the name is.
        const named = /^\s*[A-Za-z_$][\w$]*\s*$/.test(click) ? src.match(new RegExp(`const ${click.trim()} = ([^\\n]*)`))?.[1] ?? '' : ''
        assert.doesNotMatch(named, /play|toggle|snippet/i, `a hand-drawn card's ${click.trim()} plays in ${f}: ${named}`)
        assert.doesNotMatch(tag, /onDoubleClick=/, `a hand-drawn card plays on double-click in ${f}`)
      }
      assert.ok(cards.length + openingTags(src, /data-card-kind="/).length > 0, `${f} has no cards on the rule`)
    })
  }
  it('album tiles: the grid has no double-click (it could never fire after the first click opened the album)', () => {
    assert.doesNotMatch(read('renderer/components/AlbumGrid.tsx'), /onDoubleClick/)
    assert.doesNotMatch(read('renderer/components/TrackGridView.tsx'), /onDoubleClick/)
  })
  it("Home's song cards no longer play on a click", () => {
    assert.doesNotMatch(read('renderer/components/HomeShelves.tsx'), /onClick=\{play\}/)
  })
  it("Cover Flow: the only double-click left is the song list's, and ↓ goes to the next album", () => {
    const cf = read('renderer/views/CoverFlowView.tsx')
    assert.equal((cf.match(/onDoubleClick=/g) ?? []).length, 1)
    assert.match(cf, /className=\{`coverflow-track-row[^]*?onDoubleClick=/)
    assert.match(cf, /e\.key === 'ArrowRight' \|\| e\.key === 'ArrowDown'\) \{[^}]*go\(1\)/)
    assert.match(cf, /e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowUp'\) \{[^}]*go\(-1\)/)
  })
})

describe('song lists outside the table play on double-click', () => {
  it("an artist's Top Songs", () => {
    const src = read('renderer/views/ArtistDetailView.tsx')
    const rows = openingTags(src, /className=\{`ad-table-row/)
    assert.equal(rows.length, 1)
    assert.match(rows[0], /onDoubleClick=\{\(\) => playQueue/)
    assert.doesNotMatch(rows[0], /onClick=/)
  })
  it("an artist's other releases (owned songs)", () => {
    const src = read('renderer/components/artist/MoreFromList.tsx')
    assert.doesNotMatch(src, /onClick=\{\(\) => onPlay\(/)
    assert.match(src, /onDoubleClick=\{\(\) => onPlay\(have\)\}/)
  })
})

describe('menu parity: one menu per kind, from utils/libraryMenus.ts', () => {
  it('every album grid uses the Albums view\'s album menu (no hand-built copies)', () => {
    for (const f of ['renderer/components/TrackGridView.tsx', 'renderer/views/CoverFlowView.tsx', 'renderer/views/ArtistDetailView.tsx', 'renderer/views/AlbumsView.tsx']) {
      const src = read(f)
      assert.match(src, /albumMenuEntries\(/, `${f} builds its own album menu`)
      assert.doesNotMatch(src, /queueMenuEntries\(/, `${f} hand-builds menu lines`)
    }
  })
  it('artist tiles have the artist menu', () => {
    assert.match(read('renderer/views/ArtistsView.tsx'), /artistMenuEntries\(/)
    const home = read('renderer/views/HomeView.tsx')
    assert.equal((home.match(/openArtistMenu\(/g) ?? []).length, 2, 'Top Artists and Rediscover')
    assert.match(read('renderer/components/TonightOnJakeTunes.tsx'), /openArtistMenu\(/)
  })
  it('the Home menus host offers every library kind', () => {
    const host = read('renderer/components/HomeItemMenus.tsx')
    for (const fn of ['songMenuEntries', 'albumMenuEntries', 'artistMenuEntries', 'playlistMenuEntries']) assert.match(host, new RegExp(`${fn}\\(`))
  })
  it('shop cards, Listening List rows and concert rows have menus', () => {
    assert.match(read('renderer/views/NewForYouView.tsx'), /onContextMenu=\{\(e\) => \{ e\.preventDefault\(\); setShopMenu/)
    assert.match(read('renderer/views/ListenToTheListView.tsx'), /onContextMenu=\{\(e\) => \{ e\.preventDefault\(\); setSel\(i\); setRowMenu/)
    assert.match(read('renderer/views/ConcertsView.tsx'), /concertMenuEntries\(/)
  })
})

function tsx(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsx(p))
    else if (e.name.endsWith('.tsx')) out.push(p)
  }
  return out
}

describe('words across the app', () => {
  const files = tsx(join(SRC, 'renderer'))
  it('"See All" never carries a count or an arrow, and nothing grows in place', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      assert.doesNotMatch(src, /See All (›|\$?\{|\d)/, f)
      assert.doesNotMatch(src, /`Show (First|Top) \$\{/, f)
    }
  })
  it('no typed "▶ Play" / "▶ Album": every Play is the PlayButton', () => {
    // PlayButton.tsx names the old ones in its history comment.
    for (const f of files.filter((x) => !x.endsWith('PlayButton.tsx'))) assert.doesNotMatch(readFileSync(f, 'utf8'), /▶\s*\{?\s*(Play|Album)|▶ \{setPlaying/, f)
  })
})
