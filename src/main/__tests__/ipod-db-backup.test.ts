/**
 * Brief 265 Part 3 (Amendment 4): the iTunesDB is backed up on the Mac before a sync
 * rewrites it, and a backup restores the pre-sync catalog (ipod-db-backup.ts).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupItunesDb, backupStamp, deviceBackupKey, pruneBackups, restoreItunesDbBackup } from '../ipod-db-backup.ts'

async function ipod(opts: { id?: string; db?: string; playCounts?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'b265-bk-'))
  const mount = join(dir, 'IndieSleaze')
  const itunes = join(mount, 'iPod_Control', 'iTunes')
  await mkdir(itunes, { recursive: true })
  if (opts.id) await writeFile(join(mount, 'iPod_Control', 'jaketunes-device.json'), JSON.stringify({ id: opts.id }))
  if (opts.db !== undefined) await writeFile(join(itunes, 'iTunesDB'), opts.db)
  if (opts.playCounts !== undefined) await writeFile(join(itunes, 'Play Counts'), opts.playCounts)
  return { dir, mount, itunes, root: join(dir, 'backups') }
}

describe('backing up before a DB write', () => {
  it('copies iTunesDB and Play Counts into <root>/<iPod id>/<stamp>/, byte for byte', async () => {
    const d = await ipod({ id: '2a2f2e5c-a5b6-48fe-934c-a7c38b744132', db: 'OLD-CATALOG', playCounts: 'PC' })
    const r = await backupItunesDb({ mount: d.mount, root: d.root, now: new Date('2026-11-24T19:12:54.123Z') })
    assert.equal(r.ok, true)
    assert.ok(r.ok && r.dir)
    if (!r.ok || !r.dir) return
    assert.equal(r.dir, join(d.root, '2a2f2e5c-a5b6-48fe-934c-a7c38b744132', '2026-11-24T19-12-54-123Z'))
    assert.deepEqual(r.files, ['iTunesDB', 'Play Counts'])
    assert.equal(await readFile(join(r.dir, 'iTunesDB'), 'utf-8'), 'OLD-CATALOG')
  })

  it('an iPod with no JakeTunes id is filed under its volume name', async () => {
    const d = await ipod({ db: 'X' })
    assert.equal(await deviceBackupKey(d.mount), 'IndieSleaze')
  })

  it('a blank iPod (no catalog yet) has nothing to back up and is not refused', async () => {
    const d = await ipod({})
    const r = await backupItunesDb({ mount: d.mount, root: d.root })
    assert.deepEqual(r, { ok: true, dir: null, files: [], reason: 'no catalog on the iPod yet' })
  })

  it('no backup, no DB write: a backup that cannot be written is a refusal', { skip: process.getuid?.() === 0 }, async () => {
    const d = await ipod({ db: 'OLD' })
    await mkdir(d.root, { recursive: true })
    await chmod(d.root, 0o500)
    try {
      const r = await backupItunesDb({ mount: d.mount, root: d.root })
      assert.equal(r.ok, false)
    } finally { await chmod(d.root, 0o700) }
  })

  it('keeps the newest 8 per iPod and touches nothing it did not name', async () => {
    const d = await ipod({ id: 'nano', db: 'X' })
    for (let i = 0; i < 11; i++) {
      await backupItunesDb({ mount: d.mount, root: d.root, now: new Date(Date.UTC(2026, 10, 24, 10, i)) })
    }
    await mkdir(join(d.root, 'nano', 'keep-me'))
    await pruneBackups(join(d.root, 'nano'), 8)
    const left = (await readdir(join(d.root, 'nano'))).sort()
    assert.equal(left.filter((n) => n !== 'keep-me').length, 8)
    assert.ok(left.includes('keep-me'))
    assert.ok(left.includes(backupStamp(new Date(Date.UTC(2026, 10, 24, 10, 10)))), 'the newest stays')
    assert.ok(!left.includes(backupStamp(new Date(Date.UTC(2026, 10, 24, 10, 0)))), 'the oldest went')
  })

  it('both engines back up before writing the catalog, and refuse without one', async () => {
    const sync = await readFile(new URL('../sync-engine/index.ts', import.meta.url), 'utf-8')
    const sb = sync.indexOf('await backupItunesDb(')
    assert.ok(sb > 0 && sync.indexOf("'--write'") > sb, 'sync-engine: backup before the catalog write')
    assert.match(sync.slice(sb, sb + 500), /if \(!dbBackup\.ok\)[\s\S]{0,200}backupRefusal/)
    // The activity engine backs up through backupOnMac (once per run) in putCatalog, before --write.
    const act = await readFile(new URL('../ipod-activity-engine.ts', import.meta.url), 'utf-8')
    assert.match(act, /const backupOnMac = async \(\)[\s\S]{0,300}await backupItunesDb\(/)
    const inCatalog = act.indexOf('const backup = await backupOnMac()')
    assert.ok(inCatalog > 0 && act.indexOf("'--write'") > inCatalog, 'activity engine: backup before the catalog write')
    assert.match(act.slice(inCatalog, inCatalog + 200), /if \(!backup\.ok\) return stop\(false, \{[^}]*error: backupRefusal/)
  })
})

describe('the activity sync backs up before anything leaves the card', () => {
  it('the Mac backup comes before the remove/wipe loop, and a failed backup stops it', async () => {
    const src = await readFile(new URL('../ipod-activity-engine.ts', import.meta.url), 'utf-8')
    const section = src.indexOf('// ── 3. Remove (swap) or wipe (full) ──')
    const backup = src.indexOf('const backup = await backupOnMac()', section)
    const firstUnlink = src.indexOf('await unlink(p)', section)
    const interim = src.indexOf("await putCatalog(stayTracks, stayPlaylists, 'interim'", section)
    assert.ok(section > 0 && backup > section, 'backed up in section 3')
    assert.ok(backup < firstUnlink && backup < interim, 'before the first deletion and the interim catalog')
    assert.match(src.slice(backup, backup + 250), /if \(!backup\.ok\) \{[\s\S]{0,120}return fail\(\{ copied: 0, target, error: backupRefusal/)
  })
})

describe('recovery', () => {
  it('restoring a backup over an interrupted sync gives back the pre-sync catalog', async () => {
    const d = await ipod({ id: 'nano', db: 'PRE-SYNC', playCounts: 'PC-PRE' })
    const r = await backupItunesDb({ mount: d.mount, root: d.root })
    assert.ok(r.ok && r.dir)
    if (!r.ok || !r.dir) return
    // The sync dies after writing a half catalog.
    await writeFile(join(d.itunes, 'iTunesDB'), 'HALF-WRITTEN')
    await writeFile(join(d.itunes, 'Play Counts'), 'PC-NEW')
    assert.deepEqual(await restoreItunesDbBackup(r.dir, d.mount), ['iTunesDB', 'Play Counts'])
    assert.equal(await readFile(join(d.itunes, 'iTunesDB'), 'utf-8'), 'PRE-SYNC')
    assert.equal(await readFile(join(d.itunes, 'Play Counts'), 'utf-8'), 'PC-PRE')
    assert.deepEqual((await readdir(d.itunes)).filter((n) => n.includes('restore-tmp')), [])
  })
})
