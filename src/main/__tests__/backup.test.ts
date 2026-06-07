import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { snapshotLibraryAt, listBackupsAt, restoreBackupAt } from '../backup-core.ts'

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
