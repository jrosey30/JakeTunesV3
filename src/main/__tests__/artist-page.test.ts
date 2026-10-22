// The artist page's arithmetic and wording (src/common/artist-page.ts): the
// top-songs ranking (nothing under a minute ranks), the most-played record,
// dates and lengths read the way the rest of the app reads them, poster
// captions, and a long name stepping down instead of clipping.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  topSongs, mostPlayedRecord, earliestAdded, dayMonthYear, clock, lengthLabel, heroEyebrow,
  heroNameSize, posterDate, posterYear, liveCaption, posterShowLine, posterVenue, albumTileMeta, headerPhotoChoice, heroPhotoFit,
} from '../../common/artist-page.ts'

const t = (id: number, plays: number, extra: Record<string, unknown> = {}) => ({ id, title: `Song ${id}`, duration: 200_000, playCount: plays, dateAdded: '2026-08-09T17:00:00.000Z', ...extra })
const playsOf = (x: { playCount: number }) => x.playCount

describe('Your <Artist>: top songs', () => {
  it('most played first, five at most, bars relative to the top song', () => {
    const r = topSongs([t(1, 3), t(2, 13), t(3, 10), t(4, 8), t(5, 6), t(6, 5), t(7, 1)], playsOf)
    assert.deepEqual(r.map((x) => x.track.id), [2, 3, 4, 5, 6])
    assert.equal(r[0].bar, 1)
    assert.equal(r[1].bar, 10 / 13)
  })
  it('a song under a minute never ranks (its plays still count elsewhere); unplayed songs never rank', () => {
    const r = topSongs([t(1, 40, { duration: 37_000 }), t(2, 4), t(3, 0)], playsOf)
    assert.deepEqual(r.map((x) => x.track.id), [2])
  })
  it('ties keep a stable order: earlier added, then title', () => {
    const r = topSongs([t(2, 5, { title: 'B', dateAdded: '2026-09-01' }), t(1, 5, { title: 'A', dateAdded: '2026-09-01' }), t(3, 5, { title: 'C', dateAdded: '2026-08-01' })], playsOf)
    assert.deepEqual(r.map((x) => x.track.title), ['C', 'A', 'B'])
  })
})

describe('most played record', () => {
  const g = (name: string, year: number, plays: number[]) => ({ name, year, tracks: plays.map((p, i) => t(year * 100 + i, p)) })
  it('the release with the most plays; a tie goes to the newer one', () => {
    assert.equal(mostPlayedRecord([g('3D Country', 2023, [10, 20]), g('Getting Killed', 2025, [59])], playsOf)?.group.name, 'Getting Killed')
    assert.equal(mostPlayedRecord([g('Old', 2018, [5]), g('New', 2021, [5])], playsOf)?.group.name, 'New')
    assert.equal(mostPlayedRecord([g('Old', 2018, [0])], playsOf), null)
  })
})

describe('dates and lengths', () => {
  it('the record line\'s earliest add, as a day that never splits', () => {
    const ms = earliestAdded([t(1, 0, { dateAdded: '2026-09-27T10:00:00Z' }), t(2, 0, { dateAdded: '2026-08-09T17:03:47.923Z' }), t(3, 0, { dateAdded: '' })])
    assert.equal(dayMonthYear(ms), 'Aug 9, 2026')
    assert.equal(earliestAdded([]), null)
  })
  it('song time floors seconds like SongsView; record length uses the album page formula', () => {
    assert.equal(clock(210_946), '3:30')
    assert.equal(clock(3_725_000), '1:02:05')
    assert.equal(lengthLabel(2_745_000), '46 min')
    assert.equal(lengthLabel(4_860_000), '1 hr 21 min')
  })
})

