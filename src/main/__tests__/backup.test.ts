import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  snapshotLibraryAt, listBackupsAt, restoreBackupAt,
  snapshotOverridesAt, listOverridesBackupsAt, restoreOverridesBackupAt,
} from '../backup-core.ts'

async function setup(trackCount = 5) {
  const dir = await mkdtemp(join(tmpdir(), 'jt-backup-'))
  const lib = join(dir, 'library.json')
  const backups = join(dir, 'backups')
  await writeFile(lib, JSON.stringify({
    tracks: Array.from({ length: trackCount }, (_, i) => ({ id: i + 1, title: `t${i}` })),
    playlists: [],
  }))
  return { dir, lib, backups, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('backup-core (Phase 0 data-safety)', () => {
  it('snapshots a verified file with count + reason in the name', async () => {
    const { lib, backups, cleanup } = await setup(5)
    try {
      const info = await snapshotLibraryAt(lib, backups, 'launch')
      assert.ok(info, 'returns info')
      assert.equal(info!.trackCount, 5)
      assert.match(info!.file, /^library-\d{8}-\d{6}-5tracks-launch\.json$/)
      assert.equal(JSON.parse(await readFile(join(backups, info!.file), 'utf-8')).tracks.length, 5)
    } finally { await cleanup() }
  })

  it('refuses to snapshot an empty library', async () => {
    const { backups, lib, cleanup } = await setup(0)
    try {
      assert.equal(await snapshotLibraryAt(lib, backups, 'manual'), null)
      assert.equal((await readdir(backups).catch(() => [])).length, 0, 'no file written')
    } finally { await cleanup() }
  })

  it('rotates: keeps only the newest N', async () => {
    const { lib, backups, cleanup } = await setup(3)
    try {
      for (let i = 0; i < 25; i++) {
        await snapshotLibraryAt(lib, backups, 'save', 5, `20260101-0000${String(i).padStart(2, '0')}`)
      }
      assert.equal((await listBackupsAt(backups)).length, 5, 'pruned to keep=5')
    } finally { await cleanup() }
  })

  it('restores a snapshot AND backs up the current state first (reversible)', async () => {
    const { lib, backups, cleanup } = await setup(5)
    try {
      const snap = await snapshotLibraryAt(lib, backups, 'manual')
      // Mutate the live library down to 2 tracks, then restore the 5-track snapshot.
      await writeFile(lib, JSON.stringify({ tracks: [{ id: 1 }, { id: 2 }], playlists: [] }))
      const res = await restoreBackupAt(lib, backups, snap!.file)
      assert.equal(res.ok, true)
      assert.equal(res.trackCount, 5)
      assert.equal(JSON.parse(await readFile(lib, 'utf-8')).tracks.length, 5, 'library restored to 5')
      const list = await listBackupsAt(backups)
      assert.ok(list.some((b) => b.reason === 'pre-restore' && b.trackCount === 2), 'current (2-track) state snapshotted before restore')
    } finally { await cleanup() }
  })

  it('refuses to restore an empty/invalid backup', async () => {
    const { lib, backups, cleanup } = await setup(5)
    try {
      await snapshotLibraryAt(lib, backups, 'manual')
      const bad = 'library-20260101-000000-0tracks-bad.json'
      await writeFile(join(backups, bad), JSON.stringify({ tracks: [] }))
      assert.equal((await restoreBackupAt(lib, backups, bad)).ok, false)
    } finally { await cleanup() }
  })

  it('rejects path-traversal in the restore filename', async () => {
    const { lib, backups, cleanup } = await setup(5)
    try {
      assert.equal((await restoreBackupAt(lib, backups, '../../etc/passwd')).ok, false)
    } finally { await cleanup() }
  })
})

async function setupOverrides(entries = 3) {
  const dir = await mkdtemp(join(tmpdir(), 'jt-backup-ov-'))
  const ov = join(dir, 'metadata-overrides.json')
  const backups = join(dir, 'backups')
  const doc: Record<string, unknown> = {}
  for (let i = 0; i < entries; i++) doc[String(100 + i)] = { rating: 5, playCount: i }
  await writeFile(ov, JSON.stringify(doc))
  return { dir, ov, backups, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('backup-core — metadata-overrides.json (Brief 171)', () => {
  it('snapshots the overrides file with entry count + reason in the name', async () => {
    const { ov, backups, cleanup } = await setupOverrides(3)
    try {
      const info = await snapshotOverridesAt(ov, backups, 'launch')
      assert.ok(info, 'returns info')
      assert.equal(info!.trackCount, 3)
      assert.match(info!.file, /^metadata-overrides-\d{8}-\d{6}-3entries-launch\.json$/)
      assert.deepEqual(
        JSON.parse(await readFile(join(backups, info!.file), 'utf-8')),
        JSON.parse(await readFile(ov, 'utf-8')),
        'snapshot holds the exact overrides document',
      )
    } finally { await cleanup() }
  })

  it('refuses to snapshot a missing, empty, or non-object overrides file', async () => {
    const { dir, ov, backups, cleanup } = await setupOverrides(0)
    try {
      assert.equal(await snapshotOverridesAt(ov, backups, 'manual'), null, 'empty object refused')
      assert.equal((await readdir(backups).catch(() => [])).length, 0, 'no file written')
      await writeFile(ov, JSON.stringify([1, 2, 3]))
      assert.equal(await snapshotOverridesAt(ov, backups, 'manual'), null, 'array refused')
      assert.equal(await snapshotOverridesAt(join(dir, 'does-not-exist.json'), backups, 'manual'), null, 'missing refused')
    } finally { await cleanup() }
  })

  it('rotates: keeps only the newest 20, and never prunes library snapshots', async () => {
    const { lib, backups, cleanup } = await setup(3)
    const { ov, cleanup: cleanupOv } = await setupOverrides(2)
    try {
      await snapshotLibraryAt(lib, backups, 'manual')
      for (let i = 0; i < 25; i++) {
        await snapshotOverridesAt(ov, backups, 'save', 20, `20260101-0000${String(i).padStart(2, '0')}`)
      }
      assert.equal((await listOverridesBackupsAt(backups)).length, 20, 'pruned to keep=20')
      assert.equal((await listBackupsAt(backups)).length, 1, 'library snapshot untouched by overrides rotation')
    } finally { await cleanup(); await cleanupOv() }
  })

  it('restores an overrides snapshot AND backs up the current state first (reversible)', async () => {
    const { ov, backups, cleanup } = await setupOverrides(3)
    try {
      const snap = await snapshotOverridesAt(ov, backups, 'manual')
      // Mutate the live overrides down to a single different entry, then restore.
      await writeFile(ov, JSON.stringify({ '999': { rating: 1 } }))
      const res = await restoreOverridesBackupAt(ov, backups, snap!.file)
      assert.equal(res.ok, true)
      assert.equal(res.trackCount, 3)
      assert.deepEqual(Object.keys(JSON.parse(await readFile(ov, 'utf-8'))).sort(), ['100', '101', '102'], 'overrides restored to 3 entries')
      const list = await listOverridesBackupsAt(backups)
      assert.ok(list.some((b) => b.reason === 'pre-restore' && b.trackCount === 1), 'current (1-entry) state snapshotted before restore')
    } finally { await cleanup() }
  })

  it('refuses to restore an empty/invalid overrides backup, and rejects traversal', async () => {
    const { ov, backups, cleanup } = await setupOverrides(3)
    try {
      await snapshotOverridesAt(ov, backups, 'manual')
      const bad = 'metadata-overrides-20260101-000000-0entries-bad.json'
      const { mkdir } = await import('node:fs/promises')
      await mkdir(backups, { recursive: true })
      await writeFile(join(backups, bad), JSON.stringify({}))
      assert.equal((await restoreOverridesBackupAt(ov, backups, bad)).ok, false)
      assert.equal((await restoreOverridesBackupAt(ov, backups, '../../etc/passwd')).ok, false)
      assert.equal((await restoreOverridesBackupAt(ov, backups, 'library-20260101-000000-3tracks-x.json')).ok, false, 'library snapshots are not overrides restores')
    } finally { await cleanup() }
  })
})
