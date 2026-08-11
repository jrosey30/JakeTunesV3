/**
 * Boom Phase 2 — apply-remote + SSE parse unit tests.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyBoomEvent,
  applyBoomEvents,
  applySnapshot,
  buildTrackPatch,
  type BoomCacheState,
} from '../boom/apply-remote.ts'
import { createParser } from '../boom/sse-parse.ts'
import { isBoomEnabled, normalizeBoomUrl } from '../boom/client.ts'

describe('boom apply-remote', () => {
  it('applies snapshot', () => {
    const s = applySnapshot({
      schema: 1,
      latestEventId: 9,
      tracks: [{ id: 1, title: 'A' }],
      playlists: [{ id: 'p', name: 'P', trackIds: [1] }],
    })
    assert.equal(s.latestEventId, 9)
    assert.equal(s.tracks.length, 1)
    assert.equal(s.playlists[0].name, 'P')
  })

  it('field-patches an existing track and respects etag', () => {
    let state: BoomCacheState = {
      latestEventId: 1,
      tracks: [{ id: 5, title: 'Old', genre: 'Rock', _etag: 2 }],
      playlists: [],
    }
    state = applyBoomEvent(state, {
      id: 2,
      type: 'track-updated',
      payload: { id: 5, fields: { title: 'New' }, etag: 3 },
    })
    assert.equal(state.tracks[0].title, 'New')
    assert.equal(state.tracks[0].genre, 'Rock')
    assert.equal(state.tracks[0]._etag, 3)

    // Stale etag ignored
    state = applyBoomEvent(state, {
      id: 3,
      type: 'track-updated',
      payload: { id: 5, fields: { title: 'Stale' }, etag: 2 },
    })
    assert.equal(state.tracks[0].title, 'New')
  })

  it('upserts unknown track and deletes', () => {
    let state: BoomCacheState = { latestEventId: 0, tracks: [], playlists: [] }
    state = applyBoomEvent(state, {
      id: 1,
      type: 'track-updated',
      payload: { id: 99, fields: { title: 'Fresh', artist: 'Z' }, etag: 1 },
    })
    assert.equal(state.tracks.length, 1)
    state = applyBoomEvent(state, {
      id: 2,
      type: 'track-deleted',
      payload: { id: 99 },
    })
    assert.equal(state.tracks.length, 0)
    assert.equal(state.latestEventId, 2)
  })

  it('applies playlist update/delete burst', () => {
    const state = applyBoomEvents(
      { latestEventId: 0, tracks: [], playlists: [] },
      [
        {
          id: 1,
          type: 'playlist-updated',
          payload: { id: 'a', playlist: { id: 'a', name: 'A', trackIds: [1] }, etag: 1 },
        },
        {
          id: 2,
          type: 'playlist-updated',
          payload: { id: 'a', playlist: { id: 'a', name: 'A2', trackIds: [1, 2] }, etag: 2 },
        },
        { id: 3, type: 'playlist-deleted', payload: { id: 'a' } },
      ],
    )
    assert.equal(state.playlists.length, 0)
    assert.equal(state.latestEventId, 3)
  })

  it('buildTrackPatch diffs fields', () => {
    const patch = buildTrackPatch(
      { id: 1, title: 'A', genre: 'Rock' },
      { id: 1, title: 'B', genre: 'Rock', year: 1999 },
    )
    assert.deepEqual(patch.fields, { title: 'B', year: 1999 })
  })
})

describe('boom sse-parse', () => {
  it('parses id/event/data frames', () => {
    const seen: Array<{ id?: string; event?: string; data: string }> = []
    const p = createParser((ev) => seen.push(ev))
    p.feed('id: 7\nevent: track-updated\ndata: {"id":1}\n\n')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].id, '7')
    assert.equal(seen[0].event, 'track-updated')
    assert.equal(seen[0].data, '{"id":1}')
  })

  it('ignores keepalives and handles split chunks', () => {
    const seen: Array<{ data: string }> = []
    const p = createParser((ev) => seen.push(ev))
    p.feed(': keepalive\n\n')
    p.feed('data: {"a":')
    p.feed('1}\n\n')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].data, '{"a":1}')
  })
})

describe('boom client helpers', () => {
  it('normalizes and validates boom urls', () => {
    assert.equal(normalizeBoomUrl('http://homemini:3001/'), 'http://homemini:3001')
    assert.equal(isBoomEnabled('http://homemini:3001'), true)
    assert.equal(isBoomEnabled(''), false)
    assert.equal(isBoomEnabled(undefined), false)
  })
})