describe('album tiles', () => {
  it('kind · year only — never a play count (Jake 10/20)', () => {
    assert.equal(albumTileMeta('', 2025), '2025')
    assert.equal(albumTileMeta('EP', '2023'), 'EP · 2023')
    assert.equal(albumTileMeta('Single', ''), 'Single')
    assert.equal(albumTileMeta('', 0), '')
  })
  it('the artist page builds tile lines with it and puts no plays next to an album', () => {
    const view = readFileSync(join(import.meta.dirname, '../../renderer/views/ArtistDetailView.tsx'), 'utf-8')
    const cover = view.slice(view.indexOf('const cover = ('), view.indexOf('return (', view.indexOf('const cover = (')))
    assert.match(cover, /albumTileMeta\(/)
    assert.doesNotMatch(cover, /playsOf\(|plural\([^)]*'play'/, 'an album tile line counts plays again')
  })
})

describe('the header photo (twin of the phone, Mobile #501)', () => {
  it('a credited hero, then heroNeedsPhoto → the record cover, else the artist image', () => {
    assert.equal(headerPhotoChoice({ hero: { source: 'commons' } }), 'hero')
    assert.equal(headerPhotoChoice({ hero: { source: 'commons' }, heroNeedsPhoto: true }), 'hero')
    assert.equal(headerPhotoChoice({ heroNeedsPhoto: true }), 'cover', 'Sublime: the app image is the wrong line-up')
    assert.equal(headerPhotoChoice({ hero: { source: 'library' }, heroNeedsPhoto: true }), 'hero', 'a framed app image is a header photo')
    assert.equal(headerPhotoChoice({ hero: { source: 'library' } }), 'hero', 'the app image re-framed for this wide header (Fat Dog: faces under the fade as it stands)')
    assert.equal(headerPhotoChoice({}), 'artistImage')
    assert.equal(headerPhotoChoice(null), 'artistImage')
  })
  it('the page never draws the artist image when the choice is the cover', () => {
    const view = readFileSync(join(import.meta.dirname, '../../renderer/views/ArtistDetailView.tsx'), 'utf-8')
    assert.match(view, /headerPhotoChoice\(profile\)/)
    assert.match(view, /headerChoice === 'cover'\s*\?\s*coverSrc/)
  })
})

describe('the header photo window (twin of the phone, Mobile ArtistHeroFraming)', () => {
  const twoToOne = { width: 1800, height: 900 }
  it('a group photo is shown whole once the window is narrower than the photo', () => {
    // The narrowest desktop window (900): the photo's window is 72% of the page, 541 × 440.
    assert.equal(heroPhotoFit('group', { width: 541, height: 440 }, twoToOne), 'width')
    assert.equal(heroPhotoFit('group', { width: 610, height: 440 }, twoToOne), 'width', '1000-wide page: 61% of it')
    assert.equal(heroPhotoFit('group', { width: 793, height: 440 }, twoToOne), 'width', '1300-wide page: still 10% of the photo cropped')
  })
  it('keeps the full-height cover the builder framed for, and the wider windows', () => {
    // 1440-wide window: 878 × 440, the builder\'s own model. Wider: the crop is only vertical.
    assert.equal(heroPhotoFit('group', { width: 878, height: 440 }, twoToOne), 'cover')
    assert.equal(heroPhotoFit('group', { width: 1037, height: 440 }, twoToOne), 'cover')
    // Three percent off the photo\'s own proportions is rounding, not cropping.
    assert.equal(heroPhotoFit('group', { width: 860, height: 440 }, twoToOne), 'cover')
  })
  it('a person always fills the window; so does anything it cannot measure', () => {
    assert.equal(heroPhotoFit('person', { width: 541, height: 440 }, twoToOne), 'cover')
    assert.equal(heroPhotoFit(' Person ', { width: 300, height: 440 }, twoToOne), 'cover')
    assert.equal(heroPhotoFit('person', { width: 878, height: 440 }, { width: 600, height: 520 }), 'cover')
    assert.equal(heroPhotoFit('group', { width: 0, height: 440 }, twoToOne), 'cover')
    assert.equal(heroPhotoFit('group', { width: 541, height: 440 }, { width: 0, height: 0 }), 'cover')
  })
  it('anything that is not a person is a group; a profile without a kind too', () => {
    assert.equal(heroPhotoFit('other', { width: 541, height: 440 }, twoToOne), 'width')
    assert.equal(heroPhotoFit(undefined, { width: 541, height: 440 }, twoToOne), 'width')
  })
  it('a tall group portrait is shown whole by its height, not sliced through its rows of faces (Camper Van Beethoven, served 600 × 520)', () => {
    const camper = { width: 600, height: 520 }
    assert.equal(heroPhotoFit('group', { width: 878, height: 440 }, camper), 'height', 'the builder\'s 878 × 440 model: cover keeps 58% of the height')
    assert.equal(heroPhotoFit('group', { width: 788, height: 440 }, camper), 'height', 'a 1440-wide window (the 148px sidebar takes its share)')
    assert.equal(heroPhotoFit('group', { width: 1037, height: 440 }, camper), 'height')
    // A narrower window than the photo\'s own proportions: the sides first.
    assert.equal(heroPhotoFit('group', { width: 400, height: 440 }, camper), 'width')
    // A near-2:1 photo is not tall: cover keeps 90%.
    assert.equal(heroPhotoFit('group', { width: 878, height: 440 }, { width: 1800, height: 1012 }), 'cover')
  })
  it('the app\'s own artist image keeps its cover however tall it is (not a header photo)', () => {
    assert.equal(heroPhotoFit(undefined, { width: 878, height: 440 }, { width: 1000, height: 1000 }, false), 'cover')
    assert.equal(heroPhotoFit('group', { width: 878, height: 440 }, { width: 1000, height: 1000 }, true), 'height')
  })
  it('the page measures its window and the photo, and the stylesheet draws the whole one', () => {
    const view = readFileSync(join(import.meta.dirname, '../../renderer/views/ArtistDetailView.tsx'), 'utf-8')
    assert.match(view, /heroPhotoFit\(profile\?\.kind, heroBox, heroNatural, !!creditedHero\)/)
    assert.match(view, /ad-hero-photo--whole/)
    assert.match(view, /ad-hero-photo--tall/)
    const css = readFileSync(join(import.meta.dirname, '../../renderer/styles/artist-detail.css'), 'utf-8')
    assert.match(css, /\.ad-hero-photo--whole img\s*\{[^}]*height:\s*auto/)
    assert.match(css, /\.ad-hero-photo--tall img\s*\{[^}]*width:\s*auto/)
    assert.match(css, /\.ad-drift, \.ad-rise, \.ad-hero-photo--whole img, \.ad-hero-photo--tall img \{ animation: none; \}/, 'reduced motion stops the whole photo\'s drift too')
  })
})

describe('the header', () => {
  it('eyebrow says only what the profile grounds', () => {
    assert.equal(heroEyebrow({ place: 'Brooklyn, New York', since: '2016' }), 'Artist · Brooklyn, New York · Since 2016')
    assert.equal(heroEyebrow(null), 'Artist')
    assert.equal(heroEyebrow({ place: 'Aberdeen, Washington', since: '1987', until: '1994' }), 'Artist · Aberdeen, Washington · 1987–1994')
    assert.equal(heroEyebrow({ place: 'Somewhere', until: '1994' }), 'Artist · Somewhere · Until 1994')
  })
  it('a long name steps down a size instead of clipping', () => {
    assert.equal(heroNameSize('Geese'), 'xl')
    assert.equal(heroNameSize('Talking Heads'), 'xl')
    assert.equal(heroNameSize('Red Hot Chili Peppers'), 'l')
    assert.equal(heroNameSize('Godspeed You! Black Emperor'), 'm')
    assert.equal(heroNameSize('King Gizzard & the Lizard Wizard and Friends of the Lizard'), 's')
  })
})

describe('live posters', () => {
  it('dates read the way a poster prints them', () => {
    assert.equal(posterDate('October 3, 2026'), 'Oct 3, 2026')
    assert.equal(posterDate('2023 (exact date not published)'), '2023')
    assert.equal(posterYear('2023 (exact date not published)'), '2023')
    assert.equal(posterYear('Dec 14–16, 1983'), '1983')
  })
  it('captions: venue, then city · date · set — only what is grounded', () => {
    assert.deepEqual(liveCaption({ title: 'Getting Killed Again (Live at Forest Hills…)', venue: 'Forest Hills Stadium', city: 'Queens, NY', date: 'October 3, 2026', songs: 16, fullSet: true }),
      { head: 'Forest Hills Stadium', meta: 'Queens, NY · Oct 3, 2026 · full set, 16 songs' })
    assert.deepEqual(liveCaption({ title: 'Alive & In Person', venue: 'The Diamond Mine Recording Studio', city: 'Queens, NY', date: '2023 (exact date not published)', songs: 7, fullSet: true, studio: true }),
      { head: 'The Diamond Mine', meta: 'Queens, NY · 2023 · studio live set, 7 songs' })
    assert.deepEqual(liveCaption({ title: 'Live at the BBC', songs: 1 }), { head: 'Live at the BBC', meta: '1 song' })
  })
  it('a made poster prints the venue name, city and year', () => {
    assert.equal(posterShowLine({ venue: posterVenue('The Diamond Mine Recording Studio'), city: 'Queens, NY', date: '2023 (exact date not published)' }), 'The Diamond Mine · Queens, NY · 2023')
    assert.equal(posterShowLine({ year: 1991 }), '1991')
    assert.equal(posterVenue('Abbey Road Studios'), 'Abbey Road Studios')
    assert.equal(posterVenue('Sony Music Studios'), 'Sony Music Studios', 'Unplugged was taped at Sony Music Studios, not at a label')
    assert.equal(posterVenue('Forest Hills Stadium'), 'Forest Hills Stadium')
  })
})
