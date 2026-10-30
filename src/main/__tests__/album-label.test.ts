// The album page's label (Jake 2026-10-30: "isnt nevermind on sub pop not
// robotic empire??" — iTunes' first row for "Nirvana Nevermind" is a tribute
// album by Various Artists on Robotic Empire).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickItunesAlbumRow } from '../download-search.ts'
import { mbReleaseLabel } from '../album-label.ts'

const ROWS = [
  { artistName: 'Various Artists', collectionName: "Whatever Nevermind: A Tribute to Nirvana's Nevermind", copyright: '℗ 2015 Robotic Empire' },
  { artistName: 'Dr. Sick', collectionName: 'Nirvana Nevermind: Solo Violin' },
  { artistName: 'Nirvana', collectionName: 'MTV Unplugged In New York (Live Acoustic)' },
]

test('pickItunesAlbumRow with the artist: only their rows, no first-row fallback', () => {
  assert.equal(pickItunesAlbumRow(ROWS, 'Nevermind', 'Nirvana'), undefined)
  const withIt = [...ROWS, { artistName: 'Nirvana', collectionName: 'Nevermind (Remastered)' }]
  assert.equal(pickItunesAlbumRow(withIt, 'Nevermind', 'Nirvana')?.collectionName, 'Nevermind (Remastered)')
  const exact = [...withIt, { artistName: 'Nirvana', collectionName: 'Nevermind' }]
  assert.equal(pickItunesAlbumRow(exact, 'Nevermind', 'Nirvana')?.collectionName, 'Nevermind')
  // Without the artist the old behaviour stands (other callers).
  assert.equal(pickItunesAlbumRow(ROWS, 'Nevermind')?.artistName, 'Various Artists')
})

test('mbReleaseLabel: the earliest official release that names a label', () => {
  const releases = [
    { status: 'Official', date: '2011-09-26', 'label-info': [{ label: { name: 'Geffen Records' } }] },
    { status: 'Official', date: '1991-09-24', 'label-info': [{ label: { name: 'DGC' } }] },
    { status: 'Bootleg', date: '1990', 'label-info': [{ label: { name: 'Nobody' } }] },
    { status: 'Official', date: '1991', 'label-info': [] },
  ]
  assert.equal(mbReleaseLabel(releases), 'DGC')
  assert.equal(mbReleaseLabel([{ status: 'Official', date: '2001' }]), undefined)
  assert.equal(mbReleaseLabel([{ date: '1999-01-01', 'label-info': [{ label: { name: 'Sub Pop' } }] }]), 'Sub Pop')
})
