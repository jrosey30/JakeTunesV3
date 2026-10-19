/**
 * Jake 2026-10-18: group an artist's discography into studio albums, EPs,
 * singles, live and compilations — desktop and mobile, one rulebook.
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/releaseKind.ts carries the same rules.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyRelease, kindFromMusicBrainz, kindFromTitle, kindFromShape,
  releaseTitleForLookup, releaseKey, RELEASE_KIND_ORDER, RELEASE_KIND_LABEL,
} from '../../common/release-kind.ts'

test('MusicBrainz: secondary Live / Compilation win, then the primary type', () => {
  assert.equal(kindFromMusicBrainz({ primaryType: 'EP', secondaryTypes: ['Live'] }), 'live') // Geese — Alive & In Person
  assert.equal(kindFromMusicBrainz({ primaryType: 'Album', secondaryTypes: ['Compilation'] }), 'compilation')
  assert.equal(kindFromMusicBrainz({ primaryType: 'Album', secondaryTypes: ['Soundtrack'] }), 'album')
  assert.equal(kindFromMusicBrainz({ primaryType: 'Single' }), 'single')
  assert.equal(kindFromMusicBrainz({ primaryType: 'EP' }), 'ep')
  assert.equal(kindFromMusicBrainz({ primaryType: 'Broadcast' }), null)
  assert.equal(kindFromMusicBrainz(null), null)
})

test('title markers: Apple suffixes, live wording, compilations', () => {
  assert.equal(kindFromTitle("'I Feel 4 U' - Single"), 'single')
  assert.equal(kindFromTitle('&Forever - EP'), 'ep')
  assert.equal(kindFromTitle('EP'), 'ep') // Geese's 2018 EP is titled "EP"
  assert.equal(kindFromTitle('Getting Killed Again (Live at Forest Hills, New York, Oct 3rd, 2026)'), 'live')
  assert.equal(kindFromTitle('Alive & In Person (Live Set)'), 'live')
  assert.equal(kindFromTitle('MTV Unplugged in New York'), 'live')
  assert.equal(kindFromTitle('20 All‐Time Greatest Hits!'), 'compilation')
  // The pre-10/18 desktop list (26 albums regressed without these)
  assert.equal(kindFromTitle('Past Masters, Vol. 1'), 'compilation')
  assert.equal(kindFromTitle('The Singles 1992-2003'), 'compilation')
  assert.equal(kindFromTitle('Singles Going Steady'), 'compilation')
  assert.equal(kindFromTitle('The Traveling Wilburys Collection'), 'compilation')
  assert.equal(kindFromTitle('Essential'), 'compilation')
  assert.equal(kindFromTitle('Live at the BBC'), 'live')
  assert.equal(kindFromTitle('Johnny Cash In Concert'), 'live')
  assert.equal(kindFromTitle('Now 99', 'Various Artists'), 'compilation')
  // Not fooled by look-alikes
  assert.equal(kindFromTitle('Alive & In Person'), null)
  assert.equal(kindFromTitle('Live Through This'), null)
  assert.equal(kindFromTitle('all my exes live in brooklyn'), null)
  assert.equal(kindFromTitle('Live at Leeds'), 'live')
  assert.equal(kindFromTitle('At Folsom Prison - Live at Folsom'), 'live')
  assert.equal(kindFromTitle('Deep Cuts'), null)
  assert.equal(kindFromTitle('Getting Killed'), null)
})

test('shape needs a declared track count; owning a few songs proves nothing', () => {
  assert.equal(kindFromShape(1, [200_000]), 'single')
  assert.equal(kindFromShape(5, [200_000, 200_000, 200_000, 200_000, 200_000]), 'ep') // 4D Country
  assert.equal(kindFromShape(11, [200_000]), 'album')
  assert.equal(kindFromShape(0, [200_000]), null)
  // 3 songs but 40 minutes — not a single
  assert.equal(kindFromShape(3, [800_000, 800_000, 800_000]), 'album')
})

test('precedence: manual > MusicBrainz > title > shape > default', () => {
  assert.deepEqual(classifyRelease({ album: 'X - Single', manual: 'album', mb: { primaryType: 'Single' } }), { kind: 'album', source: 'manual' })
  assert.deepEqual(classifyRelease({ album: 'Alive & In Person', declaredTrackCount: 7, mb: { primaryType: 'EP', secondaryTypes: ['Live'] } }), { kind: 'live', source: 'musicbrainz' })
  assert.deepEqual(classifyRelease({ album: '&Forever - EP', declaredTrackCount: 12 }), { kind: 'ep', source: 'title' })
  assert.deepEqual(classifyRelease({ album: '4D Country', declaredTrackCount: 5 }), { kind: 'ep', source: 'shape' })
  assert.deepEqual(classifyRelease({ album: 'Mystery' }), { kind: 'album', source: 'default' })
})

test('lookup title drops store suffixes and edition tags, keeps live wording', () => {
  assert.equal(releaseTitleForLookup('&Forever - EP'), '&Forever')
  assert.equal(releaseTitleForLookup("'I Feel 4 U' - Single"), "'I Feel 4 U'")
  assert.equal(releaseTitleForLookup('1999 (Deluxe Edition)'), '1999')
  assert.equal(releaseTitleForLookup('Abbey Road [Remastered 2019]'), 'Abbey Road')
  assert.equal(releaseTitleForLookup('Live at Leeds (Live)'), 'Live at Leeds (Live)')
})

test('section order, labels and key format are the shared contract', () => {
  assert.deepEqual([...RELEASE_KIND_ORDER], ['album', 'ep', 'single', 'live', 'compilation'])
  assert.deepEqual(RELEASE_KIND_ORDER.map((k) => RELEASE_KIND_LABEL[k]), ['Albums', 'EPs', 'Singles', 'Live', 'Compilations'])
  assert.equal(releaseKey((s) => s.toLowerCase(), 'Geese', '3D Country'), 'geese|3d country')
})
