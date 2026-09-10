/**
 * The sleeves in the bin.
 *
 * What a crate actually looks like, and what this does:
 *
 *   • It is FULL. All 48 records are drawn, every frame, packed at ~9 mm,
 *     sorted by artist the way a shop files them. The run of sleeve tops
 *     behind the one you're on is the single strongest cue that you are
 *     in a crate and not looking at a card on a table.
 *   • A sleeve is an object: a thin box with the cover on its face, kraft
 *     card on its back, spine and edges. Tipped over, it shows its back.
 *   • The bin is sized to the records (world.ts BIN), so the stack fills
 *     it wall to wall and the base is never visible.
 *   • Flipping: the ones you've passed tip FORWARD onto the front rail
 *     and compress there, the way a dug crate looks; the one you're on
 *     lifts a hand's width and leans back to face you at the rail.
 *   • Pulling is two moves, not a pop-up: the record rises straight out
 *     of its slot until its bottom edge clears the rail and the pile, THEN
 *     comes forward and tilts back into your hands. Sliding it back runs
 *     the same path in reverse — forward-then-down would drag it through
 *     the front wall.
 *   • Dividers are plain index cards with a printed tab every twelve
 *     records. The tab reads the artist letters of the section behind it
 *     — real, because the crate is sorted — and the tabs stagger
 *     left/centre/right like a cut-tab set so every one is readable.
 *
 * All motion is critically damped and frame-rate independent.
 */
import * as THREE from 'three'
import { BIN } from './world'
import { kraftTexture, labelTexture } from './textures'
import type { CrateRecord } from './types'

const SLEEVE = 0.62
const THICK = 0.006
const SPACING = 0.0092
const LEAN = 0.10                 // the packed stack leans back a touch
// Flipped-past records lean forward INSIDE the bin against the front wall,
// tops over the rail. A leaning record TOUCHES the wall: with the wall
// 0.30 m above the base, a pivot 0.11 m inside and a 0.34 rad lean put the
// sleeve's face on the rail's inner edge.
const PASSED = 0.34
const PASSED_INSET = 0.11
// The one you're on is lifted a hand's width — the way a digger tips a
// record up out of the pack to see it — and leans back toward eyes at the
// rail. From there the flipped pile hides its bottom quarter, which is
// what a crate looks like; pulling it out is how you see the rest.
const SEL_LIFT = 0.10
const SEL_TILT = -0.26
// While digging, the pack BEHIND the selection leans back with it, a touch
// further, so the selection never leans into the sleeve behind it.
const STACK_TILT = -0.30
// Held pose: bottom edge a little above the pile tops, pivot just past the
// front wall, leaned back ~30° so it squares up to a face at the rail.
const HOLD_LIFT = 0.52
const HOLD_FWD = 0.02
const HOLD_TILT = -0.55
const PULL_SECONDS = 0.55
const DIVIDER_EVERY = 12

export interface CrateView {
  group: THREE.Group
  /** `digging` false = nobody is at the bin: every record packed and upright,
   *  no selection, nothing tipped. The lifted pose exists only mid-dig. */
  update: (index: number, pulled: boolean, dt: number, digging: boolean) => void
  /** Local z of the record at `index` — the camera looks here while digging. */
  selectionZ: (index: number) => number
  /** Where the eye should rest, in the crate's local frame: the face of the
   *  record you're on, or the centre of the one in your hands. */
  focus: (index: number, pulled: boolean) => { y: number; z: number }
  dispose: () => void
}

const ease = (t: number): number => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Filing letter for a divider tab: leading "The" dropped, accents folded
 *  (Édith files under E, the way the sort already puts her). Any script's
 *  letter counts — Hebrew and Cyrillic acts file after Z in this library,
 *  and the tab says so in their own alphabet. Digits and symbols are "#". */
function filingLetter(artist: string): string {
  const c = [...artist.replace(/^the\s+/i, '').trim()][0] ?? ''
  const folded = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
  return /\p{L}/u.test(folded) ? folded : '#'
}

