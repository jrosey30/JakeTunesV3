/**
 * The sleeves in the bin — third pass, after Jake: "trash."
 *
 * What a crate actually looks like, and what this now does:
 *
 *   • It is FULL. All 48 records are drawn, every frame, packed at ~9 mm.
 *     The run of sleeve tops behind the one you're on is the single
 *     strongest cue that you are in a crate and not looking at a card on
 *     a table. The old version culled and spaced them into invisibility.
 *   • A sleeve is an object: a thin box with the cover on its face, kraft
 *     card on its back, spine and edges. Tipped over, it shows its back.
 *   • The bin is sized to the records (world.ts BIN), so the stack fills
 *     it wall to wall and the base is never visible.
 *   • Flipping: the ones you've passed tip FORWARD onto the front rail
 *     and compress there, the way a dug crate looks; the one you're on
 *     lifts a little and leans back to face a camera above the front rail;
 *     pulling it lifts it clear, forward, and squares it up.
 *   • Dividers are kraft cards with a coloured tab, slightly proud of the
 *     sleeves, every eight records.
 *
 * All motion is critically damped and frame-rate independent.
 */
import * as THREE from 'three'
import { BIN } from './world'
import { kraftTexture } from './textures'
import type { CrateRecord } from './types'

const SLEEVE = 0.62
const THICK = 0.006
const SPACING = 0.0092
const LEAN = 0.10                 // the packed stack leans back a touch
// Flipped-past records lean forward INSIDE the bin against the front wall,
// tops just over the rail. The old pose pivoted AT the rail and tipped 40°,
// which swung the whole sleeve out past the front wall to hang in the air.
const PASSED = 0.45
const PASSED_INSET = 0.06         // pivot sits this far inside the front wall
// The one you're on is lifted and rested on top of the flipped pile, the way
// a digger holds a record up to look at it — whole cover clear of the pile,
// bottom edge on the pile, nothing floating.
const SEL_LIFT = 0.10
// The selection comes FORWARD and stays near-upright. Leaning it back put
// its top behind the tops of the records behind it, which then overlapped
// the cover mid-flip.
const SEL_TILT = -0.30           // leans back to face a camera over the front rail
// While digging, the pack BEHIND the selection leans back with it, a touch
// further, the way a pile gives when you tip a record against it. Without
// this the selection leaned into the sleeve behind and the face you saw
// was the next record's, not the one named on the card.
const STACK_TILT = -0.36
// No forward push: 0.12 m carried the sleeve THROUGH the front rail, so from
// the room it sat on the crate rather than in it. The lift alone keeps its
// top clear of the records behind.
const SEL_FWD = 0.0
const PULL_LIFT = 0.42
const PULL_TILT = -0.30
const PULL_FWD = 0.10
const DIVIDER_EVERY = 8
const TAB_COLOURS = [0xc94f3d, 0x3d78c9, 0xd9a63a, 0x4f9c5a, 0x8b5cc9, 0xd06aa0]

export interface CrateView {
  group: THREE.Group
  /** `digging` false = nobody is at the bin: every record packed and upright,
   *  no selection, nothing tipped. The lifted pose exists only mid-dig. */
  update: (index: number, pulled: boolean, dt: number, digging: boolean) => void
  /** Local z of the record at `index` — the camera looks here while digging. */
  selectionZ: (index: number) => number
  dispose: () => void
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
  const backZ = -BIN.innerHalfZ + 0.04
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

  // Dividers: a kraft card a little taller than the sleeves with a coloured tab.
  const dividerGeo = new THREE.BoxGeometry(SLEEVE + 0.04, SLEEVE + 0.05, 0.004)
  const tabGeo = new THREE.BoxGeometry(0.16, 0.05, 0.004)
  disposables.push(dividerGeo, tabGeo)
  const dividers: Array<{ pivot: THREE.Group; index: number }> = []
  for (let i = DIVIDER_EVERY; i < records.length; i += DIVIDER_EVERY) {
    const pivot = new THREE.Group()
    const card = new THREE.Mesh(dividerGeo, backMat)
    card.position.y = (SLEEVE + 0.05) / 2
    pivot.add(card)
    const tabMat = new THREE.MeshLambertMaterial({ color: TAB_COLOURS[(i / DIVIDER_EVERY) % TAB_COLOURS.length] })
    disposables.push(tabMat)
    const tab = new THREE.Mesh(tabGeo, tabMat)
    tab.position.set(-0.2 + ((i / DIVIDER_EVERY) % 3) * 0.2, SLEEVE + 0.05 + 0.025, 0)
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

  const update = (index: number, pulled: boolean, dt: number, digging: boolean): void => {
    const k = 1 - Math.exp(-12 * dt)
    if (!digging) {
      // Walk away and the crate settles back to a packed bin — the record
      // you were on slides home, the tipped ones stand back up.
      for (let i = 0; i < pivots.length; i++) settle(pivots[i], -LEAN, BIN.baseTop, zFor(i), k)
      for (const d of dividers) settle(d.pivot, -LEAN, BIN.baseTop, zFor(d.index) + SPACING / 2, k)
      return
    }
    for (let i = 0; i < pivots.length; i++) {
      const p = pivots[i]
      const rel = i - index
      if (rel < 0) settle(p, PASSED, BIN.baseTop, passedZ(rel), k)
      else if (rel === 0) settle(p, pulled ? PULL_TILT : SEL_TILT, BIN.baseTop + (pulled ? PULL_LIFT : SEL_LIFT), zFor(i) + (pulled ? PULL_FWD : SEL_FWD), k)
      else settle(p, STACK_TILT, BIN.baseTop, zFor(i), k)
    }
    for (const d of dividers) {
      const rel = d.index - index
      if (rel < 0) settle(d.pivot, PASSED, BIN.baseTop, passedZ(rel) - 0.002, k)
      else settle(d.pivot, STACK_TILT, BIN.baseTop, zFor(d.index) + SPACING / 2, k)
    }
  }

  const dispose = (): void => {
    for (const d of disposables) d.dispose()
    for (const p of pivots) {
      const m = p.children[0] as THREE.Mesh
      const mats = m.material as THREE.MeshLambertMaterial[]
      mats[4]?.map?.dispose()
    }
  }

  return { group, update, dispose, selectionZ: (index: number) => zFor(Math.max(0, Math.min(n - 1, index))) }
}
