import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { downloadsPanelRows, panelRowFor, panelSummary, downloadsBadge } from '../../common/downloads-panel-model.ts'
import type { QueueItemLike } from '../../common/record-shop-live.ts'

const NOW = Date.parse('2026-09-06T17:00:00Z')
const album = (over: Partial<QueueItemLike> = {}): QueueItemLike => ({
  key: 'qobuz|album|q|album|talkingheads|littlecreaturesdeluxeversion', status: 'done', imported: 0, dupes: 12, completion: '12 tracks · 0 imported, 12 already in your library', startedAt: NOW - 20_000, endedAt: NOW - 18_000,
  result: { kind: 'query', source: 'qobuz', mediaType: 'album', id: 'q|album|talkingheads|littlecreaturesdeluxeversion', desc: 'Little Creatures (Deluxe Version) — Talking Heads (album)', artist: 'Talking Heads', album: 'Little Creatures (Deluxe Version)', collectionId: 124906778, trackCount: 12, releaseYear: 1985, origin: { recommendationIds: ['r1'], entryId: 'r1', sourceKind: 'person', sourceLabel: 'Alex' } },
  ...over,
})
const song = (over: Partial<QueueItemLike> = {}): QueueItemLike => ({
  key: 'qobuz|track|q|track|dstone|cups', status: 'failed', outcome: 'not-found', primary: 'Not found', detail: 'Nothing resembling “Cups” — D-Stone on Qobuz, Bandcamp or SoundCloud', startedAt: NOW - 30_000, endedAt: NOW - 15_000,
  result: { kind: 'query', source: 'qobuz', mediaType: 'track', id: 'q|track|dstone|cups', desc: 'Cups — D-Stone', artist: 'D-Stone', title: 'Cups', origin: { recommendationIds: ['r2'], entryId: 'r2' } },
  ...over,
})

describe('the Downloads panel rows', () => {
  it('a finished album keeps its edition identity, provenance, counts and completion line', () => {
    const r = panelRowFor(album(), NOW)
    assert.equal(r.status, 'done'); assert.equal(r.kind, 'album')
    assert.equal(r.title, 'Little Creatures (Deluxe Version)'); assert.equal(r.artist, 'Talking Heads')
    assert.equal(r.edition, 'album · 12 tracks · 1985 · iTunes 124906778')
    assert.equal(r.from, 'from Alex')
    assert.equal(r.counts, '0 imported · 12 already in your library')
    assert.equal(r.completion, '12 tracks · 0 imported, 12 already in your library')
    assert.deepEqual(r.actions, [])
  })
  it('in flight: Cancel with an elapsed clock; queued: Cancel', () => {
    const d = panelRowFor(album({ status: 'downloading', endedAt: undefined, startedAt: NOW - 7_500 }), NOW)
    assert.equal(d.status, 'downloading'); assert.deepEqual(d.actions, ['cancel']); assert.equal(d.elapsedSec, 7)
    const q = panelRowFor(album({ status: 'queued', startedAt: undefined, endedAt: undefined }), NOW)
    assert.equal(q.status, 'queued'); assert.deepEqual(q.actions, ['cancel']); assert.equal(q.elapsedSec, null)
  })
  it('a refused verdict offers a new choice — Choose version for a song, Choose edition for a record — never Retry', () => {
    const s = panelRowFor(song(), NOW)
    assert.equal(s.status, 'refused'); assert.deepEqual(s.actions, ['chooseVersion'])
    assert.equal(s.primary, 'Not found'); assert.match(s.detail ?? '', /Nothing resembling/)
    assert.deepEqual(s.choose, { query: 'D-Stone Cups', kind: 'song', artist: 'D-Stone', title: 'Cups' })
    assert.equal(s.from, 'from your Listen List')
    const a = panelRowFor(album({ status: 'failed', outcome: 'exact-not-found', primary: 'Exact edition not found', alternatives: [{ provider: 'qobuz', desc: 'Little Creatures (9 tracks)', reason: 'has 9 tracks' }] }), NOW)
    assert.equal(a.status, 'refused'); assert.deepEqual(a.actions, ['chooseEdition']); assert.equal(a.alternatives.length, 1)
    assert.equal(a.choose?.kind, 'album')
  })
  it('a provider failure and a canceled job offer Retry', () => {
    const f = panelRowFor(song({ outcome: 'provider-failed', primary: 'Download failed' }), NOW)
    assert.equal(f.status, 'failed'); assert.deepEqual(f.actions, ['retry'])
    const c = panelRowFor(song({ status: 'canceled', outcome: undefined, primary: undefined }), NOW)
    assert.equal(c.status, 'canceled'); assert.deepEqual(c.actions, ['retry']); assert.equal(c.primary, null)
  })
  it('a pasted link is labelled as such and keeps no edition', () => {
    const r = panelRowFor({ key: 'youtube|track|abc', status: 'done', imported: 1, dupes: 0, result: { kind: 'id', source: 'youtube', mediaType: 'track', id: 'abc', desc: 'https://youtu.be/abc' } }, NOW)
    assert.equal(r.kind, 'link'); assert.equal(r.from, 'pasted link'); assert.equal(r.edition, null)
  })
  it('orders in-flight, then decisions, then finished — newest first within a group; the badge follows', () => {
    const rows = downloadsPanelRows([album(), song(), album({ key: 'k-dl', status: 'downloading', startedAt: NOW - 1000, endedAt: undefined }), song({ key: 'k-q', status: 'queued', startedAt: undefined, endedAt: undefined }), song({ key: 'k-c', status: 'canceled', endedAt: NOW - 5000 })], NOW)
    assert.deepEqual(rows.map((r) => r.status), ['downloading', 'queued', 'refused', 'canceled', 'done'])
    const s = panelSummary(rows)
    assert.deepEqual(s, { active: 1, queued: 1, done: 1, failed: 1, canceled: 1 })
    assert.equal(downloadsBadge(s), '2')
    assert.equal(downloadsBadge({ active: 0, queued: 0, done: 0, failed: 0, canceled: 0 }), undefined)
  })
  it('the door count never calls a failed, refused or canceled job "done"', () => {
    assert.equal(downloadsBadge({ active: 0, queued: 0, done: 2, failed: 0, canceled: 0 }), '2 done')
    assert.equal(downloadsBadge({ active: 0, queued: 0, done: 2, failed: 1, canceled: 0 }), '1 need attention')
    assert.equal(downloadsBadge({ active: 0, queued: 0, done: 0, failed: 2, canceled: 1 }), '2 need attention')
    assert.equal(downloadsBadge({ active: 0, queued: 0, done: 1, failed: 0, canceled: 1 }), '2 finished')
    assert.equal(downloadsBadge({ active: 0, queued: 0, done: 0, failed: 0, canceled: 1 }), '1 finished')
    // Anything moving outranks the settled verdicts.
    assert.equal(downloadsBadge({ active: 1, queued: 0, done: 0, failed: 3, canceled: 0 }), '1')
    // A refused verdict is a failed job in the summary — same door count.
    const refused = panelSummary(downloadsPanelRows([song()], NOW))
    assert.equal(refused.failed, 1)
    assert.equal(downloadsBadge(refused), '1 need attention')
  })
})
