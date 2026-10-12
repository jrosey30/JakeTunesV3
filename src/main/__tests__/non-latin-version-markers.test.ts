/**
 * Version markers in Hebrew and Russian (2026-10-11) — the pattern of
 * non-latin-keys.test.ts. Every title below is a real iTunes IL/RU title
 * (sampled for Israeli and Russian artists). The wrong-version guard only knew
 * English words, so a Hebrew live, instrumental or acoustic cut passed as the
 * studio recording once Hebrew titles could match at all (#80).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { unwantedVersionOf, requestedVersionMarkers, searchTitle } from '../streamrip-match.ts'
import { buildRequestedRecording, verifyCandidate } from '../exact-recording.ts'
import { acceptableHit } from '../discover-feed.ts'

describe('a Hebrew or Russian version is a different recording', () => {
  it('live', () => {
    assert.equal(unwantedVersionOf('לזוז', 'לזוז (הופעה חיה)'), 'live')
    assert.equal(unwantedVersionOf('חוץ מזה לא צריך כלום', 'חוץ מזה לא צריך כלום (בהופעה)'), 'live')
    assert.equal(unwantedVersionOf('לבן בחלום שחור', 'לבן בחלום שחור - לייב (מהדורת ויניל 2024)'), 'live')
  })
  it('instrumental, acoustic, medley, rehearsal', () => {
    assert.equal(unwantedVersionOf('עולם שלם', 'עולם שלם (אינסטרומנטלי)'), 'instrumental')
    assert.equal(unwantedVersionOf('בואי הביתה', 'בואי הביתה [אקוסטי]'), 'acoustic')
    assert.equal(unwantedVersionOf('הבלדה על יואל משה סלומון', 'הבלדה על יואל משה סלומון (מתוך מחרוזת שבלול 2)'), 'medley')
    assert.equal(unwantedVersionOf('מדברים בשקט', 'מדברים בשקט (מתוך חזרות למופע NEXT)'), 'rehearsals')
  })
  it('Russian, adjectives included', () => {
    assert.equal(unwantedVersionOf('Супергуд', 'Супергуд (Инструментальная версия)'), 'instrumental')
    assert.equal(unwantedVersionOf('Малыш', 'Малыш (Акустика)'), 'acoustic')
    assert.equal(unwantedVersionOf('Дождь', 'Дождь (Трибьют ДДТ)'), 'tribute')
    assert.equal(unwantedVersionOf('Звезда', 'Звезда (концертная запись)'), 'live')
  })
  it('the download guard refuses it, and discovery drops an instrumental', () => {
    const req = buildRequestedRecording({ artist: 'Hadag Nahash', title: 'לזוז', durationTolSec: 3 })
    const v = verifyCandidate(req, { provider: 'qobuz', title: 'לזוז (הופעה חיה)', artist: 'Hadag Nahash' })
    assert.equal(v.verdict === 'reject' && v.kind, 'version')
    assert.equal(acceptableHit({ artist: 'Kaveret', title: 'עולם שלם' }, { artist: 'Kaveret', title: 'עולם שלם (אינסטרומנטלי)' }), false)
  })
})

describe('one label in two languages is one label', () => {
  it('"(Live - הופעה חיה)" is the live recording a "(Live)" request asked for — not live twice', () => {
    assert.equal(unwantedVersionOf('אין מקום אחר (Live)', 'אין מקום אחר (Live - הופעה חיה)'), null)
    assert.deepEqual(requestedVersionMarkers('אין מקום אחר (Live - הופעה חיה)'), ['live'])
  })
  it('asking for the Hebrew live cut refuses the studio cut (it used to pass: הופעה was no marker)', () => {
    assert.deepEqual(requestedVersionMarkers('לזוז (הופעה חיה)'), ['live'])
    const req = buildRequestedRecording({ artist: 'Hadag Nahash', title: 'לזוז (הופעה חיה)', durationTolSec: 3 })
    const studio = verifyCandidate(req, { provider: 'qobuz', title: 'לזוז', artist: 'Hadag Nahash' })
    assert.equal(studio.verdict === 'reject' && studio.kind, 'version')
    assert.equal(verifyCandidate(req, { provider: 'qobuz', title: 'לזוז (הופעה חיה)', artist: 'Hadag Nahash' }).verdict, 'exact')
  })
  it('the version layer reads "(הופעה חיה)" and "(Live)" as the same marker', () => {
    assert.equal(unwantedVersionOf('לזוז (הופעה חיה)', 'לזוז (Live)'), null)
    assert.equal(unwantedVersionOf('לזוז (Live)', 'לזוז (הופעה חיה)'), null)
  })
  it('still a limit: a title worded ONLY in the other language does not read as the same title (refused, never wrong)', () => {
    const req = buildRequestedRecording({ artist: 'Hadag Nahash', title: 'לזוז (הופעה חיה)', durationTolSec: 3 })
    const v = verifyCandidate(req, { provider: 'qobuz', title: 'לזוז (Live)', artist: 'Hadag Nahash' })
    assert.equal(v.verdict === 'reject' && v.kind, 'title')
  })
  it('the search keeps a Hebrew live group, as it keeps "(Live)"', () => {
    assert.equal(searchTitle('לזוז (הופעה חיה)'), 'לזוז (הופעה חיה)')
  })
})

describe('neutral words stay neutral', () => {
  it('a vinyl edition, a remastering, a subtitle with "концерт" in it', () => {
    assert.equal(unwantedVersionOf('מה שעובר עלי', 'מה שעובר עלי (מהדורת ויניל)'), null)
    assert.equal(unwantedVersionOf('למה לי לקחת ללב', 'למה לי לקחת ללב [שבלול - רימאסטרינג]'), null)
    assert.equal(unwantedVersionOf('Ленинград', 'Ленинград (Приглашение на концерт)'), null)
  })
  it('English markers are unchanged', () => {
    assert.equal(unwantedVersionOf('Who Are You', 'Who Are You (Live)'), 'live')
    assert.equal(unwantedVersionOf('Live and Let Die', 'Live and Let Die'), null)
    assert.equal(unwantedVersionOf('Live and Let Die', 'Live and Let Die (Live)'), 'live')
  })
})