export function buildCrateView(records: CrateRecord[]): CrateView {
  const group = new THREE.Group()
  const loader = new THREE.TextureLoader()
  const disposables: Array<{ dispose: () => void }> = []

  const kraft = kraftTexture('#b9a07a', 11)
  const kraftDark = kraftTexture('#8f7a5c', 12)
  disposables.push(kraft, kraftDark)
  const edgeMat = new THREE.MeshLambertMaterial({ map: kraftDark })
  const backMat = new THREE.MeshLambertMaterial({ map: kraft })
  disposables.push(edgeMat, backMat)

  // One geometry for every sleeve. Box faces: +x, -x, +y, -y, +z (front), -z (back).
  const sleeveGeo = new THREE.BoxGeometry(SLEEVE, SLEEVE, THICK)
  disposables.push(sleeveGeo)

  // The pack is anchored at the BACK of the bin. Digging moves records to a
  // pile at the front wall, so the gap opens exactly where you are and the
  // record you're on can stand in it — in the crate, not lifted out of it.
  // 20 cm behind the pack so it can lean back with the selection without
  // the last record's top going through the back wall.
  const backZ = -BIN.innerHalfZ + 0.20
  const frontZ = BIN.innerHalfZ
  const n = records.length
  const zFor = (i: number): number => backZ + (n - 1 - i) * SPACING

  const pivots: THREE.Group[] = []
  records.forEach((rec, i) => {
    const faceMat = new THREE.MeshLambertMaterial({ color: 0xd8cbb0 })
    disposables.push(faceMat)
    if (rec.coverUrl) {
      loader.load(rec.coverUrl, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace
        tex.magFilter = THREE.LinearFilter
        tex.minFilter = THREE.LinearMipmapLinearFilter
        tex.anisotropy = 8
        faceMat.map = tex
        faceMat.color.set(0xffffff)
        faceMat.needsUpdate = true
      }, undefined, () => { /* blank board: what an unsleeved record looks like */ })
    }
    const mesh = new THREE.Mesh(sleeveGeo, [edgeMat, edgeMat, edgeMat, edgeMat, faceMat, backMat])
    mesh.position.y = SLEEVE / 2
    const pivot = new THREE.Group()          // pivot on the bottom edge: it tips on its spine
    pivot.add(mesh)
    pivot.position.set(0, BIN.baseTop, zFor(i))
    pivot.rotation.x = -LEAN
    group.add(pivot)
    pivots.push(pivot)
  })

  // Dividers: index cards, a little taller than the sleeves, with a printed
  // tab. The card in front of record i files the section i … i+11.
  const cardMat = new THREE.MeshLambertMaterial({ color: 0xece6d6 })
  const cardEdgeMat = new THREE.MeshLambertMaterial({ color: 0xd6cfbd })
  const dividerGeo = new THREE.BoxGeometry(SLEEVE + 0.04, SLEEVE + 0.03, 0.004)
  const tabGeo = new THREE.BoxGeometry(0.20, 0.07, 0.004)
  disposables.push(cardMat, cardEdgeMat, dividerGeo, tabGeo)
  const dividers: Array<{ pivot: THREE.Group; index: number }> = []
  for (let i = 0, ord = 0; i < records.length; i += DIVIDER_EVERY, ord++) {
    const last = Math.min(i + DIVIDER_EVERY - 1, records.length - 1)
    const from = filingLetter(records[i].artist)
    const to = filingLetter(records[last].artist)
    const label = labelTexture(from === to ? from : `${from}–${to}`)
    const labelMat = new THREE.MeshLambertMaterial({ map: label })
    disposables.push(label, labelMat)

    const pivot = new THREE.Group()
    const card = new THREE.Mesh(dividerGeo, [cardEdgeMat, cardEdgeMat, cardEdgeMat, cardEdgeMat, cardMat, cardMat])
    card.position.y = (SLEEVE + 0.03) / 2
    pivot.add(card)
    const tab = new THREE.Mesh(tabGeo, [cardEdgeMat, cardEdgeMat, cardEdgeMat, cardEdgeMat, labelMat, cardMat])
    tab.position.set(-0.19 + (ord % 3) * 0.19, SLEEVE + 0.03 + 0.03, 0)
    pivot.add(tab)
    pivot.position.set(0, BIN.baseTop, zFor(i) + SPACING / 2)
    pivot.rotation.x = -LEAN
    group.add(pivot)
    dividers.push({ pivot, index: i })
  }

  const settle = (obj: THREE.Object3D, rot: number, y: number, z: number, k: number): void => {
    obj.rotation.x += (rot - obj.rotation.x) * k
    obj.position.y += (y - obj.position.y) * k
    obj.position.z += (z - obj.position.z) * k
  }

  // Where a passed record rests: tipped onto the front rail, compressed.
  const passedZ = (rel: number): number => frontZ - PASSED_INSET - Math.min(-rel, 14) * 0.0025

  // Progress along the pull path, 0 = in its slot, 1 = in your hands.
  // Lift runs over the first 55 % of the path, the forward move over the
  // last 60 %; they overlap only once the bottom edge is over the pile.
  let pullT = 0
  let pullIndex = -1
  const heldPose = (i: number, t: number): { rot: number; y: number; z: number } => {
    const up = ease(t / 0.55)
    const fwd = ease((t - 0.4) / 0.6)
    return {
      rot: lerp(SEL_TILT, HOLD_TILT, fwd),
      y: BIN.baseTop + lerp(SEL_LIFT, HOLD_LIFT, up),
      z: lerp(zFor(i), frontZ + HOLD_FWD, fwd),
    }
  }

  const update = (index: number, pulled: boolean, dt: number, digging: boolean): void => {
    const k = 1 - Math.exp(-12 * dt)
    if (!digging) {
      pullT = 0
      pullIndex = -1
      // Walk away and the crate settles back to a packed bin — the record
      // you were on slides home, the tipped ones stand back up.
      for (let i = 0; i < pivots.length; i++) settle(pivots[i], -LEAN, BIN.baseTop, zFor(i), k)
      for (const d of dividers) settle(d.pivot, -LEAN, BIN.baseTop, zFor(d.index) + SPACING / 2, k)
      return
    }
    // Flipping to another record drops whatever was in hand straight back.
    if (pullIndex !== index) { pullT = 0; pullIndex = index }
    const step = dt / PULL_SECONDS
    pullT = pulled ? Math.min(1, pullT + step) : Math.max(0, pullT - step)

    for (let i = 0; i < pivots.length; i++) {
      const p = pivots[i]
      const rel = i - index
      if (rel < 0) settle(p, PASSED, BIN.baseTop, passedZ(rel), k)
      else if (rel === 0) {
        const h = heldPose(i, pullT)
        settle(p, h.rot, h.y, h.z, Math.min(1, 2.2 * k))
      }
      else settle(p, STACK_TILT, BIN.baseTop, zFor(i), k)
    }
    for (const d of dividers) {
      const rel = d.index - index
      // The card that files the section you're in sits in front of the
      // record you're on: it has been flipped past too.
      if (rel <= 0) settle(d.pivot, PASSED, BIN.baseTop, passedZ(rel - 1) - 0.002, k)
      else settle(d.pivot, STACK_TILT, BIN.baseTop, zFor(d.index) + SPACING / 2, k)
    }
  }

  const focus = (index: number, pulled: boolean): { y: number; z: number } => {
    const i = Math.max(0, Math.min(n - 1, index))
    if (pulled) {
      // Centre of the held sleeve. rotation.x < 0 leans the top toward -z.
      const half = SLEEVE / 2
      return {
        y: BIN.baseTop + HOLD_LIFT + half * Math.cos(HOLD_TILT),
        z: frontZ + HOLD_FWD + half * Math.sin(HOLD_TILT),
      }
    }
    // A little above the visible centre of the face: the pile hides its foot.
    return { y: BIN.baseTop + SEL_LIFT + 0.36, z: zFor(i) }
  }

  const dispose = (): void => {
    for (const d of disposables) d.dispose()
    for (const p of pivots) {
      const m = p.children[0] as THREE.Mesh
      const mats = m.material as THREE.MeshLambertMaterial[]
      mats[4]?.map?.dispose()
    }
  }

  return { group, update, dispose, focus, selectionZ: (index: number) => zFor(Math.max(0, Math.min(n - 1, index))) }
}
