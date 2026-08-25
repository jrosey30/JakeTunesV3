/**
 * WAN full-sync doctrine (2026-08-22): full syncs downgrade to quick when
 * the NAS mount is served over the tailnet — a 73GB rsync stat-walk cannot
 * finish across a WAN link inside the 10-minute kill-timer, and eight
 * hourly safety-net runs proved it in one morning's flight log.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { TAILNET_HOST_RE, mountHostFor, isTailnetHost, decideSyncMode } from '../sync-mode.ts'

describe('tailnet host detection (CGNAT 100.64/10)', () => {
  test('range bounds are exact', () => {
    assert.ok(isTailnetHost('100.64.0.1'))
    assert.ok(isTailnetHost('100.117.19.93'))   // ds225's actual tailnet IP
    assert.ok(isTailnetHost('100.127.255.254'))
    assert.ok(!isTailnetHost('100.63.255.254'))
    assert.ok(!isTailnetHost('100.128.0.1'))
    assert.ok(!isTailnetHost('192.168.1.223'))  // the home LAN address
    assert.ok(!isTailnetHost('ds225.local'))
    assert.ok(!isTailnetHost('ds225'))
    assert.ok(!isTailnetHost(null))
  })
  test('regex anchors at the start — no substring hits', () => {
    assert.ok(!TAILNET_HOST_RE.test('10.100.64.1'))
  })
})

describe('mountHostFor', () => {
  const table = [
    '/dev/disk3s1 on / (apfs, sealed, local, read-only, journaled)',
    '//jakerosenbaum@100.117.19.93/JakeShared on /Volumes/JakeShared (smbfs, nodev, nosuid, mounted by jacobrosenbaum)',
    '//jake@ds225.local/Other Share on /Volumes/Other Share (smbfs, nodev)',
  ].join('\n')

  test('finds the host serving the exact volume', () => {
    assert.equal(mountHostFor(table, '/Volumes/JakeShared'), '100.117.19.93')
  })
  test('hostname mounts resolve too (the at-home shape)', () => {
    assert.equal(mountHostFor(table, '/Volumes/Other Share'), 'ds225.local')
  })
  test('unmounted volume → null; local fs lines never match', () => {
    assert.equal(mountHostFor(table, '/Volumes/Nope'), null)
    assert.equal(mountHostFor(table, '/'), null)
  })
  test('user@ prefix is optional', () => {
    assert.equal(mountHostFor('//192.168.1.223/JakeShared on /Volumes/JakeShared (smbfs)', '/Volumes/JakeShared'), '192.168.1.223')
  })
})

describe('decideSyncMode', () => {
  test('quick requests run as asked, remote or not', () => {
    assert.deepEqual(decideSyncMode(true, true), { quick: true, downgradedFromFull: false })
    assert.deepEqual(decideSyncMode(true, false), { quick: true, downgradedFromFull: false })
  })
  test('full at home runs full', () => {
    assert.deepEqual(decideSyncMode(false, false), { quick: false, downgradedFromFull: false })
  })
  test('full over the tailnet downgrades and records the debt', () => {
    assert.deepEqual(decideSyncMode(false, true), { quick: true, downgradedFromFull: true })
  })
})

// 2026-08-24 — cadence easing (Jake: "ease up the full sync cadence").
// The recovery kick fires on every breaker close; on a flapping link that is
// many times an hour. It must NOT cost a full both-tree SMB walk.
describe('nas-recovery is a quick reason', () => {
  test('recovery kick asks for quick mode, not a full reconcile', () => {
    // wantQuick=true is what the orchestrator derives for 'nas-recovery'.
    assert.equal(decideSyncMode(true, false).quick, true)
    assert.equal(decideSyncMode(true, false).downgradedFromFull, false)
  })
  test('the periodic reconcile is still full at home', () => {
    assert.equal(decideSyncMode(false, false).quick, false)
  })
})
